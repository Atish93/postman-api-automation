// An AI run: starts the agent team (agent/orchestrator.ts) as its own process, using the engine's
// interface from phase 0: events on stdout (QA_EVENTS=1), approvals answered on stdin,
// a result file (QA_RESULT_FILE), and a settings file written for this run (QA_CONFIG).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSetting, type DB } from "../db.ts";
import type { RunOutcome, RunRow } from "./manager.ts";
import { statusFromFailures } from "./manager.ts";
import { loadEnvironment } from "./environment.ts";
import { fileURLToPath } from "node:url";

type Emit = (type: string, data: Record<string, unknown>) => void;
export type AiHandle = { done: Promise<RunOutcome>; answer: (text: string) => boolean; cancel: () => boolean };

export const agentDir = () => process.env.QA_AGENT_DIR ?? fileURLToPath(new URL("../../../agent/", import.meta.url));
const runsDir = () => process.env.QA_RUNS_DIR ?? fileURLToPath(new URL("../../data/runs/", import.meta.url));

export function runAi(db: DB, run: RunRow, emit: Emit): AiHandle {
  const env = loadEnvironment(db, run.environment_id!);
  const collection = db.prepare("SELECT postman_uid FROM collections WHERE id = ?").get(run.collection_id) as any;
  if (!collection?.postman_uid) {
    return { done: Promise.resolve({ status: "error", message: "AI runs need a collection imported from Postman." }), answer: () => false, cancel: () => false };
  }

  // This run's settings: the agent's own settings, with only the chosen environment.
  const dir = join(runsDir(), String(run.id));
  mkdirSync(dir, { recursive: true });
  const config = JSON.parse(readFileSync(join(agentDir(), "qa.config.json"), "utf8"));
  config.environments = { [env.name]: { label: env.label, baseUrl: env.baseUrl, healthPath: env.healthPath, variables: env.variables } };
  config.defaultEnvironment = env.name;
  writeFileSync(join(dir, "qa.config.json"), JSON.stringify(config, null, 2));
  const resultFile = join(dir, "result.json");

  const postmanKey = getSetting(db, "postman_api_key");
  const child = spawn("npx", ["tsx", "orchestrator.ts", "--env", env.name, "--regression", collection.postman_uid], {
    cwd: agentDir(),
    env: {
      ...process.env,
      ...(postmanKey && { POSTMAN_API_KEY: postmanKey }),
      QA_EVENTS: "1",
      QA_CONFIG: join(dir, "qa.config.json"),
      QA_RESULT_FILE: resultFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let waitingForApproval = false;
  let cancelled = false;

  const readLines = async (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
    for await (const line of createInterface({ input: stream })) {
      if (name === "stdout" && line.startsWith("@@event ")) {
        let ev: any;
        try {
          ev = JSON.parse(line.slice(8));
        } catch {
          continue;
        }
        const { seq: _seq, time: _time, type, ...data } = ev;
        if (type === "approval_request") waitingForApproval = true;
        if (type === "approval_answer") waitingForApproval = false;
        emit(type, data);
      } else if (line.trim() && !/ExperimentalWarning|UNDICI-EHPA|--trace-warnings/.test(line)) {
        emit("log", { stream: name, line });
      }
    }
  };

  const done = (async (): Promise<RunOutcome> => {
    const reading = Promise.all([readLines(child.stdout!, "stdout"), readLines(child.stderr!, "stderr")]);
    const code: number | null = await new Promise((r) => child.on("close", r));
    await reading;
    if (cancelled) return { status: "cancelled", message: "Cancelled while running.", exit_code: code };

    const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
    const cols: any[] = result?.collections ?? [];
    const sum = (k: string) => cols.reduce((n, c) => n + (c[k] ?? 0), 0);
    const failing = [...new Set(cols.flatMap((c) => (c.failures ?? []).map((f: any) => f.request)))] as string[];
    const status =
      code === 2 ? "server_issue"
      : code === 3 ? "circuit_breaker"
      : code === 0 && result ? statusFromFailures(failing)
      : "error";
    return {
      status,
      message: code === 2 ? result?.server_issue ?? "Facing server issues." : code === 3 ? "Circuit breaker tripped: too many requests failing at once." : status === "error" ? `The agent run ended with exit code ${code}.` : null,
      requests: result ? sum("requests") : null,
      assertions: result ? sum("assertions") : null,
      failed_assertions: result ? sum("failed_assertions") : null,
      cost_usd: result?.cost_usd ?? null,
      exit_code: code,
      result,
    };
  })();

  return {
    done,
    answer: (text) => {
      if (!waitingForApproval || child.exitCode !== null) return false;
      child.stdin!.write(text.replace(/\r?\n/g, " ") + "\n");
      return true;
    },
    cancel: () => {
      if (child.exitCode !== null) return false;
      cancelled = true;
      child.kill("SIGTERM");
      return true;
    },
  };
}
