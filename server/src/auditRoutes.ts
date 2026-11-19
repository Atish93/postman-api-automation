// Records every successful change in the audit log, with a summary in words.
// Each entry below describes one kind of request; secret values are never written, only which keys changed.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "./db.ts";
import { audit } from "./audit.ts";

type Described = { action: string; summary: string; details?: Record<string, unknown> } | null;
type Entry = { before?: (req: FastifyRequest, db: DB) => any; after: (req: FastifyRequest, res: any, before: any, db: DB) => Described };

const p = (req: FastifyRequest) => req.params as Record<string, string>;
const b = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
const nameOf = (db: DB, table: string, col: string, id: unknown) => (db.prepare(`SELECT ${col} AS n FROM ${table} WHERE id = ?`).get(Number(id)) as any)?.n ?? `#${id}`;
const list = (xs: string[]) => xs.join(", ");
const kindOf = (r: any) => (r?.kind === "ai" ? (r.ai_mode === "build" ? "AI build" : "AI") : "plain");

const ENTRIES: Record<string, Entry> = {
  "PUT /api/settings/postman": { after: (req) => b(req).api_key === null
    ? { action: "settings.postman_key_removed", summary: "Removed the Postman API key" }
    : { action: "settings.postman_key_saved", summary: "Saved a new Postman API key" } },
  "PUT /api/settings/email": { after: (req) => ({ action: "settings.email", summary: `Saved email settings (${b(req).host}:${b(req).port}${b(req).password ? ", with a new password" : b(req).password === "" ? ", password cleared" : ""})` }) },
  "POST /api/settings/email/test": { after: (req) => ({ action: "settings.email_test", summary: `Sent a test email to ${b(req).to}` }) },
  "PUT /api/settings/runs": { after: (req) => ({ action: "settings.runs", summary: `Set runs at the same time to ${b(req).max_parallel}` }) },

  "POST /api/collections/import": { after: (_r, res) => ({ action: "collection.import", summary: `Imported collection "${res.name}" from Postman`, details: { collection_id: res.id } }) },
  "POST /api/collections/upload": { after: (_r, res) => ({ action: "collection.upload", summary: `Uploaded collection "${res.name}"`, details: { collection_id: res.id } }) },
  "POST /api/collections/:id/refresh": { after: (_r, res) => ({ action: "collection.refresh", summary: `Updated collection "${res.name}" from Postman`, details: { collection_id: res.id } }) },
  "DELETE /api/collections/:id": {
    before: (req, db) => nameOf(db, "collections", "name", p(req).id),
    after: (req, _res, name) => ({ action: "collection.delete", summary: `Deleted collection "${name}"`, details: { collection_id: Number(p(req).id) } }),
  },
  "PUT /api/collections/:id/reports": { after: (req, _res, _b, db) => ({ action: "collection.reports",
    summary: `Reports for "${nameOf(db, "collections", "name", p(req).id)}": ${b(req).enabled === false ? "off" : `${list(b(req).recipients ?? []) || "nobody"}, ${String(b(req).send_when).replace("_", " ")}`}` }) },

  "POST /api/runs": { after: (_r, res) => ({ action: "run.start", summary: `Started ${kindOf(res)} run #${res.id}: ${res.collection?.name} on ${res.environment?.label}${res.data_file ? ` with ${res.data_file.name}` : ""}`, details: { run_id: res.id } }) },
  "POST /api/runs/:id/approval": {
    // What was being asked, from the run's latest approval request.
    before: (req, db) => {
      const ev = db.prepare("SELECT data_json FROM run_events WHERE run_id = ? AND type = 'approval_request' ORDER BY seq DESC LIMIT 1").get(Number(p(req).id)) as any;
      return ev ? JSON.parse(ev.data_json) : {};
    },
    after: (req, _res, asked) => {
      const yes = String(b(req).answer).trim().toLowerCase() === "y";
      const what = asked.kind === "plan" ? "the test plan" : asked.kind === "known_bugs_over_limit" ? `marking ${asked.requests?.length ?? "several"} requests as known bugs`
        : asked.request ? `${/^[aeiou]/i.test(asked.kind ?? "") ? "an" : "a"} ${asked.kind ? `${asked.kind} change` : "change"} to "${asked.request}"` : asked.question ?? "a request";
      return { action: yes ? "run.approved" : "run.refused", summary: `${yes ? "Approved" : "Refused"} ${what} (run #${p(req).id})`, details: { run_id: Number(p(req).id), asked } };
    },
  },
  "POST /api/runs/:id/cancel": { after: (req) => ({ action: "run.cancel", summary: `Cancelled run #${p(req).id}`, details: { run_id: Number(p(req).id) } }) },
  "POST /api/runs/:id/email": { after: (req, res) => ({ action: "run.email", summary: `Emailed run #${p(req).id}'s report to ${list(res.recipients ?? [])} (${res.status})`, details: { run_id: Number(p(req).id) } }) },

  "POST /api/environments": { after: (_r, res) => ({ action: "environment.create", summary: `Created environment ${res.label} (${res.base_url})${res.variables?.length ? `, variables: ${list(res.variables.map((v: any) => v.key + (v.secret ? " (secret)" : "")))}` : ""}`, details: { environment_id: res.id } }) },
  "PUT /api/environments/:id": {
    before: (req, db) => ({
      env: db.prepare("SELECT label, base_url, health_path FROM environments WHERE id = ?").get(Number(p(req).id)),
      vars: new Map((db.prepare("SELECT key, value, secret FROM variables WHERE environment_id = ?").all(Number(p(req).id)) as any[]).map((v) => [v.key, v])),
    }),
    after: (req, res, before) => {
      const sent: any[] = b(req).variables ?? [];
      const added = sent.filter((v) => !before.vars.has(v.key)).map((v) => v.key);
      const removed = [...before.vars.keys()].filter((k) => !sent.some((v) => v.key === k));
      const changed = sent.filter((v) => {
        const old = before.vars.get(v.key);
        if (!old) return false;
        if (!!old.secret !== !!v.secret) return true;
        return v.secret ? v.value != null : v.value !== old.value; // a secret sent as null is kept as it was
      }).map((v) => v.key);
      const parts = [
        before.env?.label !== res.label && `renamed from ${before.env?.label}`,
        before.env?.base_url !== res.base_url && `base URL ${before.env?.base_url} → ${res.base_url}`,
        before.env?.health_path !== res.health_path && `health check ${res.health_path}`,
        added.length && `added ${list(added)}`, changed.length && `changed ${list(changed)}`, removed.length && `removed ${list(removed)}`,
      ].filter(Boolean);
      return { action: "environment.update", summary: `Updated environment ${res.label}${parts.length ? `: ${parts.join("; ")}` : " (no changes)"}`, details: { environment_id: res.id, added, changed, removed } };
    },
  },
  "DELETE /api/environments/:id": {
    before: (req, db) => nameOf(db, "environments", "label", p(req).id),
    after: (req, _res, label) => ({ action: "environment.delete", summary: `Deleted environment ${label}`, details: { environment_id: Number(p(req).id) } }),
  },
  "POST /api/environments/:id/copy-from": { after: (req, res, _b, db) => res.dry_run ? null : ({
    action: "environment.copy",
    summary: `Copied values from ${nameOf(db, "environments", "label", b(req).source_id)} to ${res.environment?.label}: ${[res.added.length && `added ${list(res.added)}`, res.overwritten.length && `replaced ${list(res.overwritten)}`].filter(Boolean).join("; ") || "nothing changed"}`,
    details: { source_id: b(req).source_id, target_id: Number(p(req).id), added: res.added, overwritten: res.overwritten },
  }) },

  "POST /api/collections/:id/data-files": { after: (req, res, _b, db) => ({ action: "data_file.upload", summary: `${b(req).replace ? "Replaced" : "Uploaded"} test data ${res.name} (${res.row_count} rows) for "${nameOf(db, "collections", "name", p(req).id)}"`, details: { data_file_id: res.id } }) },
  "DELETE /api/data-files/:id": {
    before: (req, db) => nameOf(db, "data_files", "name", p(req).id),
    after: (req, _res, name) => ({ action: "data_file.delete", summary: `Deleted test data ${name}`, details: { data_file_id: Number(p(req).id) } }),
  },

  "POST /api/schedules": { after: (_r, res) => ({ action: "schedule.create", summary: `Scheduled ${res.kind} runs of "${res.collection?.name}" on ${res.environment?.label} (${res.cron})`, details: { schedule_id: res.id } }) },
  "PUT /api/schedules/:id": { after: (_r, res) => ({ action: "schedule.update", summary: `Changed the schedule of "${res.collection?.name}" on ${res.environment?.label}: ${res.cron}, ${res.enabled ? "enabled" : "paused"}`, details: { schedule_id: res.id } }) },
  "DELETE /api/schedules/:id": {
    before: (req, db) => (db.prepare("SELECT c.name, e.label, s.cron FROM schedules s JOIN collections c ON c.id = s.collection_id JOIN environments e ON e.id = s.environment_id WHERE s.id = ?").get(Number(p(req).id)) as any),
    after: (req, _res, s) => ({ action: "schedule.delete", summary: `Deleted the schedule of "${s?.name}" on ${s?.label} (${s?.cron})`, details: { schedule_id: Number(p(req).id) } }),
  },

  "POST /api/backups": { after: (_r, res) => ({ action: "backup.create", summary: `Made a backup: ${res.name}` }) },
};

