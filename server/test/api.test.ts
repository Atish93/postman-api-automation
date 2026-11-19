// End-to-end tests of the API: settings, Postman, collections, environments and runs.
// Uses a fake API and a fake Postman on this machine; no real services, no model calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeApi, fakePostman, fixtureCollection, testApp, waitForRun, POSTMAN_KEY } from "./helpers.ts";

let api: Awaited<ReturnType<typeof fakeApi>>, pm: Awaited<ReturnType<typeof fakePostman>>, app: any;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
let envId: number, uploadedId: number, importedId: number;

before(async () => {
  api = await fakeApi();
  pm = await fakePostman();
  ({ app } = await testApp(pm.url));
});
after(async () => { await app.close(); api.close(); pm.close(); });

test("health", async () => {
  assert.deepEqual((await call("GET", "/api/health")).body, { ok: true });
});

test("Postman: a wrong key is rejected and not saved", async () => {
  const r = await call("PUT", "/api/settings/postman", { api_key: "PMAK-wrong" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /rejected the API key/);
  assert.equal((await call("GET", "/api/settings")).body.postman.connected, false);
});

test("Postman: browsing before connecting explains what to do", async () => {
  const r = await call("GET", "/api/postman/workspaces");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not connected/);
});

test("Postman: a right key is saved and never shown in full", async () => {
  const r = await call("PUT", "/api/settings/postman", { api_key: POSTMAN_KEY });
  assert.equal(r.status, 200);
  assert.equal(r.body.postman.user, "tester");
  const settings = await call("GET", "/api/settings");
  assert.deepEqual(settings.body.postman, { connected: true, key_hint: "…1234" });
  assert.ok(!JSON.stringify(settings.body).includes(POSTMAN_KEY));
});

test("Postman: workspaces and their collections", async () => {
  assert.deepEqual((await call("GET", "/api/postman/workspaces")).body, [{ id: "ws1", name: "Practice", type: "personal" }]);
  assert.deepEqual((await call("GET", "/api/postman/workspaces/ws1/collections")).body, [{ uid: "1-abc", name: "Fake API tests (from Postman)", imported: false }]);
});

test("collections: import from Postman", async () => {
  const r = await call("POST", "/api/collections/import", { uid: "1-abc" });
  assert.equal(r.status, 201);
  assert.equal(r.body.source, "postman");
  assert.equal(r.body.request_count, 3);
  importedId = r.body.id;
  assert.equal((await call("GET", "/api/postman/workspaces/ws1/collections")).body[0].imported, true);
  const again = await call("POST", "/api/collections/import", { uid: "1-abc" });
  assert.equal(again.body.id, importedId, "importing again updates instead of duplicating");
});

test("collections: upload a file, including folders", async () => {
  const r = await call("POST", "/api/collections/upload", fixtureCollection());
  assert.equal(r.status, 201);
  uploadedId = r.body.id;
  const detail = (await call("GET", `/api/collections/${uploadedId}`)).body;
  assert.equal(detail.requests.length, 3);
  assert.deepEqual(detail.requests[2], { name: "03 Uses an environment variable", folder: "Folder", method: "GET", url: "{{baseUrl}}/echo?token={{apiToken}}" });
});

