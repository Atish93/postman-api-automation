// A QA team of five agents (defined in agents.ts):
//   Planner      - turns a request into test cases (reads the knowledge base, nothing else)
//   Builder      - turns approved test cases into a Postman collection and runs it once
//   Debugger     - works out why each failure happened: test defect, flaky, or API bug
//   Self-healer  - fixes diagnosed test defects, nothing else
//   Orchestrator - runs the process and decides what gets published
//
// Build a new collection:   npx tsx orchestrator.ts [--env test|stg|prod] "what to test" [workspace id]
// Re-check published ones:  npx tsx orchestrator.ts [--env test|stg|prod] --regression [collection uid ...]
//   (with no uids, regression checks every "(agent-built)" collection in the workspace)
//
// Exit codes: 0 finished, 2 server issues (5xx or unreachable), 3 circuit breaker tripped,
//             1 the run did not finish successfully or another error.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildAgents, allowedTools, type Mode } from "./agents.ts";
import { env, selectEnvironment } from "./config.ts";
import { qaServer, printMessage, cleanupProbes, closeHuman, checkServerHealth, serverIssue, abortController, breakerState, runResults } from "./tools.ts";
import { emit } from "./events.ts";
import { writeFileSync } from "node:fs";

const WORKSPACE_ID = "a4ac7a19-b10d-4f2d-8621-68f6b79122b5"; // "Practice Collection"

// ---- Arguments ----
const args = process.argv.slice(2);
const envFlag = args.indexOf("--env");
try {
  if (envFlag >= 0) selectEnvironment(args.splice(envFlag, 2)[1]);
} catch (e: any) {
  console.log(e.message);
  process.exit(1);
}
const mode: Mode = args[0] === "--regression" ? "regression" : "build";
if (mode === "regression") args.shift();

const prompt =
  mode === "regression"
    ? args.length
      ? `Re-check these collections: ${args.join(", ")}`
      : `Re-check every collection whose name ends in "(agent-built)" in Postman workspace ${WORKSPACE_ID}. List them with postman_list_collections first.`
    : `Request: ${args[0] ?? "Test the checkin and checkout date filters on GET /booking."}\nPostman workspace id: ${args[1] ?? WORKSPACE_ID}`;

console.log(`Environment: ${env().label} (${env().baseUrl})`);
const startedAt = new Date().toISOString();
emit("run_started", { mode, environment: env().name, prompt });

// Writes the result file (QA_RESULT_FILE) and the final event, then exits.
function finish(exitCode: number, healthIssue: string | null = null): never {
  const results = { mode, started_at: startedAt, finished_at: new Date().toISOString(), exit_code: exitCode, ...runResults() };
  if (healthIssue) results.server_issue = healthIssue;
  if (process.env.QA_RESULT_FILE) writeFileSync(process.env.QA_RESULT_FILE, JSON.stringify(results, null, 2));
  emit("run_finished", { exit_code: exitCode, cost_usd: results.cost_usd });
  process.exit(exitCode);
}

// ---- Stop before spending anything if the server is down ----
const unhealthy = await checkServerHealth();
if (unhealthy) {
  console.log(`\n${unhealthy}`);
  emit("server_issue", { message: unhealthy.split("\n")[0], details: unhealthy.split("\n").slice(1).join(" ") });
  finish(2, unhealthy);
}

// ---- Run the team ----
const agents = buildAgents(mode);
let exitCode = 0;
try {
  for await (const msg of query({
    prompt,
    options: {
      agent: "orchestrator", // the main thread runs as the orchestrator, with only its tools
      model: agents.orchestrator.model,
      agents,
      tools: ["Agent"], // the only built-in tool anyone gets: starting a subagent. No shell, no file access.
      mcpServers: { qa: qaServer(true) },
      allowedTools: allowedTools(agents),
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 60,
      abortController, // tools abort it on a 5xx or an unreachable server
    },
  })) {
    printMessage(msg, "orchestrator");
    if (msg.type === "result" && msg.subtype !== "success") exitCode = 1;
  }
} catch (err) {
  // An abort for server issues is expected; anything else is a real error.
  if (!serverIssue()) {
    console.error(err);
    exitCode = 1;
  }
} finally {
  // Delete probe bookings even if the run failed part-way (pointless if the server is down).
  if (!serverIssue())
    await cleanupProbes().catch((err) => {
      console.error("Probe cleanup failed:", err);
      exitCode = 1;
    });
  closeHuman();
}

if (serverIssue()) {
  console.log(`\nRun terminated.\n${serverIssue()}`);
  exitCode = 2;
} else if (exitCode === 0 && breakerState()) {
  exitCode = 3;
}
// Newman and HTTP keep-alive sockets can also hold the event loop open; the run is over, so exit.
finish(exitCode);
