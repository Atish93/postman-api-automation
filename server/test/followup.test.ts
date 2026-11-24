// What a person can do from a failure's debug page: re-send the request, ask the debugger again, mark it as
// a known bug, and apply a fix (a new run). Plain runs get debug pages too. The agent is a stand-in
// (fixtures/fake-agent/followup.ts), so no model is called.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fakeApi, fakePostman, fixtureCollection, testApp, waitForRun, POSTMAN_KEY } from "./helpers.ts";

process.env.QA_AGENT_DIR = fileURLToPath(new URL("./fixtures/fake-agent/", import.meta.url));

let api: any, pm: any, app: any, db: any, envId = 0, aiRun = 0;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
const issue = (run: number, request: string) => call("GET", `/api/runs/${run}/issue?request=${encodeURIComponent(request)}`);
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const WRONG = "TC02 Wrong path";
// An AI run as the agent now leaves it: the collection it ended with, and a debug bundle for its failure.
function aiResult(base: string) {
  const collection = {
    info: { name: "Fake API (agent-built)", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [
      { name: "TC01 Items", request: { method: "GET", url: "{{baseUrl}}/items" } },
      { name: WRONG, request: { method: "GET", url: "{{baseUrl}}/echo?token={{apiToken}}", header: [{ key: "Authorization", value: "Bearer {{apiToken}}" }] } },
    ],
  };
  return {
    environment: { label: "Test" },
    collections: [{
      name: collection.info.name, requests: 2, assertions: 2, failed_assertions: 1,
      failures: [{ request: WRONG, assertion: "Status is 201", error: "expected 200 to equal 201" }],
      diagnoses: [], known_bugs: [], known_bugs_now_passing: [], changes: [],
      executions: [
        { request: "TC01 Items", case_id: "TC01", method: "GET", status: 200, error: null, passed: 1, failed: 0 },
        { request: WRONG, case_id: "TC02", method: "GET", status: 200, error: null, passed: 0, failed: 1 },
      ],
      issues: [{
        request: WRONG, case_id: "TC02", state: "failing",
        exchange: { method: "GET", url: `${base}/echo?token={{apiToken}}`, status: 200, body: '{"token":"{{apiToken}}"}', at: "2026-11-24T10:00:00Z",
          assertions: [{ name: "Status is 201", error: "expected 200 to equal 201" }],
          request_headers: [{ key: "Authorization", value: "Bearer {{apiToken}}" }, { key: "Accept", value: "*/*" }], request_body: "", response_headers: [] },
        failed_assertions: [{ assertion: "Status is 201", error: "expected 200 to equal 201" }],
        test_script: "", prerequest_script: "", probes: [], diagnoses: [], changes: [],
      }],
      collection,
    }],
    cost_usd: 1, report: "One failure.",
  };
}

before(async () => {
  api = await fakeApi();
  pm = await fakePostman();
  ({ app, db } = await testApp(pm.url));
  envId = (await call("POST", "/api/environments", { name: "test", label: "Test", base_url: api.url, health_path: "/health",
    variables: [{ key: "apiToken", value: "secret-123", secret: true }] })).body.id;
  aiRun = Number(db.prepare(`INSERT INTO runs (collection_name, environment_id, environment_label, kind, ai_mode, status, failed_assertions, cost_usd, result_json, created_at, started_at, finished_at)
    VALUES ('Fake API (agent-built)', ?, 'Test', 'ai', 'regression', 'failed', 1, 1, ?, ?, ?, ?)`)
    .run(envId, JSON.stringify(aiResult(api.url)), "2026-11-24T10:00:00Z", "2026-11-24T10:00:00Z", "2026-11-24T10:01:00Z").lastInsertRowid);
});
after(() => { api?.close(); pm?.close(); });

test("re-send: the exact request again, with the secret filled in from the environment and hidden in what's kept", async () => {
  const r = await call("POST", `/api/runs/${aiRun}/issue/resend`, { request: WRONG });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 200);
  assert.equal(r.body.same_as_run, true);
  assert.equal(r.body.body, '{"token":"{{apiToken}}"}', "the API echoed the real token; it's stored by name");
  const d = (await issue(aiRun, WRONG)).body;
  assert.equal(d.actions[0].kind, "resend");
  assert.ok(!JSON.stringify(d).includes("secret-123"));
});

