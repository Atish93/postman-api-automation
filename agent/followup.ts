// Follow-up work on one failure of a finished run, started from the dashboard's debug page:
//   debug - the debugger investigates the failure again (optionally with the person's question) and
//           records new probes, likely causes and probable fixes. Nothing is changed.
//   fix   - the self-healer applies the fix the person chose, then the whole collection is run again.
//           A change is kept only if its request passes and nothing else newly fails (as in every run).
//           A collection that lives in Postman is saved back only when every remaining failure is a
//           marked known bug: the same rule as a regression run.
//
//   npx tsx followup.ts [--env <name>] <job.json>      (written by the dashboard; see server/src/runs/followup.ts)
//
// Writes QA_RESULT_FILE like orchestrator.ts. Exit codes: 0 finished, 2 server issues, 3 circuit breaker, 1 error.
import { readFileSync, writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildAgents } from "./agents.ts";
import { env, selectEnvironment } from "./config.ts";
import { loadContract } from "./contract.ts";
import { emit } from "./events.ts";
import {
  abortController, breakerState, canShip, checkServerHealth, cleanupProbes, closeHuman, printMessage, qaServer,
  runResults, seedFollowup, serverIssue, updatePublishedCollection, type Detail, type Diagnosis, type Failure,
} from "./tools.ts";

type Fix = { kind: string; title: string; detail: string; change?: string };
type Job = {
  kind: "debug" | "fix";
  request: string;
  collection: any;
  source_uid?: string | null; // the collection lives in Postman (regression and build runs)
  contract_file?: string | null; // contract runs: the contract, for the debugger's and healer's contract tools
  plan?: any;
  exchange?: Detail | null;
  failures: Failure[];
  diagnoses?: Diagnosis[];
  requests?: number; assertions?: number; passing?: string[];
  note?: string | null; // debug: the person's question
  fix?: Fix | null; // fix: the fix the person chose
};

const args = process.argv.slice(2);
const envFlag = args.indexOf("--env");
if (envFlag >= 0) selectEnvironment(args.splice(envFlag, 2)[1]);
const job: Job = JSON.parse(readFileSync(args[0] ?? "", "utf8"));
if (job.contract_file) loadContract(job.contract_file);
seedFollowup(job);
console.log(`Environment: ${env().label} (${env().baseUrl})\nFollow-up (${job.kind}) on "${job.request}"`);
emit("followup_started", { kind: job.kind, request: job.request });

function finish(code: number): never {
  const r = { kind: job.kind, request: job.request, exit_code: code, ...runResults() };
  if (process.env.QA_RESULT_FILE) writeFileSync(process.env.QA_RESULT_FILE, JSON.stringify(r, null, 2));
  emit("followup_finished", { kind: job.kind, request: job.request, exit_code: code, cost_usd: r.cost_usd });
  process.exit(code);
}

const unhealthy = await checkServerHealth();
if (unhealthy) {
  emit("server_issue", { message: unhealthy.split("\n")[0], details: unhealthy.split("\n").slice(1).join(" ") });
  finish(2);
}

const team = buildAgents(job.contract_file ? "contract" : "regression");
const who = job.kind === "debug" ? "debugger" : "healer";
// A follow-up debug looks at one failure: it doesn't re-run the whole collection.
const def = { ...team[who], tools: (team[who].tools ?? []).filter((t) => job.kind === "fix" || t !== "mcp__qa__rerun_collection") };

const failed = job.failures.filter((f) => f.request === job.request);
const before = (job.diagnoses ?? []).filter((d) => d.request === job.request);
const prompt = job.kind === "debug"
  ? `A person is debugging this failure on the dashboard and asked you to investigate it again.
Request: "${job.request}"
Failed checks:\n${failed.map((f) => `- ${f.assertion}: ${f.error}`).join("\n") || "- (see get_run_details)"}
What was found before: ${before.length ? before.map((d) => `${d.category} (${d.confidence}): ${d.evidence}`).join(" | ") : "nothing was recorded (the run may have stopped first)."}
${job.note ? `The person asks: ${job.note}\n` : ""}
The result of this request in the run is available with get_run_details. Reproduce and isolate the cause with send_request (always pass for_request "${job.request}" and a short purpose), then call record_diagnosis once per failed check, with evidence, likely causes and probable fixes.
Do not run the whole collection. Reply with your conclusion in two or three sentences.`
  : `A person chose a fix for "${job.request}" on the dashboard. Apply it, then run the collection again.
The fix: ${job.fix?.title}
${job.fix?.detail ?? ""}
${job.fix?.change ? `The change, as -/+ lines:\n${job.fix.change}\n` : ""}
Read the request with get_request, make this change with patch_request (as small as possible, everything else exactly as it is; its diagnosis is already recorded as a test defect), then run rerun_collection once. Changes to assertions are approved in advance, because the person chose this fix.
Do not make other changes. Reply with what you changed and whether it was kept.`;

// Healer: patch_request needs a test_defect diagnosis for the request. The person's choice is that diagnosis.
if (job.kind === "fix") {
  const { recordDiagnosis } = await import("./tools.ts");
  for (const f of failed.length ? failed : [{ request: job.request, assertion: "(chosen fix)", error: "" }])
    await recordDiagnosis.handler({ request: job.request, assertion: f.assertion, category: "test_defect", confidence: "high",
      evidence: `A person chose this fix on the dashboard: ${job.fix?.title ?? "(unnamed)"}`, fix_hint: job.fix?.detail,
      lesson: undefined, causes: undefined, fixes: undefined }, {} as any);
}

process.env.MCP_TOOL_TIMEOUT = process.env.QA_TOOL_TIMEOUT_MS ?? String(3600 * 1000);
let code = 0;
try {
  for await (const msg of query({
    prompt,
    options: {
      agent: who, model: def.model, agents: { [who]: def },
      tools: [], // no built-in tools: only the QA tools below
      mcpServers: { qa: qaServer(true) }, allowedTools: def.tools ?? [],
      permissionMode: "dontAsk", settingSources: [], strictMcpConfig: true, maxTurns: 30, abortController,
    },
  })) {
    printMessage(msg, who);
    if (msg.type === "result" && msg.subtype !== "success") code = 1;
  }
} catch (err) {
  if (!serverIssue()) { console.error(err); code = 1; }
} finally {
  if (!serverIssue()) await cleanupProbes().catch((e) => console.error("Probe cleanup failed:", e));
  closeHuman();
}

// A fixed collection that lives in Postman is saved back on the same terms as a regression run.
if (job.kind === "fix" && code === 0 && !serverIssue() && job.source_uid) {
  const blocked = canShip();
  if (blocked) console.log(`[postman] Not saved to Postman: ${blocked}.`);
  else console.log(`[postman] ${((await updatePublishedCollection.handler({}, {} as any)).content[0] as { text: string }).text}`);
}
finish(serverIssue() ? 2 : code === 0 && breakerState() ? 3 : code);
