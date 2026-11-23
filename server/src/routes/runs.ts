// Runs: start, list, view, follow live, answer approvals, cancel.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { FINISHED, type RunManager } from "../runs/manager.ts";

const view = (r: any, withResult = false) => ({
  id: r.id, kind: r.kind, ai_mode: r.ai_mode ?? null, request: r.request ?? null, status: r.status, message: r.message,
  schedule_id: r.schedule_id ?? null, unattended: !!r.unattended,
  data_file: r.data_file_name ? { id: r.data_file_id ?? null, name: r.data_file_name } : null,
  contract: r.ai_mode === "contract" ? { id: r.contract_id ?? null, endpoints: r.contract_endpoints ? JSON.parse(r.contract_endpoints) : null } : null,
  collection: { id: r.collection_id, name: r.collection_name },
  environment: { id: r.environment_id, label: r.environment_label },
  requests: r.requests, assertions: r.assertions, failed_assertions: r.failed_assertions,
  cost_usd: r.cost_usd, exit_code: r.exit_code,
  created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
  duration_ms: r.started_at && r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null,
  ...(withResult && { result: r.result_json ? JSON.parse(r.result_json) : null }),
});

// A data file can drive a plain run of its own collection.
export function checkDataFile(db: DB, id: number, kind: string, collectionId: number | null) {
  if (kind !== "plain") throw new HttpError(400, "Test-data files are for plain runs. AI runs choose their own test data.");
  const f = db.prepare("SELECT id, name, collection_id FROM data_files WHERE id = ?").get(id) as any;
  if (!f) throw new HttpError(404, "Data file not found.");
  if (f.collection_id !== collectionId) throw new HttpError(400, "That data file belongs to a different collection.");
  return f as { id: number; name: string };
}

