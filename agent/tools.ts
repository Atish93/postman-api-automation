// The tools our agents can call, served from one in-process MCP server named "qa".
// Each agent is given only the tools its job needs (see orchestrator.ts).
//
// The important rules live here, in code, so no agent can talk its way past them:
//   - the healer may only change requests the debugger diagnosed as a test defect
//   - the healer may never change a request diagnosed as an API bug
//   - a change touching an assertion needs a human's approval
//   - nothing is published unless every remaining failure is a marked KNOWN BUG
import { tool, createSdkMcpServer, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import newman from "newman";
import { appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { search, addChunk } from "./rag/search.ts";

// Hosts the debugger may send probe requests to. Keeps it from calling anything else.
const PROBE_HOSTS = ["restful-booker.herokuapp.com"];
const KNOWN_BUG_PREFIX = "KNOWN BUG - ";

// ---- State shared by the tools ----
type Failure = { request: string; assertion: string; error: string };
type Diagnosis = {
  request: string;
  assertion: string;
  category: "test_defect" | "api_bug" | "flaky";
  confidence: "high" | "medium" | "low";
  evidence: string;
  fix_hint?: string;
};
const state = {
  collection: null as any, // the collection being worked on
  source: null as null | { uid: string }, // set when it was loaded from Postman (regression)
  lastRun: null as null | { failures: Failure[]; requests: number; assertions: number },
  dirty: false, // changed since the last run
  approved: false, // a human approved the plan
  diagnoses: [] as Diagnosis[],
  heals: [] as string[], // human-readable record of every change made
};

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

// ---- Helpers ----
async function postman(path: string, init: RequestInit = {}) {
  // In the cloud session the network proxy injects the key; on your own machine set POSTMAN_API_KEY.
  const res = await fetch(`https://api.getpostman.com${path}`, {
    ...init,
    headers: { "X-Api-Key": process.env.POSTMAN_API_KEY ?? "proxy-injected", "Content-Type": "application/json" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Postman API ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

let stdinLines: AsyncIterator<string> | null = null;
async function askHuman(question: string): Promise<string | null> {
  stdinLines ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  process.stdout.write(question);
  const next = await stdinLines.next();
  return next.done ? null : next.value.trim(); // null: nobody can answer (e.g. in CI)
}

function requestsOf(items: any[] = []): any[] {
  return items.flatMap((it) => (it.item ? requestsOf(it.item) : [it]));
}
const findRequest = (name: string) => requestsOf(state.collection?.item).find((r) => r.name === name);

const scriptOf = (item: any, listen: "test" | "prerequest") =>
  (item.event ?? []).find((e: any) => e.listen === listen)?.script?.exec?.join("\n") ?? "";

function setScript(item: any, listen: "test" | "prerequest", source: string) {
  item.event ??= [];
  let ev = item.event.find((e: any) => e.listen === listen);
  if (!ev) item.event.push((ev = { listen, script: { type: "text/javascript" } }));
  ev.script.exec = source.split("\n");
}

// A line-level diff, good enough to show a person what changed.
function diff(before: string, after: string) {
  const a = before.split("\n"), b = after.split("\n");
  return [...a.filter((l) => !b.includes(l)).map((l) => `- ${l}`), ...b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`)];
}
// Changing an assertion line can hide a bug, so those changes need a human.
const ASSERTION = /expect|status|eql|equal|include|property|to\.be|to\.have|pm\.test/;

function canShip(): string | null {
  if (!state.collection || !state.lastRun) return "no collection has been run yet";
  if (state.dirty) return "the collection changed since its last run; run it again first";
  const unexplained = state.lastRun.failures.filter((f) => !f.request.startsWith(KNOWN_BUG_PREFIX));
  if (unexplained.length) return `${unexplained.length} failed assertions are not marked as known API bugs`;
  return null;
}

async function runWorkingCollection() {
  const summary: any = await new Promise((resolve, reject) =>
    newman.run({ collection: state.collection, reporters: [] }, (err: unknown, s: unknown) => (err ? reject(err) : resolve(s))),
  );
  mkdirSync("runs", { recursive: true });
  writeFileSync("runs/last-collection.json", JSON.stringify(state.collection, null, 2));
  const executions = summary.run.executions.map((x: any) => ({
    request: x.item.name,
    status: x.response?.code,
    body: x.response?.stream?.toString().slice(0, 300),
    assertions: (x.assertions ?? []).map((a: any) => ({ name: a.assertion, error: a.error?.message })),
  }));
  const failures: Failure[] = executions.flatMap((e: any) =>
    e.assertions.filter((a: any) => a.error).map((a: any) => ({ request: e.request, assertion: a.name, error: a.error })),
  );
  state.lastRun = { failures, requests: summary.run.stats.requests.total, assertions: summary.run.stats.assertions.total };
  state.dirty = false;
  console.log(`[newman] ${state.lastRun.requests} requests, ${failures.length}/${state.lastRun.assertions} assertions failed`);
  return { requests: state.lastRun.requests, assertions: state.lastRun.assertions, failed: failures.length, failures, executions };
}

// ---- Knowledge base ----
export const searchKnowledge = tool(
  "search_knowledge",
  "Search the knowledge base (API documentation, the team's test conventions, and known issues from earlier runs).",
  { query: z.string().describe("What you need to know, in plain words, e.g. 'headers needed to update a booking'") },
  async ({ query }) => {
    const hits = search(query);
    console.log(`[retrieved] "${query}" -> ${hits.map((h) => h.title).join(" | ") || "nothing"}`);
    return text(hits.map((h) => `### ${h.title} (source: ${h.source})\n${h.text}`).join("\n\n") || "No matching sections.");
  },
);

// ---- Running ----
export const runCollection = tool(
  "run_collection",
  "Make the given Postman collection (v2.1 JSON, as a string) the working collection and run it with Newman.",
  { collection_json: z.string().describe("The full Postman v2.1 collection as a JSON string") },
  async ({ collection_json }) => {
    try {
      state.collection = JSON.parse(collection_json);
    } catch (e) {
      return text(`Invalid JSON: ${e}`, true);
    }
    state.source = null;
    return text(JSON.stringify(await runWorkingCollection(), null, 2));
  },
);

export const rerunCollection = tool(
  "rerun_collection",
  "Run the working collection again, as it is now, and return the results.",
  {},
  async () => (state.collection ? text(JSON.stringify(await runWorkingCollection(), null, 2)) : text("No working collection.", true)),
);

export const getRequest = tool(
  "get_request",
  "Show one request of the working collection: method, URL, headers, body, and its pre-request and test scripts.",
  { request_name: z.string() },
  async ({ request_name }) => {
    const r = findRequest(request_name);
    if (!r) return text(`No request named "${request_name}". Names: ${requestsOf(state.collection?.item).map((x) => x.name).join(" | ")}`, true);
    const { method, url, header, body } = r.request;
    return text(JSON.stringify({ name: r.name, method, url, header, body, prerequest_script: scriptOf(r, "prerequest"), test_script: scriptOf(r, "test"), collection_variables: state.collection.variable }, null, 2));
  },
);

// ---- Debugger ----
export const sendRequest = tool(
  "send_request",
  `Send one HTTP request directly to the API under test, to reproduce or isolate a failure. Allowed hosts: ${PROBE_HOSTS.join(", ")}.`,
  {
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().describe("Full URL, e.g. https://restful-booker.herokuapp.com/booking?checkin=2027-06-10"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional().describe("Raw request body, usually JSON"),
  },
  async ({ method, url, headers, body }) => {
    const host = new URL(url).hostname;
    if (!PROBE_HOSTS.includes(host)) return text(`Refused: ${host} is not an allowed host.`, true);
    const res = await fetch(url, { method, headers, body });
    const resBody = await res.text();
    console.log(`[probe] ${method} ${url} -> ${res.status}`);
    return text(JSON.stringify({ status: res.status, content_type: res.headers.get("content-type"), body: resBody.slice(0, 1500) }, null, 2));
  },
);

export const recordDiagnosis = tool(
  "record_diagnosis",
  "Record your diagnosis of one failed assertion. The healer may only change requests diagnosed as test_defect, and never one diagnosed as api_bug. High-confidence findings that are new are also saved to the knowledge base for future runs.",
  {
    request: z.string().describe("Exact request name"),
    assertion: z.string().describe("Exact name of the failed assertion"),
    category: z.enum(["test_defect", "api_bug", "flaky"]),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.string().describe("What you observed that proves it, e.g. probe requests and their responses"),
    fix_hint: z.string().optional().describe("For test_defect: what should change in the test"),
    lesson: z.string().optional().describe("One general sentence for future runs, naming the endpoint, e.g. 'GET /booking?checkin= excludes bookings on the given date (docs say on or after)'. Omit if the knowledge base already has it."),
  },
  async ({ lesson, ...d }) => {
    if (!findRequest(d.request)) return text(`No request named "${d.request}".`, true);
    state.diagnoses = state.diagnoses.filter((x) => !(x.request === d.request && x.assertion === d.assertion));
    state.diagnoses.push(d);
    console.log(`[diagnosis] ${d.category} (${d.confidence}): ${d.request} / ${d.assertion}`);
    let saved = "";
    if (lesson && d.confidence === "high" && d.category !== "flaky") {
      const title = `${d.category === "api_bug" ? "Known API bug" : "Test pitfall"}: ${lesson}`;
      const body = `${d.evidence}${d.fix_hint ? `\nFix: ${d.fix_hint}` : ""}\nFound ${new Date().toISOString().slice(0, 10)} in "${d.request}".`;
      const file = "knowledge/known-issues.md";
      if (!existsSync(file)) writeFileSync(file, "# Known issues found by the debugger\n");
      appendFileSync(file, `\n## ${title}\n${body}\n`);
      addChunk({ id: `known-issues.md:${title}`, source: "known-issues.md", title, text: body });
      saved = " Saved to the knowledge base.";
      console.log(`[learned] ${title}`);
    }
    return text(`Recorded.${saved}`);
  },
);

// ---- Self-healer ----
export const patchRequest = tool(
  "patch_request",
  "Change one part of one request in the working collection. Only allowed for requests diagnosed as test_defect. Changes to assertion lines in a test script are shown to a human for approval first.",
  {
    request_name: z.string(),
    part: z.enum(["url", "method", "headers", "body", "test_script", "prerequest_script"]),
    new_value: z.string().describe("The complete new value. headers: a JSON array of {key, value}. Scripts: the full script source."),
    reason: z.string().describe("Which diagnosis this fixes and why the change is right"),
  },
  async ({ request_name, part, new_value, reason }) => {
    const r = findRequest(request_name);
    if (!r) return text(`No request named "${request_name}".`, true);
    const mine = state.diagnoses.filter((d) => d.request === request_name);
    if (mine.some((d) => d.category === "api_bug"))
      return text("Refused: this request has a failure diagnosed as an API bug. Tests that expose API bugs must not be changed.", true);
    if (!mine.some((d) => d.category === "test_defect"))
      return text("Refused: this request has no failure diagnosed as a test defect. Ask the debugger first.", true);

    const before =
      part === "test_script" ? scriptOf(r, "test")
      : part === "prerequest_script" ? scriptOf(r, "prerequest")
      : part === "headers" ? JSON.stringify(r.request.header ?? [], null, 2)
      : part === "body" ? r.request.body?.raw ?? ""
      : typeof r.request[part] === "string" ? r.request[part] : r.request[part]?.raw ?? JSON.stringify(r.request[part]);
    let after = new_value;
    if (part === "headers") {
      try {
        after = JSON.stringify(JSON.parse(new_value), null, 2);
      } catch {
        return text("headers must be a JSON array of {key, value}.", true);
      }
    }
    const changes = diff(before, after);
    if (!changes.length) return text("No change: the new value is the same as the old one.");

    const touchesAssertion = part === "test_script" && changes.some((l) => ASSERTION.test(l));
    if (touchesAssertion) {
      console.log(`\n========== ASSERTION CHANGE NEEDS APPROVAL ==========\nRequest: ${request_name}\nReason: ${reason}\n${changes.join("\n")}\n=====================================================`);
      const answer = await askHuman("Apply this assertion change? Type y to apply, anything else to refuse: ");
      if (!answer || !/^(y|yes)$/i.test(answer))
        return text(`Refused by the human${answer ? `: ${answer}` : " (no answer)"}. Leave this failure for the report.`, true);
    }

    if (part === "test_script") setScript(r, "test", after);
    else if (part === "prerequest_script") setScript(r, "prerequest", after);
    else if (part === "headers") r.request.header = JSON.parse(after);
    else if (part === "body") r.request.body = { ...(r.request.body ?? { mode: "raw", options: { raw: { language: "json" } } }), raw: after };
    else r.request[part] = after;
    state.dirty = true;
    const record = `${request_name} (${part}${touchesAssertion ? ", approved by human" : ""}): ${reason}\n${changes.map((l) => `    ${l}`).join("\n")}`;
    state.heals.push(record);
    console.log(`[healed] ${record}`);
    return text(`Applied.\n${changes.join("\n")}`);
  },
);

// ---- Orchestrator ----
export const requestApproval = tool(
  "request_approval",
  "Show a test plan to the human and wait for their decision. Returns APPROVED, or REJECTED with their feedback.",
  { plan_summary: z.string().describe("The plan, written for a person to read: one line per test case") },
  async ({ plan_summary }) => {
    console.log(`\n================ PLAN FOR REVIEW ================\n${plan_summary}\n=================================================`);
    const answer = await askHuman("Approve this plan? Type y to approve, or type what to change: ");
    if (answer === null) return text("REJECTED: nobody answered, so nothing will be built.");
    state.approved = /^(y|yes)$/i.test(answer);
    return text(state.approved ? "APPROVED" : `REJECTED. Feedback from the human: ${answer}`);
  },
);

export const runStatus = tool(
  "run_status",
  "Summarise the working collection's state: last run's failures, diagnoses so far, changes made by the healer, and whether it can be published.",
  {},
  async () =>
    text(JSON.stringify({ last_run: state.lastRun, diagnoses: state.diagnoses, heals: state.heals, changed_since_last_run: state.dirty, can_publish: canShip() ?? "yes" }, null, 2)),
);

export const markKnownBugs = tool(
  "mark_known_bugs",
  `Rename every request with a failure diagnosed as an API bug to start with "${KNOWN_BUG_PREFIX}", and add the evidence to its description. Its assertions are kept as they are.`,
  {},
  async () => {
    const buggy = [...new Set(state.diagnoses.filter((d) => d.category === "api_bug").map((d) => d.request))];
    const marked: string[] = [];
    for (const name of buggy) {
      const r = findRequest(name);
      if (!r || r.name.startsWith(KNOWN_BUG_PREFIX)) continue;
      const evidence = state.diagnoses.filter((d) => d.request === name && d.category === "api_bug").map((d) => `- ${d.assertion}: ${d.evidence}`).join("\n");
      r.name = KNOWN_BUG_PREFIX + r.name;
      r.request.description = `${r.request.description ?? ""}\n\nThis request currently fails because of an API bug:\n${evidence}`.trim();
      for (const d of state.diagnoses) if (d.request === name) d.request = r.name;
      marked.push(r.name);
    }
    if (marked.length) state.dirty = true;
    return text(marked.length ? `Marked:\n${marked.join("\n")}\nRun the collection again before publishing.` : "Nothing to mark.");
  },
);

export const loadPublishedCollection = tool(
  "load_published_collection",
  "Download a published collection from Postman and make it the working collection. Does not run it.",
  { collection_uid: z.string() },
  async ({ collection_uid }) => {
    const data = await postman(`/collections/${encodeURIComponent(collection_uid)}`);
    Object.assign(state, { collection: data.collection, source: { uid: collection_uid }, lastRun: null, dirty: false, diagnoses: [], heals: [] });
    return text(`Loaded "${data.collection.info.name}" with ${requestsOf(data.collection.item).length} requests.`);
  },
);

export const listCollections = tool(
  "postman_list_collections",
  "List the names and uids of the collections in a Postman workspace.",
  { workspace_id: z.string() },
  async ({ workspace_id }) => {
    const data = await postman(`/collections?workspace=${encodeURIComponent(workspace_id)}`);
    return text(JSON.stringify(data.collections.map((c: any) => ({ name: c.name, uid: c.uid })), null, 2));
  },
);

export const publishCollection = tool(
  "postman_publish_collection",
  "Publish the working collection as a new collection in a Postman workspace. Refuses unless a human approved the plan and every failure in the latest run is a marked known API bug.",
  { workspace_id: z.string() },
  async ({ workspace_id }) => {
    if (!state.approved) return text("Refused: no human has approved a plan.", true);
    const blocked = canShip();
    if (blocked) return text(`Refused: ${blocked}.`, true);
    const data = await postman(`/collections?workspace=${encodeURIComponent(workspace_id)}`, { method: "POST", body: JSON.stringify({ collection: state.collection }) });
    return text(JSON.stringify(data.collection));
  },
);

export const updatePublishedCollection = tool(
  "postman_update_collection",
  "Save the working collection back over the published collection it was loaded from. Refuses unless every failure in the latest run is a marked known API bug.",
  {},
  async () => {
    if (!state.source) return text("Refused: the working collection was not loaded from Postman.", true);
    if (!state.heals.length && !state.collection.item.some((r: any) => r.name?.startsWith(KNOWN_BUG_PREFIX))) return text("Nothing changed, so nothing was saved.");
    const blocked = canShip();
    if (blocked) return text(`Refused: ${blocked}.`, true);
    await postman(`/collections/${encodeURIComponent(state.source.uid)}`, { method: "PUT", body: JSON.stringify({ collection: state.collection }) });
    return text(`Updated ${state.source.uid}.`);
  },
);

// The single-agent version (agent.ts) uses this simpler publish, gated only on a clean run.
const publishPassingCollection = tool(
  "postman_publish_collection",
  "Publish the collection from the most recent run_collection call to a Postman workspace. Refuses unless that run had zero failed assertions.",
  { workspace_id: z.string() },
  async ({ workspace_id }) => {
    if (!state.lastRun) return text("Refused: no collection has been run yet.", true);
    if (state.lastRun.failures.length) return text(`Refused: the last run had ${state.lastRun.failures.length} failed assertions.`, true);
    const data = await postman(`/collections?workspace=${encodeURIComponent(workspace_id)}`, { method: "POST", body: JSON.stringify({ collection: state.collection }) });
    return text(JSON.stringify(data.collection));
  },
);

export const qaServer = (team = false) =>
  createSdkMcpServer({
    name: "qa",
    tools: team
      ? [searchKnowledge, runCollection, rerunCollection, getRequest, sendRequest, recordDiagnosis, patchRequest,
         requestApproval, runStatus, markKnownBugs, loadPublishedCollection, listCollections, publishCollection, updatePublishedCollection]
      : [searchKnowledge, runCollection, listCollections, publishPassingCollection],
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
        const target = block.name === "Agent" ? input.subagent_type : block.name.replace("mcp__qa__", "");
        console.log(`\n[${who(msg.parent_tool_use_id)} -> ${target}] ${JSON.stringify(input).slice(0, 160)}…`);
      }
    }
  } else if (msg.type === "result") {
    console.log(`\n[done] ${msg.subtype}, ${msg.num_turns} turns, $${msg.total_cost_usd?.toFixed(3)}`);
  }
}
