// Three agents working together:
//   Planner      - turns a request into test cases (reads the knowledge base, nothing else)
//   Builder      - turns approved test cases into a passing Postman collection (knowledge base + Newman)
//   Orchestrator - runs the process: plan -> human approval -> build -> publish
//
// Run: npx tsx orchestrator.ts "what to test" [workspace id]
import { query, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { qaServer, printMessage } from "./tools.ts";

const request =
  process.argv[2] ??
  "Test the checkin and checkout date filters on GET /booking, including a date in the far future that should match nothing.";
const workspaceId = process.argv[3] ?? "a4ac7a19-b10d-4f2d-8621-68f6b79122b5"; // "Practice Collection"

const agents: Record<string, AgentDefinition> = {
  planner: {
    description: "Turns a testing request into a structured list of API test cases. Does not write or run tests.",
    tools: ["mcp__qa__search_knowledge"],
    prompt: `You are a test planner for HTTP APIs.
Look up the relevant endpoints and the team's test conventions with search_knowledge before planning; never assume how the API behaves.
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
    description: "Turns an approved test plan into a Postman collection and makes it pass. Does not publish.",
    tools: ["mcp__qa__search_knowledge", "mcp__qa__run_collection"],
    prompt: `You are a QA engineer who writes Postman collections (v2.1 format, JavaScript pm.test scripts).
You are given an approved test plan as JSON. Implement every case in it, in order, as one collection with the plan's collection_name. Do not add or drop cases.
Look up endpoint details and the team's conventions with search_knowledge, and follow them.
Verify with run_collection. When a test fails because the test is wrong, fix the test and run again.
When a failure looks like a real bug in the API, do not weaken the test to hide it: stop and report it.

Reply with: the final run's numbers (requests, assertions, failed), one line per case saying how it was checked, and any API bugs found.`,
  },

  orchestrator: {
    description: "Coordinates the planner and builder, gets human approval, and publishes the result.",
    tools: ["Agent", "mcp__qa__request_approval", "mcp__qa__postman_list_collections", "mcp__qa__postman_publish_collection"],
    prompt: `You coordinate a small QA team. You do not write test cases or tests yourself.
Follow these steps in order. Always call subagents with run_in_background set to false, and pass them everything they need in the prompt, since they cannot see this conversation.

1. Ask the planner subagent for a test plan for the request.
2. Show the plan to the human with request_approval, as one readable line per case.
   If they reject it, send the planner the previous plan and the human's feedback, then ask again. Stop after 3 rejections.
3. Check with postman_list_collections that the plan's collection_name is not already used in the workspace. If it is, ask the planner for a new name and get approval again.
4. Give the builder the approved plan JSON exactly as approved.
5. If the builder reports zero failed assertions and no API bugs, publish with postman_publish_collection. Otherwise do not publish.
6. Finish with a short report: what was published (or why not), the final run numbers, and any API bugs.`,
  },
};

for await (const msg of query({
  prompt: `Request: ${request}\nPostman workspace id: ${workspaceId}`,
  options: {
    model: "claude-opus-5-5",
    agent: "orchestrator", // the main thread runs as the orchestrator, with only its tools
    agents,
    tools: ["Agent"], // the only built-in tool anyone gets: starting a subagent. No shell, no file access.
    mcpServers: { qa: qaServer(true) }, // true: publishing also requires human approval
    allowedTools: [
      "Agent",
      "mcp__qa__search_knowledge",
      "mcp__qa__run_collection",
      "mcp__qa__request_approval",
      "mcp__qa__postman_list_collections",
      "mcp__qa__postman_publish_collection",
    ],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    maxTurns: 30,
  },
})) {
  printMessage(msg, "orchestrator");
}
