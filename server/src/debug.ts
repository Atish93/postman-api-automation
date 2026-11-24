// Debugging a failed run: one summary per failure (for the run page), the full debug view of one
// failure (for the debug page), and the contract gaps found by a contract run.
// The agent writes a debug bundle per failure into the result file (agent/tools.ts debugIssues());
// runs recorded before that only have failures and diagnoses, so their issues are rebuilt from those.
// Plain runs (Newman, no AI) get the same from their executions. What the debugger found when a person
// asked it again (issue_actions, kind "debug") is laid over the run's own findings.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import type { DB } from "./db.ts";
import { agentDir, specOf } from "./runs/ai.ts";

const KNOWN_BUG = "KNOWN BUG - ";
export const baseName = (request: string) => request.replace(KNOWN_BUG, "");
export const caseIdOf = (request: string) => baseName(request).match(/^(TC\d{2,3})\b/)?.[1] ?? null;

// ---- Categories, in the order the run page lists them ----
export type Category = "unexplained" | "api_bug" | "known_bug" | "test_defect" | "fixed" | "flaky";
const ORDER: Category[] = ["unexplained", "api_bug", "known_bug", "test_defect", "flaky", "fixed"];

function categoryOf(request: string, diagnoses: any[], passingNow: boolean): Category {
  const mine = diagnoses.filter((d) => d.request === request);
  if (request.startsWith(KNOWN_BUG) && !mine.some((d) => d.category === "test_defect")) return "known_bug";
  if (mine.some((d) => d.category === "api_bug")) return "api_bug";
  if (mine.some((d) => d.category === "test_defect")) return passingNow ? "fixed" : "test_defect";
  if (mine.some((d) => d.category === "flaky")) return "flaky";
  return "unexplained";
}

// ---- The run's collections, as the debug views need them ----
// A plain run is one collection: its failing requests (first failing row, with a data file) are its issues.
export function collectionsOf(result: any): any[] {
  if (Array.isArray(result?.collections)) return result.collections;
  if (!Array.isArray(result?.executions)) return [];
  const failing = new Map<string, any>();
  for (const e of result.executions) {
    const bad = e.error || (e.status ?? 0) >= 500 || (e.assertions ?? []).some((a: any) => a.error);
    if (bad && !failing.has(e.request)) failing.set(e.request, e);
  }
  const rows = (name: string) => result.executions.filter((e: any) => e.request === name && typeof e.iteration === "number" &&
    (e.error || (e.status ?? 0) >= 500 || (e.assertions ?? []).some((a: any) => a.error))).map((e: any) => e.iteration);
  const failures = [...failing.values()].flatMap((e) => {
    const failed = (e.assertions ?? []).filter((a: any) => a.error).map((a: any) => ({ request: e.request, assertion: a.name, error: a.error }));
    return failed.length ? failed : [{ request: e.request, assertion: "Server responded without error", error: e.error ?? `status ${e.status}` }];
  });
  return [{
    name: "Collection", plain: true, failures, diagnoses: [],
    executions: result.executions.map((e: any) => ({ request: e.request, case_id: caseIdOf(e.request), method: e.method, status: e.status, error: e.error,
      passed: (e.assertions ?? []).filter((a: any) => !a.error).length, failed: (e.assertions ?? []).filter((a: any) => a.error).length })),
    issues: [...failing.values()].map((e) => ({
      request: e.request, case_id: caseIdOf(e.request), state: "failing", rows: rows(e.request),
      exchange: { method: e.method, url: e.url, status: e.status ?? undefined, response_time_ms: e.response_time_ms ?? undefined, error: e.error ?? undefined,
        body: e.body ?? "", at: result.started_at ?? null, assertions: (e.assertions ?? []).map((a: any) => ({ name: a.name, error: a.error ?? undefined })),
        request_headers: [], request_body: "", response_headers: [] },
      failed_assertions: failures.filter((f) => f.request === e.request).map((f) => ({ assertion: f.assertion, error: f.error })),
      test_script: "", prerequest_script: "", probes: [], diagnoses: [], changes: [],
    })),
  }];
}

// A collection's issues as stored by the agent, or rebuilt from failures and diagnoses for older runs.
function storedIssues(c: any): any[] {
  if (Array.isArray(c.issues)) return c.issues;
  const byRequest = new Map<string, any[]>();
  for (const f of c.failures ?? []) byRequest.set(f.request, [...(byRequest.get(f.request) ?? []), f]);
  return [...byRequest].map(([request, failures]) => ({
    request, case_id: caseIdOf(request), state: "failing", exchange: null,
    failed_assertions: failures.map((f) => ({ assertion: f.assertion, error: f.error })),
    test_script: "", prerequest_script: "", probes: [],
    diagnoses: (c.diagnoses ?? []).filter((d: any) => d.request === request), changes: [],
  }));
}

