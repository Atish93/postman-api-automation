// Debugging a failed run: one summary per failure (for the run page), the full debug view of one
// failure (for the debug page), and the contract gaps found by a contract run.
// The agent writes a debug bundle per failure into the result file (agent/tools.ts debugIssues());
// runs recorded before that only have failures and diagnoses, so their issues are rebuilt from those.
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
  if (mine.some((d) => d.category === "api_bug")) return "api_bug";
  if (mine.some((d) => d.category === "test_defect")) return passingNow ? "fixed" : "test_defect";
  if (mine.some((d) => d.category === "flaky")) return "flaky";
  if (request.startsWith(KNOWN_BUG)) return "known_bug"; // a recorded known bug failing the same way again
  return "unexplained";
}

// A collection's issues as stored by the agent, or rebuilt from failures and diagnoses for older runs.
function issuesOf(c: any): any[] {
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

// One line per failure, for the run page and the debug page's previous/next.
export function issueSummaries(result: any) {
  const out: any[] = [];
  (result?.collections ?? []).forEach((c: any, collection: number) => {
    for (const i of issuesOf(c)) {
      const category = categoryOf(i.request, c.diagnoses ?? [], i.state === "passing_now");
      const d = (i.diagnoses ?? [])[0] ?? (c.diagnoses ?? []).find((x: any) => x.request === i.request);
      out.push({
        collection, request: i.request, case_id: i.case_id ?? caseIdOf(i.request), category, state: i.state,
        confidence: d?.confidence ?? null,
        summary: d?.evidence ?? i.failed_assertions?.map((a: any) => `${a.assertion}: ${a.error}`).join("; ") ?? "",
        status: i.exchange?.status ?? null,
      });
    }
  });
  return out.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
}

// The run's result as the run page needs it: the heavy debug bundles replaced by one summary line each.
export function lightResult(result: any) {
  if (!result?.collections) return result;
  return {
    ...result,
    collections: result.collections.map(({ issues: _issues, ...c }: any) => c),
    issues: issueSummaries(result),
  };
}

// ---- The debug page ----
export function issueDetail(db: DB, run: any, collection: number, request: string) {
  const result = run.result_json ? JSON.parse(run.result_json) : null;
  const c = result?.collections?.[collection];
  const issue = c ? issuesOf(c).find((i) => i.request === request) : null;
  if (!issue) return null;
  const all = issueSummaries(result);
  const at = all.findIndex((i) => i.collection === collection && i.request === request);
  const neighbour = (k: number) => (all[k] ? { collection: all[k].collection, request: all[k].request, case_id: all[k].case_id } : null);
  const summary = all[at];
  const exchange = issue.exchange;
  const endpoint = run.contract_id && exchange ? contractEndpointFor(db, run.contract_id, exchange.method, exchange.url) : null;
  return {
    run: { id: run.id, status: run.status, collection_name: run.collection_name, environment_label: run.environment_label, contract_id: run.contract_id ?? null, created_at: run.created_at },
    issue: {
      ...issue, category: summary.category, confidence: summary.confidence,
      diagnoses: issue.diagnoses?.length ? issue.diagnoses : (c.diagnoses ?? []).filter((d: any) => d.request === request),
    },
    position: { index: at, total: all.length, previous: neighbour(at - 1), next: neighbour(at + 1) },
    history: historyOf(db, run, request),
    logs: logsOf(db, run.id, request),
    contract: endpoint,
    gaps: endpoint && result?.contract?.plan ? gapsOf(result.contract.plan, contractEndpoints(db, run.contract_id)).filter((g) => g.endpoints.includes(endpoint.key)) : [],
    knowledge: knowledgeFor(exchange?.url, endpoint?.path),
  };
}

// This request's result in this run and up to 9 earlier runs of the same collection (or contract).
function historyOf(db: DB, run: any, request: string) {
  const where = run.contract_id ? "contract_id = ?" : run.collection_id ? "collection_id = ?" : "collection_name = ?";
  const key = run.contract_id ?? run.collection_id ?? run.collection_name;
  const rows = db.prepare(`SELECT id, status, created_at, result_json FROM runs WHERE ${where} AND id <= ? AND result_json IS NOT NULL ORDER BY id DESC LIMIT 10`).all(key, run.id) as any[];
  const name = baseName(request), id = caseIdOf(request);
  const same = (n: string) => baseName(n) === name || (!!id && caseIdOf(n) === id);
  return rows.reverse().map((r) => {
    const cols: any[] = JSON.parse(r.result_json)?.collections ?? [];
    const execution = cols.flatMap((c) => c.executions ?? []).find((e: any) => same(e.request));
    const failedThere = cols.some((c) => (c.failures ?? []).some((f: any) => same(f.request)));
    const outcome = execution ? (execution.failed || execution.error ? "failed" : "passed") : failedThere ? "failed" : cols.some((c) => c.executions) ? "not_run" : "unknown";
    return { run_id: r.id, at: r.created_at, outcome };
  });
}

// Events and log lines that mention this request.
function logsOf(db: DB, runId: number, request: string) {
  const name = baseName(request);
  const rows = db.prepare("SELECT seq, type, data_json, created_at FROM run_events WHERE run_id = ? ORDER BY seq").all(runId) as any[];
  return rows.filter((e) => e.data_json.includes(JSON.stringify(name).slice(1, -1)))
    .slice(0, 400)
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
