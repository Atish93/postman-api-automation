// Starts scheduled runs. Schedules use 5-field cron expressions in the server's local time.
// Runs only while the server is running; a run missed while it was off isn't made up later.
import { CronExpressionParser } from "cron-parser";
import { now, type DB } from "./db.ts";
import { HttpError } from "./errors.ts";
import type { RunManager } from "./runs/manager.ts";

// The next n times a cron expression fires after `from`. Throws a 400 with the reason if it's invalid.
export function nextRuns(cron: string, from = new Date(), n = 3): Date[] {
  if (cron.trim().split(/\s+/).length !== 5) throw new HttpError(400, "Use 5 fields: minute hour day-of-month month day-of-week, e.g. 0 7 * * 1-5");
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: from });
    return Array.from({ length: n }, () => it.next().toDate());
  } catch (e: any) {
    throw new HttpError(400, `That schedule isn't valid: ${e.message}`);
  }
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private db: DB, private runs: RunManager) {}

  start(intervalMs = 30_000) {
    // Skip runs missed while the server was off: move overdue schedules to their next time from now.
    const t = new Date();
    for (const s of this.db.prepare("SELECT id, cron FROM schedules WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)").all(t.toISOString()) as any[])
      this.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(nextRuns(s.cron, t, 1)[0].toISOString(), s.id);
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Starts every due schedule. Returns the run ids started (the tests call this directly).
  tick(at = new Date()): number[] {
    const started: number[] = [];
    const due = this.db.prepare(`SELECT s.*, c.name AS collection_name, c.postman_uid, e.label AS environment_label
      FROM schedules s JOIN collections c ON c.id = s.collection_id JOIN environments e ON e.id = s.environment_id
      WHERE s.enabled = 1 AND s.next_run_at <= ?`).all(at.toISOString()) as any[];
    for (const s of due) {
      this.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(nextRuns(s.cron, at, 1)[0].toISOString(), s.id);
      // Don't pile up: skip if this schedule's previous run hasn't finished.
      if (this.db.prepare("SELECT 1 FROM runs WHERE schedule_id = ? AND status IN ('queued', 'running')").get(s.id)) continue;
      if (s.kind === "ai" && !s.postman_uid) continue; // AI runs need a Postman collection (checked when saving too)
      const id = Number(this.db.prepare(`INSERT INTO runs (collection_id, environment_id, collection_name, environment_label, kind, ai_mode, schedule_id, unattended, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?)`)
        .run(s.collection_id, s.environment_id, s.collection_name, s.environment_label, s.kind, s.kind === "ai" ? "regression" : null, s.id, now()).lastInsertRowid);
      this.runs.addEvent(id, "status", { status: "queued", scheduled: true });
      this.runs.enqueue(id);
      started.push(id);
    }
    return started;
  }
}
