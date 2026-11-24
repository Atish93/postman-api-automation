// Checks the debug bundle each failure gets in the result file (for the dashboard's debug page),
// without any model calls: a tiny fake server, a two-request collection, a probe and a diagnosis.
// Run: npm run check:debug
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "sekret-token-123456";
// /item answers 200. /upload crashes with 500 and echoes the Authorization header it got (to prove it is hidden).
const server = createServer((req, res) => {
  if (req.url === "/ping") return res.writeHead(200).end("ok");
  if (req.url === "/item") return res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":1}');
  res.writeHead(500, { "Content-Type": "application/json", "Set-Cookie": "session=a-server-session-value" })
    .end(JSON.stringify({ error: "NullPointerException", auth: req.headers.authorization ?? null }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const real = JSON.parse(readFileSync(new URL("../qa.config.json", import.meta.url), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "qa-debug-"));
writeFileSync(join(dir, "qa.config.json"), JSON.stringify({
  ...real,
  environments: { mock: { label: "Mock", baseUrl: base, healthPath: "/ping", variables: { accessToken: SECRET } } },
  defaultEnvironment: "mock",
}));
const collection = {
  info: { name: "Debug bundle check", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    { name: "TC01 Get item", request: { method: "GET", url: "{{baseUrl}}/item" },
      event: [{ listen: "test", script: { exec: ['pm.test("Status is 200", () => pm.response.to.have.status(200));'] } }] },
    { name: "TC02 Upload empty", request: { method: "POST", url: "{{baseUrl}}/upload", header: [{ key: "Authorization", value: "Bearer {{accessToken}}" }] },
      event: [{ listen: "test", script: { exec: ['pm.test("Status is 400", () => pm.response.to.have.status(400));'] } }] },
  ],
};
writeFileSync(join(dir, "collection.json"), JSON.stringify(collection));
process.env.QA_CONFIG = join(dir, "qa.config.json");
process.env.QA_NO_PROMPTS = "1";
process.env.QA_NO_LEARNING = "1";

const t = await import("../tools.ts");
const { selectEnvironment } = await import("../config.ts");
selectEnvironment("mock");
const call = async (tool: any, input: any = {}) => {
  const r = await tool.handler(input, {});
  return { text: r.content[0].text as string, error: !!r.isError };
};
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failed++;
}

t.loadCollectionFile(join(dir, "collection.json"));
await call(t.rerunCollection);
await call(t.getRequest, { request_name: "TC02 Upload empty" });
// No for_request: the probe belongs to the request the debugger last read.
await call(t.sendRequest, { method: "POST", url: `${base}/upload`, headers: { Authorization: `Bearer ${SECRET}` }, purpose: "same request again" });
await call(t.recordDiagnosis, {
  request: "TC02 Upload empty", assertion: "Status is 400", category: "api_bug", confidence: "high", evidence: "probe returned 500",
  causes: [{ title: "The server crashes on an empty upload", likelihood: "high", explanation: "NullPointerException in the body.", evidence_for: ["probe: 500"] }],
  fixes: [{ kind: "report_api_bug", title: "Report it", detail: "Empty upload returns 500, not 400.", recommended: true }],
});

const result = t.runResults();
const c = result.collections[0];
const issue = c.issues.find((i: any) => i.request === "TC02 Upload empty");
const all = JSON.stringify(result);

console.log("-- Debug bundle --");
check("one issue, for the failing request only", c.issues.length === 1 && !!issue, JSON.stringify(c.issues.map((i: any) => i.request)));
check("it carries the case id", issue?.case_id === "TC02");
check("the exchange has the response status and headers", issue?.exchange.status === 500 && issue.exchange.response_headers.length > 0, JSON.stringify(issue?.exchange).slice(0, 300));
check("the failed assertion is listed", issue?.failed_assertions[0]?.assertion === "Status is 400");
check("the test script is kept", issue?.test_script.includes("status(400)"));
check("the probe is attached to the request the debugger last read", issue?.probes.length === 1 && issue.probes[0].purpose === "same request again" && issue.probes[0].status === 500, JSON.stringify(issue?.probes));
check("the diagnosis keeps its causes and fixes", issue?.diagnoses[0]?.causes?.length === 1 && issue.diagnoses[0].fixes?.[0]?.recommended === true);
check("executions list every request with its result", c.executions.length === 2 && c.executions.some((e: any) => e.case_id === "TC01" && e.failed === 0 && e.passed === 1), JSON.stringify(c.executions));

console.log("-- Secrets --");
check("the Authorization header keeps only the variable's name, so it can be re-sent", issue?.exchange.request_headers.find((h: any) => h.key === "Authorization")?.value === "Bearer {{accessToken}}", JSON.stringify(issue?.exchange.request_headers));
check("a cookie that isn't an environment variable is hidden for good", issue?.exchange.response_headers.find((h: any) => h.key.toLowerCase() === "set-cookie")?.value === "••••••", JSON.stringify(issue?.exchange.response_headers));
check("the final collection is kept with the run, for follow-up work", c.collection?.item?.length === 2);
check("the secret appears nowhere in the result (headers, bodies, probes)", !all.includes(SECRET), all.slice(all.indexOf(SECRET) - 80, all.indexOf(SECRET) + 40));

console.log("-- Follow-up from the dashboard: apply a chosen fix, then re-run --");
// Seeded from the finished run's result, as agent/followup.ts does. The chosen fix points the request at the
// right URL and expects its status: both need approval, given in advance because the person chose the fix.
// (A fix that accepted the 500 would never be kept: a server error always counts as a failure.)
process.env.QA_PREAPPROVE = "url change,method change,assertion change";
t.seedFollowup({
  collection: c.collection, request: "TC02 Upload empty", exchange: issue.exchange,
  failures: c.failures, passing: ["TC01 Get item"], requests: 2, assertions: 2,
});
await call(t.recordDiagnosis, { request: "TC02 Upload empty", assertion: "Status is 400", category: "test_defect", confidence: "high", evidence: "chosen on the dashboard" });
const url = await call(t.patchRequest, { request_name: "TC02 Upload empty", part: "url", reason: "chosen fix", new_value: "{{baseUrl}}/item" });
const script = await call(t.patchRequest, { request_name: "TC02 Upload empty", part: "test_script", reason: "chosen fix",
  new_value: 'pm.test("Status is 200", () => pm.response.to.have.status(200));' });
check("URL and assertion changes are applied without waiting for a person", !url.error && !script.error, url.text + " | " + script.text);
await call(t.rerunCollection);
const after = t.runResults().collections[0];
check("after the re-run the changes are kept and nothing fails", after.failed_assertions === 0 && after.changes.length >= 1 && !after.changes.some((ch: string) => ch.includes("reverted")), JSON.stringify(after.changes));
check("the follow-up's bundle shows the request now passes", after.issues.find((i: any) => i.request === "TC02 Upload empty")?.state === "passing_now");
check("…and it could be saved back (nothing unexplained left)", t.canShip() === null, String(t.canShip()));

server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
