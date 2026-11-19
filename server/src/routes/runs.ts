// Runs: start, list, view, follow live, answer approvals, cancel.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { FINISHED, type RunManager } from "../runs/manager.ts";

const view = (r: any, withResult = false) => ({
  id: r.id, kind: r.kind, status: r.status, message: r.message,
  collection: { id: r.collection_id, name: r.collection_name },
  environment: { id: r.environment_id, label: r.environment_label },
  requests: r.requests, assertions: r.assertions, failed_assertions: r.failed_assertions,
  cost_usd: r.cost_usd, exit_code: r.exit_code,
  created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
  duration_ms: r.started_at && r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null,
  ...(withResult && { result: r.result_json ? JSON.parse(r.result_json) : null }),
});

export function runsRoutes(app: FastifyInstance, db: DB, runs: RunManager) {
  const getRow = (id: number) => {
    const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    if (!r) throw new HttpError(404, "Run not found.");
    return r as any;
  };

  app.post("/api/runs", async (req, reply) => {
    const body = z.object({
      collection_id: z.number().int(),
      environment_id: z.number().int(),
      kind: z.enum(["plain", "ai"]).default("plain"),
    }).parse(req.body);
    const c = db.prepare("SELECT id, name, postman_uid FROM collections WHERE id = ?").get(body.collection_id) as any;
    if (!c) throw new HttpError(404, "Collection not found.");
    const e = db.prepare("SELECT id, label FROM environments WHERE id = ?").get(body.environment_id) as any;
    if (!e) throw new HttpError(404, "Environment not found.");
    if (body.kind === "ai" && !c.postman_uid)
      throw new HttpError(400, "AI runs need a collection imported from Postman (the agents read and update it there). Uploaded collections can have plain runs.");
    const id = Number(db.prepare("INSERT INTO runs (collection_id, environment_id, collection_name, environment_label, kind, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
      .run(c.id, e.id, c.name, e.label, body.kind, now()).lastInsertRowid);
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

  // Live: server-sent events. Sends what happened so far, then each new event, and ends when the run finishes.
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (req, reply) => {
    const id = Number(req.params.id);
    getRow(id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (e: any) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, data: e.data, created_at: e.created_at })}\n\n`);

    let last = Number(req.query.after ?? req.headers["last-event-id"] ?? 0);
    const buffered: any[] = [];
    let replaying = true;
    const unsubscribe = runs.subscribe(id, (e) => (replaying ? buffered.push(e) : deliver(e)));
    const deliver = (e: any) => {
      if (e.seq <= last) return;
      last = e.seq;
      send(e);
      if (e.type === "finished") close();
    };
    const close = () => {
      unsubscribe();
      clearInterval(keepAlive);
      res.end();
    };
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.raw.on("close", close);

    for (const e of db.prepare("SELECT seq, type, data_json, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq").all(id, last) as any[])
      deliver({ seq: e.seq, type: e.type, data: JSON.parse(e.data_json), created_at: e.created_at });
    replaying = false;
    for (const e of buffered) deliver(e);
    if (FINISHED.includes(getRow(id).status) && !res.writableEnded) close();
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