// What the debugger found when asked again, per failure: newer probes are added, newer diagnoses replace older ones.
export type Overlay = Map<string, { probes: any[]; diagnoses: any[] }>;
const key = (collection: number, request: string) => `${collection}:${baseName(request)}`;
export function debugOverlay(db: DB, runId: number): Overlay {
  const m: Overlay = new Map();
  const rows = db.prepare("SELECT collection, request, output_json FROM issue_actions WHERE run_id = ? AND kind = 'debug' AND status = 'done' ORDER BY id").all(runId) as any[];
  for (const r of rows) {
    const out = r.output_json ? JSON.parse(r.output_json) : null;
    if (!out?.issue) continue;
    const k = key(r.collection, r.request), was = m.get(k) ?? { probes: [], diagnoses: [] };
    const fresh = out.issue.diagnoses ?? [];
    m.set(k, { probes: [...was.probes, ...(out.issue.probes ?? [])], diagnoses: fresh.length ? fresh : was.diagnoses });
  }
  return m;
}

// Every issue of every collection, with the overlay applied.
function allIssues(result: any, overlay: Overlay) {
  return collectionsOf(result).flatMap((c, collection) => storedIssues(c).map((i) => {
    const o = overlay.get(key(collection, i.request));
    const ownDiagnoses = i.diagnoses?.length ? i.diagnoses : (c.diagnoses ?? []).filter((d: any) => d.request === i.request);
    // The debugger records diagnoses under the request's name at that time; match them by base name.
    const later = (o?.diagnoses ?? []).map((d: any) => ({ ...d, request: i.request }));
    const diagnoses = later.length ? [...ownDiagnoses.filter((d: any) => !later.some((x: any) => x.assertion === d.assertion)), ...later] : ownDiagnoses;
    return { collection, c, issue: { ...i, probes: [...(i.probes ?? []), ...(o?.probes ?? [])], diagnoses } };
  }));
}

// One line per failure, for the run page and the debug page's previous/next.
export function issueSummaries(result: any, overlay: Overlay = new Map()) {
  return allIssues(result, overlay).map(({ collection, issue: i }) => {
    const category = categoryOf(i.request, i.diagnoses, i.state === "passing_now");
    const d = i.diagnoses.find((x: any) => x.category === "api_bug") ?? i.diagnoses[0];
    return {
      collection, request: i.request, case_id: i.case_id ?? caseIdOf(i.request), category, state: i.state,
      confidence: d?.confidence ?? null,
      summary: d?.evidence ?? i.failed_assertions?.map((a: any) => `${a.assertion}: ${a.error}`).join("; ") ?? "",
      status: i.exchange?.status ?? null,
    };
  }).sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
}

// The run's result as the run page needs it: the heavy debug bundles and collection copies replaced by one
// summary line per failure.
export function lightResult(result: any, overlay: Overlay = new Map()) {
  if (!result) return result;
  if (!result.collections) return Array.isArray(result.executions) ? { ...result, issues: issueSummaries(result, overlay) } : result;
  return {
    ...result,
    collections: result.collections.map(({ issues: _issues, collection: _collection, ...c }: any) => c),
    issues: issueSummaries(result, overlay),
  };
}

// The collection a run ended with: kept with the result (contract runs, and AI runs from now on), or the
// dashboard's copy of the collection it ran (plain runs, and older AI runs).
export function runCollection(db: DB, run: any, result: any, collection: number) {
  const kept = result?.collections?.[collection]?.collection ?? (collection === 0 ? result?.contract?.collection : null);
  if (kept?.item) return { collection: kept, source_uid: null as string | null, stored: "result" as const };
  const row = run.collection_id ? db.prepare("SELECT json, postman_uid FROM collections WHERE id = ?").get(run.collection_id) as any : null;
  return row ? { collection: JSON.parse(row.json), source_uid: row.postman_uid as string | null, stored: "dashboard" as const } : null;
}

