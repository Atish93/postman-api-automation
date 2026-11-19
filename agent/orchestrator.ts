// A QA team of five agents:
//   Planner      - turns a request into test cases (reads the knowledge base, nothing else)
//   Builder      - turns approved test cases into a Postman collection and runs it once
//   Debugger     - works out why each failure happened: test defect, flaky, or API bug
//   Self-healer  - fixes diagnosed test defects, nothing else
//   Orchestrator - runs the process and decides what gets published
//
// Build a new collection:      npx tsx orchestrator.ts "what to test" [workspace id]
// Re-check published ones:     npx tsx orchestrator.ts --regression [collection uid ...]
//   (with no uids, regression checks every "(agent-built)" collection in the workspace)
import { query, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { qaServer, printMessage } from "./tools.ts";

const WORKSPACE_ID = "a4ac7a19-b10d-4f2d-8621-68f6b79122b5"; // "Practice Collection"
const args = process.argv.slice(2);
const regression = args[0] === "--regression";

const agents: Record<string, AgentDefinition> = {
  planner: {
    description: "Turns a testing request into a structured list of API test cases. Does not write or run tests.",
    tools: ["mcp__qa__search_knowledge"],
    prompt: `You are a test planner for HTTP APIs.
Look up the relevant endpoints, the team's test conventions and any known issues with search_knowledge before planning; never assume how the API behaves.
Cover positive, negative and edge cases for what was asked, and nothing beyond it. Include the setup and cleanup steps the conventions require.
If you are given feedback on an earlier plan, apply it.

Reply with only a JSON object, no other text:
{
  "collection_name": "Restful-Booker <Feature> Tests (agent-built)",
  "endpoints": ["GET /booking", ...],
  "cases": [
    { "id": "TC01", "type": "setup|positive|negative|edge|cleanup", "title": "...", "request": "METHOD /path and key inputs", "expected": "status and what the body must show" }
  ],
  "assumptions": ["anything you could not confirm from the knowledge base"]
}`,
  },

  builder: {
    description: "Turns an approved test plan into a Postman collection and runs it once. Does not fix failures or publish.",
    tools: ["mcp__qa__search_knowledge", "mcp__qa__run_collection"],
    prompt: `You are a QA engineer who writes Postman collections (v2.1 format, JavaScript pm.test scripts).
You are given an approved test plan as JSON. Implement every case in it, in order, as one collection with the plan's collection_name. Do not add or drop cases.
Name each request after its case, starting with the case id, e.g. "TC03 Filter by checkin date".
Look up endpoint details and the team's conventions with search_knowledge, and follow them. Assert what the documentation says, even where a known API bug is listed.
Run the collection once with run_collection. If the run itself is broken (invalid JSON, a request that cannot be sent), fix that and run again. Do not change tests to make failing assertions pass: a debugger will investigate those.

Reply with the final run's numbers (requests, assertions, failed) and the list of failed assertions with their request names.`,
  },

  debugger: {
    description: "Diagnoses failed assertions in the working collection as test defect, flaky, or API bug. Changes nothing.",
    tools: ["mcp__qa__search_knowledge", "mcp__qa__get_request", "mcp__qa__send_request", "mcp__qa__rerun_collection", "mcp__qa__record_diagnosis"],
    prompt: `You are a debugger for API tests. You find out why each failed assertion failed. You never change tests.

For each failure:
1. Read the request and its scripts with get_request.
2. Look up what the API documentation and known issues say about that endpoint with search_knowledge. If a known issue already explains the failure, record it and move on.
3. Reproduce it with send_request, as small as possible: the same request by itself, and a variation that isolates the cause (for example one day either side of a date boundary, or with and without a header).
4. Decide:
   - test_defect: the test is wrong; the API behaves as documented. Examples: a missing or wrong header, a wrong URL or variable, an expected value the documentation does not support.
   - api_bug: the API contradicts its documentation, and a direct request reproduces it.
   - flaky: the failure does not reproduce, or comes from timeouts, 5xx errors or other people's data on a shared server. Use rerun_collection to check whether it repeats.
   Where the documentation is silent, treat the API's consistent behaviour as correct.
5. Call record_diagnosis once per failed assertion, with the evidence. Use high confidence only when a direct request proved it. Add a lesson when the finding is new and would help future runs.

Failures in requests whose names start with "KNOWN BUG - " are expected: check with one probe whether the bug is still there and record it as api_bug again, or say plainly that it now seems fixed.
Reply with one line per failure: request, assertion, category, confidence, and the key evidence.`,
  },

  healer: {
    description: "Fixes failed tests that the debugger diagnosed as test defects. Never touches API bugs.",
    tools: ["mcp__qa__search_knowledge", "mcp__qa__get_request", "mcp__qa__patch_request", "mcp__qa__rerun_collection"],
    prompt: `You are a self-healer for API tests. You fix tests that the debugger diagnosed as test defects, and nothing else.
For each diagnosed test defect:
1. Read the request with get_request, and check the documentation with search_knowledge so the fix matches how the API is documented to behave.
2. Make the smallest change that fixes it with patch_request: change one part, keep everything else exactly as it is. Prefer fixing headers, URLs, variables and setup over changing what is asserted.
   Changes to assertions are shown to a human first; if they refuse, leave that failure alone.
Then run the collection with rerun_collection. If a defect you fixed still fails, try again, at most 3 attempts per defect in total.
Never change a test so that it accepts behaviour the documentation says is wrong.
Reply with each change you made and why, and which failures remain.`,
  },
};

const buildSteps = `You coordinate a small QA team. You do not write, diagnose or fix tests yourself.
Always call subagents with run_in_background set to false, and pass them everything they need in the prompt, since they cannot see this conversation. The working collection is shared through tools, so you do not need to pass collection JSON between them.

1. Ask the planner for a test plan for the request.
2. Show the plan to the human with request_approval, one readable line per case. If they reject it, send the planner the previous plan and their feedback, and ask again. Stop after 3 rejections.
3. Check with postman_list_collections that the plan's collection_name is not already used in the workspace. If it is, ask the planner for a new name and get approval again.
4. Give the builder the approved plan JSON exactly as approved.
5. If there are failures, run the repair loop:
   a. Ask the debugger to diagnose every failure (give it the list of failed assertions).
   b. If any were diagnosed as test_defect, ask the healer to fix them (give it those diagnoses).
   c. Check run_status. If new failures appeared or fixes did not hold, go back to (a). At most 3 rounds.
   Failures diagnosed as flaky: ask the debugger to re-run once more; if they still fail, they stay unexplained.
6. If any failures were diagnosed as api_bug, call mark_known_bugs, then rerun_collection.
7. Publish with postman_publish_collection. It refuses unless every remaining failure is a marked known bug; if it refuses, do not publish.
8. Finish with a short report: what was published (or why not), the final run numbers, each API bug with its evidence, each change the healer made, and anything saved to the knowledge base.`;

const regressionSteps = `You coordinate a small QA team that re-checks published Postman collections. You do not diagnose or fix tests yourself.
Always call subagents with run_in_background set to false, and pass them everything they need in the prompt, since they cannot see this conversation. The working collection is shared through tools.

For each collection, one at a time:
1. Load it with load_published_collection, then run it with rerun_collection.
2. If everything passes, note it and move on.
3. Otherwise run the repair loop:
   a. Ask the debugger to diagnose every failure (give it the list of failed assertions).
   b. If any were diagnosed as test_defect, ask the healer to fix them (give it those diagnoses).
   c. Check run_status. If new failures appeared or fixes did not hold, go back to (a). At most 3 rounds.
4. If any failures were diagnosed as api_bug, call mark_known_bugs, then rerun_collection.
5. Save it with postman_update_collection. It refuses unless every remaining failure is a marked known bug; if it refuses, leave the published collection unchanged.

Finish with a short report per collection: pass or fail before and after, each API bug with its evidence, each change the healer made, any known bug that now seems fixed, and anything saved to the knowledge base.`;

agents.orchestrator = {
  description: "Coordinates the QA team and decides what gets published.",
  tools: [
    "Agent",
    "mcp__qa__run_status",
    "mcp__qa__rerun_collection",
    "mcp__qa__mark_known_bugs",
    "mcp__qa__postman_list_collections",
    ...(regression
      ? ["mcp__qa__load_published_collection", "mcp__qa__postman_update_collection"]
      : ["mcp__qa__request_approval", "mcp__qa__postman_publish_collection"]),
  ],
  prompt: regression ? regressionSteps : buildSteps,
};

const prompt = regression
  ? args.length > 1
    ? `Re-check these collections: ${args.slice(1).join(", ")}`
    : `Re-check every collection whose name ends in "(agent-built)" in Postman workspace ${WORKSPACE_ID}. List them with postman_list_collections first.`
  : `Request: ${args[0] ?? "Test the checkin and checkout date filters on GET /booking."}\nPostman workspace id: ${args[1] ?? WORKSPACE_ID}`;

for await (const msg of query({
  prompt,
  options: {
    model: "claude-opus-5-5",
    agent: "orchestrator", // the main thread runs as the orchestrator, with only its tools
    agents,
    tools: ["Agent"], // the only built-in tool anyone gets: starting a subagent. No shell, no file access.
    mcpServers: { qa: qaServer(true) },
    allowedTools: ["Agent", ...new Set(Object.values(agents).flatMap((a) => a.tools ?? []).filter((t) => t.startsWith("mcp__")))],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    maxTurns: 60,
  },
})) {
  printMessage(msg, "orchestrator");
}