test("collections: invalid uploads are rejected with a reason", async () => {
  const r = await call("POST", "/api/collections/upload", { hello: "world" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /info/);
});

test("collections: refresh works only for Postman imports", async () => {
  assert.equal((await call("POST", `/api/collections/${importedId}/refresh`)).status, 200);
  const r = await call("POST", `/api/collections/${uploadedId}/refresh`);
  assert.equal(r.status, 400);
});

test("environments: validation", async () => {
  const r = await call("POST", "/api/environments", { name: "Bad Name", label: "", base_url: "ftp://x" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /name/);
  assert.match(r.body.error, /base_url/);
});

test("environments: create, with a secret that is never returned", async () => {
  const r = await call("POST", "/api/environments", {
    name: "test", label: "Test", base_url: api.url, health_path: "/health",
    variables: [{ key: "apiToken", value: "secret-123", secret: true }, { key: "region", value: "eu" }],
  });
  assert.equal(r.status, 201);
  envId = r.body.id;
  assert.deepEqual(r.body.variables, [
    { key: "apiToken", value: null, masked: "••••23", secret: true },
    { key: "region", value: "eu", secret: false },
  ]);
  assert.ok(!JSON.stringify((await call("GET", "/api/environments")).body).includes("secret-123"));
  assert.equal((await call("POST", "/api/environments", { name: "test", label: "Again", base_url: api.url })).status, 409);
});

test("environments: updating keeps a secret sent as null", async () => {
  const r = await call("PUT", `/api/environments/${envId}`, {
    name: "test", label: "Test", base_url: api.url, health_path: "/health",
    variables: [{ key: "apiToken", value: null, secret: true }, { key: "region", value: "us" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.variables[0].masked, "••••23");
  assert.equal(r.body.variables[1].value, "us");
});

const startRun = async (collection_id: number, kind = "plain") => {
  const r = await call("POST", "/api/runs", { collection_id, environment_id: envId, kind });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.ok(["queued", "running"].includes(r.body.status), r.body.status); // it may already have started
  return waitForRun(app, r.body.id);
};

test("plain run: passes, using the environment's base URL and secret variable", async () => {
  const run = await startRun(uploadedId);
  assert.equal(run.status, "passed", run.message);
  assert.equal(run.requests, 3);
  assert.equal(run.failed_assertions, 0);
  assert.equal(run.cost_usd, 0);
  assert.equal(run.result.executions[2].assertions[0].error, null, "the secret reached the request");
  const events = (await call("GET", `/api/runs/${run.id}/events/history`)).body.map((e: any) => e.type);
  assert.deepEqual(events, ["status", "status", "request_done", "request_done", "request_done", "finished"]);
});

test("plain run: a failing assertion fails the run", async () => {
  const id = (await call("POST", "/api/collections/upload", fixtureCollection({ failItems: true }))).body.id;
  const run = await startRun(id);
  assert.equal(run.status, "failed");
  assert.equal(run.failed_assertions, 1);
  assert.match(run.result.executions[1].assertions[0].error, /expected 2 to deeply equal 3/);
});

test("plain run: failures only in KNOWN BUG requests count as passed with known bugs", async () => {
  const id = (await call("POST", "/api/collections/upload", fixtureCollection({ failItems: true, itemsName: "KNOWN BUG - 02 Items" }))).body.id;
  assert.equal((await startRun(id)).status, "passed_with_known_bugs");
});

test("plain run: a failing health check stops with the server-issue message", async () => {
  api.state.mode = "down";
  const run = await startRun(uploadedId);
  api.state.mode = "ok";
  assert.equal(run.status, "server_issue");
  assert.match(run.message, /^Facing server issues, please check Test Env/);
});

test("plain run: a single 5xx is an ordinary failure, not an outage", async () => {
  api.state.mode = "one500";
  const run = await startRun(uploadedId);
  api.state.mode = "ok";
  assert.equal(run.status, "failed");
  assert.equal(run.result.executions[1].status, 500);
});

test("plain run: every request getting 5xx is an outage", async () => {
  api.state.mode = "outage";
  const run = await startRun(uploadedId);
  api.state.mode = "ok";
  assert.equal(run.status, "server_issue");
  assert.match(run.message, /^Facing server issues, please check Test Env\. 3 of 3 requests got server errors/);
});

test("runs: list with filters", async () => {
  const all = (await call("GET", "/api/runs")).body;
  assert.ok(all.length >= 5);
  assert.ok(all[0].id > all[1].id, "newest first");
  const failed = (await call("GET", "/api/runs?status=failed")).body;
  assert.ok(failed.length >= 1 && failed.every((r: any) => r.status === "failed"));
  const forCollection = (await call("GET", `/api/runs?collection_id=${uploadedId}`)).body;
  assert.ok(forCollection.every((r: any) => r.collection.id === uploadedId));
  const list = (await call("GET", "/api/collections")).body;
  assert.ok(list.find((c: any) => c.id === uploadedId).last_run, "collections show their last run");
});

test("runs: live events over server-sent events", async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const started = await (await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collection_id: uploadedId, environment_id: envId }) })).json();
  const res = await fetch(`${base}/api/runs/${started.id}/events`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text(); // the stream ends when the run finishes
  const types = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(types, ["status", "status", "request_done", "request_done", "request_done", "finished"]);
});

test("AI runs: not allowed for uploaded collections", async () => {
  const r = await call("POST", "/api/runs", { collection_id: uploadedId, environment_id: envId, kind: "ai" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /imported from Postman/);
});

test("AI runs: starts the agents; a down server stops it before any model call", async () => {
  api.state.mode = "down";
  const run = await startRun(importedId, "ai");
  api.state.mode = "ok";
  assert.equal(run.status, "server_issue", run.message);
  assert.equal(run.exit_code, 2);
  assert.match(run.message, /Facing server issues, please check Test Env/);
  const events = (await call("GET", `/api/runs/${run.id}/events/history`)).body;
  const types = events.map((e: any) => e.type);
  for (const t of ["run_started", "server_issue", "run_finished", "finished"]) assert.ok(types.includes(t), `missing ${t}: ${types.join(", ")}`);
  assert.equal(run.result.environment.label, "Test");
});

test("approvals and cancelling: refused when the run isn't waiting or has finished", async () => {
  const id = (await call("GET", "/api/runs")).body[0].id;
  assert.equal((await call("POST", `/api/runs/${id}/approval`, { answer: "y" })).status, 409);
  assert.equal((await call("POST", `/api/runs/${id}/cancel`)).status, 409);
});

test("dashboard: headline figures, runs per day and open known bugs", async () => {
  const d = (await call("GET", "/api/dashboard?days=14")).body;
  assert.equal(d.daily.length, 14);
  const today = d.daily.at(-1);
  assert.equal(today.date, new Date().toISOString().slice(0, 10));
  assert.ok(today.total >= 7);
  assert.equal(today.total, today.passed + today.known_bugs + today.failed + today.server_issue + today.other);
  assert.ok(today.pass_rate > 0 && today.pass_rate < 1);
  assert.equal(d.this_week.runs, today.total);
  assert.equal(d.last_week.runs, 0);
  assert.equal(d.last_week.pass_rate, null);
  assert.ok(d.known_bugs.some((b: any) => b.request === "02 Items"), JSON.stringify(d.known_bugs));
  assert.ok(d.latest_runs.length > 0 && d.latest_runs[0].id > d.latest_runs.at(-1).id);
  assert.equal((await call("GET", "/api/dashboard?days=2")).status, 400);
});

test("unknown API paths answer 404 as JSON", async () => {
  const r = await call("GET", "/api/nope");
  assert.equal(r.status, 404);
});

test("deleting a collection keeps its run history", async () => {
  const before = (await call("GET", `/api/runs?collection_id=${uploadedId}`)).body.map((r: any) => r.id);
  assert.ok(before.length > 0);
  assert.equal((await call("DELETE", `/api/collections/${uploadedId}`)).status, 204);
  for (const id of before) {
    const run = (await call("GET", `/api/runs/${id}`)).body;
    assert.equal(run.collection.id, null);
    assert.equal(run.collection.name, "Fake API tests");
  }
});
