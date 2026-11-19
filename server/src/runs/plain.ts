// A plain run: the collection through Newman, no AI. Free, and usually done in seconds.
import newman from "newman";
import type { DB } from "../db.ts";
import type { RunOutcome, RunRow } from "./manager.ts";
import { statusFromFailures } from "./manager.ts";
import { healthCheck, loadEnvironment, serverIssueMessage } from "./environment.ts";
import { parseDataFile } from "../datafiles.ts";

type Emit = (type: string, data: Record<string, unknown>) => void;

// Same rule as the agents: it's an outage only if most requests (at least 3) got server errors.
const OUTAGE_PERCENT = 80;
const OUTAGE_MIN_REQUESTS = 3;

export async function runPlain(db: DB, run: RunRow, emit: Emit): Promise<RunOutcome> {
  const env = loadEnvironment(db, run.environment_id!);
  const row = db.prepare("SELECT json FROM collections WHERE id = ?").get(run.collection_id) as any;
  if (!row) return { status: "error", message: "The collection no longer exists." };
  // With a test-data file, the collection runs once per row; each row's columns are variables.
  let rows: Record<string, string>[] | undefined;
  if (run.data_file_name) {
    const f = run.data_file_id ? db.prepare("SELECT name, content FROM data_files WHERE id = ?").get(run.data_file_id) as any : null;
    if (!f) return { status: "error", message: `The test-data file "${run.data_file_name}" was deleted before the run started.` };
    rows = parseDataFile(f.name, f.content).rows;
    emit("data_file", { name: f.name, rows: rows.length });
  }

  const unhealthy = await healthCheck(env);
  if (unhealthy) {
    emit("server_issue", { message: serverIssueMessage(env.label), details: unhealthy });
    return { status: "server_issue", message: `${serverIssueMessage(env.label)}. ${unhealthy}` };
  }

  const executions: any[] = [];
  const summary: any = await new Promise((resolve, reject) => {
    const runner = newman.run(
      {
        collection: JSON.parse(row.json),
        reporters: [],
        timeoutRequest: 30_000,
        ...(rows && { iterationData: rows, iterationCount: rows.length }),
        // The environment's values win over the collection's own variables.
        envVar: [...Object.entries(env.variables).map(([key, value]) => ({ key, value })), { key: "baseUrl", value: env.baseUrl }],
      },
      (err: unknown, s: unknown) => (err ? reject(err) : resolve(s)),
    );
    // Report each request as soon as it finishes, for the live view.
    runner.on("item", (_err: unknown, args: any) => {
      const x = summaryLess(args, runner, !!rows);
      if (x) {
        executions.push(x);
        emit("request_done", x);
      }
    });
  });

  // Newman's own summary is the source of truth for the stored results.
  const results = summary.run.executions.map((x: any) => ({
    request: x.item.name,
    ...(rows && { iteration: (x.cursor?.iteration ?? 0) + 1 }), // which row of the data file (from 1)
    method: x.request?.method,
    url: x.request?.url?.toString(),
    status: x.response?.code ?? null,
    response_time_ms: x.response?.responseTime ?? null,
    error: x.requestError?.message ?? null,
    body: x.response?.stream?.toString().slice(0, 2000) ?? "",
    assertions: (x.assertions ?? []).map((a: any) => ({ name: a.assertion, error: a.error?.message ?? null })),
  }));
  const failing = results.filter((r: any) => r.assertions.some((a: any) => a.error) || r.error || (r.status ?? 0) >= 500);
  const failedAssertions = results.reduce((n: number, r: any) => n + r.assertions.filter((a: any) => a.error).length, 0);
  const serverErrors = results.filter((r: any) => (r.status ?? 0) >= 500 || r.error).length;
  const outage = serverErrors >= Math.max(Math.min(OUTAGE_MIN_REQUESTS, results.length), Math.ceil((results.length * OUTAGE_PERCENT) / 100));

  const outcome: RunOutcome = {
    status: outage ? "server_issue" : statusFromFailures(failing.map((r: any) => r.request)),
    message: outage ? `${serverIssueMessage(env.label)}. ${serverErrors} of ${results.length} requests got server errors.` : null,
    requests: summary.run.stats.requests.total,
    assertions: summary.run.stats.assertions.total,
    failed_assertions: failedAssertions,
    cost_usd: 0,
    result: {
      environment: { name: env.name, label: env.label, base_url: env.baseUrl },
      ...(rows && { data_file: { name: run.data_file_name, rows: rows.length } }),
      executions: results,
    },
  };
  if (outage) emit("server_issue", { message: serverIssueMessage(env.label), details: outcome.message });
  return outcome;
}

// Newman's "item" event fires when a request and its tests are done; build a small live record from it.
function summaryLess(args: any, runner: any, withRows: boolean) {
  const exec = runner.summary?.run?.executions?.find((e: any) => e.id === args.item?.id) ??
    [...(runner.summary?.run?.executions ?? [])].reverse().find((e: any) => e.item?.id === args.item?.id);
  if (!exec) return null;
  return {
    request: args.item.name,
    ...(withRows && { iteration: (args.cursor?.iteration ?? 0) + 1 }),
    status: exec.response?.code ?? null,
    response_time_ms: exec.response?.responseTime ?? null,
    error: exec.requestError?.message ?? null,
    failed_assertions: (exec.assertions ?? []).filter((a: any) => a.error).map((a: any) => ({ name: a.assertion, error: a.error.message })),
  };
}
