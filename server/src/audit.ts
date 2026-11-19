// The audit log: who did what, and when. Summaries are written for people and never contain secret values.
import { now, type DB } from "./db.ts";

export type Actor = "admin" | "schedule" | "system" | "cli";

export function audit(db: DB, e: { actor: Actor; ip?: string | null; action: string; summary: string; details?: Record<string, unknown> }) {
  db.prepare("INSERT INTO audit_log (at, actor, ip, action, summary, details) VALUES (?, ?, ?, ?, ?, ?)")
    .run(now(), e.actor, e.ip ?? null, e.action, e.summary, e.details ? JSON.stringify(e.details) : null);
}

// Older entries are removed after this many days (QA_AUDIT_DAYS, default a year).
export function pruneAudit(db: DB, days = Number(process.env.QA_AUDIT_DAYS ?? 365)) {
  db.prepare("DELETE FROM audit_log WHERE at < ?").run(new Date(Date.now() - days * 86_400_000).toISOString());
}
