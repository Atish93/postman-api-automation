// Checks the engine's interface for the dashboard server (phase 0), without any model calls:
// events on stdout, approvals answered by another program, and the result file.
// Run: npm run check:events
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failed++;
}

// Starts a program with QA_EVENTS=1 and collects its events. answer() is called for each approval request.
async function run(args: string[], env: Record<string, string>, answer?: (ev: any) => string) {
  const child = spawn("npx", ["tsx", ...args], { cwd: root, env: { ...process.env, QA_EVENTS: "1", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const events: any[] = [];
  const log: string[] = [];
  for await (const line of createInterface({ input: child.stdout! })) {
    if (!line.startsWith("@@event ")) { log.push(line); continue; }
    const ev = JSON.parse(line.slice("@@event ".length));
    events.push(ev);
    if (ev.type === "approval_request" && answer) child.stdin!.write(answer(ev) + "\n");
  }
  const code: number = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("exit", r)));
  return { events, log, code };
}

console.log("-- Approvals answered by another program --");
let r = await run(["tests/helpers/approval-child.ts"], {}, () => "y");
const req = r.events.find((e) => e.type === "approval_request");
check("an approval request is emitted with the diff", req?.kind === "assertion change" && Array.isArray(req.diff) && req.diff.length > 0, JSON.stringify(req));
check("answering y applies the change", r.log.includes("OUTCOME applied") && r.events.some((e) => e.type === "change_pending" && e.approved_by_human));
check("the answer is recorded as an event", r.events.some((e) => e.type === "approval_answer" && e.answer === "y"));
r = await run(["tests/helpers/approval-child.ts"], {}, () => "no, keep 200");
check("answering anything else refuses it", r.log.includes("OUTCOME refused") && !r.events.some((e) => e.type === "change_pending"));
check("every event has seq, time and type", r.events.every((e) => typeof e.seq === "number" && e.time && e.type));

console.log("\n-- Result file when the server is down (no agents start) --");
const server = createServer((_q, res) => res.writeHead(503).end());
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const dir = mkdtempSync(join(tmpdir(), "qa-events-"));
const cfg = JSON.parse(readFileSync(join(root, "qa.config.json"), "utf8"));
cfg.environments.mock = { label: "Mock", baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, healthPath: "/ping" };
writeFileSync(join(dir, "qa.config.json"), JSON.stringify(cfg));
r = await run(["orchestrator.ts", "--env", "mock", "--regression", "some-uid"], { QA_CONFIG: join(dir, "qa.config.json"), QA_RESULT_FILE: join(dir, "result.json") });
server.close();
const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
check("exit code 2", r.code === 2, String(r.code));
check("events: run_started, server_issue, run_finished", ["run_started", "server_issue", "run_finished"].every((t) => r.events.some((e) => e.type === t)), r.events.map((e) => e.type).join(", "));
check("result file has the exit code and the message", result.exit_code === 2 && String(result.server_issue).startsWith("Facing server issues, please check Mock Env") && result.environment.label === "Mock", JSON.stringify(result).slice(0, 300));

console.log(`\n${failed ? `${failed} check(s) FAILED` : "All checks passed"}`);
process.exit(failed ? 1 : 0);