export function auditHooks(app: FastifyInstance, db: DB) {
  const entryOf = (req: FastifyRequest) => ENTRIES[`${req.method} ${req.routeOptions?.url}`];
  app.addHook("preHandler", async (req) => {
    const e = entryOf(req);
    if (e?.before) (req as any).auditBefore = e.before(req, db);
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const e = entryOf(req);
    if (!e || reply.statusCode >= 400) return payload;
    try {
      const res = typeof payload === "string" && payload ? JSON.parse(payload) : {};
      const d = e.after(req, res, (req as any).auditBefore, db);
      if (d) audit(db, { actor: "admin", ip: req.ip, ...d });
    } catch (err) {
      req.log.error({ err }, "Couldn't write the audit log entry");
    }
    return payload;
  });
}

export function auditRoutes(app: FastifyInstance, db: DB) {
  // Newest first, with paging (before_id) and filters.
  app.get<{ Querystring: { action?: string; q?: string; before_id?: string; limit?: string } }>("/api/audit", async (req) => {
    const where: string[] = [], args: any[] = [];
    if (req.query.action) { where.push("action LIKE ?"); args.push(`${req.query.action}%`); }
    if (req.query.q) { where.push("summary LIKE ?"); args.push(`%${req.query.q}%`); }
    if (req.query.before_id) { where.push("id < ?"); args.push(Number(req.query.before_id)); }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
    return (db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit) as any[])
      .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  });
}
