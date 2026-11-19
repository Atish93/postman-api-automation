// Queues runs, runs them one at a time, records their events, and lets live viewers follow along.
import { EventEmitter } from "node:events";
import { now, type DB } from "../db.ts";
import { runPlain } from "./plain.ts";
import { runAi, type AiHandle } from "./ai.ts";

export type RunRow = {
  id: number;
  collection_id: number | null;
  environment_id: number | null;
  collection_name: string;
  environment_label: string;
  kind: "plain" | "ai";
  ai_mode: "regression" | "build" | null;
  request: string | null;
  workspace_id: string | null;
  status: string;
};

// What a finished run reports back; the manager stores it.
export type RunOutcome = {
  status: string;
  message?: string | null;
  requests?: number | null;
  assertions?: number | null;
  failed_assertions?: number | null;
  cost_usd?: number | null;
  exit_code?: number | null;
  result?: unknown;
};

export const FINISHED = ["passed", "passed_with_known_bugs", "failed", "server_issue", "circuit_breaker", "error", "cancelled"];

export class RunManager {
  private bus = new EventEmitter();
  private queue: number[] = [];
  private working = false;
  private aiRuns = new Map<number, AiHandle>(); // running AI runs, for approvals and cancelling

  constructor(private db: DB) {
    this.bus.setMaxListeners(0);
    // Runs that were queued or running when the server last stopped can't be resumed.
    db.prepare("UPDATE runs SET status = 'error', message = 'The server stopped before this run finished.', finished_at = ? WHERE status IN ('queued', 'running')").run(now());
  }

  enqueue(runId: number) {
    this.queue.push(runId);
    void this.work();
  }

  // Records an event and tells anyone watching the run.
  addEvent(runId: number, type: string, data: Record<string, unknown> = {}) {
    const seq = Number((this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?").get(runId) as any).next);
    const created_at = now();
    this.db.prepare("INSERT INTO run_events (run_id, seq, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, seq, type, JSON.stringify(data), created_at);
    this.bus.emit(`run:${runId}`, { seq, type, data, created_at });
  }

  subscribe(runId: number, listener: (event: any) => void) {
    this.bus.on(`run:${runId}`, listener);
    return () => this.bus.off(`run:${runId}`, listener);
  }

  answerApproval(runId: number, answer: string): boolean {
    return this.aiRuns.get(runId)?.answer(answer) ?? false;
  }

  cancel(runId: number): boolean {
    const run = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as any;
    if (run?.status === "queued") {
      this.queue = this.queue.filter((id) => id !== runId);
      this.finish(runId, { status: "cancelled", message: "Cancelled before it started." });
      return true;
    }
    return this.aiRuns.get(runId)?.cancel() ?? false;
  }

  private async work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const runId = this.queue.shift()!;
        const run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any as RunRow;
        if (!run || run.status !== "queued") continue;
        this.db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(now(), runId);
        this.addEvent(runId, "status", { status: "running" });
        let outcome: RunOutcome;
        try {
          if (run.kind === "plain") {
            outcome = await runPlain(this.db, run, (type, data) => this.addEvent(runId, type, data));
          } else {
            const handle = runAi(this.db, run, (type, data) => this.addEvent(runId, type, data));
            this.aiRuns.set(runId, handle);
            outcome = await handle.done;
            this.aiRuns.delete(runId);
          }
        } catch (e: any) {
          outcome = { status: "error", message: e.message };
        }
        this.finish(runId, outcome);
      }
    } finally {
      this.working = false;
    }
  }

  private finish(runId: number, o: RunOutcome) {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, message = ?, requests = ?, assertions = ?, failed_assertions = ?, cost_usd = ?,
         exit_code = ?, result_json = ?, finished_at = ? WHERE id = ?`,
      )
      .run(o.status, o.message ?? null, o.requests ?? null, o.assertions ?? null, o.failed_assertions ?? null, o.cost_usd ?? null,
        o.exit_code ?? null, o.result === undefined ? null : JSON.stringify(o.result), now(), runId);
    this.addEvent(runId, "finished", { status: o.status, message: o.message ?? null });
  }
}

// Status from failures: only KNOWN BUG requests failing still counts as a pass, with known bugs.
export function statusFromFailures(failingRequests: string[]): string {
  if (!failingRequests.length) return "passed";
  return failingRequests.every((n) => n.startsWith("KNOWN BUG - ")) ? "passed_with_known_bugs" : "failed";
}
