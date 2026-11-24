// Debugging failures: one summary per failure on the run, each failure's debug view (exchange, probes,
// causes and fixes, history, logs, the contract's text), the downloadable bundle, and contract gaps
// a person can mark as intended. Runs are stored directly, as a finished agent run would leave them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakePostman, testApp } from "./helpers.ts";

let pm: any, app: any, db: any, contractId = 0, runId = 0, oldRunId = 0;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload });
  return { status: r.statusCode, headers: r.headers, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};

const SPEC = `openapi: 3.0.3
info: { title: Pet Store, version: 1.0.0 }
servers: [ { url: /api/v3 } ]
paths:
  /pet/findByStatus:
    get:
      parameters: [ { name: status, in: query, required: true, schema: { type: string, default: available } } ]
      responses: { '200': { description: ok } }
  /pet/{petId}:
    get:
      parameters: [ { name: petId, in: path, required: true, schema: { type: integer } } ]
      responses: { '200': { description: ok } }
  /pet/{petId}/uploadImage:
    post:
      summary: Uploads an image
      parameters: [ { name: petId, in: path, required: true, schema: { type: integer } } ]
      requestBody: { content: { application/octet-stream: { schema: { type: string, format: binary } } } }
      responses: { '200': { description: ok }, '400': { description: No file uploaded } }
`;

const UPLOAD = "TC24 Upload image with empty body";
const FIND = "TC05 Find by status";
const exchange = (url: string, status: number) => ({
  method: "POST", url, status, response_time_ms: 212, body: '{"code":500,"message":"NullPointerException"}',
  assertions: [{ name: "Status is 400", error: "expected 500 to equal 400" }],
  request_headers: [{ key: "Authorization", value: "••••••" }], request_body: "", response_headers: [{ key: "Content-Type", value: "application/json" }], at: "2026-11-23T15:57:12Z",
});

const result = (withIssues: boolean, uploadFails: boolean) => ({
  collections: [{
    name: "Pet Store Contract Tests", requests: 2, assertions: 3, failed_assertions: uploadFails ? 2 : 1,
    failures: [
      ...(uploadFails ? [{ request: UPLOAD, assertion: "Status is 400", error: "expected 500 to equal 400" }] : []),
      { request: FIND, assertion: "Status is 200", error: "expected 404 to equal 200" },
    ],
    diagnoses: uploadFails ? [{
      request: UPLOAD, assertion: "Status is 400", category: "api_bug", confidence: "medium", evidence: "Empty upload returns 500, not the documented 400.",
      causes: [{ title: "The server crashes on an empty upload", likelihood: "high", explanation: "NullPointerException in the body." }],
      fixes: [{ kind: "report_api_bug", title: "Report it", detail: "POST uploadImage with no body returns 500.", recommended: true }],
    }] : [],
    known_bugs: [], known_bugs_now_passing: [], changes: [],
    executions: [
      { request: UPLOAD, case_id: "TC24", method: "POST", status: uploadFails ? 500 : 400, error: null, passed: uploadFails ? 0 : 1, failed: uploadFails ? 1 : 0 },
      { request: FIND, case_id: "TC05", method: "GET", status: 404, error: null, passed: 1, failed: 1 },
    ],
    ...(withIssues && {
      issues: [
        { request: UPLOAD, case_id: "TC24", state: "failing", exchange: exchange("http://pets.test/api/v3/pet/90215/uploadImage", 500),
          failed_assertions: [{ assertion: "Status is 400", error: "expected 500 to equal 400" }], test_script: "pm.response.to.have.status(400);", prerequest_script: "",
          probes: [{ for_request: UPLOAD, purpose: "same request again", method: "POST", url: "http://pets.test/api/v3/pet/90215/uploadImage", status: 500, request_headers: [], request_body: "", response_body: "{}", at: "2026-11-23T15:58:44Z" }],
          diagnoses: [], changes: [] },
        { request: FIND, case_id: "TC05", state: "failing", exchange: { ...exchange("http://pets.test/api/v3/pet/findByStatus?status=sold", 404), method: "GET" },
          failed_assertions: [{ assertion: "Status is 200", error: "expected 404 to equal 200" }], test_script: "", prerequest_script: "", probes: [], diagnoses: [], changes: [] },
      ].map((i) => (i.request === UPLOAD && uploadFails ? { ...i, diagnoses: [] } : i)),
    }),
  }],
  contract: {
    name: "Pet Store",
    plan: {
      collection_name: "Pet Store Contract Tests", cases: [{ id: "TC24", type: "negative", title: "Upload image with empty body", expected: "400" }],
      gaps: [
        "POST /pet/{petId}/uploadImage: the request body is not marked required, yet 400 'No file uploaded' is documented.",
        { text: "status is required but also has a default", endpoints: ["GET /pet/findByStatus"], suggestion: "required: false", not_tested: "calling it without status" },
        "GET/POST /pet/{petId} never say what happens for an unknown id.",
      ],
    },
  },
  report: "Two failures.",
});

const insertRun = (status: string, r: any, createdAt: string) => Number(db.prepare(
  `INSERT INTO runs (collection_name, environment_label, kind, ai_mode, contract_id, status, result_json, created_at, finished_at)
   VALUES ('Contract: Pet Store', 'Pets', 'ai', 'contract', ?, ?, ?, ?, ?)`).run(contractId, status, JSON.stringify(r), createdAt, createdAt).lastInsertRowid);

