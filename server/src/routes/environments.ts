// Environments and their variables. Secret values are never returned in full.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";

const Variable = z.object({
  key: z.string().trim().min(1).max(200),
  value: z.string().nullable().optional(), // a secret may be sent as null to keep its current value
  secret: z.boolean().default(false),
});
const Environment = z.object({
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "Use lowercase letters, digits, - or _ (e.g. stg)"),
  label: z.string().trim().min(1).max(50),
  base_url: z.string().trim().url().refine((u) => /^https?:\/\//.test(u), "Must start with http:// or https://"),
  health_path: z.string().trim().startsWith("/").default("/"),
  variables: z.array(Variable).default([]),
});

const mask = (value: string) => (value.length <= 4 ? "••••" : `••••${value.slice(-2)}`);

export function environmentsRoutes(app: FastifyInstance, db: DB) {
  const view = (id: number) => {
    const e = db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as any;
    if (!e) throw new HttpError(404, "Environment not found.");
    const vars = db.prepare("SELECT key, value, secret FROM variables WHERE environment_id = ? ORDER BY key").all(id) as any[];
    return {
      id: e.id, name: e.name, label: e.label, base_url: e.base_url, health_path: e.health_path, created_at: e.created_at, updated_at: e.updated_at,
      variables: vars.map((v) => (v.secret ? { key: v.key, value: null, masked: mask(v.value), secret: true } : { key: v.key, value: v.value, secret: false })),
    };
  };

  const saveVariables = (envId: number, vars: z.infer<typeof Variable>[]) => {
    const keys = vars.map((v) => v.key);
    if (new Set(keys).size !== keys.length) throw new HttpError(400, "Each variable key may appear only once.");
    const old = new Map((db.prepare("SELECT key, value FROM variables WHERE environment_id = ?").all(envId) as any[]).map((v) => [v.key, v.value]));
    db.prepare("DELETE FROM variables WHERE environment_id = ?").run(envId);
    const insert = db.prepare("INSERT INTO variables (environment_id, key, value, secret) VALUES (?, ?, ?, ?)");
    for (const v of vars) {
      const value = v.value ?? (v.secret ? old.get(v.key) : undefined);
      if (value === undefined) throw new HttpError(400, `Variable "${v.key}" needs a value.`);
      insert.run(envId, v.key, value, v.secret ? 1 : 0);
    }
  };

  const inTransaction = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  app.get("/api/environments", async () =>
    (db.prepare("SELECT id FROM environments ORDER BY label").all() as any[]).map((r) => view(r.id)));

  app.get<{ Params: { id: string } }>("/api/environments/:id", async (req) => view(Number(req.params.id)));

  app.post("/api/environments", async (req, reply) => {
    const e = Environment.parse(req.body);
    if (db.prepare("SELECT 1 FROM environments WHERE name = ?").get(e.name)) throw new HttpError(409, `An environment named "${e.name}" already exists.`);
    const id = inTransaction(() => {
      const t = now();
      const id = Number(db.prepare("INSERT INTO environments (name, label, base_url, health_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(e.name, e.label, e.base_url, e.health_path, t, t).lastInsertRowid);
      saveVariables(id, e.variables);
      return id;
    });
    reply.code(201);
    return view(id);
  });

  app.put<{ Params: { id: string } }>("/api/environments/:id", async (req) => {
    const id = Number(req.params.id);
    view(id); // 404 if missing
    const e = Environment.parse(req.body);
    const clash = db.prepare("SELECT id FROM environments WHERE name = ? AND id != ?").get(e.name, id);
    if (clash) throw new HttpError(409, `An environment named "${e.name}" already exists.`);
    inTransaction(() => {
      db.prepare("UPDATE environments SET name = ?, label = ?, base_url = ?, health_path = ?, updated_at = ? WHERE id = ?").run(e.name, e.label, e.base_url, e.health_path, now(), id);
      saveVariables(id, e.variables);
    });
    return view(id);
  });

  app.delete<{ Params: { id: string } }>("/api/environments/:id", async (req, reply) => {
    view(Number(req.params.id));
    db.prepare("DELETE FROM environments WHERE id = ?").run(Number(req.params.id)); // runs keep the environment's label
    reply.code(204);
  });
}
