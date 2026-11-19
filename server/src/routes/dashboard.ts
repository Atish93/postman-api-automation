// The dashboard's numbers in one call: headline figures, runs per day by outcome, open known bugs, latest runs.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";

// Run statuses grouped the way the dashboard shows them.
const GROUP: Record<string, string> = {
  passed: "passed",
  passed_with_known_bugs: "known_bugs",
  failed: "failed",
  server_issue: "server_issue",
  circuit_breaker: "other",
  error: "other",
};
const PASSING = new Set(["passed", "passed_with_known_bugs"]);
const day = (iso: string) => iso.slice(0, 10);

// The names of failing requests in a run's stored results (plain or AI).
export function failingRequests(resultJson: string | null): string[] {
  if (!resultJson) return [];
  const r = JSON.parse(resultJson);
  if (Array.isArray(r.executions))
    return r.executions.filter((e: any) => e.assertions.some((a: any) => a.error) || e.error || (e.status ?? 0) >= 500).map((e: any) => e.request);
  return [...new Set((r.collections ?? []).flatMap((c: any) => (c.failures ?? []).map((f: any) => f.request)))] as string[];
}

export function dashboardRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/dashboard", async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }).parse(req.query);
    const today = new Date();
    const since = new Date(today.getTime() - (days - 1) * 86_400_000);
    const sinceDay = day(since.toISOString());

    // Finished runs only (cancelled ones don't count towards pass rates), far enough back for the
    // chart and for last week's figures, whichever reaches further.
    const twoWeeksAgo = day(new Date(today.getTime() - 13 * 86_400_000).toISOString());
    const runs = db.prepare(`SELECT id, status, kind, cost_usd, finished_at FROM runs
      WHERE finished_at IS NOT NULL AND status != 'cancelled' AND finished_at >= ?`).all(twoWeeksAgo < sinceDay ? twoWeeksAgo : sinceDay) as any[];

    // Runs per day, by outcome, with every day present (zeros included) so the chart has no gaps.
    const daily = Array.from({ length: days }, (_, i) => {
      const d = day(new Date(since.getTime() + i * 86_400_000).toISOString());
      return { date: d, passed: 0, known_bugs: 0, failed: 0, server_issue: 0, other: 0, total: 0, pass_rate: null as number | null };
    });
    const byDay = new Map(daily.map((d) => [d.date, d]));
    for (const r of runs) {
      const d = byDay.get(day(r.finished_at));
      if (!d) continue;
      (d as any)[GROUP[r.status] ?? "other"]++;
      d.total++;
    }
    for (const d of daily) d.pass_rate = d.total ? (d.passed + d.known_bugs) / d.total : null;

    // Headline figures: the last 7 days, compared with the 7 before.
    const window = (fromDaysAgo: number, toDaysAgo: number) => {
      const from = day(new Date(today.getTime() - fromDaysAgo * 86_400_000).toISOString());
      const to = day(new Date(today.getTime() - toDaysAgo * 86_400_000).toISOString());
      const w = runs.filter((r) => day(r.finished_at) >= from && day(r.finished_at) <= to);
      return {
        runs: w.length,
        pass_rate: w.length ? w.filter((r) => PASSING.has(r.status)).length / w.length : null,
        ai_cost_usd: Number(w.reduce((n, r) => n + (r.cost_usd ?? 0), 0).toFixed(4)),
        ai_runs: w.filter((r) => r.kind === "ai").length,
      };
    };

    // Open known bugs: failing KNOWN BUG requests in the latest finished run of each collection + environment.
    const latest = db.prepare(`SELECT r.* FROM runs r WHERE r.id IN (
        SELECT MAX(id) FROM runs WHERE finished_at IS NOT NULL AND status NOT IN ('cancelled', 'error', 'server_issue', 'circuit_breaker')
        -- by id, so two collections with the same name stay apart; by name only once a collection was deleted
        GROUP BY COALESCE(CAST(collection_id AS TEXT), 'deleted:' || collection_name), COALESCE(CAST(environment_id AS TEXT), 'deleted:' || environment_label))`).all() as any[];
    const knownBugs = latest.flatMap((r) =>
      failingRequests(r.result_json)
        .filter((n) => n.startsWith("KNOWN BUG - "))
        .map((n) => ({ request: n.slice("KNOWN BUG - ".length), collection: r.collection_name, environment: r.environment_label, run_id: r.id, seen_at: r.finished_at })),
    );

    const latestRuns = (db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 8").all() as any[]).map((r) => ({
      id: r.id, kind: r.kind, status: r.status, collection: r.collection_name, environment: r.environment_label,
      failed_assertions: r.failed_assertions, cost_usd: r.cost_usd, created_at: r.created_at, finished_at: r.finished_at,
    }));

    return { days, this_week: window(6, 0), last_week: window(13, 7), daily, known_bugs: knownBugs, latest_runs: latestRuns };
  });
}
