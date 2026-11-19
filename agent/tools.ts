// The tools our agents can call, served from one in-process MCP server named "qa".
// Each agent is given only the tools its job needs (see orchestrator.ts).
import { tool, createSdkMcpServer, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import newman from "newman";
import { writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { search } from "./rag/search.ts";

// ---- State shared by the tools, kept in code so the model cannot talk its way past it ----
let lastRun: { collection: any; failed: number } | null = null; // most recent Newman run
let approved = false; // set only when a human approves the plan

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

// Calls the Postman REST API. In the cloud session the network proxy injects the key;
// on your own machine, set POSTMAN_API_KEY in your shell.
async function postman(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.getpostman.com${path}`, {
    ...init,
    headers: { "X-Api-Key": process.env.POSTMAN_API_KEY ?? "proxy-injected", "Content-Type": "application/json" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Postman API ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// Reads answers typed (or piped) into this program, one line per question.
let stdinLines: AsyncIterator<string> | null = null;
async function askHuman(question: string): Promise<string | null> {
  stdinLines ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  process.stdout.write(question);
  const next = await stdinLines.next();
  return next.done ? null : next.value.trim();
}

// ---- RAG: look things up in the knowledge base ----
export const searchKnowledge = tool(
  "search_knowledge",
  "Search the knowledge base (API documentation and the team's test conventions). Returns the most relevant sections.",
  { query: z.string().describe("What you need to know, in plain words, e.g. 'headers needed to update a booking'") },
  async ({ query }) => {
    const hits = search(query);
    console.log(`[retrieved] "${query}" -> ${hits.map((h) => h.title).join(" | ") || "nothing"}`);
    return text(hits.map((h) => `### ${h.title} (source: ${h.source})\n${h.text}`).join("\n\n") || "No matching sections.");
  },
);

// ---- Run a collection with Newman ----
export const runCollection = tool(
  "run_collection",
  "Run a Postman collection (v2.1 JSON, as a string) with Newman and return which assertions passed or failed.",
  { collection_json: z.string().describe("The full Postman v2.1 collection as a JSON string") },
  async ({ collection_json }) => {
    let collection: any;
    try {
      collection = JSON.parse(collection_json);
    } catch (e) {
      return text(`Invalid JSON: ${e}`, true);
    }
    mkdirSync("runs", { recursive: true });
    writeFileSync("runs/last-collection.json", JSON.stringify(collection, null, 2));
    const summary: any = await new Promise((resolve, reject) =>
      newman.run({ collection, reporters: [] }, (err: unknown, s: unknown) => (err ? reject(err) : resolve(s))),
    );
    lastRun = { collection, failed: summary.run.stats.assertions.failed };
    console.log(`[newman] ${summary.run.stats.requests.total} requests, ${summary.run.stats.assertions.failed}/${summary.run.stats.assertions.total} assertions failed`);
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
    return text(JSON.stringify(report, null, 2));
  },
);

// ---- Human approval of a test plan ----
export const requestApproval = tool(
  "request_approval",
  "Show a test plan to the human and wait for their decision. Returns APPROVED, or REJECTED with their feedback.",
  { plan_summary: z.string().describe("The plan, written for a person to read: one line per test case") },
  async ({ plan_summary }) => {
    console.log(`\n================ PLAN FOR REVIEW ================\n${plan_summary}\n=================================================`);
    const answer = await askHuman("Approve this plan? Type y to approve, or type what to change: ");
    if (answer === null) return text("REJECTED: nobody answered, so nothing will be built.");
    if (/^(y|yes)$/i.test(answer)) {
      approved = true;
      return text("APPROVED");
    }
    approved = false;
    return text(`REJECTED. Feedback from the human: ${answer}`);
  },
);

// ---- Postman workspace ----
export const listCollections = tool(
  "postman_list_collections",
  "List the names and ids of the collections in a Postman workspace.",
  { workspace_id: z.string() },
  async ({ workspace_id }) => {
    const data = await postman(`/collections?workspace=${encodeURIComponent(workspace_id)}`);
    return text(JSON.stringify(data.collections.map((c: any) => ({ name: c.name, uid: c.uid })), null, 2));
  },
);

export const publishCollection = tool(
  "postman_publish_collection",
  "Publish the collection from the most recent run_collection call to a Postman workspace. Refuses unless that run had zero failed assertions.",
  { workspace_id: z.string() },
  async ({ workspace_id }) => {
    if (!lastRun) return text("Refused: no collection has been run yet.", true);
    if (lastRun.failed > 0) return text(`Refused: the last run had ${lastRun.failed} failed assertions.`, true);
    const data = await postman(`/collections?workspace=${encodeURIComponent(workspace_id)}`, {
      method: "POST",
      body: JSON.stringify({ collection: lastRun.collection }),
    });
    return text(JSON.stringify(data.collection));
  },
);

// Same as publishCollection, but also refuses unless a human approved the plan. Used by the orchestrator.
export const publishApprovedCollection = tool(
  "postman_publish_collection",
  "Publish the collection from the most recent run_collection call to a Postman workspace. Refuses unless a human approved the plan and that run had zero failed assertions.",
  { workspace_id: z.string() },
  async (args, extra) => {
    if (!approved) return text("Refused: no human has approved a plan.", true);
    return publishCollection.handler(args, extra);
  },
);

export const qaServer = (withApprovalGate = false) =>
  createSdkMcpServer({
    name: "qa",
    tools: [
      searchKnowledge,
      runCollection,
      requestApproval,
      listCollections,
      withApprovalGate ? publishApprovedCollection : publishCollection,
    ],
  });

// ---- Printing what the agents do ----
// Messages from a subagent carry parent_tool_use_id: the id of the Agent call that started it.
const agentNames = new Map<string, string>();
export function printMessage(msg: SDKMessage, mainName = "agent") {
  const who = (id: string | null | undefined) => (id ? agentNames.get(id) ?? "subagent" : mainName);
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) console.log(`\n[${who(msg.parent_tool_use_id)}] ${block.text.trim()}`);
      if (block.type === "tool_use") {
        const input: any = block.input;
        if (block.name === "Agent") agentNames.set(block.id, input.subagent_type ?? "subagent");
        console.log(`\n[${who(msg.parent_tool_use_id)} -> ${block.name === "Agent" ? `${input.subagent_type}` : block.name}] ${JSON.stringify(input).slice(0, 160)}…`);
      }
    }
  } else if (msg.type === "result") {
    console.log(`\n[done] ${msg.subtype}, ${msg.num_turns} turns, $${msg.total_cost_usd?.toFixed(3)}`);
  }
}