export function runsRoutes(app: FastifyInstance, db: DB, runs: RunManager) {
  const getRow = (id: number) => {
    const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    if (!r) throw new HttpError(404, "Run not found.");
    return r as any;
  };

  app.post("/api/runs", async (req, reply) => {
    // Four kinds of run: plain (Newman), AI regression (re-check a collection), AI build (create a collection),
    // and AI contract (test cases and a collection from an API contract; published later, where the person chooses).
    const body = z.object({
      environment_id: z.number().int(),
      kind: z.enum(["plain", "ai"]).default("plain"),
      ai_mode: z.enum(["regression", "build", "contract"]).default("regression"),
      contract_id: z.number().int().optional(),
      endpoints: z.array(z.string()).max(500).optional(), // contract runs: which endpoints (all if left out)
      collection_id: z.number().int().optional(),
      request: z.string().trim().max(2000).optional(),
      workspace_id: z.string().trim().min(1).optional(),
      data_file_id: z.number().int().optional(), // plain runs: run once per row of this test-data file
    }).parse(req.body);
    const e = db.prepare("SELECT id, label FROM environments WHERE id = ?").get(body.environment_id) as any;
    if (!e) throw new HttpError(404, "Environment not found.");
    const build = body.kind === "ai" && body.ai_mode === "build";
    const contractRun = body.kind === "ai" && body.ai_mode === "contract";

    let collection: { id: number | null; name: string };
    let contract: { id: number; endpoints: string[] | null } | null = null;
    if (contractRun) {
      if (!body.contract_id) throw new HttpError(400, "Choose the contract to generate tests from.");
      const c = db.prepare("SELECT id, name, format, endpoints FROM contracts WHERE id = ?").get(body.contract_id) as any;
      if (!c) throw new HttpError(404, "Contract not found.");
      const known = new Set((JSON.parse(c.endpoints) as any[]).map((x) => x.key));
      const chosen = body.endpoints?.length ? [...new Set(body.endpoints)] : null;
      // For a spec the endpoints are known; for a document the agent finds them, so any choice is a hint.
      const unknown = c.format === "openapi" ? (chosen ?? []).filter((k) => !known.has(k)) : [];
      if (unknown.length) throw new HttpError(400, `Not in the contract: ${unknown.slice(0, 5).join(", ")}`);
      contract = { id: c.id, endpoints: chosen };
      collection = { id: null, name: `Contract: ${c.name}` };
    } else if (build) {
      if (!body.request || body.request.length < 15) throw new HttpError(400, "Describe what to test in a sentence or two (at least 15 characters).");
      if (!body.workspace_id) throw new HttpError(400, "Choose the Postman workspace to publish the new collection to.");
      if (body.collection_id) throw new HttpError(400, "A build run creates a new collection; don't pass a collection_id.");
      // Named after the request until the agents publish the collection; then it's linked to it.
      collection = { id: null, name: `New: ${body.request.length > 70 ? body.request.slice(0, 70) + "…" : body.request}` };
    } else {
      if (!body.collection_id) throw new HttpError(400, "collection_id is required.");
      const c = db.prepare("SELECT id, name, postman_uid FROM collections WHERE id = ?").get(body.collection_id) as any;
      if (!c) throw new HttpError(404, "Collection not found.");
      if (body.kind === "ai" && !c.postman_uid)
        throw new HttpError(400, "AI runs need a collection imported from Postman (the agents read and update it there). Uploaded collections can have plain runs.");
      collection = { id: c.id, name: c.name };
    }
    const dataFile = body.data_file_id ? checkDataFile(db, body.data_file_id, body.kind, collection.id) : null;
    const id = Number(db.prepare(`INSERT INTO runs (collection_id, environment_id, collection_name, environment_label, kind, ai_mode, request, workspace_id, data_file_id, data_file_name, contract_id, contract_endpoints, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
      .run(collection.id, e.id, collection.name, e.label, body.kind, body.kind === "ai" ? body.ai_mode : null,
        build || contractRun ? body.request ?? null : null, build ? body.workspace_id! : null,
        dataFile?.id ?? null, dataFile?.name ?? null, contract?.id ?? null, contract?.endpoints ? JSON.stringify(contract.endpoints) : null, now()).lastInsertRowid);
    runs.addEvent(id, "status", { status: "queued" });
    runs.enqueue(id);
    reply.code(202);
    return view(getRow(id));
  });

  app.get("/api/runs", async (req) => {
    const q = z.object({
      collection_id: z.coerce.number().int().optional(),
      environment_id: z.coerce.number().int().optional(),
      status: z.string().optional(),
      kind: z.enum(["plain", "ai"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      before_id: z.coerce.number().int().optional(), // for paging: runs older than this one
    }).parse(req.query);
    const where: string[] = [], args: any[] = [];
    if (q.collection_id) { where.push("collection_id = ?"); args.push(q.collection_id); }
    if (q.environment_id) { where.push("environment_id = ?"); args.push(q.environment_id); }
    if (q.status) { where.push("status = ?"); args.push(q.status); }
    if (q.kind) { where.push("kind = ?"); args.push(q.kind); }
    if (q.before_id) { where.push("id < ?"); args.push(q.before_id); }
    const rows = db.prepare(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, q.limit);
    return rows.map((r) => view(r));
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req) => view(getRow(Number(req.params.id)), true));

  // Every event of a run so far (after=<seq> for only newer ones).
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events/history", async (req) => {
    getRow(Number(req.params.id));
    return (db.prepare("SELECT seq, type, data_json, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(Number(req.params.id), Number(req.query.after ?? 0)) as any[]).map((e) => ({ seq: e.seq, type: e.type, data: JSON.parse(e.data_json), created_at: e.created_at }));
  });

  // Live: server-sent events. Sends what happened so far, then each new event. It ends a few seconds after the
  // run finishes, so events that follow the finish (e.g. the report being emailed) still arrive.
  const AFTER_FINISH_MS = 5000;
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (req, reply) => {
    const id = Number(req.params.id);
    getRow(id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

    let last = Number(req.query.after ?? req.headers["last-event-id"] ?? 0);
    let closed = false;
    let closeTimer: NodeJS.Timeout | null = null;
    const buffered: any[] = [];
    let replaying = true;

    const write = (chunk: string) => {
      if (!closed && !res.writableEnded) res.write(chunk); // never write after the end: that would throw
    };
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(keepAlive);
      if (closeTimer) clearTimeout(closeTimer);
      if (!res.writableEnded) res.end();
    };
    const closeIn = (ms: number) => {
      if (!closeTimer) closeTimer = setTimeout(close, Math.max(0, ms));
    };
    const deliver = (e: any) => {
      if (closed || e.seq <= last) return;
      last = e.seq;
      write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, data: e.data, created_at: e.created_at })}\n\n`);
      if (e.type === "finished" && !replaying) closeIn(AFTER_FINISH_MS);
    };
    const unsubscribe = runs.subscribe(id, (e) => (replaying ? buffered.push(e) : deliver(e)));
    const keepAlive = setInterval(() => write(": keep-alive\n\n"), 15_000);
    req.raw.on("close", close);
    res.on("error", close);

    // Everything stored so far (all of it, even past "finished"), then whatever arrived meanwhile.
    for (const e of db.prepare("SELECT seq, type, data_json, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq").all(id, last) as any[])
      deliver({ seq: e.seq, type: e.type, data: JSON.parse(e.data_json), created_at: e.created_at });
    replaying = false;
    for (const e of buffered) deliver(e);
    const row = getRow(id);
    if (FINISHED.includes(row.status)) closeIn(AFTER_FINISH_MS - (Date.now() - Date.parse(row.finished_at ?? 0)));
  });

  // Answer the run's pending approval: "y" to approve, anything else to refuse.
  app.post<{ Params: { id: string } }>("/api/runs/:id/approval", async (req) => {
    const id = Number(req.params.id);
    getRow(id);
    const { answer } = z.object({ answer: z.string().trim().min(1).max(500) }).parse(req.body);
    if (!runs.answerApproval(id, answer)) throw new HttpError(409, "This run isn't waiting for an approval.");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req) => {
    const id = Number(req.params.id);
    const r = getRow(id);
    if (FINISHED.includes(r.status)) throw new HttpError(409, "This run has already finished.");
    if (!runs.cancel(id)) throw new HttpError(409, "This run can't be cancelled now (plain runs finish on their own in seconds).");
    return { ok: true };
  });
}
