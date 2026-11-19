// Environments and their variables. Secret values are stored encrypted and never returned in full;
// comparing and copying secrets happens here on the server, so they never travel to the browser.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { decrypt, encrypt, isEncrypted, SecretError } from "../secrets.ts";

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

// A variable's real value (secrets decrypted). null if a secret can't be decrypted (the key changed).
function plainValue(v: { value: string; secret: number }): string | null {
  if (!v.secret) return v.value;
  try {
    return decrypt(v.value);
  } catch (e) {
    if (e instanceof SecretError) return null;
    throw e;
  }
}
const stored = (value: string, secret: boolean) => (secret ? (isEncrypted(value) ? value : encrypt(value)) : value);

const CopyRequest = z.object({
  source_id: z.number().int(),
  keys: z.array(z.string()).min(1, "Choose at least one variable to copy."),
  overwrite: z.boolean().default(false), // replace values the target already has
  dry_run: z.boolean().default(false),   // only say what would happen
});
export function environmentsRoutes(app: FastifyInstance, db: DB) {
  const view = (id: number) => {
    const e = db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as any;
    if (!e) throw new HttpError(404, "Environment not found.");
    const vars = db.prepare("SELECT key, value, secret FROM variables WHERE environment_id = ? ORDER BY key").all(id) as any[];
    return {
      id: e.id, name: e.name, label: e.label, base_url: e.base_url, health_path: e.health_path, created_at: e.created_at, updated_at: e.updated_at,
      variables: vars.map((v) => {
        if (!v.secret) return { key: v.key, value: v.value, secret: false };
        const plain = plainValue(v);
        return { key: v.key, value: null, masked: plain === null ? "can't decrypt: enter it again" : mask(plain), secret: true, ...(plain === null && { unreadable: true }) };
      }),
    };
  };

  const saveVariables = (envId: number, vars: z.infer<typeof Variable>[]) => {
    const keys = vars.map((v) => v.key);
    if (new Set(keys).size !== keys.length) throw new HttpError(400, "Each variable key may appear only once.");
    const old = new Map((db.prepare("SELECT key, value, secret FROM variables WHERE environment_id = ?").all(envId) as any[]).map((v) => [v.key, v]));
    db.prepare("DELETE FROM variables WHERE environment_id = ?").run(envId);
    const insert = db.prepare("INSERT INTO variables (environment_id, key, value, secret) VALUES (?, ?, ?, ?)");
    for (const v of vars) {
      let value: string | undefined = v.value ?? undefined;
      if (value === undefined && v.secret && old.has(v.key)) {
        const before = old.get(v.key)!;
        value = before.value; // keep the saved value; stored() encrypts it if it was plain before
      }
      if (value === undefined) throw new HttpError(400, `Variable "${v.key}" needs a value.`);
      insert.run(envId, v.key, stored(value, v.secret), v.secret ? 1 : 0);
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

  // Side by side: every key in any of the chosen environments, its value in each, and whether they agree.
  // Secrets are compared here; the answer says same/different without showing them.
  app.get<{ Querystring: { ids?: string } }>("/api/environments/compare", async (req) => {
    const ids = [...new Set(String(req.query.ids ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length < 2) throw new HttpError(400, "Choose at least two environments to compare.");
    const envs = ids.map((id) => {
      const e = db.prepare("SELECT id, name, label, base_url, health_path FROM environments WHERE id = ?").get(id) as any;
      if (!e) throw new HttpError(404, `Environment ${id} not found.`);
      const vars = db.prepare("SELECT key, value, secret FROM variables WHERE environment_id = ?").all(id) as any[];
      return { ...e, vars: new Map(vars.map((v) => [v.key, v])) };
    });
    const keys = [...new Set(envs.flatMap((e) => [...e.vars.keys()]))].sort((a, b) => a.localeCompare(b));
    const rows = keys.map((key) => {
      const cells = envs.map((e) => {
        const v = e.vars.get(key);
        if (!v) return { present: false as const };
        const plain = plainValue(v);
        return v.secret
          ? { present: true as const, secret: true, value: null, masked: plain === null ? "can't decrypt" : mask(plain), plain }
          : { present: true as const, secret: false, value: v.value, plain };
      });
      const present = cells.filter((c) => c.present) as any[];
      const status =
        present.length < cells.length ? "missing"
        : present.some((c) => c.plain === null) ? "unknown"
        : new Set(present.map((c) => c.plain)).size === 1 ? "same" : "different";
      return { key, status, cells: cells.map(({ plain: _p, ...c }: any) => c) };
    });
    return {
      environments: envs.map(({ vars: _v, ...e }) => e),
      rows,
      counts: Object.fromEntries(["same", "different", "missing", "unknown"].map((s) => [s, rows.filter((r) => r.status === s).length])),
    };
  });

  // Copies variables from another environment into this one. Values (secrets included) are copied
  // here on the server; a secret stays secret. Existing values are kept unless overwrite is set.
  app.post<{ Params: { id: string } }>("/api/environments/:id/copy-from", async (req) => {
    const targetId = Number(req.params.id);
    view(targetId);
    const body = CopyRequest.parse(req.body);
    if (body.source_id === targetId) throw new HttpError(400, "Choose a different environment to copy from.");
    view(body.source_id);
    const source = new Map((db.prepare("SELECT key, value, secret FROM variables WHERE environment_id = ?").all(body.source_id) as any[]).map((v) => [v.key, v]));
    const target = new Map((db.prepare("SELECT key, value, secret FROM variables WHERE environment_id = ?").all(targetId) as any[]).map((v) => [v.key, v]));
    const result = { added: [] as string[], overwritten: [] as string[], unchanged: [] as string[], skipped: [] as string[], not_found: [] as string[] };
    const writes: { key: string; value: string; secret: number }[] = [];
    for (const key of [...new Set(body.keys)]) {
      const s = source.get(key);
      if (!s) { result.not_found.push(key); continue; }
      const plain = plainValue(s);
      if (plain === null) throw new HttpError(400, `The secret "${key}" in the source environment can't be decrypted. Enter it again there first.`);
      const t = target.get(key);
      if (!t) result.added.push(key);
      else if (plainValue(t) === plain && !!t.secret === !!s.secret) { result.unchanged.push(key); continue; }
      else if (!body.overwrite) { result.skipped.push(key); continue; }
      else result.overwritten.push(key);
      writes.push({ key, value: s.secret ? encrypt(plain) : plain, secret: s.secret ? 1 : 0 });
    }
    if (!body.dry_run && writes.length) {
      inTransaction(() => {
        const up = db.prepare(`INSERT INTO variables (environment_id, key, value, secret) VALUES (?, ?, ?, ?)
          ON CONFLICT(environment_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret`);
        for (const w of writes) up.run(targetId, w.key, w.value, w.secret);
        db.prepare("UPDATE environments SET updated_at = ? WHERE id = ?").run(now(), targetId);
      });
    }
    return { dry_run: body.dry_run, ...result, environment: view(targetId) };
  });

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
