// What a person can do from a failure's debug page, after the run:
//   resend    - send the request again exactly as the run sent it (no AI)
//   debug     - ask the debugger to investigate it again (agent/followup.ts, kind "debug")
//   known_bug - mark the request as a known API bug in the run's collection (no AI)
//   fix       - apply a probable fix and re-run the collection: a new run (agent/followup.ts, kind "fix")
// Each is recorded in issue_actions; the debug page shows them, newest first.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { postman } from "../postman.ts";
import { importFromPostman } from "../collections.ts";
import { audit } from "../audit.ts";
import { baseName, collectionsOf, issueDetail, runCollection } from "../debug.ts";
import { loadEnvironment, networkReason, type RunEnvironment } from "./environment.ts";
import { runsDir, spawnAgent, writeContractFile } from "./ai.ts";
import { statusFromFailures, FINISHED, type RunManager, type RunRow } from "./manager.ts";

const KNOWN_BUG = "KNOWN BUG - ";
const HIDDEN = "••••••";
type Ref = { collection: number; request: string };

const getRun = (db: DB, id: number) => {
  const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
  if (!r) throw new HttpError(404, "Run not found.");
  if (!FINISHED.includes(r.status)) throw new HttpError(409, "This run is still going. Wait for it to finish.");
  return r;
};
const detailOf = (db: DB, run: any, ref: Ref) => {
  const d = issueDetail(db, run, ref.collection, ref.request);
  if (!d) throw new HttpError(404, "That failure isn't in this run.");
  return d;
};
const record = (db: DB, runId: number, ref: Ref, kind: string, status: string, input: unknown, output?: unknown, extra: { message?: string | null; child_run_id?: number | null } = {}) =>
  Number(db.prepare(`INSERT INTO issue_actions (run_id, collection, request, kind, status, input_json, output_json, message, child_run_id, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, ref.collection, ref.request, kind, status, JSON.stringify(input ?? null),
    output === undefined ? null : JSON.stringify(output), extra.message ?? null, extra.child_run_id ?? null, now(), status === "running" ? null : now()).lastInsertRowid);
const settle = (db: DB, id: number, status: "done" | "failed", output: unknown, message: string | null = null, cost: number | null = null) =>
  db.prepare("UPDATE issue_actions SET status = ?, output_json = ?, message = ?, cost_usd = ?, finished_at = ? WHERE id = ?")
    .run(status, JSON.stringify(output ?? null), message, cost, now(), id);

// Secrets the agent stored as {{name}} come back from the environment; ones it could only hide can't.
function restore(text: string, env: RunEnvironment, missing: Set<string>) {
  return text.replace(/\{\{([\w.-]+)\}\}/g, (all, name) => {
    if (name === "baseUrl") return env.baseUrl.replace(/\/$/, "");
    if (name in env.variables) return env.variables[name];
    missing.add(name);
    return all;
  });
}
// And the other way, for what is stored: the environment's secret values back to {{name}}.
function hideSecrets(text: string, env: RunEnvironment) {
  let out = text;
  for (const [k, v] of Object.entries(env.variables)) if (/authorization|cookie|token|secret|password|passwd|api[-_]?key|session|credential/i.test(k) && v.length >= 4) out = out.split(v).join(`{{${k}}}`);
  return out;
}

// ---- Re-send: the exact request again, to the run's environment ----
export async function resend(db: DB, runId: number, ref: Ref) {
  const run = getRun(db, runId);
  const d = detailOf(db, run, ref);
  const x = d.issue.exchange;
  if (!x?.url) throw new HttpError(409, "This run was recorded before request details were kept, so it can't be re-sent.");
  const env = loadEnvironment(db, run.environment_id);
  const stored = [x.url, x.request_body ?? "", ...(x.request_headers ?? []).map((h: any) => h.value)].join("\n");
  if (stored.includes(HIDDEN))
    throw new HttpError(409, "This request used a credential obtained during the run (for example a login token), which isn't stored, so it can't be re-sent exactly. Ask the debugger again instead: it can log in.");
  const missing = new Set<string>();
  const url = restore(x.url, env, missing);
  const headers = Object.fromEntries((x.request_headers ?? []).filter((h: any) => !/^(content-length|host|connection)$/i.test(h.key)).map((h: any) => [h.key, restore(h.value, env, missing)]));
  const body = x.request_body ? restore(x.request_body, env, missing) : undefined;
  if (missing.size) throw new HttpError(409, `It needs ${[...missing].map((m) => `{{${m}}}`).join(", ")}, which ${env.label} doesn't have.`);
  if (new URL(url).host !== new URL(env.baseUrl).host) throw new HttpError(409, `Only ${new URL(env.baseUrl).host} (the ${env.label} environment) can be called from here.`);

  const input = { method: x.method, url: x.url, environment: env.label };
  const started = Date.now();
  let output: any;
  try {
    const res = await fetch(url, { method: x.method, headers, body: ["GET", "HEAD"].includes(x.method) ? undefined : body, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    output = {
      status: res.status, response_time_ms: Date.now() - started, response_size: text.length,
      response_headers: [...res.headers].map(([key, value]) => ({ key, value: /cookie|authorization|token/i.test(key) ? HIDDEN : hideSecrets(value, env) })),
      body: hideSecrets(text, env).slice(0, 4000),
      same_as_run: res.status === x.status,
    };
  } catch (e: any) {
    output = { error: networkReason(e), response_time_ms: Date.now() - started, same_as_run: !!x.error };
  }
  const id = record(db, run.id, { ...ref, request: d.issue.request }, "resend", "done", input, output);
  return { id, ...output };
}

// ---- Ask the debugger again ----
export function startDebug(db: DB, runs: RunManager, runId: number, ref: Ref, note: string | null) {
  const run = getRun(db, runId);
  const d = detailOf(db, run, ref);
  if (d.can.debug) throw new HttpError(409, d.can.debug);
  if (d.actions.some((a: any) => a.kind === "debug" && a.status === "running")) throw new HttpError(409, "The debugger is already looking at this failure.");
  const result = JSON.parse(run.result_json);
  const env = loadEnvironment(db, run.environment_id);
  const id = record(db, run.id, { ...ref, request: d.issue.request }, "debug", "running", { note });
  const dir = join(runsDir(), String(run.id), `followup-${id}`);
  const job = jobFor(db, run, result, ref.collection, d.issue, env, dir, { kind: "debug", note });
  const emit = (type: string, data: Record<string, unknown>) => runs.addEvent(run.id, type, { ...data, followup: id });
  const agent = spawnAgent(db, { script: "followup.ts", args: [job], env, dir, extraEnv: { QA_NO_PROMPTS: "1" }, emit });
  void agent.done.then(({ code, result: r }) => {
    const found = r?.collections?.[0]?.issues?.find((i: any) => baseName(i.request) === baseName(d.issue.request));
    const report = r?.report ?? null;
    if (code === 0 && found) {
      settle(db, id, "done", { issue: found, report }, null, r?.cost_usd ?? null);
    } else {
      settle(db, id, "failed", { report }, code === 2 ? r?.server_issue ?? "The server had problems, so the debugger stopped." : `The debugger stopped early (exit code ${code}).`, r?.cost_usd ?? null);
    }
    if (r?.cost_usd) db.prepare("UPDATE runs SET cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?").run(r.cost_usd, run.id);
  }).catch((e) => settle(db, id, "failed", null, e.message));
  return { id, status: "running" };
}

// The job file agent/followup.ts reads: the collection as it ended, this failure's result and findings,
// and (contract runs) the contract and the approved plan.
function jobFor(db: DB, run: any, result: any, collection: number, issue: any, env: RunEnvironment, dir: string, extra: { kind: "debug" | "fix"; note?: string | null; fix?: unknown }) {
  const src = runCollection(db, run, result, collection);
  if (!src) throw new HttpError(409, "The collection this run used is no longer here.");
  const c = collectionsOf(result)[collection] ?? {};
  mkdirSync(dir, { recursive: true });
  const contractFile = run.contract_id ? writeContractFile(db, run.contract_id, env, dir) : null;
  const passing = (c.executions ?? []).filter((e: any) => !e.failed && !e.error).map((e: any) => e.request);
  const file = join(dir, "job.json");
  writeFileSync(file, JSON.stringify({
    ...extra, request: issue.request, collection: src.collection, source_uid: src.source_uid,
    contract_file: contractFile, plan: result?.contract?.plan ?? null,
    exchange: issue.exchange ?? null, failures: c.failures ?? [], diagnoses: issue.diagnoses ?? [],
    requests: c.requests ?? c.executions?.length, assertions: c.assertions, passing: passing.length ? passing : undefined,
  }), { mode: 0o600 });
  return file;
}

// ---- Mark as a known bug ----
// The request is renamed "KNOWN BUG - …" with the evidence in its description, the same way the agents do it,
// so later runs treat the same failure as a known bug. Where the collection is: the run's own copy (contract
// runs, until published), Postman (imported collections), or the dashboard's copy (uploaded ones).
export async function markKnownBug(db: DB, runId: number, ref: Ref, evidence: string, ip: string | null) {
  const run = getRun(db, runId);
  const d = detailOf(db, run, ref);
  if (d.can.known_bug) throw new HttpError(409, d.can.known_bug);
  const result = JSON.parse(run.result_json);
  const old = d.issue.request, renamed = KNOWN_BUG + baseName(old);
  const lines = (d.issue.failed_assertions.length ? d.issue.failed_assertions : [{ assertion: "(this request)" }]).map((a: any) => `- ${a.assertion}: ${evidence}`).join("\n");
  const describe = (item: any) => {
    item.name = renamed;
    if (item.request) item.request.description = `${item.request.description ?? ""}\n\nThis request currently fails because of an API bug (marked on the dashboard):\n${lines}`.trim();
  };
  const findIn = (items: any[] = []): any => {
    for (const it of items) {
      if (it.item) { const f = findIn(it.item); if (f) return f; } else if (it.name === old) return it;
    }
    return null;
  };

  // The run's own copy is renamed too (it's what follow-up work starts from).
  const kept = [result.collections?.[ref.collection]?.collection, ref.collection === 0 ? result.contract?.collection : null].filter(Boolean);
  for (const col of kept) { const it = findIn(col.item); if (it) describe(it); }
  const row = run.ai_mode !== "contract" && run.collection_id ? db.prepare("SELECT json, postman_uid FROM collections WHERE id = ?").get(run.collection_id) as any : null;
  let where: string;
  if (row?.postman_uid) {
    // A collection from Postman: change it there, so later runs know the bug, and refresh the dashboard's copy.
    const pm = (await postman(db, `/collections/${encodeURIComponent(row.postman_uid)}`)).collection;
    const it = findIn(pm?.item);
    if (!it) throw new HttpError(409, `"${old}" isn't in the Postman collection any more (it may have been renamed there).`);
    describe(it);
    await postman(db, `/collections/${encodeURIComponent(row.postman_uid)}`, { method: "PUT", body: { collection: pm } });
    await importFromPostman(db, row.postman_uid);
    where = "the collection in Postman";
  } else if (row) {
    const col = JSON.parse(row.json);
    const it = findIn(col.item);
    if (!it) throw new HttpError(409, `"${old}" isn't in the collection any more.`);
    describe(it);
    db.prepare("UPDATE collections SET json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(col), now(), run.collection_id);
    where = "the dashboard's copy of the collection";
  } else if (kept.length) {
    where = "the run's collection (it goes to Postman when you add it)";
  } else {
    throw new HttpError(409, "The collection this run used is no longer here.");
  }

  // The run's own record follows the new name, so its failures count as known bugs.
  const rename = (n: string) => (n === old ? renamed : n);
  for (const c of result.collections ?? []) {
    for (const k of ["failures", "diagnoses", "executions", "issues"]) for (const x of c[k] ?? []) x.request = rename(x.request);
    c.known_bugs = [...new Set([...(c.known_bugs ?? []), renamed])];
  }
  for (const x of result.executions ?? []) x.request = rename(x.request); // plain runs
  let status = run.status;
  // A finished run whose only failures are known bugs now counts as passed with known bugs (a contract run can then
  // be added to Postman). A run that stopped early (circuit breaker, server issue) stays as it was.
  if (["failed", "passed_with_known_bugs"].includes(run.status)) {
    const failing = collectionsOf(result).flatMap((c) => (c.failures ?? []).map((f: any) => f.request));
    status = statusFromFailures([...new Set(failing)] as string[]);
  }
  db.prepare("UPDATE runs SET result_json = ?, status = ? WHERE id = ?").run(JSON.stringify(result), status, run.id);
  const id = record(db, run.id, { ...ref, request: renamed }, "known_bug", "done", { evidence }, { renamed, where, status_before: run.status, status_after: status });
  audit(db, { actor: "admin", ip, action: "run.known_bug", summary: `Marked "${baseName(old)}" as a known bug (run #${run.id}, ${where})`, details: { run_id: run.id, request: renamed } });
  return { id, request: renamed, where, status };
}

// ---- Apply a fix and re-run: a new run, queued like any other ----
export function startFix(db: DB, runs: RunManager, runId: number, ref: Ref, fixIndex: number, ip: string | null) {
  const run = getRun(db, runId);
  const d = detailOf(db, run, ref);
  if (d.can.fix) throw new HttpError(409, d.can.fix);
  const fixes = d.issue.diagnoses.flatMap((x: any) => x.fixes ?? []).sort((a: any, b: any) => Number(!!b.recommended) - Number(!!a.recommended));
  const fix = fixes[fixIndex];
  if (!fix) throw new HttpError(400, "That fix isn't one of the debugger's suggestions.");
  if (fix.kind !== "change_test") throw new HttpError(400, "Only a change to the test can be applied. The other fixes are for people: report the bug, fix the environment, or clarify the contract.");
  const title = `Apply fix to ${d.issue.case_id ?? baseName(d.issue.request)}: ${fix.title}`.slice(0, 300);
  const childId = Number(db.prepare(`INSERT INTO runs (collection_id, environment_id, collection_name, environment_label, kind, ai_mode, request, contract_id,
      parent_run_id, followup_json, status, created_at)
    VALUES (?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?, 'queued', ?)`).run(run.collection_id, run.environment_id, run.collection_name, run.environment_label,
    run.kind === "plain" ? "regression" : run.ai_mode, title, run.contract_id ?? null, run.id,
    JSON.stringify({ collection: ref.collection, request: d.issue.request, fix }), now()).lastInsertRowid);
  const id = record(db, run.id, { ...ref, request: d.issue.request }, "fix", "done", { fix }, null, { child_run_id: childId });
  runs.addEvent(childId, "status", { status: "queued" });
  runs.enqueue(childId);
  audit(db, { actor: "admin", ip, action: "run.fix", summary: `Applied a fix to "${baseName(d.issue.request)}" and started run #${childId} (from run #${run.id})`, details: { run_id: run.id, child_run_id: childId } });
  return { id, run_id: childId };
}

// For runAi: the job file of a fix run, from its parent run.
export function fixJob(db: DB, run: RunRow, env: RunEnvironment, dir: string) {
  const f = JSON.parse(run.followup_json!);
  const parent = db.prepare("SELECT * FROM runs WHERE id = ?").get(run.parent_run_id) as any;
  if (!parent?.result_json) throw new Error("The run this fix comes from no longer exists.");
  const d = issueDetail(db, parent, f.collection, f.request);
  if (!d) throw new Error(`"${f.request}" isn't a failure of run #${parent.id} any more.`);
  return jobFor(db, parent, JSON.parse(parent.result_json), f.collection, d.issue, env, dir, { kind: "fix", fix: f.fix });
}
