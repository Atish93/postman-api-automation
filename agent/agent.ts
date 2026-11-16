// A first QA agent: it designs API tests, runs them, fixes failures, then publishes to Postman.
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import newman from "newman";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const WORKSPACE_ID = "a4ac7a19-b10d-4f2d-8621-68f6b79122b5"; // "Practice Collection"

// Remembers the most recent run, so publishing can be gated on it in code.
let lastRun: { collection: any; failed: number } | null = null;

// Calls the Postman REST API. Here the key is injected by the network proxy; on your own
// machine, set POSTMAN_API_KEY in your shell instead.
async function postman(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.getpostman.com${path}`, {
    ...init,
    headers: { "X-Api-Key": process.env.POSTMAN_API_KEY ?? "proxy-injected", "Content-Type": "application/json" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Postman API ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// ---- 1. Custom tools we wrote ourselves ----
const runCollection = tool(
  "run_collection",
  "Run a Postman collection (v2.1 JSON, as a string) with Newman and return which assertions passed or failed.",
  { collection_json: z.string().describe("The full Postman v2.1 collection as a JSON string") },
  async ({ collection_json }) => {
    let collection: any;
    try {
      collection = JSON.parse(collection_json);
    } catch (e) {
      return { content: [{ type: "text", text: `Invalid JSON: ${e}` }], isError: true };
    }
    mkdirSync("runs", { recursive: true });
    writeFileSync("runs/last-collection.json", JSON.stringify(collection, null, 2));
    const summary: any = await new Promise((resolve, reject) =>
      newman.run({ collection, reporters: [] }, (err: unknown, s: unknown) => (err ? reject(err) : resolve(s))),
    );
    lastRun = { collection, failed: summary.run.stats.assertions.failed };
    const report = {
      requests: summary.run.stats.requests.total,
      assertions: summary.run.stats.assertions.total,
      failed: summary.run.stats.assertions.failed,
      executions: summary.run.executions.map((x: any) => ({
        request: x.item.name,
        status: x.response?.code,
        body: x.response?.stream?.toString().slice(0, 300),
        assertions: (x.assertions ?? []).map((a: any) => ({ name: a.assertion, error: a.error?.message })),
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },
);
const listCollections = tool(
  "postman_list_collections",
  "List the names and ids of the collections in a Postman workspace.",
  { workspace_id: z.string() },
  async ({ workspace_id }) => {
    const data = await postman(`/collections?workspace=${encodeURIComponent(workspace_id)}`);
    const list = data.collections.map((c: any) => ({ name: c.name, uid: c.uid }));
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  },
);

const publishCollection = tool(
  "postman_publish_collection",
  "Publish the collection from the most recent run_collection call to a Postman workspace. Refuses unless that run had zero failed assertions.",
  { workspace_id: z.string() },
  async ({ workspace_id }) => {
    if (!lastRun) return { content: [{ type: "text", text: "Refused: no collection has been run yet." }], isError: true };
    if (lastRun.failed > 0)
      return { content: [{ type: "text", text: `Refused: the last run had ${lastRun.failed} failed assertions.` }], isError: true };
    const data = await postman(`/collections?workspace=${encodeURIComponent(workspace_id)}`, {
      method: "POST",
      body: JSON.stringify({ collection: lastRun.collection }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data.collection) }] };
  },
);

const qaServer = createSdkMcpServer({ name: "qa", tools: [runCollection, listCollections, publishCollection] });

// ---- 2. The instructions (system prompt) and the task (user prompt) ----
const systemPrompt = `You are a QA engineer who writes API tests as Postman collections (v2.1 format, JavaScript pm.test scripts).
Work in this order: design the tests, verify them with run_collection, fix anything that fails because the test is wrong, and only publish a collection whose latest run had zero failed assertions.
If a failure looks like a real bug in the API rather than a mistake in the test, do not weaken the test to hide it; report it instead and leave that request out of the published collection.
Tests must clean up any data they create. Use collection variables for the base URL and for values passed between requests.

API reference:
${readFileSync("api-notes.md", "utf8")}`;

const task =
  process.argv[2] ??
  `Create a collection named "Restful-Booker Filter Tests (agent-built)" that tests the name filters on GET /booking: ` +
    `a booking created with a unique name is found by firstname and lastname, and a name that does not exist returns an empty list. ` +
    `Then publish it to Postman workspace ${WORKSPACE_ID}, after checking no collection with that name already exists there.`;

// ---- 3. Run the agent loop and print every step ----
for await (const msg of query({
  prompt: task,
  options: {
    model: "claude-opus-5-5",
    systemPrompt,
    tools: [], // no built-in tools (no shell, no file access)
    mcpServers: {
      qa: qaServer, // our own in-process MCP server with three tools
    },
    allowedTools: [
      // the only tools the agent may call
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
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) console.log(`\n[agent] ${block.text.trim()}`);
      if (block.type === "tool_use")
        console.log(`\n[tool call] ${block.name} ${JSON.stringify(block.input).slice(0, 160)}…`);
    }
  } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content)
      if (block.type === "tool_result")
        console.log(`[tool result] ${JSON.stringify(block.content).slice(0, 300)}…`);
  } else if (msg.type === "result") {
    console.log(`\n[done] ${msg.subtype}, ${msg.num_turns} turns, $${msg.total_cost_usd?.toFixed(3)}`);
  }
}