test("re-send is refused when the credential was obtained during the run, or the host isn't the environment's", async () => {
  const result = aiResult(api.url);
  result.collections[0].issues[0].exchange.request_headers[0].value = "Bearer ••••••";
  const hidden = Number(db.prepare("INSERT INTO runs (collection_name, environment_id, environment_label, kind, ai_mode, status, result_json, created_at) VALUES ('x', ?, 'Test', 'ai', 'regression', 'failed', ?, ?)")
    .run(envId, JSON.stringify(result), "2026-11-24T10:00:00Z").lastInsertRowid);
  let r = await call("POST", `/api/runs/${hidden}/issue/resend`, { request: WRONG });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /obtained during the run/);

  const other = aiResult("http://example.invalid");
  const elsewhere = Number(db.prepare("INSERT INTO runs (collection_name, environment_id, environment_label, kind, ai_mode, status, result_json, created_at) VALUES ('x', ?, 'Test', 'ai', 'regression', 'failed', ?, ?)")
    .run(envId, JSON.stringify(other), "2026-11-24T10:00:00Z").lastInsertRowid);
  r = await call("POST", `/api/runs/${elsewhere}/issue/resend`, { request: WRONG });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Only 127\.0\.0\.1/);
});

test("ask the debugger again: runs in the background, then its findings join the page and the run", async () => {
  const r = await call("POST", `/api/runs/${aiRun}/issue/debug`, { request: WRONG, note: "Is it the token?" });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal((await call("POST", `/api/runs/${aiRun}/issue/debug`, { request: WRONG })).status, 409, "one at a time per failure");
  const d = (await until(() => issue(aiRun, WRONG), (x) => x.body.actions.find((a: any) => a.kind === "debug")?.status !== "running")).body;
  const action = d.actions.find((a: any) => a.kind === "debug");
  assert.equal(action.status, "done", JSON.stringify(action));
  assert.equal(action.input.note, "Is it the token?");
  assert.equal(action.output.report, "It is an API bug.");
  assert.equal(d.issue.category, "api_bug");
  assert.equal(d.issue.probes[0].purpose, "asked again");
  assert.match(d.issue.diagnoses[0].evidence, /Is it the token\?/, "the person's question reached the debugger");
  const run = (await call("GET", `/api/runs/${aiRun}`)).body;
  assert.equal(run.result.issues[0].category, "api_bug", "the run page sees it too");
  assert.equal(run.cost_usd, 1.12, "its cost is added to the run's");
  assert.ok(d.logs.some((e: any) => e.type === "followup_finished"), "its events are the run's events");
});

test("a follow-up that fails says so", async () => {
  process.env.FAKE_FOLLOWUP_EXIT = "1";
  try {
    await call("POST", `/api/runs/${aiRun}/issue/debug`, { request: WRONG });
    const d = (await until(() => issue(aiRun, WRONG), (x) => x.body.actions[0].status !== "running")).body;
    assert.equal(d.actions[0].status, "failed");
    assert.match(d.actions[0].message, /stopped early/);
  } finally {
    delete process.env.FAKE_FOLLOWUP_EXIT;
  }
});