before(async () => {
  pm = await fakePostman();
  ({ app, db } = await testApp(pm.url));
  const up = await call("POST", "/api/contracts/upload", { filename: "pets.yaml", content_base64: Buffer.from(SPEC).toString("base64") });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  contractId = up.body.id;
  oldRunId = insertRun("failed", result(false, false), "2026-11-20T10:00:00Z"); // an older run: no debug bundles, upload passed
  runId = insertRun("failed", result(true, true), "2026-11-23T15:51:08Z");
  db.prepare("INSERT INTO run_events (run_id, seq, type, data_json, created_at) VALUES (?, 1, 'diagnosis', ?, '2026-11-23T15:59:10Z'), (?, 2, 'log', ?, '2026-11-23T15:59:11Z')")
    .run(runId, JSON.stringify({ request: UPLOAD, category: "api_bug" }), runId, JSON.stringify({ line: "[newman] something unrelated" }));
});
after(() => pm?.close());

test("the run carries one summary per failure, not the heavy bundles", async () => {
  const r = await call("GET", `/api/runs/${runId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.collections[0].issues, undefined, "bundles stay on the server");
  const [first, second] = r.body.result.issues;
  assert.equal(first.request, FIND, "unexplained failures come first");
  assert.equal(first.category, "unexplained");
  assert.equal(second.request, UPLOAD);
  assert.equal(second.category, "api_bug");
  assert.equal(second.confidence, "medium");
  assert.equal(second.status, 500);
});

test("a failure's debug view: exchange, probes, causes and fixes, position", async () => {
  const r = await call("GET", `/api/runs/${runId}/issue?request=${encodeURIComponent(UPLOAD)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.issue.exchange.status, 500);
  assert.equal(d.issue.probes[0].purpose, "same request again");
  assert.equal(d.issue.category, "api_bug");
  assert.equal(d.issue.diagnoses[0].causes[0].likelihood, "high", "diagnoses come from the collection when the bundle has none");
  assert.equal(d.issue.diagnoses[0].fixes[0].recommended, true);
  assert.deepEqual(d.position, { index: 1, total: 2, previous: { collection: 0, request: FIND, case_id: "TC05" }, next: null });
});

test("…with its history across runs, the log lines about it, and the contract's text", async () => {
  const d = (await call("GET", `/api/runs/${runId}/issue?request=${encodeURIComponent(UPLOAD)}`)).body;
  assert.deepEqual(d.history.map((h: any) => h.outcome), ["passed", "failed"]);
  assert.deepEqual(d.logs.map((l: any) => l.type), ["diagnosis"], "only events that mention the request");
  assert.equal(d.contract.key, "POST /pet/{petId}/uploadImage", "the most specific matching template");
  assert.match(d.contract.excerpt, /No file uploaded/);
  assert.equal(d.gaps.length, 1);
  assert.match(d.gaps[0].text, /not marked required/);
});

test("a request on a templated path matches its own template, not a shorter one", async () => {
  const d = (await call("GET", `/api/runs/${runId}/issue?request=${encodeURIComponent(FIND)}`)).body;
  assert.equal(d.contract.key, "GET /pet/findByStatus");
});

test("an unknown failure is a 404; the bundle downloads as a file", async () => {
  assert.equal((await call("GET", `/api/runs/${runId}/issue?request=nope`)).status, 404);
  const b = await call("GET", `/api/runs/${runId}/issue/bundle?request=${encodeURIComponent(UPLOAD)}`);
  assert.equal(b.status, 200);
  assert.match(String(b.headers["content-disposition"]), /attachment; filename="run-\d+-TC24-debug\.json"/);
  assert.equal(b.body.issue.request, UPLOAD);
});

test("runs from before debug bundles still list and open their failures", async () => {
  const r = await call("GET", `/api/runs/${oldRunId}`);
  assert.deepEqual(r.body.result.issues.map((i: any) => i.request), [FIND]);
  const d = await call("GET", `/api/runs/${oldRunId}/issue?request=${encodeURIComponent(FIND)}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.issue.exchange, null);
  assert.equal(d.body.issue.failed_assertions[0].assertion, "Status is 200");
});

test("contract gaps: endpoints found in plain sentences, and marking one as intended", async () => {
  let g = await call("GET", `/api/contracts/${contractId}/gaps?run=${runId}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.run.id, runId);
  const [upload, status, unknownId] = g.body.gaps;
  assert.deepEqual(upload.endpoints, ["POST /pet/{petId}/uploadImage"]);
  assert.deepEqual(status.endpoints, ["GET /pet/findByStatus"]);
  assert.equal(status.suggestion, "required: false");
  assert.deepEqual(unknownId.endpoints, ["GET /pet/{petId}"], "GET/POST split, and only endpoints the contract has");
  assert.ok(g.body.gaps.every((x: any) => !x.intended));

  assert.equal((await call("PUT", `/api/contracts/${contractId}/gaps/${status.key}`, { intended: true })).status, 200);
  g = await call("GET", `/api/contracts/${contractId}/gaps`); // the latest run by default
  assert.equal(g.body.run.id, runId);
  assert.equal(g.body.gaps.find((x: any) => x.key === status.key).intended, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'contract.gap_intended'").get().n, 1);

  assert.equal((await call("PUT", `/api/contracts/${contractId}/gaps/${status.key}`, { intended: false })).status, 200);
  g = await call("GET", `/api/contracts/${contractId}/gaps`);
  assert.equal(g.body.gaps.find((x: any) => x.key === status.key).intended, false);
  assert.equal((await call("PUT", `/api/contracts/${contractId}/gaps/not-a-key`, { intended: true })).status, 400);
});
