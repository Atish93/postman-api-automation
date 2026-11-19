// Email: SMTP settings, deciding when a finished run is reported, sending, and the email log.
import nodemailer from "nodemailer";
import { getSetting, now, setSetting, type DB } from "./db.ts";
import { HttpError } from "./errors.ts";
import { failuresOf, loadReportRun, reportEmail, reportHtml, type ReportRun } from "./report.ts";

export type SmtpSettings = { host: string; port: number; secure: boolean; user: string; from: string; dashboard_url: string };

export function smtpSettings(db: DB): SmtpSettings | null {
  const raw = getSetting(db, "smtp");
  return raw ? JSON.parse(raw) : null;
}
export const dashboardUrl = (db: DB) => smtpSettings(db)?.dashboard_url || "http://127.0.0.1:4000";
export const hasSmtpPassword = (db: DB) => !!getSetting(db, "smtp_password");

export function saveSmtpSettings(db: DB, s: SmtpSettings, password: string | null | undefined) {
  setSetting(db, "smtp", JSON.stringify(s));
  if (password === "") setSetting(db, "smtp_password", null); // cleared
  else if (password) setSetting(db, "smtp_password", password); // null/undefined: keep the saved one
}

function transport(db: DB) {
  const s = smtpSettings(db);
  if (!s) throw new HttpError(400, "Email isn't set up. Add your SMTP details in Settings first.");
  const pass = getSetting(db, "smtp_password");
  return {
    from: s.from || s.user,
    mailer: nodemailer.createTransport({
      host: s.host, port: s.port, secure: s.secure,
      auth: s.user ? { user: s.user, pass: pass ?? "" } : undefined,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    }),
  };
}

// SMTP errors are technical; say what usually fixes them.
function explain(e: any): string {
  const msg = String(e?.message ?? e);
  if (e?.code === "EAUTH" || /Invalid login|Username and Password not accepted|535/.test(msg))
    return `The mail server rejected the login. For Gmail, use an app password (not your normal password). (${msg})`;
  if (["ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "ECONNECTION", "EDNS"].includes(e?.code))
    return `Couldn't reach the mail server: check the host, port and the SSL setting (Gmail: smtp.gmail.com, port 465 with SSL). (${msg})`;
  return msg;
}

export async function sendTestEmail(db: DB, to: string) {
  const { from, mailer } = transport(db);
  try {
    await mailer.sendMail({ from, to, subject: "[QA] Test email from your QA dashboard", text: "Email works. Run reports will arrive like this.", html: "<p>Email works. Run reports will arrive like this.</p>" });
  } catch (e) {
    throw new HttpError(400, explain(e));
  }
}

// Sends a run's report and records it. Returns the logged email.
export async function sendRunReport(db: DB, runId: number, recipients: string[], trigger: "rule" | "manual") {
  const run = loadReportRun(db, runId);
  if (!run) throw new HttpError(404, "Run not found.");
  const { subject, html, text } = reportEmail(run, dashboardUrl(db));
  const log = (status: "sent" | "failed", error: string | null) =>
    Number(db.prepare("INSERT INTO emails (run_id, recipients, subject, status, error, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, JSON.stringify(recipients), subject, status, error, trigger, now()).lastInsertRowid);
  try {
    const { from, mailer } = transport(db);
    await mailer.sendMail({
      from, to: recipients.join(", "), subject, html, text,
      attachments: [{ filename: `qa-run-${run.id}-report.html`, content: reportHtml(run, dashboardUrl(db)), contentType: "text/html; charset=utf-8" }],
    });
    log("sent", null);
    return { status: "sent" as const, recipients, subject };
  } catch (e: any) {
    const error = e instanceof HttpError ? e.message : explain(e);
    log("failed", error);
    return { status: "failed" as const, recipients, subject, error };
  }
}

// ---- When a finished run is reported, by the collection's rule ----

const PASSING = new Set(["passed", "passed_with_known_bugs"]);
const unexplained = (run: ReportRun) => new Set(failuresOf(run).filter((f) => !f.knownBug).map((f) => f.request));

// Why this run should be emailed under the rule, or null if it shouldn't.
export function reasonToSend(db: DB, run: ReportRun & { collection_id: number | null; environment_id: number | null }, sendWhen: string): string | null {
  if (["cancelled", "queued", "running"].includes(run.status)) return null;
  if (sendWhen === "always") return "always";
  if (PASSING.has(run.status)) return null;
  if (sendWhen === "failure") return "failed";
  // new_failure: something wrong that wasn't wrong in the previous finished run of this collection + environment.
  const prevRow = db.prepare(`SELECT id FROM runs WHERE collection_id = ? AND environment_id = ? AND id < ?
    AND finished_at IS NOT NULL AND status != 'cancelled' ORDER BY id DESC LIMIT 1`).get(run.collection_id, run.environment_id, run.id) as any;
  if (!prevRow) return "first run, and it didn't pass";
  const prev = loadReportRun(db, prevRow.id)!;
  if (PASSING.has(prev.status)) return `it passed last time (run #${prev.id})`;
  if (run.status !== prev.status) return `last time it was ${prev.status.replace(/_/g, " ")} (run #${prev.id})`;
  if (run.status !== "failed") return null; // the same server issue, breaker or error as last time
  // Both failed: report only if a request is failing that wasn't before (known bugs don't count).
  const before = unexplained(prev);
  const fresh = [...unexplained(run)].filter((r) => !before.has(r));
  return fresh.length ? `new failures: ${fresh.join(", ")}` : null;
}

// Called when any run finishes: emails it if its collection's rule says so.
export async function notifyRunFinished(db: DB, runId: number): Promise<{ status: string; reason: string; recipients: string[]; error?: string } | null> {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
  if (!row?.collection_id) return null;
  const rule = db.prepare("SELECT * FROM collection_reports WHERE collection_id = ? AND enabled = 1").get(row.collection_id) as any;
  const recipients: string[] = rule ? JSON.parse(rule.recipients) : [];
  if (!rule || !recipients.length) return null;
  const run = loadReportRun(db, runId)!;
  const reason = reasonToSend(db, { ...run, collection_id: row.collection_id, environment_id: row.environment_id }, rule.send_when);
  if (!reason) return null;
  const sent = await sendRunReport(db, runId, recipients, "rule");
  return { status: sent.status, reason, recipients, ...(sent.status === "failed" && { error: sent.error }) };
}