// ---- The debug page ----
export function issueDetail(db: DB, run: any, collection: number, request: string) {
  const result = run.result_json ? JSON.parse(run.result_json) : null;
  const overlay = debugOverlay(db, run.id);
  const issues = allIssues(result, overlay);
  const found = issues.find((x) => x.collection === collection && x.issue.request === request)
    // After "Mark as known bug" the request has a new name; an old link still finds it.
    ?? issues.find((x) => x.collection === collection && baseName(x.issue.request) === baseName(request));
  if (!found) return null;
  const issue = found.issue;
  const all = issueSummaries(result, overlay);
  const at = all.findIndex((i) => i.collection === collection && i.request === issue.request);
  const neighbour = (k: number) => (all[k] ? { collection: all[k].collection, request: all[k].request, case_id: all[k].case_id } : null);
  const summary = all[at];
  const exchange = issue.exchange;
  const endpoint = run.contract_id && exchange ? contractEndpointFor(db, run.contract_id, exchange.method, exchange.url) : null;
  return {
    run: { id: run.id, kind: run.kind, ai_mode: run.ai_mode ?? null, status: run.status, collection_name: run.collection_name, environment_label: run.environment_label,
      contract_id: run.contract_id ?? null, created_at: run.created_at, plain: !!found.c.plain },
    issue: { ...issue, category: summary.category, confidence: summary.confidence },
    position: { index: at, total: all.length, previous: neighbour(at - 1), next: neighbour(at + 1) },
    history: historyOf(db, run, issue.request),
    logs: logsOf(db, run.id, issue.request),
    contract: endpoint,
    gaps: endpoint && result?.contract?.plan ? gapsOf(result.contract.plan, contractEndpoints(db, run.contract_id)).filter((g) => g.endpoints.includes(endpoint.key)) : [],
    knowledge: knowledgeFor(exchange?.url, endpoint?.path),
    actions: actionsOf(db, run.id, collection, issue.request),
    // What can be done from the page, and why not when it can't.
    can: {
      resend: exchange ? null : "This run was recorded before request details were kept.",
      debug: runCollection(db, run, result, collection) ? null : "The collection this run used is no longer here.",
      known_bug: summary.category === "known_bug" ? "It's already a known bug." : summary.state === "passing_now" ? "It passes now." : null,
      fix: summary.state === "passing_now" ? "It passes now." : runCollection(db, run, result, collection) ? null : "The collection this run used is no longer here.",
    },
  };
}

// Actions people took on this failure, newest first.
export function actionsOf(db: DB, runId: number, collection: number, request: string) {
  const name = baseName(request);
  return (db.prepare("SELECT * FROM issue_actions WHERE run_id = ? AND collection = ? ORDER BY id DESC").all(runId, collection) as any[])
    .filter((a) => baseName(a.request) === name)
    .map((a) => ({
      id: a.id, kind: a.kind, status: a.status, message: a.message, cost_usd: a.cost_usd, child_run_id: a.child_run_id,
      created_at: a.created_at, finished_at: a.finished_at,
      input: a.input_json ? JSON.parse(a.input_json) : null,
      // The debugger's whole bundle is already merged into the page; keep its conclusion only.
      output: (() => { const o = a.output_json ? JSON.parse(a.output_json) : null; if (!o) return null; const { issue: _i, ...rest } = o; return rest; })(),
    }));
}

// This request's result in this run and up to 9 earlier runs of the same collection (or contract).
function historyOf(db: DB, run: any, request: string) {
  const where = run.contract_id ? "contract_id = ?" : run.collection_id ? "collection_id = ?" : "collection_name = ?";
  const k = run.contract_id ?? run.collection_id ?? run.collection_name;
  const rows = db.prepare(`SELECT id, status, created_at, result_json FROM runs WHERE ${where} AND id <= ? AND result_json IS NOT NULL ORDER BY id DESC LIMIT 10`).all(k, run.id) as any[];
  const name = baseName(request), id = caseIdOf(request);
  const same = (n: string) => baseName(n) === name || (!!id && caseIdOf(n) === id);
  return rows.reverse().map((r) => {
    const cols = collectionsOf(JSON.parse(r.result_json));
    const execution = cols.flatMap((c) => c.executions ?? []).find((e: any) => same(e.request));
    const failedThere = cols.some((c) => (c.failures ?? []).some((f: any) => same(f.request)));
    const outcome = failedThere ? "failed" : execution ? (execution.failed || execution.error ? "failed" : "passed") : cols.some((c) => c.executions) ? "not_run" : "unknown";
    return { run_id: r.id, at: r.created_at, outcome };
  });
}

// Events and log lines that mention this request.
function logsOf(db: DB, runId: number, request: string) {
  const name = baseName(request);
  const rows = db.prepare("SELECT seq, type, data_json, created_at FROM run_events WHERE run_id = ? ORDER BY seq").all(runId) as any[];
  return rows.filter((e) => e.data_json.includes(JSON.stringify(name).slice(1, -1)))
    .slice(-400)
    .map((e) => ({ seq: e.seq, type: e.type, data: JSON.parse(e.data_json), created_at: e.created_at }));
}

// ---- The contract ----
type Ep = { key: string; method: string; path: string; summary?: string | null; responses?: string[]; secured?: boolean };
const contractEndpoints = (db: DB, id: number): Ep[] => {
  const c = db.prepare("SELECT endpoints FROM contracts WHERE id = ?").get(id) as any;
  return c ? JSON.parse(c.endpoints) : [];
};

