// Checks every guard in tools.ts directly, without starting any agent, so it costs nothing.
// Run: npm run check
//
// Uses the faulty fixture (eval/fixtures/booking-lifecycle-faults.json) against the real demo API,
// and a tiny fake server on this machine to simulate 5xx errors and mass failures.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Fake server: its behaviour is switched per check ----
// all404: every route but /ping answers 404.   one500: like all404, but the checkin filter crashes with 500.
// server500: every route but /ping answers 500. ping503: the health check fails too.
let mode: "all404" | "one500" | "server500" | "ping503" = "all404";
const server = createServer((req, res) => {
  if (req.url === "/ping") return res.writeHead(mode === "ping503" ? 503 : 201).end("Created");
  if (mode === "server500" || mode === "ping503") return res.writeHead(500).end("Internal Server Error");
  if (mode === "one500" && req.url?.includes("checkin=")) return res.writeHead(500).end("Internal Server Error");
  res.writeHead(404).end("Not Found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;

// ---- A test config: the real one plus a "mock" environment and small limits ----
const real = JSON.parse(readFileSync(new URL("../qa.config.json", import.meta.url), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "qa-check-"));
const cfg = {
  ...real,
  environments: { ...real.environments, mock: { label: "Mock", baseUrl: `http://127.0.0.1:${port}`, healthPath: "/ping" } },
  circuitBreaker: { minFailingRequests: 5, failingRequestPercent: 15 },
  serverErrors: { terminateAtPercent: 80, minRequests: 3, recheckAfterSeconds: 0 },
  limits: { healsPerRun: 2, newKnownBugsPerRun: 1, attemptsPerRequest: 2 },
};
writeFileSync(join(dir, "qa.config.json"), JSON.stringify(cfg));
process.env.QA_CONFIG = join(dir, "qa.config.json");
process.env.QA_NO_PROMPTS = "1"; // nobody answers approval prompts, as in CI
process.env.QA_NO_LEARNING = "1"; // keep test findings out of the knowledge base

const t = await import("../tools.ts");
const { selectEnvironment } = await import("../config.ts");
const fixture = fileURLToPath(new URL("../eval/fixtures/booking-lifecycle-faults.json", import.meta.url));
const x: any = {};
const call = async (tool: any, input: any = {}) => {
  const r = await tool.handler(input, x);
  return { text: r.content[0].text as string, error: !!r.isError };
};
const req = (name: string) => t.snapshot().collection.item.find((i: any) => i.name === name);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failed++;
}
const diagnose = (request: string, category: string) =>
  call(t.recordDiagnosis, { request, assertion: "x", category, confidence: "high", evidence: "check-guards" });

// ================= Against the real demo API (Test environment) =================
console.log("\n-- Short run reports --");
t.loadCollectionFile(fixture);
let run = await call(t.rerunCollection);
const report = JSON.parse(run.text);
check("report lists only failed requests", report.failed_requests.length === 4 && report.passed_requests === 7, run.text.slice(0, 300));
check("report has no per-request list of passing requests", !run.text.includes('"04 Create booking"'));
check(`report is small (${run.text.length} chars)`, run.text.length < 3000);
const details = await call(t.getRunDetails, { request_name: "04 Create booking" });
check("get_run_details returns a passing request on demand", !details.error && details.text.includes('"status": 200'));

console.log("\n-- Healer permissions --");
let r = await call(t.patchRequest, { request_name: "07 Update booking (full)", part: "headers", new_value: "[]", reason: "test" });
check("healer refused without a diagnosis", r.error && r.text.includes("no failure diagnosed as a test defect"));
await diagnose("05b Filter by checkin date (same day)", "api_bug");
r = await call(t.patchRequest, { request_name: "05b Filter by checkin date (same day)", part: "headers", new_value: "[]", reason: "test" });
check("healer refused on an API bug", r.error && r.text.includes("diagnosed as an API bug"));

console.log("\n-- Proof or revert --");
await diagnose("07 Update booking (full)", "test_defect");
const original07 = JSON.stringify(req("07 Update booking (full)"));
const withHeader = (extra: object) =>
  JSON.stringify([{ key: "Content-Type", value: "application/json" }, { key: "Accept", value: "application/json" }, extra]);
await call(t.patchRequest, { request_name: "07 Update booking (full)", part: "headers", new_value: withHeader({ key: "X-Unneeded", value: "1" }), reason: "an unnecessary change" });
run = await call(t.rerunCollection);
check("an unnecessary change is undone", run.text.includes("REVERTED") && JSON.stringify(req("07 Update booking (full)")) === original07, run.text.slice(0, 400));
await call(t.patchRequest, { request_name: "07 Update booking (full)", part: "headers", new_value: withHeader({ key: "Cookie", value: "token={{token}}" }), reason: "the real fix" });
run = await call(t.rerunCollection);
const after = JSON.parse(run.text);
check("a real fix is kept", !run.text.includes("REVERTED") && !after.failed_requests.some((f: any) => f.request.startsWith("07") || f.request.startsWith("08")), run.text.slice(0, 400));

console.log("\n-- Approvals (nobody answers) --");
await diagnose("09 Delete booking", "test_defect");
r = await call(t.patchRequest, { request_name: "09 Delete booking", part: "test_script", new_value: 'pm.test("Deleted", () => pm.response.to.have.status(201));', reason: "test" });
check("assertion change refused without approval", r.error && r.text.includes("Refused by the human"));
r = await call(t.patchRequest, { request_name: "09 Delete booking", part: "url", new_value: "{{baseUrl}}/booking/1", reason: "test" });
check("URL change refused without approval", r.error && r.text.includes("Refused by the human"));
r = await call(t.patchRequest, { request_name: "09 Delete booking", part: "method", new_value: "GET", reason: "test" });
check("method change refused without approval", r.error && r.text.includes("Refused by the human"));

console.log("\n-- Per-run limits (test config: 2 attempts per request, 2 changed requests) --");
r = await call(t.patchRequest, { request_name: "07 Update booking (full)", part: "body", new_value: "{}", reason: "third attempt" });
check("attempts per request are limited", r.error && r.text.includes("attempts on this request already"));
await diagnose("10 Get deleted booking (negative)", "test_defect");
await call(t.patchRequest, { request_name: "10 Get deleted booking (negative)", part: "body", new_value: "{}", reason: "second changed request" });
await diagnose("06 Update booking without token (negative)", "test_defect");
r = await call(t.patchRequest, { request_name: "06 Update booking without token (negative)", part: "body", new_value: "{}", reason: "third changed request" });
check("changed requests per run are limited", r.error && r.text.includes("changed requests per run"));

t.loadCollectionFile(fixture);
await call(t.rerunCollection);
await diagnose("05b Filter by checkin date (same day)", "api_bug");
await diagnose("09 Delete booking", "api_bug");
r = await call(t.markKnownBugs);
check("new known bugs over the limit need approval", r.error && r.text.includes("over the limit"));

console.log("\n-- Probe restrictions --");
r = await call(t.sendRequest, { method: "GET", url: "https://example.com/" });
check("probes to other hosts are refused", r.error && r.text.includes("may be probed"));

// ================= Against the fake server (Mock environment) =================
selectEnvironment("mock");

console.log("\n-- A single 5xx is a failure to debug, not an outage --");
mode = "one500";
t.loadCollectionFile(fixture);
r = await call(t.rerunCollection);
const one = r.error ? null : JSON.parse(r.text);
check("one 500 does not terminate the run", !r.error && !t.abortController.signal.aborted, r.text.slice(0, 200));
check("the 500 is reported as a failure", one?.failed_requests.some((f: any) => f.request.startsWith("05b") && f.status === 500), r.text.slice(0, 300));
r = await call(t.sendRequest, { method: "GET", url: `http://127.0.0.1:${port}/booking?checkin=2027-01-01` });
check("a probe's 500 goes back to the debugger as evidence", !r.error && r.text.includes('"status": 500') && !t.abortController.signal.aborted, r.text.slice(0, 200));

console.log("\n-- Health check before any agent starts --");
mode = "ping503";
const health = await t.checkServerHealth();
check("a failing health check stops the run", health?.startsWith("Facing server issues, please check Mock Env") ?? false, String(health));

console.log("\n-- Circuit breaker (everything answers 404) --");
mode = "all404";
t.loadCollectionFile(fixture);
await call(t.rerunCollection);
const status = JSON.parse((await call(t.runStatus)).text);
check("breaker trips when most requests fail", status.circuit_breaker.tripped === true, JSON.stringify(status.circuit_breaker));
await diagnose("07 Update booking (full)", "test_defect");
r = await call(t.patchRequest, { request_name: "07 Update booking (full)", part: "headers", new_value: "[]", reason: "test" });
check("healing is refused while tripped", r.error && r.text.includes("circuit breaker"));
await diagnose("05b Filter by checkin date (same day)", "api_bug");
r = await call(t.markKnownBugs);
check("marking is refused while tripped", r.error && r.text.includes("circuit breaker"));
check("program reports the breaker for its exit code", t.breakerState() === true);

console.log("\n-- Outage: everything except /ping answers 500, in two runs --");
mode = "server500";
t.loadCollectionFile(fixture);
r = await call(t.rerunCollection);
check("a confirmed outage terminates the run with the message", r.error && r.text.includes("TERMINATED: Facing server issues, please check Mock Env") && r.text.includes("two runs in a row"), r.text.slice(0, 300));
check("the agent run is aborted", t.abortController.signal.aborted);
r = await call(t.runStatus);
check("every later tool call is refused", r.error && r.text.startsWith("TERMINATED"));

server.close();
console.log(`\n${failed ? `${failed} check(s) FAILED` : "All checks passed"}`);
process.exit(failed ? 1 : 0);