test("apply a fix: only a test change, and it starts a new run from this one", async () => {
  // The debugger's fixes, recommended first: 0 = report the bug (for people), 1 = change the test.
  assert.equal((await call("POST", `/api/runs/${aiRun}/issue/fix`, { request: WRONG, fix: 0 })).status, 400);
  const r = await call("POST", `/api/runs/${aiRun}/issue/fix`, { request: WRONG, fix: 1 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const child = await waitForRun(app, r.body.run_id);
  assert.equal(child.status, "passed", JSON.stringify(child));
  assert.equal(child.parent_run_id, aiRun);
  assert.equal(child.followup.request, WRONG);
  assert.equal(child.followup.fix.title, "Point it at the right URL");
  assert.equal(child.ai_mode, "regression");
  const d = (await issue(aiRun, WRONG)).body;
  assert.equal(d.actions.find((a: any) => a.kind === "fix").child_run_id, child.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'run.fix'").get().n, 1);
});

test("plain runs: their failures get debug pages, and can be marked as known bugs", async () => {
  const col = (await call("POST", "/api/collections/upload", fixtureCollection({ failItems: true }))).body;
  const started = await call("POST", "/api/runs", { collection_id: col.id, environment_id: envId, kind: "plain" });
  const run = await waitForRun(app, started.body.id);
  assert.equal(run.status, "failed");
  assert.deepEqual(run.result.issues.map((i: any) => [i.request, i.category]), [["02 Items", "unexplained"]]);
  const d = (await issue(run.id, "02 Items")).body;
  assert.equal(d.run.plain, true);
  assert.match(d.issue.exchange.url, /\/items$/);
  assert.equal(d.issue.failed_assertions[0].assertion, "Two items");

  const m = await call("POST", `/api/runs/${run.id}/issue/known-bug`, { request: "02 Items", evidence: "The API returns 2 items; the docs promise 3." });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.request, "KNOWN BUG - 02 Items");
  assert.equal(m.body.status, "passed_with_known_bugs", "its only failure is now a known bug");
  const saved = JSON.parse(db.prepare("SELECT json FROM collections WHERE id = ?").get(col.id).json);
  const items = saved.item.find((i: any) => i.name === "KNOWN BUG - 02 Items");
  assert.ok(items, "renamed in the dashboard's copy (an uploaded collection)");
  assert.match(items.request.description, /- Two items: The API returns 2 items/, "with the evidence, as the agents write it");
  const after = (await issue(run.id, "02 Items")).body; // the old name still finds it
  assert.equal(after.issue.request, "KNOWN BUG - 02 Items");
  assert.equal(after.issue.category, "known_bug");
  assert.equal(after.can.known_bug, "It's already a known bug.");
});

test("mark as known bug on a collection from Postman changes it in Postman", async () => {
  await call("PUT", "/api/settings/postman", { api_key: POSTMAN_KEY });
  const col = (await call("POST", "/api/collections/import", { uid: "1-abc" })).body;
  const result = { environment: { label: "Test" }, executions: [
    { request: "02 Items", method: "GET", url: `${api.url}/items`, status: 200, assertions: [{ name: "Two items", error: "expected 2 to equal 3" }] },
  ] };
  const run = Number(db.prepare("INSERT INTO runs (collection_id, collection_name, environment_id, environment_label, kind, status, result_json, created_at) VALUES (?, ?, ?, 'Test', 'plain', 'failed', ?, ?)")
    .run(col.id, col.name, envId, JSON.stringify(result), "2026-11-24T10:00:00Z").lastInsertRowid);
  const m = await call("POST", `/api/runs/${run}/issue/known-bug`, { request: "02 Items", evidence: "Returns 2, documented 3." });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.where, "the collection in Postman");
  assert.ok(pm.store.get("1-abc").item.some((i: any) => i.name === "KNOWN BUG - 02 Items"));
});

test("a contract run whose only failure is marked becomes publishable", async () => {
  const result = aiResult(api.url) as any;
  result.contract = { name: "c", plan: { collection_name: "c", cases: [] }, review_rounds: 1, collection: structuredClone(result.collections[0].collection) };
  delete result.collections[0].collection;
  const run = Number(db.prepare("INSERT INTO runs (collection_name, environment_id, environment_label, kind, ai_mode, status, result_json, created_at) VALUES ('Contract: c', ?, 'Test', 'ai', 'contract', 'failed', ?, ?)")
    .run(envId, JSON.stringify(result), "2026-11-24T10:00:00Z").lastInsertRowid);
  const m = await call("POST", `/api/runs/${run}/issue/known-bug`, { request: WRONG, evidence: "The contract says 201; it answers 200." });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.status, "passed_with_known_bugs");
  const stored = JSON.parse(db.prepare("SELECT result_json FROM runs WHERE id = ?").get(run).result_json);
  assert.ok(stored.contract.collection.item.some((i: any) => i.name === `KNOWN BUG - ${WRONG}`), "the collection that will be published is renamed");
  assert.equal((await call("POST", `/api/runs/${run}/issue/known-bug`, { request: WRONG, evidence: "again please" })).status, 409);
});

test("actions need a finished run, a real failure, and evidence for a known bug", async () => {
  const going = Number(db.prepare("INSERT INTO runs (collection_name, environment_id, environment_label, kind, ai_mode, status, created_at) VALUES ('x', ?, 'Test', 'ai', 'regression', 'running', ?)")
    .run(envId, "2026-11-24T10:00:00Z").lastInsertRowid);
  assert.equal((await call("POST", `/api/runs/${going}/issue/resend`, { request: WRONG })).status, 409);
  assert.equal((await call("POST", `/api/runs/${aiRun}/issue/resend`, { request: "nope" })).status, 404);
  assert.equal((await call("POST", `/api/runs/${aiRun}/issue/known-bug`, { request: WRONG, evidence: "" })).status, 400);
});
