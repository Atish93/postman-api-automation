// An AI run: starts the agent team (agent/orchestrator.ts) as its own process, using the engine's
// interface from phase 0: events on stdout (QA_EVENTS=1), approvals answered on stdin,
// a result file (QA_RESULT_FILE), and a settings file written for this run (QA_CONFIG).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db.ts";
import { getSecretSetting } from "../secrets.ts";
import type { RunOutcome, RunRow } from "./manager.ts";
import { statusFromFailures } from "./manager.ts";
import { loadEnvironment } from "./environment.ts";
import { importFromPostman } from "../collections.ts";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { authOf, resolveServers } from "../contracts.ts";

type Emit = (type: string, data: Record<string, unknown>) => void;
export type AiHandle = { done: Promise<RunOutcome>; answer: (text: string) => boolean; cancel: () => boolean };

export const agentDir = () => process.env.QA_AGENT_DIR ?? fileURLToPath(new URL("../../../agent/", import.meta.url));
const runsDir = () => process.env.QA_RUNS_DIR ?? fileURLToPath(new URL("../../data/runs/", import.meta.url));

export function runAi(db: DB, run: RunRow, emit: Emit): AiHandle {
  const env = loadEnvironment(db, run.environment_id!);
  const build = run.ai_mode === "build";
  const contractRun = run.ai_mode === "contract";
  const failed = (message: string): AiHandle => ({ done: Promise.resolve({ status: "error", message }), answer: () => false, cancel: () => false });
  // regression: re-check a published collection.  build: plan, build and publish a new one.
  let args: string[];
  const dir = join(runsDir(), String(run.id));
  if (contractRun) {
    // The contract goes to the agents as a file: the parsed spec, or the document's text.
    const c = db.prepare("SELECT * FROM contracts WHERE id = ?").get(run.contract_id) as any;
    if (!c) return failed("The contract no longer exists.");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "contract.json");
    const spec = c.format === "openapi" ? (specOf(c)) : null;
    writeFileSync(file, JSON.stringify({
      name: c.name, title: c.title, api_version: c.api_version, format: c.format, spec_version: c.spec_version,
      servers: resolveServers(JSON.parse(c.servers), c.source_kind === "url" ? c.source_ref : null), endpoints: JSON.parse(c.endpoints),
      auth: spec ? authOf(spec) : null, base_url: env.baseUrl,
      selected: run.contract_endpoints ? JSON.parse(run.contract_endpoints) : null,
      focus: run.request ?? null,
      spec, text: c.format === "document" ? c.text : null,
    }));
    args = ["--contract", file];
  } else if (build) {
    if (!run.request || !run.workspace_id) return failed("A build run needs a request and a workspace.");
    args = [run.request, run.workspace_id];
  } else {
    const collection = db.prepare("SELECT postman_uid FROM collections WHERE id = ?").get(run.collection_id) as any;
    if (!collection?.postman_uid) return failed("AI runs need a collection imported from Postman.");
    args = ["--regression", collection.postman_uid];
  }

  // This run's settings: the agent's own settings, with only the chosen environment.
  mkdirSync(dir, { recursive: true });
  const config = JSON.parse(readFileSync(join(agentDir(), "qa.config.json"), "utf8"));
  config.environments = { [env.name]: { label: env.label, baseUrl: env.baseUrl, healthPath: env.healthPath, variables: env.variables } };
  config.defaultEnvironment = env.name;
  // It holds the environment's secrets in plain text for the agent, so only the owner can read it,
  // and it is deleted as soon as the agent process ends.
  const configFile = join(dir, "qa.config.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  const resultFile = join(dir, "result.json");

  const postmanKey = getSecretSetting(db, "postman_api_key");
  const child = spawn("npx", ["tsx", "orchestrator.ts", "--env", env.name, ...args], {
    cwd: agentDir(),
    env: {
      ...process.env,
      ...(postmanKey && { POSTMAN_API_KEY: postmanKey }),
      QA_EVENTS: "1",
      // Scheduled runs are unattended: approval requests are refused instead of waiting forever.
      ...(run.unattended ? { QA_NO_PROMPTS: "1" } : {}),
      QA_CONFIG: configFile,
      QA_RESULT_FILE: resultFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.on("error", () => rmSync(configFile, { force: true }));

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
    rmSync(configFile, { force: true });
    await reading;
    if (cancelled) return { status: "cancelled", message: "Cancelled while running.", exit_code: code };

    const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
    if (build) await linkPublishedCollection(db, run.id, result, emit);
    if (contractRun && result?.contract) saveFoundEndpoints(db, run.contract_id!, result.contract);
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

// After a build run: import the collection the agents published, and link the run to it,
// so it appears on the Collections page with this run in its history.
export async function linkPublishedCollection(db: DB, runId: number, result: any, emit: Emit) {
  const published = (result?.collections ?? []).map((c: any) => c.published).find((p: any) => p?.uid);
  if (!published) return;
  try {
    const collectionId = await importFromPostman(db, published.uid);
    const name = (db.prepare("SELECT name FROM collections WHERE id = ?").get(collectionId) as any).name;
    db.prepare("UPDATE runs SET collection_id = ?, collection_name = ? WHERE id = ?").run(collectionId, name, runId);
    emit("collection_imported", { collection_id: collectionId, name, uid: published.uid });
  } catch (e: any) {
    emit("log", { stream: "server", line: `The new collection was published to Postman (${published.uid}) but couldn't be imported here: ${e.message}. Import it from the Collections page.` });
  }
}

// The stored contract's spec as an object (it was checked when the contract was added).
function specOf(c: any) {
  const text = Buffer.from(c.original).toString("utf8").replace(/^\uFEFF/, "").trim();
  return text.startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
}

// For a document, the endpoints are found by the agent: keep its list on the contract, so the page shows them.
export function saveFoundEndpoints(db: DB, contractId: number, contract: any) {
  const c = db.prepare("SELECT format FROM contracts WHERE id = ?").get(contractId) as any;
  const found: any[] = contract?.plan?.endpoints_found ?? [];
  if (c?.format !== "document" || !found.length) return;
  const endpoints = found.filter((e) => e?.method && e?.path).map((e) => ({
    key: `${String(e.method).toUpperCase()} ${e.path}`, method: String(e.method).toUpperCase(), path: e.path, summary: e.summary ?? null,
    operation_id: null, tags: [], parameters: 0, has_body: false, responses: (e.responses ?? []).map(String), secured: !!e.secured, deprecated: false, fingerprint: "",
  }));
  db.prepare("UPDATE contracts SET endpoints = ? WHERE id = ?").run(JSON.stringify(endpoints), contractId);
}
