// Queues runs and starts them, up to N at the same time (setting "max_parallel_runs", default 2),
// records their events, and lets live viewers follow along. Two runs of the same collection on the
// same environment never run together: they'd change and check the same data.
import { EventEmitter } from "node:events";
import { getSetting, now, type DB } from "../db.ts";
import { runPlain } from "./plain.ts";
import { runAi, type AiHandle } from "./ai.ts";

export type RunRow = {
  id: number;
  collection_id: number | null;
  environment_id: number | null;
  collection_name: string;
  environment_label: string;
  kind: "plain" | "ai";
  ai_mode: "regression" | "build" | "contract" | null;
  contract_id: number | null;
  contract_endpoints: string | null; // JSON array, or null for all
  request: string | null;
  workspace_id: string | null;
  schedule_id: number | null;
  unattended: number; // 1: nobody can answer approvals (scheduled runs), so they are refused
  data_file_id: number | null;   // plain runs: once per row of this test-data file
  data_file_name: string | null;
  parent_run_id: number | null;  // fix runs: the run whose failure is being fixed
  followup_json: string | null;  // fix runs: { collection, request, fix }
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
  private running = new Map<number, string>(); // run id -> its collection+environment key
  private aiRuns = new Map<number, AiHandle>(); // running AI runs, for approvals and cancelling

  // onFinished: called after a run is stored as finished (e.g. to email its report). Errors are logged, not thrown.
  constructor(private db: DB, private onFinished?: (runId: number) => Promise<void>) {
    this.bus.setMaxListeners(0);
    // Runs that were running when the server last stopped can't be resumed; queued ones still wait their turn.
    db.prepare("UPDATE runs SET status = 'error', message = 'The server stopped before this run finished.', finished_at = ? WHERE status = 'running'").run(now());
    db.prepare("UPDATE issue_actions SET status = 'failed', message = 'The server stopped before this finished.', finished_at = ? WHERE status = 'running'").run(now());
    this.queue = (db.prepare("SELECT id FROM runs WHERE status = 'queued' ORDER BY id").all() as any[]).map((r) => r.id);
    if (this.queue.length) queueMicrotask(() => this.pump());
  }

  // How many runs may run at the same time.
  maxParallel(): number {
    const n = Number(getSetting(this.db, "max_parallel_runs") ?? process.env.QA_MAX_PARALLEL ?? 2);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 2;
  }
  status() {
    return { running: [...this.running.keys()], queued: [...this.queue], max_parallel: this.maxParallel() };
  }

  enqueue(runId: number) {
    this.queue.push(runId);
    this.pump();
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

  // Starts queued runs while there's room, oldest first, skipping any whose collection+environment is busy.
  private pump() {
    for (let i = 0; i < this.queue.length && this.running.size < this.maxParallel(); ) {
      const runId = this.queue[i];
      const run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any as RunRow | undefined;
      if (!run || run.status !== "queued") { this.queue.splice(i, 1); continue; }
      // A build run makes a new collection, so it never clashes.
      const key = run.collection_id ? `${run.collection_id}:${run.environment_id}` : run.contract_id ? `contract:${run.contract_id}:${run.environment_id}` : `run:${runId}`;
      if ([...this.running.values()].includes(key)) { i++; continue; }
      this.queue.splice(i, 1);
      this.running.set(runId, key);
      void this.execute(run).finally(() => {
        this.running.delete(runId);
        this.pump();
      });
    }
  }

  private async execute(run: RunRow) {
    const runId = run.id;
    this.db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(now(), runId);
    this.addEvent(runId, "status", { status: "running" });
    let outcome: RunOutcome;
    try {
      if (run.kind === "plain") {
        outcome = await runPlain(this.db, run, (type, data) => this.addEvent(runId, type, data));
      } else {
        const handle = runAi(this.db, run, (type, data) => this.addEvent(runId, type, data));
        this.aiRuns.set(runId, handle);
        try {
          outcome = await handle.done;
        } finally {
          this.aiRuns.delete(runId);
        }
      }
    } catch (e: any) {
      outcome = { status: "error", message: e.message };
    }
    this.finish(runId, outcome);
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
    if (this.onFinished) this.onFinished(runId).catch((e) => console.error(`After run ${runId}:`, e));
  }
}

// Status from failures: only KNOWN BUG requests failing still counts as a pass, with known bugs.
export function statusFromFailures(failingRequests: string[]): string {
  if (!failingRequests.length) return "passed";
  return failingRequests.every((n) => n.startsWith("KNOWN BUG - ")) ? "passed_with_known_bugs" : "failed";
}
