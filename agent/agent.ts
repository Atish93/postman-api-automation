// The single-agent version: one agent designs, runs, fixes and publishes API tests.
// See orchestrator.ts for the same job split across a planner, a builder and an orchestrator.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { qaServer, printMessage } from "./tools.ts";

const WORKSPACE_ID = "a4ac7a19-b10d-4f2d-8621-68f6b79122b5"; // "Practice Collection"

// ---- 1. The instructions (system prompt) and the task (user prompt) ----
const systemPrompt = `You are a QA engineer who writes API tests as Postman collections (v2.1 format, JavaScript pm.test scripts).
Work in this order: design the tests, verify them with run_collection, fix anything that fails because the test is wrong, and only publish a collection whose latest run had zero failed assertions.
If a failure looks like a real bug in the API rather than a mistake in the test, do not weaken the test to hide it; report it instead and leave that request out of the published collection.
Tests must clean up any data they create. Use collection variables for the base URL and for values passed between requests.

You do not know this API or this team's conventions in advance. Before writing any request, look up the endpoints you will use and the team's test conventions with search_knowledge, and follow what you find. Search again whenever you are unsure rather than guessing.`;

const task =
  process.argv[2] ??
  `Create a collection named "Restful-Booker Filter Tests (agent-built)" that tests the name filters on GET /booking: ` +
    `a booking created with a unique name is found by firstname and lastname, and a name that does not exist returns an empty list. ` +
    `Then publish it to Postman workspace ${WORKSPACE_ID}, after checking no collection with that name already exists there.`;

// ---- 2. Run the agent loop and print every step ----
for await (const msg of query({
  prompt: task,
  options: {
    model: "claude-opus-5-5",
    systemPrompt,
    tools: [], // no built-in tools (no shell, no file access)
    mcpServers: {
      qa: qaServer(), // our own in-process MCP server
    },
    allowedTools: [
      // the only tools the agent may call
      "mcp__qa__search_knowledge",
      "mcp__qa__run_collection",
      "mcp__qa__postman_list_collections",
      "mcp__qa__postman_publish_collection",
    ],
    permissionMode: "dontAsk", // anything not on the list is refused, never prompted
    settingSources: [],
    strictMcpConfig: true,
    maxTurns: 25,
  },
})) {
  printMessage(msg);
}