// The contract endpoint a request URL belongs to (the most specific template that matches its path),
// with the contract's text for it.
function contractEndpointFor(db: DB, contractId: number, method: string, url: string) {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return null; }
  const eps = contractEndpoints(db, contractId).filter((e) => e.method === String(method).toUpperCase());
  const score = (p: string) => p.split("/").filter((s) => s && !s.startsWith("{")).length;
  const match = eps
    .filter((e) => new RegExp(`${e.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}/?$`).test(pathname))
    .sort((a, b) => score(b.path) - score(a.path))[0];
  if (!match) return null;
  const c = db.prepare("SELECT * FROM contracts WHERE id = ?").get(contractId) as any;
  let excerpt: string | null = null;
  if (c?.format === "openapi") {
    try {
      const op = specOf(c)?.paths?.[match.path]?.[match.method.toLowerCase()];
      if (op) {
        const { summary, parameters, requestBody, responses, security } = op;
        excerpt = toYaml({ [`${match.method} ${match.path}`]: { summary, parameters, requestBody, responses, security } }).slice(0, 4000);
      }
    } catch { /* the excerpt is a nicety */ }
  }
  return { contract_id: contractId, key: match.key, method: match.method, path: match.path, summary: match.summary ?? null, responses: match.responses ?? [], secured: !!match.secured, excerpt };
}

// Contract gaps: plain sentences (older plans) or objects naming their endpoints. Each gets a stable key,
// so a person's "this is intended" sticks to it across runs.
export type Gap = { key: string; text: string; endpoints: string[]; not_tested: string | null; contract_now: string | null; suggestion: string | null };
export const gapKey = (text: string) => createHash("sha1").update(text.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 12);

export function gapsOf(plan: any, endpoints: Ep[]): Gap[] {
  const keys = new Set(endpoints.map((e) => e.key));
  return (plan?.gaps ?? []).map((g: any) => {
    const o = typeof g === "string" ? { text: g } : g ?? {};
    const text = String(o.text ?? "").trim();
    let found: string[] = Array.isArray(o.endpoints) ? o.endpoints.map(String) : [];
    if (!found.length) {
      // "GET /pet/{petId}" and "GET/DELETE /store/order/{orderId}" in the sentence
      for (const m of text.matchAll(/\b((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*)\s+(\/[\w\-./{}]*[\w}])/g))
        for (const method of m[1].split("/")) found.push(`${method} ${m[2]}`);
      // a bare path: every method on it
      if (!found.length) for (const e of endpoints) if (new RegExp(`(^|[\\s'"(])${e.path.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")}(?=$|[\\s'",.;:)])`).test(text)) found.push(e.key);
    }
    found = [...new Set(found)].filter((k) => !keys.size || keys.has(k));
    return { key: gapKey(text), text, endpoints: found, not_tested: o.not_tested ?? null, contract_now: o.contract_now ?? null, suggestion: o.suggestion ?? null };
  }).filter((g: Gap) => g.text);
}

// The contract's gaps from one run (or its latest contract run), with the person's decisions.
export function contractGaps(db: DB, contractId: number, runId?: number) {
  const run = (runId
    ? db.prepare("SELECT id, status, created_at, result_json FROM runs WHERE id = ? AND contract_id = ?").get(runId, contractId)
    : db.prepare("SELECT id, status, created_at, result_json FROM runs WHERE contract_id = ? AND result_json IS NOT NULL ORDER BY id DESC LIMIT 1").get(contractId)) as any;
  const c = db.prepare("SELECT gap_decisions FROM contracts WHERE id = ?").get(contractId) as any;
  const decisions: Record<string, { intended: boolean; at: string }> = c?.gap_decisions ? JSON.parse(c.gap_decisions) : {};
  const plan = run?.result_json ? JSON.parse(run.result_json)?.contract?.plan : null;
  const gaps = plan ? gapsOf(plan, contractEndpoints(db, contractId)) : [];
  return {
    run: run ? { id: run.id, status: run.status, created_at: run.created_at } : null,
    gaps: gaps.map((g) => ({ ...g, intended: !!decisions[g.key]?.intended })),
  };
}

// ---- The knowledge base: sections of known-issues.md that mention the endpoint ----
function knowledgeFor(url?: string, templatePath?: string) {
  const file = join(agentDir(), "knowledge", "known-issues.md");
  if (!existsSync(file)) return [];
  let pathname = "";
  try { pathname = url ? new URL(url).pathname : ""; } catch { /* no URL */ }
  const needles = [templatePath, pathname.replace(/\/\d+(?=\/|$)/g, "/")].filter((s): s is string => !!s && s.length > 2);
  if (!needles.length) return [];
  return readFileSync(file, "utf8").split(/\n(?=## )/).slice(1)
    .filter((s) => needles.some((n) => s.includes(n)))
    .slice(-3)
    .map((s) => {
      const [title, ...body] = s.replace(/^## /, "").split("\n");
      return { title: title.trim(), text: body.join("\n").trim().slice(0, 1200) };
    });
}
