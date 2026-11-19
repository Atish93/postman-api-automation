// Schedules: run a collection on an environment at set times.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { nextRuns } from "../scheduler.ts";
import { checkDataFile } from "./runs.ts";

const Schedule = z.object({
  collection_id: z.number().int(),
  environment_id: z.number().int(),
  kind: z.enum(["plain", "ai"]).default("plain"),
  cron: z.string().trim().min(9).max(100),
  enabled: z.boolean().default(true),
  data_file_id: z.number().int().nullable().default(null), // plain runs: once per row of this file
});

export function scheduleRoutes(app: FastifyInstance, db: DB) {
  const view = (s: any) => {
    const last = db.prepare("SELECT id, status, created_at FROM runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1").get(s.id) as any;
    return {
      id: s.id, kind: s.kind, cron: s.cron, enabled: !!s.enabled, next_run_at: s.enabled ? s.next_run_at : null,
      collection: { id: s.collection_id, name: s.collection_name }, environment: { id: s.environment_id, label: s.environment_label },
      data_file: s.data_file_id ? { id: s.data_file_id, name: s.data_file_name } : null,
      last_run: last ? { id: last.id, status: last.status, created_at: last.created_at } : null,
    };
  };
  const select = `SELECT s.*, c.name AS collection_name, e.label AS environment_label, f.name AS data_file_name FROM schedules s
    JOIN collections c ON c.id = s.collection_id JOIN environments e ON e.id = s.environment_id
    LEFT JOIN data_files f ON f.id = s.data_file_id`;
  const get = (id: number) => {
    const s = db.prepare(`${select} WHERE s.id = ?`).get(id);
    if (!s) throw new HttpError(404, "Schedule not found.");
    return s as any;
  };
  const validate = (b: z.infer<typeof Schedule>) => {
    const c = db.prepare("SELECT postman_uid FROM collections WHERE id = ?").get(b.collection_id) as any;
    if (!c) throw new HttpError(404, "Collection not found.");
    if (!db.prepare("SELECT 1 FROM environments WHERE id = ?").get(b.environment_id)) throw new HttpError(404, "Environment not found.");
    if (b.kind === "ai" && !c.postman_uid) throw new HttpError(400, "Scheduled AI runs need a collection imported from Postman.");
    if (b.data_file_id) checkDataFile(db, b.data_file_id, b.kind, b.collection_id);
    return nextRuns(b.cron, new Date(), 1)[0].toISOString(); // also validates the cron expression
  };

  app.get<{ Querystring: { collection_id?: string } }>("/api/schedules", async (req) => {
    const rows = req.query.collection_id
      ? db.prepare(`${select} WHERE s.collection_id = ? ORDER BY s.id`).all(Number(req.query.collection_id))
      : db.prepare(`${select} ORDER BY s.next_run_at IS NULL, s.next_run_at`).all();
    return rows.map(view);
  });

  // When a cron expression would run next (for the form, as you type).
  app.get<{ Querystring: { cron?: string } }>("/api/schedules/preview", async (req) => ({
    next: nextRuns(String(req.query.cron ?? ""), new Date(), 3).map((d) => d.toISOString()),
  }));

  app.post("/api/schedules", async (req, reply) => {
    const b = Schedule.parse(req.body);
    const next = validate(b);
    const t = now();
    const id = Number(db.prepare("INSERT INTO schedules (collection_id, environment_id, kind, cron, enabled, data_file_id, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(b.collection_id, b.environment_id, b.kind, b.cron, b.enabled ? 1 : 0, b.data_file_id, next, t, t).lastInsertRowid);
    reply.code(201);
    return view(get(id));
  });

  app.put<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    const id = Number(req.params.id);
    get(id);
    const b = Schedule.parse(req.body);
    const next = validate(b);
    db.prepare("UPDATE schedules SET collection_id = ?, environment_id = ?, kind = ?, cron = ?, enabled = ?, data_file_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(b.collection_id, b.environment_id, b.kind, b.cron, b.enabled ? 1 : 0, b.data_file_id, next, now(), id);
    return view(get(id));
  });

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    get(Number(req.params.id));
    db.prepare("DELETE FROM schedules WHERE id = ?").run(Number(req.params.id)); // its runs stay
    reply.code(204);
  });
}
