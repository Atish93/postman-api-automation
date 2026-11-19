// The model exam: run the debugger and healer on collections with known faults, and score them.
// Use it before switching either agent to another model.
//
//   npm run eval                              # the models in qa.config.json
//   npm run eval -- --model claude-sonnet-5-5 # try another model for the debugger and healer
//
// The exam hides earlier findings from the knowledge base (so the answers can't be looked up),
// answers no approval prompts, and saves nothing to the knowledge base. Costs roughly $0.30-0.60 per run.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.QA_NO_PROMPTS = "1";
process.env.QA_NO_LEARNING = "1";
process.env.QA_EXCLUDE_KNOWN_ISSUES = "1";
const t = await import("../tools.ts");
const { buildAgents, allowedTools } = await import("../agents.ts");

const args = process.argv.slice(2);
const modelFlag = args.indexOf("--model");
const override = modelFlag >= 0 ? { debugger: args[modelFlag + 1], healer: args[modelFlag + 1] } : {};
const agents = buildAgents("regression", override);
console.log(`Debugger model: ${agents.debugger.model}\nHealer model:   ${agents.healer.model}`);

const x: any = {};
const call = async (tool: any, input: any = {}) => (await tool.handler(input, x)).content[0].text as string;

async function runAgent(name: string, prompt: string) {
  for await (const msg of query({
    prompt,
    options: {
      agent: name, // run this agent as the main thread, with only its own tools
      model: agents[name].model,
      agents,
      tools: [],
      mcpServers: { qa: t.qaServer(true) },
      allowedTools: allowedTools(agents),
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 40,
    },
  })) {
    t.printMessage(msg, name);
  }
}

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
let allPassed = true;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json"))) {
  const expected = JSON.parse(readFileSync(dir + file.replace(".json", ".expected.json"), "utf8"));
  const original = JSON.parse(readFileSync(dir + file, "utf8")).collection;
  console.log(`\n==================== ${file} ====================`);

  t.loadCollectionFile(dir + file);
  await call(t.rerunCollection);
  const needs = JSON.parse(await call(t.runStatus)).needs_diagnosis;
  await runAgent("debugger", `Diagnose these failed assertions in the working collection:\n${JSON.stringify(needs, null, 2)}`);
  const defects = t.snapshot().diagnoses.filter((d) => d.category === "test_defect");
  if (defects.length) await runAgent("healer", `Fix these diagnosed test defects in the working collection:\n${JSON.stringify(defects, null, 2)}`);

  // ---- Score ----
  const finalRun = JSON.parse(await call(t.rerunCollection));
  const failing = new Set(finalRun.failed_requests.map((f: any) => f.request));
  const { diagnoses, collection } = t.snapshot();
  const results: [string, boolean, string][] = [];
  for (const [request, category] of Object.entries(expected.diagnoses) as [string, string][]) {
    const got = [...new Set(diagnoses.filter((d) => d.request === request).map((d) => d.category))];
    results.push([`${request} diagnosed as ${category}`, got.length > 0 && got.every((c) => c === category), `got: ${got.join(", ") || "nothing"}`]);
  }
  for (const r of expected.must_pass_after) results.push([`${r} passes after healing`, !failing.has(r), "still failing"]);
  for (const r of expected.must_still_fail_after) results.push([`${r} still fails (not hidden)`, failing.has(r), "now passes: was a test changed to hide it?"]);
  const changed = collection.item
    .filter((i: any) => JSON.stringify(i) !== JSON.stringify(original.item.find((o: any) => o.name === i.name)))
    .map((i: any) => i.name);
  const unexpected = changed.filter((n: string) => !expected.may_change.includes(n));
  results.push(["no unexpected changes", unexpected.length === 0, `changed: ${unexpected.join(", ")}`]);

  console.log(`\n---- Score: ${file} ----`);
  for (const [name, ok, why] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${why})`}`);
  const passed = results.filter((r) => r[1]).length;
  console.log(`${passed}/${results.length} passed`);
  if (passed < results.length) allPassed = false;
}

await t.cleanupProbes().catch((err) => console.error("Probe cleanup failed:", err.message));
t.closeHuman();
console.log(`\nExam ${allPassed ? "PASSED" : "FAILED"}. Model cost: $${t.costSoFar().toFixed(3)}`);
process.exit(allPassed ? 0 : 1);
