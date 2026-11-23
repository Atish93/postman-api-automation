// The tools our agents can call, served from one in-process MCP server named "qa".
// Each agent is given only the tools its job needs (see agents.ts).
//
// The important rules live here, in code, so no agent - whatever model it runs on - can get past them:
//   - the run terminates only when the server itself is down: the health check fails, or most
//     requests get server errors in two runs in a row. A few 5xx responses are failures to debug.
//   - when too many requests fail at once (circuit breaker), nothing may be healed, marked or saved
//   - the healer may only change requests the debugger diagnosed as a test defect, never an API bug
//   - a change to an assertion, URL or method needs a human's approval
//   - a change is kept only if it turns its request from failing to passing and breaks nothing else
//   - per-run limits on heals, attempts per request, and new known bugs
//   - nothing is published unless every remaining failure is a marked KNOWN BUG
import { tool, createSdkMcpServer, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { contractTools, coverage, currentContract, parsePlan, type PlanT } from "./contract.ts";
import newman from "newman";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { search, addChunk } from "./rag/search.ts";
import { config, env, serverIssueMessage } from "./config.ts";
import { emit } from "./events.ts";

const KNOWN_BUG_PREFIX = "KNOWN BUG - ";

// Aborting this stops the agent run (orchestrator.ts passes it to query()).
export const abortController = new AbortController();

// ---- State shared by the tools ----
type Failure = { request: string; assertion: string; error: string };
type Detail = { method: string; url: string; status?: number; response_time_ms?: number; error?: string; body: string; assertions: { name: string; error?: string }[] };
type Diagnosis = {
  request: string;
  assertion: string;
  category: "test_defect" | "api_bug" | "flaky";
  confidence: "high" | "medium" | "low";
  evidence: string;
  fix_hint?: string;
};
type PendingChange = { item: any; before: any; record: string };

const state = {
  collection: null as any, // the collection being worked on
  source: null as null | { uid: string }, // set when it was loaded from Postman (regression)
  loadedSnapshot: null as string | null, // the collection as downloaded, to detect real changes
  lastRun: null as null | { failures: Failure[]; requests: number; assertions: number; passing: Set<string> },
  details: new Map<string, Detail>(), // full result of every request in the last run, for get_run_details
  dirty: false, // changed since the last run
  approved: false, // a human approved the plan
  contractPlan: null as PlanT | null, // contract runs: the test cases as the human approved them
  reviewRounds: 0,
  diagnoses: [] as Diagnosis[],
  heals: [] as string[], // human-readable record of every change, kept or reverted
  pending: [] as PendingChange[], // changes not yet proven by a run
  baselinePassing: new Set<string>(), // requests passing before the pending changes
  changedRequests: new Set<any>(), // requests with a kept or pending change (for the per-run limit)
  attempts: new Map<string, number>(), // patch attempts per request
  serverIssue: null as string | null,
  probeBookings: [] as number[], // bookings the debugger created, deleted by cleanupProbes()
  outcome: {} as { published?: { uid: string; name: string }; updated?: string },
  finished: [] as any[], // summaries of collections already worked on in this run (regression)
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

// Asks the person running the program. Returns null when nobody can answer
// (no terminal input, as in CI, or QA_NO_PROMPTS=1 as in the model exam).
let stdinReader: ReturnType<typeof createInterface> | null = null;
let stdinLines: AsyncIterator<string> | null = null;
let approvalSeq = 0;
async function askHuman(question: string, details: Record<string, unknown> = {}): Promise<string | null> {
  const id = ++approvalSeq;
  emit("approval_request", { id, question, ...details });
  if (process.env.QA_NO_PROMPTS === "1") {
    console.log(`${question}(no answer: prompts are off)`);
    return null;
  }
  if (!stdinReader) {
    stdinReader = createInterface({ input: process.stdin });
    stdinLines = stdinReader[Symbol.asyncIterator]();
  }
  // With events on, end the line so the next event starts on a line of its own.
  process.stdout.write(process.env.QA_EVENTS === "1" ? `${question}\n` : question);
  const next = await stdinLines!.next();
  const answer = next.done ? null : next.value.trim();
  emit("approval_answer", { id, answer });
  return answer;
}

// An open stdin reader keeps Node alive after the work is done, so close it when the run ends.
export function closeHuman() {
  stdinReader?.close();
  stdinReader = null;
  stdinLines = null;
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

function restore(item: any, before: any) {
  for (const k of Object.keys(item)) delete item[k];
  Object.assign(item, structuredClone(before));
}

// A line-level diff, good enough to show a person what changed.
function diff(before: string, after: string) {
  const a = before.split("\n"), b = after.split("\n");
  return [...a.filter((l) => !b.includes(l)).map((l) => `- ${l}`), ...b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`)];
}
// Changing an assertion line can hide a bug, so those changes need a human.
const ASSERTION = /expect|status|eql|equal|include|property|to\.be|to\.have|pm\.test/;

// ---- Server errors: stop everything ----
function stopForServerIssue(details: string): string {
  if (!state.serverIssue) {
    state.serverIssue = `${serverIssueMessage()}\n${details}`;
    emit("server_issue", { message: serverIssueMessage(), details });
    console.log(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n${state.serverIssue}\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    abortController.abort();
  }
  return `TERMINATED: ${state.serverIssue}\nStop now: do not investigate, heal or publish anything.`;
}
export const serverIssue = () => state.serverIssue;

// Checked before any agent starts, so a dead server costs no model tokens.
export async function checkServerHealth(): Promise<string | null> {
  const url = env().baseUrl + env().healthPath;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return res.status >= 500 ? `${serverIssueMessage()}\nHealth check ${url} answered ${res.status}.` : null;
  } catch (e: any) {
    return `${serverIssueMessage()}\nHealth check ${url} failed: ${e.cause?.code ?? e.message}.`;
  }
}

// ---- Circuit breaker and triage ----
// Splits the last run's failures: repeats of a recorded known bug need no investigation.
// A failure counts as a repeat only if it is in a KNOWN BUG request AND it is the same
// assertion recorded in that request's description when it was marked.
function triage() {
  const requests = requestsOf(state.collection?.item);
  const isRepeat = (f: Failure) => {
    if (!f.request.startsWith(KNOWN_BUG_PREFIX)) return false;
    const desc = requests.find((r) => r.name === f.request)?.request?.description ?? "";
    return desc.includes(`- ${f.assertion}:`);
  };
  const failures = state.lastRun?.failures ?? [];
  const failing = new Set(failures.map((f) => f.request));
  const needs = failures.filter((f) => !isRepeat(f));
  const needsRequests = new Set(needs.map((f) => f.request)).size;
  const { minFailingRequests, failingRequestPercent } = config.circuitBreaker;
  // Trips at minFailingRequests or failingRequestPercent% (whichever is larger), and always at half
  // the collection, so a small collection can't have most of its requests failing without tripping.
  const total = state.lastRun?.requests ?? 0;
  const threshold = Math.min(
    Math.max(minFailingRequests, Math.ceil((total * failingRequestPercent) / 100)),
    Math.max(1, Math.ceil(total / 2)),
  );
  const tripped = needsRequests >= threshold;
  return {
    known_bug_repeats: failures.filter(isRepeat),
    needs_diagnosis: needs,
    known_bugs_now_passing: requests.filter((r) => r.name.startsWith(KNOWN_BUG_PREFIX) && !failing.has(r.name)).map((r) => r.name),
    circuit_breaker: {
      tripped,
      requests_needing_diagnosis: needsRequests,
      trips_at: threshold,
      ...(tripped && { instruction: "Too many requests are failing at once for this to be individual test problems. Do outage triage only: no healing, marking or saving." }),
    },
  };
}
const breakerTripped = () => triage().circuit_breaker.tripped;
let breakerAnnounced = false;
// Whether the latest run tripped the breaker (for the program's exit code).
export const breakerState = () => (state.lastRun ? breakerTripped() : false);
const BREAKER_REFUSAL = "Refused: the circuit breaker has tripped (too many requests failing at once). Nothing may be changed, marked or saved in this run.";

function canShip(): string | null {
  if (!state.collection || !state.lastRun) return "no collection has been run yet";
  if (state.dirty) return "the collection changed since its last run; run it again first";
  if (breakerTripped()) return "the circuit breaker has tripped";
  const unexplained = state.lastRun.failures.filter((f) => !f.request.startsWith(KNOWN_BUG_PREFIX));
  if (unexplained.length) return `${unexplained.length} failed assertions are not marked as known API bugs`;
  return null;
}

// ---- Running a collection ----
async function newmanRun() {
  return new Promise<any>((resolve, reject) =>
    newman.run(
      {
        collection: state.collection,
        reporters: [],
        // The chosen environment's values win over the collection's own variables.
        envVar: [
          ...Object.entries(env().variables ?? {}).map(([key, value]) => ({ key, value })),
          { key: "baseUrl", value: env().baseUrl },
        ],
        timeoutRequest: 30_000,
      },
      (err: unknown, s: unknown) => (err ? reject(err) : resolve(s)),
    ),
  );
}

const isServerError = (d: Detail) => (d.status ?? 0) >= 500 || !!d.error;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runWorkingCollection(confirming = false): Promise<any> {
  if (state.serverIssue) return { terminated: stopForServerIssue("") };
  const summary = await newmanRun();
  mkdirSync("runs", { recursive: true });
  writeFileSync("runs/last-collection.json", JSON.stringify(state.collection, null, 2));

  state.details = new Map();
  for (const x of summary.run.executions) {
    state.details.set(x.item.name, {
      method: x.request?.method,
      url: x.request?.url?.toString(),
      status: x.response?.code,
      response_time_ms: x.response?.responseTime,
      error: x.requestError?.message,
      body: x.response?.stream?.toString().slice(0, 2000) ?? "",
      assertions: (x.assertions ?? []).map((a: any) => ({ name: a.assertion, error: a.error?.message })),
    });
  }

  // Server errors (5xx or no response). Terminate only if the server itself looks down:
  // the health check fails, or most requests got server errors in this run AND a re-run.
  // Otherwise they are ordinary failures for the debugger: often a real API bug.
  const serverErrors = [...state.details].filter(([, d]) => isServerError(d));
  if (serverErrors.length) {
    const total = state.details.size;
    const { terminateAtPercent, minRequests, recheckAfterSeconds } = config.serverErrors;
    const mostFailing = serverErrors.length >= Math.max(Math.min(minRequests, total), Math.ceil((total * terminateAtPercent) / 100));
    const summaryLine =
      `${serverErrors.length} of ${total} requests got a server error, e.g. ` +
      serverErrors.slice(0, 3).map(([name, d]) => `"${name}" -> ${d.status ?? d.error}`).join("; ");
    const health = await checkServerHealth();
    if (health) return { terminated: stopForServerIssue(`${health.split("\n").slice(1).join(" ")}\n${summaryLine}`) };
    if (mostFailing && confirming) return { terminated: stopForServerIssue(`${summaryLine}, in two runs in a row.`) };
    if (mostFailing) {
      console.log(`[server] ${summaryLine}. Health check passes; running again in ${recheckAfterSeconds}s to rule out a blip.`);
      emit("server_errors", { summary: summaryLine, action: "recheck" });
      await sleep(recheckAfterSeconds * 1000);
      return runWorkingCollection(true);
    }
    console.log(`[server] ${summaryLine}. Not an outage (health check passes): treating them as failures to debug.`);
    emit("server_errors", { summary: summaryLine, action: "debug" });
  }

  const failures: Failure[] = [...state.details].flatMap(([request, d]) => {
    const failed = d.assertions.filter((a) => a.error).map((a) => ({ request, assertion: a.name, error: a.error! }));
    // A server error with no failing assertion (e.g. no response, so no test ran) must still count as a failure.
    if (isServerError(d) && !failed.length)
      failed.push({ request, assertion: "Server responded without error", error: d.error ?? `status ${d.status}` });
    return failed;
  });
  const failing = new Set(failures.map((f) => f.request));
  state.lastRun = {
    failures,
    requests: summary.run.stats.requests.total,
    assertions: summary.run.stats.assertions.total,
    passing: new Set([...state.details.keys()].filter((n) => !failing.has(n))),
  };
  state.dirty = false;
  console.log(`[newman] ${state.lastRun.requests} requests, ${failures.length}/${state.lastRun.assertions} assertions failed`);
  emit("collection_run", { collection: state.collection?.info?.name, requests: state.lastRun.requests, assertions: state.lastRun.assertions, failed_assertions: failures.length, failed_requests: [...failing] });

  // Proof or revert: pending changes are kept only if their request now passes and nothing else broke.
  const reverted: string[] = [];
  if (state.pending.length) {
    const broken = [...state.baselinePassing].filter((n) => failing.has(n));
    for (const p of state.pending) {
      const reason = broken.length
        ? `${broken.join(", ")} started failing after this batch of changes`
        : failing.has(p.item.name) ? `"${p.item.name}" still fails` : null;
      if (!reason) continue;
      restore(p.item, p.before);
      state.changedRequests.delete(p.item);
      reverted.push(`${p.record.split("\n")[0]} -> REVERTED: ${reason}`);
    }
    for (const p of state.pending) {
      const wasReverted = reverted.some((r) => r.startsWith(p.record.split("\n")[0]));
      state.heals.push(wasReverted ? `${p.record}\n    (reverted)` : p.record);
      emit(wasReverted ? "change_reverted" : "change_kept", { request: p.item.name, change: p.record });
    }
    state.pending = [];
    if (reverted.length) {
      console.log(`[reverted] ${reverted.join("\n[reverted] ")}`);
      const again = await runWorkingCollection(); // refresh results for the restored collection
      return { ...again, reverted_changes: reverted };
    }
  }

  // Short report: totals, plus details for failed requests only.
  return {
    requests: state.lastRun.requests,
    assertions: state.lastRun.assertions,
    failed_assertions: failures.length,
    passed_requests: state.lastRun.passing.size,
    failed_requests: [...failing].map((name) => {
      const d = state.details.get(name)!;
      return {
        request: name, method: d.method, url: d.url, status: d.status, response_time_ms: d.response_time_ms,
        body: d.body.slice(0, 500),
        failed_assertions: d.assertions.filter((a) => a.error).map((a) => ({ assertion: a.name, error: a.error })),
      };
    }),
    note: "Passing requests are only counted. Use get_run_details for any request's full result.",
  };
}

// For the model exam (eval/): load a collection from a local file instead of Postman.
export function loadCollectionFile(path: string) {
  const c = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(state, { collection: c.collection ?? c, source: null, lastRun: null, dirty: false, diagnoses: [], heals: [], pending: [], changedRequests: new Set(), attempts: new Map() });
}
export const snapshot = () => ({ collection: state.collection, diagnoses: state.diagnoses, heals: state.heals, lastRun: state.lastRun });

// ---- Knowledge base ----
export const searchKnowledge = tool(
  "search_knowledge",
  "Search the knowledge base (API documentation, the team's test conventions, and known issues from earlier runs).",
  { query: z.string().describe("What you need to know, in plain words, e.g. 'headers needed to update a booking'") },
  async ({ query }) => {
    // QA_EXCLUDE_KNOWN_ISSUES=1 hides earlier findings, so the model exam can't just look up the answers.
    const hits = search(query, process.env.QA_EXCLUDE_KNOWN_ISSUES === "1" ? 6 : 3)
      .filter((h) => !(process.env.QA_EXCLUDE_KNOWN_ISSUES === "1" && h.source === "known-issues.md"))
      .slice(0, 3);
    console.log(`[retrieved] "${query}" -> ${hits.map((h) => h.title).join(" | ") || "nothing"}`);
    return text(hits.map((h) => `### ${h.title} (source: ${h.source})\n${h.text}`).join("\n\n") || "No matching sections.");
  },
);

// ---- Running ----
const runResult = (r: any) => (r.terminated ? text(r.terminated, true) : text(JSON.stringify(r, null, 2)));

export const runCollection = tool(
  "run_collection",
  "Make the given Postman collection (v2.1 JSON, as a string) the working collection and run it with Newman. Returns totals and details of failed requests only.",
  { collection_json: z.string().describe("The full Postman v2.1 collection as a JSON string") },
  async ({ collection_json }) => {
    let parsed: any;
    try {
      parsed = JSON.parse(collection_json);
    } catch (e) {
      return text(`Invalid JSON: ${e}`, true);
    }
    // Contract runs: only the test cases the human approved, each as one request named after its id.
    if (currentContract()) {
      if (!state.contractPlan) return text("Refused: no human has approved the test cases yet.", true);
      const { missing, extra } = coverage(state.contractPlan, parsed);
      if (missing.length || extra.length)
        return text(`Refused: the collection must have exactly one request per approved case, named after its id (e.g. "TC03 ...").${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}${extra.length ? ` Not in the approved cases: ${extra.join(" | ")}.` : ""}`, true);
    }
    state.collection = parsed;
    state.source = null;
    return runResult(await runWorkingCollection());
  },
);

export const rerunCollection = tool(
  "rerun_collection",
  "Run the working collection again, as it is now. Returns totals and details of failed requests only. Unproven healer changes are checked: kept if their request now passes and nothing else broke, otherwise undone.",
  {},
  async () => (state.collection ? runResult(await runWorkingCollection()) : text("No working collection.", true)),
);

export const getRunDetails = tool(
  "get_run_details",
  "Show the full result of one request from the last run, passing or failing: status, response time, body and every assertion.",
  { request_name: z.string() },
  async ({ request_name }) => {
    const d = state.details.get(request_name);
    return d ? text(JSON.stringify({ request: request_name, ...d }, null, 2)) : text(`No result for "${request_name}" in the last run.`, true);
  },
);

export const getRequest = tool(
  "get_request",
  "Show one request of the working collection: method, URL, headers, body, and its pre-request and test scripts.",
  { request_name: z.string() },
  async ({ request_name }) => {
    const r = findRequest(request_name);
    if (!r) return text(`No request named "${request_name}". Names: ${requestsOf(state.collection?.item).map((x) => x.name).join(" | ")}`, true);
    const { method, url, header, body } = r.request;
    return text(JSON.stringify({ name: r.name, method, url, header, body, prerequest_script: scriptOf(r, "prerequest"), test_script: scriptOf(r, "test"), collection_variables: state.collection.variable, base_url_in_use: env().baseUrl }, null, 2));
  },
);

// ---- Debugger ----
export const sendRequest = tool(
  "send_request",
  "Send one HTTP request directly to the API under test (the selected environment only), to reproduce or isolate a failure.",
  {
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().describe("Full URL on the environment under test, e.g. <base URL>/booking?checkin=2027-06-10"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional().describe("Raw request body, usually JSON"),
  },
  async ({ method, url, headers, body }) => {
    if (state.serverIssue) return text(stopForServerIssue(""), true);
    const host = new URL(url).host;
    if (host !== env().host) return text(`Refused: only ${env().host} (the ${env().label} environment) may be probed.`, true);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    } catch (e: any) {
      const health = await checkServerHealth();
      if (health) return text(stopForServerIssue(`${health.split("\n").slice(1).join(" ")} Probe ${method} ${url} also failed: ${e.cause?.code ?? e.message}`), true);
      return text(`No response: ${e.cause?.code ?? e.message}. The health check still passes, so the server is up; this endpoint did not answer.`, true);
    }
    const resBody = await res.text();
    console.log(`[probe] ${method} ${url} -> ${res.status}`);
    if (res.status >= 500) {
      const health = await checkServerHealth();
      if (health) return text(stopForServerIssue(`${health.split("\n").slice(1).join(" ")} Probe ${method} ${url} answered ${res.status}.`), true);
    }
    // Remember bookings the debugger creates, so cleanupProbes() can delete them even if it forgets.
    if (method === "POST" && new URL(url).pathname === "/booking" && res.ok) {
      try {
        const id = JSON.parse(resBody).bookingid;
        if (typeof id === "number") state.probeBookings.push(id);
      } catch {}
    }
    return text(JSON.stringify({
      status: res.status, content_type: res.headers.get("content-type"), body: resBody.slice(0, 1500),
      ...(res.status >= 500 && { note: "Server error, but the health check passes: the server is up and this endpoint failed. Find out whether this input should be valid." }),
    }, null, 2));
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
    emit("diagnosis", d);
    let saved = "";
    // QA_NO_LEARNING=1 (used by the model exam) keeps findings out of the knowledge base.
    if (lesson && d.confidence === "high" && d.category !== "flaky" && process.env.QA_NO_LEARNING !== "1") {
      const title = `${d.category === "api_bug" ? "Known API bug" : "Test pitfall"}: ${lesson}`;
      const body = `${d.evidence}${d.fix_hint ? `\nFix: ${d.fix_hint}` : ""}\nFound ${new Date().toISOString().slice(0, 10)} in "${d.request}" (${env().label}).`;
      const file = "knowledge/known-issues.md";
      if (!existsSync(file)) writeFileSync(file, "# Known issues found by the debugger\n");
      appendFileSync(file, `\n## ${title}\n${body}\n`);
      addChunk({ id: `known-issues.md:${title}`, source: "known-issues.md", title, text: body });
      saved = " Saved to the knowledge base.";
      console.log(`[learned] ${title}`);
      emit("learned", { title });
    }
    if (lesson && !saved)
      saved = process.env.QA_NO_LEARNING === "1" ? " The lesson was NOT saved: learning is switched off for this run."
        : " The lesson was NOT saved: only high-confidence api_bug or test_defect findings are saved.";
    return text(`Recorded.${saved}`);
  },
);

// Deletes every booking the debugger created with send_request. Call when the run ends.
// (Specific to Restful-Booker: log in for a token, then DELETE each booking.)
export async function cleanupProbes() {
  if (!state.probeBookings.length) return;
  const base = env().baseUrl;
  try {
    const auth = await fetch(`${base}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: process.env.QA_API_USER ?? "admin", password: process.env.QA_API_PASSWORD ?? "password123" }),
    }).then((r) => r.json());
    for (const id of state.probeBookings.splice(0)) {
      const res = await fetch(`${base}/booking/${id}`, { method: "DELETE", headers: { Cookie: `token=${auth.token}` } });
      console.log(`[cleanup] deleted probe booking ${id}: ${res.status}`);
    }
  } catch (e: any) {
    throw new Error(`could not delete probe bookings ${state.probeBookings.join(", ")}: ${e.message}`);
  }
}

// ---- Self-healer ----
export const patchRequest = tool(
  "patch_request",
  "Change one part of one request in the working collection. Only allowed for requests diagnosed as test_defect. Changes to assertion lines, the URL or the method are shown to a human for approval first. A change is only kept if the next run shows its request passing and nothing else newly failing; otherwise it is undone automatically.",
  {
    request_name: z.string(),
    part: z.enum(["url", "method", "headers", "body", "test_script", "prerequest_script"]),
    new_value: z.string().describe("The complete new value. headers: a JSON array of {key, value}. Scripts: the full script source."),
    reason: z.string().describe("Which diagnosis this fixes and why the change is right"),
  },
  async ({ request_name, part, new_value, reason }) => {
    if (breakerTripped()) return text(BREAKER_REFUSAL, true);
    const r = findRequest(request_name);
    if (!r) return text(`No request named "${request_name}".`, true);
    const mine = state.diagnoses.filter((d) => d.request === request_name);
    if (mine.some((d) => d.category === "api_bug"))
      return text("Refused: this request has a failure diagnosed as an API bug. Tests that expose API bugs must not be changed.", true);
    if (!mine.some((d) => d.category === "test_defect"))
      return text("Refused: this request has no failure diagnosed as a test defect. Ask the debugger first.", true);
    const { healsPerRun, attemptsPerRequest } = config.limits;
    if (!state.changedRequests.has(r) && state.changedRequests.size >= healsPerRun)
      return text(`Refused: the limit of ${healsPerRun} changed requests per run has been reached. Leave the rest for the report.`, true);
    const attempts = state.attempts.get(request_name) ?? 0;
    if (attempts >= attemptsPerRequest)
      return text(`Refused: ${attemptsPerRequest} attempts on this request already. Leave it for the report.`, true);

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

    const kind = part === "url" || part === "method" ? `${part} change` : part === "test_script" && changes.some((l) => ASSERTION.test(l)) ? "assertion change" : null;
    if (kind) {
      console.log(`\n========== ${kind.toUpperCase()} NEEDS APPROVAL ==========\nRequest: ${request_name}\nReason: ${reason}\n${changes.join("\n")}\n=====================================================`);
      const answer = await askHuman(`Apply this ${kind}? Type y to apply, anything else to refuse: `, { kind, request: request_name, reason, diff: changes });
      if (!answer || !/^(y|yes)$/i.test(answer))
        return text(`Refused by the human${answer ? `: ${answer}` : " (no answer)"}. Leave this failure for the report.`, true);
    }

    state.attempts.set(request_name, attempts + 1);
    if (!state.pending.length) state.baselinePassing = new Set(state.lastRun?.passing ?? []);
    if (!state.pending.some((p) => p.item === r))
      state.pending.push({ item: r, before: structuredClone(r), record: `${request_name} (${part}${kind ? ", approved by human" : ""}): ${reason}\n${changes.map((l) => `    ${l}`).join("\n")}` });

    if (part === "test_script") setScript(r, "test", after);
    else if (part === "prerequest_script") setScript(r, "prerequest", after);
    else if (part === "headers") r.request.header = JSON.parse(after);
    else if (part === "body") r.request.body = { ...(r.request.body ?? { mode: "raw", options: { raw: { language: "json" } } }), raw: after };
    else r.request[part] = after;
    state.dirty = true;
    state.changedRequests.add(r);
    console.log(`[changed] ${request_name} (${part}): ${reason}\n${changes.map((l) => `    ${l}`).join("\n")}`);
    emit("change_pending", { request: request_name, part, reason, diff: changes, approved_by_human: !!kind });
    return text(`Applied, pending proof: the next run must show "${request_name}" passing with nothing else newly failing, or it is undone.\n${changes.join("\n")}`);
  },
);

// ---- Orchestrator ----
export const requestApproval = tool(
  "request_approval",
  "Show a test plan to the human and wait for their decision. Returns APPROVED, or REJECTED with their feedback.",
  { plan_summary: z.string().describe("The plan, written for a person to read: one line per test case") },
  async ({ plan_summary }) => {
    console.log(`\n================ PLAN FOR REVIEW ================\n${plan_summary}\n=================================================`);
    const answer = await askHuman("Approve this plan? Type y to approve, or type what to change: ", { kind: "plan", plan: plan_summary });
    if (answer === null) return text("REJECTED: nobody answered, so nothing will be built.");
    state.approved = /^(y|yes)$/i.test(answer);
    return text(state.approved ? "APPROVED" : `REJECTED. Feedback from the human: ${answer}`);
  },
);

// Contract runs: the human reviews the test cases and may edit them (keep, change, remove, add).
export const requestCaseReview = tool(
  "request_case_review",
  "Show the contract test cases to the human and wait. Returns APPROVED with the exact plan to build (possibly edited by the human), or REJECTED with their feedback.",
  { plan_json: z.string().describe("The analyst's plan, as JSON") },
  async ({ plan_json }) => {
    let plan: PlanT;
    try {
      plan = parsePlan(plan_json);
    } catch (e: any) {
      return text(`${e.message} Ask the analyst for a corrected plan.`, true);
    }
    state.reviewRounds++;
    console.log(`\n========== TEST CASES FOR REVIEW (${plan.cases.length}) ==========\n${plan.cases.map((c) => `${c.id} [${c.type}] ${c.endpoint ?? ""} ${c.title} -> ${c.expected}`).join("\n")}\n=================================================`);
    const answer = await askHuman("Approve these test cases? Type y to approve, the edited plan as JSON, or what to change: ", { kind: "test_cases", plan });
    if (answer === null) return text("REJECTED: nobody answered, so nothing will be built.");
    if (/^(y|yes)$/i.test(answer)) {
      state.contractPlan = plan;
    } else if (answer.trim().startsWith("{")) {
      try {
        state.contractPlan = parsePlan(answer);
      } catch (e: any) {
        return text(`REJECTED: the edited cases couldn't be read (${e.message}). Show the same plan again.`);
      }
      emit("cases_edited", { cases: state.contractPlan.cases.length });
    } else {
      return text(`REJECTED. Feedback from the human: ${answer}`);
    }
    state.approved = true;
    emit("cases_approved", { cases: state.contractPlan.cases.length, edited: !/^(y|yes)$/i.test(answer) });
    return text(`APPROVED. Give the builder exactly this plan (it is what the human approved${/^(y|yes)$/i.test(answer) ? "" : ", with their edits"}):\n${JSON.stringify(state.contractPlan)}`);
  },
);

export const runStatus = tool(
  "run_status",
  "Summarise the working collection's state: the circuit breaker, the last run's failures split into known-bug repeats (no investigation needed) and failures that need diagnosis, known bugs that now pass, diagnoses so far, changes made by the healer, and whether it can be published.",
  {},
  async () => {
    if (state.serverIssue) return text(stopForServerIssue(""), true);
    const { requests, assertions, failures } = state.lastRun ?? { requests: 0, assertions: 0, failures: [] };
    const cb = triage().circuit_breaker;
    if (cb.tripped && !breakerAnnounced) {
      breakerAnnounced = true;
      emit("circuit_breaker", { requests_needing_diagnosis: cb.requests_needing_diagnosis, trips_at: cb.trips_at });
    }
    return text(JSON.stringify({ environment: env().label, last_run: { requests, assertions, failed: failures.length }, ...triage(), diagnoses: state.diagnoses, changes: state.heals, unproven_changes: state.pending.length, changed_since_last_run: state.dirty, can_publish: canShip() ?? "yes" }, null, 2));
  },
);

export const markKnownBugs = tool(
  "mark_known_bugs",
  `Rename every request with a failure diagnosed as an API bug to start with "${KNOWN_BUG_PREFIX}", and add the evidence to its description. Its assertions are kept as they are.`,
  {},
  async () => {
    if (breakerTripped()) return text(BREAKER_REFUSAL, true);
    const bugDiagnoses = state.diagnoses.filter((d) => d.category === "api_bug");
    // Requests already marked that now fail a different assertion: add that evidence, so later runs
    // recognise it as a known-bug repeat instead of investigating it again.
    const extended: string[] = [];
    for (const d of bugDiagnoses) {
      const r = findRequest(d.request);
      if (!r?.name.startsWith(KNOWN_BUG_PREFIX) || (r.request.description ?? "").includes(`- ${d.assertion}:`)) continue;
      r.request.description = `${r.request.description ?? ""}\n- ${d.assertion}: ${d.evidence}`;
      extended.push(`${r.name} (${d.assertion})`);
    }
    if (extended.length) state.dirty = true;
    const buggy = [...new Set(bugDiagnoses.map((d) => d.request))]
      .map((name) => findRequest(name))
      .filter((r) => r && !r.name.startsWith(KNOWN_BUG_PREFIX));
    if (!buggy.length)
      return text(extended.length
        ? `No new requests to mark. Added new evidence to:\n${extended.join("\n")}\nRun the collection again before saving.`
        : "Nothing to mark: every API bug was already marked. No need to run again.");
    const limit = config.limits.newKnownBugsPerRun;
    if (buggy.length > limit) {
      console.log(`\n========== ${buggy.length} NEW KNOWN BUGS (limit ${limit}) ==========\n${buggy.map((r) => r.name).join("\n")}`);
      const answer = await askHuman(`Mark all ${buggy.length} as KNOWN BUG? Type y to mark, anything else to refuse: `, { kind: "known_bugs_over_limit", requests: buggy.map((r) => r.name) });
      if (!answer || !/^(y|yes)$/i.test(answer))
        return text(`Refused: ${buggy.length} new known bugs is over the limit of ${limit} per run, and a human did not approve. Nothing was marked.`, true);
    }
    const marked: string[] = [];
    for (const r of buggy) {
      const name = r.name;
      const evidence = state.diagnoses.filter((d) => d.request === name && d.category === "api_bug").map((d) => `- ${d.assertion}: ${d.evidence}`).join("\n");
      r.name = KNOWN_BUG_PREFIX + name;
      r.request.description = `${r.request.description ?? ""}\n\nThis request currently fails because of an API bug:\n${evidence}`.trim();
      for (const d of state.diagnoses) if (d.request === name) d.request = r.name;
      marked.push(r.name);
    }
    state.dirty = true;
    emit("known_bugs_marked", { requests: marked });
    return text(`Marked:\n${marked.join("\n")}\nRun the collection again before publishing.`);
  },
);

export const loadPublishedCollection = tool(
  "load_published_collection",
  "Download a published collection from Postman and make it the working collection. Does not run it.",
  { collection_uid: z.string() },
  async ({ collection_uid }) => {
    const data = await postman(`/collections/${encodeURIComponent(collection_uid)}`);
    if (state.collection && state.lastRun) state.finished.push(collectionSummary());
    emit("collection_loaded", { uid: collection_uid, name: data.collection.info.name });
    Object.assign(state, {
      outcome: {},
      collection: data.collection, source: { uid: collection_uid }, loadedSnapshot: JSON.stringify(data.collection),
      lastRun: null, dirty: false, diagnoses: [], heals: [], pending: [], changedRequests: new Set(), attempts: new Map(),
    });
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
    if (process.env.QA_DRY_RUN === "1") return text("Refused: this is a dry run (QA_DRY_RUN=1), so nothing is written to Postman.", true);
    if (!state.approved) return text("Refused: no human has approved a plan.", true);
    const blocked = canShip();
    if (blocked) return text(`Refused: ${blocked}.`, true);
    const data = await postman(`/collections?workspace=${encodeURIComponent(workspace_id)}`, { method: "POST", body: JSON.stringify({ collection: state.collection }) });
    state.outcome.published = { uid: data.collection.uid, name: data.collection.name };
    emit("published", state.outcome.published);
    return text(JSON.stringify(data.collection));
  },
);

export const updatePublishedCollection = tool(
  "postman_update_collection",
  "Save the working collection back over the published collection it was loaded from. Refuses unless every failure in the latest run is a marked known API bug.",
  {},
  async () => {
    if (process.env.QA_DRY_RUN === "1") return text("Refused: this is a dry run (QA_DRY_RUN=1), so nothing is written to Postman.", true);
    if (!state.source) return text("Refused: the working collection was not loaded from Postman.", true);
    if (JSON.stringify(state.collection) === state.loadedSnapshot) return text("Nothing changed since it was downloaded, so nothing was saved.");
    const blocked = canShip();
    if (blocked) return text(`Refused: ${blocked}.`, true);
    await postman(`/collections/${encodeURIComponent(state.source.uid)}`, { method: "PUT", body: JSON.stringify({ collection: state.collection }) });
    state.outcome.updated = state.source.uid;
    emit("updated", { uid: state.source.uid });
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
      ? [searchKnowledge, runCollection, rerunCollection, getRunDetails, getRequest, sendRequest, recordDiagnosis, patchRequest,
         requestApproval, runStatus, markKnownBugs, loadPublishedCollection, listCollections, publishCollection, updatePublishedCollection,
         ...(currentContract() ? [...contractTools, requestCaseReview] : [])]
      : [searchKnowledge, runCollection, listCollections, publishPassingCollection],
  });

// ---- Printing what the agents do ----
// Messages from a subagent carry parent_tool_use_id: the id of the Agent call that started it.
const agentNames = new Map<string, string>();
let totalCost = 0;
let lastReport = "";
export const costSoFar = () => totalCost;

// What one collection ended up as: for the result file and the dashboard.
function collectionSummary() {
  const t = triage();
  return {
    name: state.collection?.info?.name,
    uid: state.source?.uid ?? state.outcome.published?.uid ?? null,
    requests: state.lastRun?.requests ?? 0,
    assertions: state.lastRun?.assertions ?? 0,
    failed_assertions: state.lastRun?.failures.length ?? 0,
    failures: state.lastRun?.failures ?? [],
    known_bugs: requestsOf(state.collection?.item).filter((r) => r.name.startsWith(KNOWN_BUG_PREFIX)).map((r) => r.name),
    known_bugs_now_passing: t.known_bugs_now_passing,
    circuit_breaker_tripped: state.lastRun ? t.circuit_breaker.tripped : false,
    diagnoses: state.diagnoses,
    changes: state.heals,
    published: state.outcome.published ?? null,
    updated: state.outcome.updated ?? null,
  };
}

// Everything a run produced. orchestrator.ts writes it to QA_RESULT_FILE when the run ends.
export function runResults() {
  return {
    environment: { name: env().name, label: env().label, base_url: env().baseUrl },
    collections: [...state.finished, ...(state.collection && state.lastRun ? [collectionSummary()] : [])],
    server_issue: state.serverIssue,
    // Contract runs: the approved cases and the collection, which the dashboard publishes where the person chooses.
    ...(currentContract() && {
      contract: {
        name: currentContract()!.name,
        plan: state.contractPlan,
        review_rounds: state.reviewRounds,
        collection: state.collection,
      },
    }),
    cost_usd: Number(totalCost.toFixed(4)),
    report: lastReport,
  };
}
export function printMessage(msg: SDKMessage, mainName = "agent") {
  const who = (id: string | null | undefined) => (id ? agentNames.get(id) ?? "subagent" : mainName);
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`\n[${who(msg.parent_tool_use_id)}] ${block.text.trim()}`);
        emit("agent_message", { agent: who(msg.parent_tool_use_id), text: block.text.trim() });
        if (!msg.parent_tool_use_id) lastReport = block.text.trim(); // the main agent's last words are its report
      }
      if (block.type === "tool_use") {
        const input: any = block.input;
        if (block.name === "Agent") agentNames.set(block.id, input.subagent_type ?? "subagent");
        const target = block.name === "Agent" ? input.subagent_type : block.name.replace("mcp__qa__", "");
        console.log(`\n[${who(msg.parent_tool_use_id)} -> ${target}] ${JSON.stringify(input).slice(0, 160)}…`);
        emit(block.name === "Agent" ? "agent_started" : "tool_call", { agent: who(msg.parent_tool_use_id), target, input: JSON.stringify(input).slice(0, 500) });
      }
    }
  } else if (msg.type === "result") {
    totalCost += msg.total_cost_usd ?? 0;
    console.log(`\n[done] ${msg.subtype}, ${msg.num_turns} turns, ${msg.total_cost_usd?.toFixed(3)}`);
    emit("agent_run_finished", { agent: mainName, subtype: msg.subtype, turns: msg.num_turns, cost_usd: msg.total_cost_usd });
  }
}
