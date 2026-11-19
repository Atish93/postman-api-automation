// Email settings, per-collection report rules, and run reports (download or email).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { dashboardUrl, hasSmtpPassword, saveSmtpSettings, sendRunReport, sendTestEmail, smtpSettings } from "../email.ts";
import { loadReportRun, reportHtml } from "../report.ts";

const Email = z.string().trim().email();

export function notificationRoutes(app: FastifyInstance, db: DB) {
  // ---- SMTP settings (the password is never returned) ----
  app.get("/api/settings/email", async () => {
    const s = smtpSettings(db);
    return { configured: !!s, ...(s ?? { host: "", port: 465, secure: true, user: "", from: "", dashboard_url: "http://127.0.0.1:4000" }), has_password: hasSmtpPassword(db) };
  });

  app.put("/api/settings/email", async (req) => {
    const b = z.object({
      host: z.string().trim().min(1),
      port: z.coerce.number().int().min(1).max(65535),
      secure: z.boolean(),
      user: z.string().trim().default(""),
      from: z.string().trim().default(""),
      dashboard_url: z.string().trim().url(),
      password: z.string().nullable().optional(), // null or missing: keep; "": clear
    }).parse(req.body);
    if (b.from && !Email.safeParse(b.from.replace(/^.*<(.+)>\s*$/, "$1")).success) throw new HttpError(400, "from: use an email address, e.g. qa@example.com or QA Bot <qa@example.com>");
    const { password, ...settings } = b;
    saveSmtpSettings(db, settings, password);
    return { configured: true, ...settings, has_password: hasSmtpPassword(db) };
  });

  app.post("/api/settings/email/test", async (req) => {
    const { to } = z.object({ to: Email }).parse(req.body);
    await sendTestEmail(db, to);
    return { ok: true };
  });

  // ---- Who gets a collection's reports, and when ----
  const getCollection = (id: number) => {
    if (!db.prepare("SELECT 1 FROM collections WHERE id = ?").get(id)) throw new HttpError(404, "Collection not found.");
  };
  const ruleView = (id: number) => {
    const r = db.prepare("SELECT * FROM collection_reports WHERE collection_id = ?").get(id) as any;
    return r ? { recipients: JSON.parse(r.recipients), send_when: r.send_when, enabled: !!r.enabled } : { recipients: [], send_when: "failure", enabled: true };
  };
  app.get<{ Params: { id: string } }>("/api/collections/:id/reports", async (req) => {
    getCollection(Number(req.params.id));
    return ruleView(Number(req.params.id));
  });
  app.put<{ Params: { id: string } }>("/api/collections/:id/reports", async (req) => {
    const id = Number(req.params.id);
    getCollection(id);
    const b = z.object({
      recipients: z.array(Email).max(50).transform((l) => [...new Set(l.map((e) => e.toLowerCase()))]),
      send_when: z.enum(["always", "failure", "new_failure"]),
      enabled: z.boolean().default(true),
    }).parse(req.body);
    db.prepare(`INSERT INTO collection_reports (collection_id, recipients, send_when, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET recipients = excluded.recipients, send_when = excluded.send_when, enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(id, JSON.stringify(b.recipients), b.send_when, b.enabled ? 1 : 0, now());
    return ruleView(id);
  });

  // ---- A run's report ----
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/runs/:id/report.html", async (req, reply) => {
    const run = loadReportRun(db, Number(req.params.id));
    if (!run) throw new HttpError(404, "Run not found.");
    if (req.query.download) reply.header("content-disposition", `attachment; filename="qa-run-${run.id}-report.html"`);
    return reply.type("text/html; charset=utf-8").send(reportHtml(run, dashboardUrl(db)));
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/emails", async (req) =>
    (db.prepare("SELECT * FROM emails WHERE run_id = ? ORDER BY id").all(Number(req.params.id)) as any[]).map((e) => ({ ...e, recipients: JSON.parse(e.recipients) })));

  // Send now: to the given addresses, or to the collection's recipients.
  app.post<{ Params: { id: string } }>("/api/runs/:id/email", async (req) => {
    const id = Number(req.params.id);
    const run = db.prepare("SELECT collection_id, status FROM runs WHERE id = ?").get(id) as any;
    if (!run) throw new HttpError(404, "Run not found.");
    if (["queued", "running"].includes(run.status)) throw new HttpError(409, "Wait until the run has finished.");
    const { recipients } = z.object({ recipients: z.array(Email).max(50).optional() }).parse(req.body ?? {});
    const to = recipients?.length ? recipients : run.collection_id ? ruleView(run.collection_id).recipients : [];
    if (!to.length) throw new HttpError(400, "Add at least one email address.");
    const sent = await sendRunReport(db, id, to, "manual");
    if (sent.status === "failed") throw new HttpError(400, sent.error!);
    return sent;
  });
}
