// Email reports and schedules. Uses a fake API, a fake Postman and a fake mail server; nothing real is sent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeApi, fakePostman, fakeSmtp, fixtureCollection, testApp, waitForRun } from "./helpers.ts";

let api: any, pm: any, smtp: any, app: any, db: any, scheduler: any;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null, headers: r.headers };
};
let envId: number, passingId: number, failingId: number;
const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); };

before(async () => {
  api = await fakeApi();
  pm = await fakePostman();
  smtp = await fakeSmtp();
  ({ app, db, scheduler } = await testApp(pm.url));
  envId = (await call("POST", "/api/environments", { name: "test", label: "Test", base_url: api.url, health_path: "/health", variables: [{ key: "apiToken", value: "secret-123", secret: true }] })).body.id;
  passingId = (await call("POST", "/api/collections/upload", fixtureCollection())).body.id;
  failingId = (await call("POST", "/api/collections/upload", { ...fixtureCollection({ failItems: true }), info: { name: "Failing <tests>" } })).body.id;
});
after(async () => { await app.close(); api.close(); pm.close(); smtp.close(); });

const run = async (collection_id: number) => waitForRun(app, (await call("POST", "/api/runs", { collection_id, environment_id: envId, kind: "plain" })).body.id);
const smtpSettings = (password: string | null) => ({ host: "127.0.0.1", port: smtp.port, secure: false, user: "qa@example.com", from: "QA Bot <qa@example.com>", dashboard_url: "http://qa.local:4000", password });

test("email settings: validated, and the password is never returned", async () => {
  assert.equal((await call("GET", "/api/settings/email")).body.configured, false);
  assert.equal((await call("PUT", "/api/settings/email", { ...smtpSettings("x"), port: 0 })).status, 400);
  assert.equal((await call("PUT", "/api/settings/email", { ...smtpSettings("x"), from: "not an address" })).status, 400);
  const r = await call("PUT", "/api/settings/email", smtpSettings("wrong-pass"));
  assert.equal(r.status, 200);
  assert.equal(r.body.has_password, true);
  assert.ok(!JSON.stringify((await call("GET", "/api/settings/email")).body).includes("wrong-pass"));
});

test("test email: a wrong password explains app passwords", async () => {
  const r = await call("POST", "/api/settings/email/test", { to: "me@example.com" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /rejected the login.*app password/);
});

test("test email: arrives with the right password (sent as null keeps it, so save it explicitly)", async () => {
  await call("PUT", "/api/settings/email", smtpSettings("app-pass"));
  await call("PUT", "/api/settings/email", smtpSettings(null)); // keeps "app-pass"
  const r = await call("POST", "/api/settings/email/test", { to: "me@example.com" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(smtp.mails.at(-1).to, ["me@example.com"]);
  assert.match(smtp.mails.at(-1).raw, /Subject: \[QA\] Test email/);
});

test("report rules: addresses are validated and de-duplicated", async () => {
  assert.equal((await call("PUT", `/api/collections/${failingId}/reports`, { recipients: ["nope"], send_when: "failure" })).status, 400);
  const r = await call("PUT", `/api/collections/${failingId}/reports`, { recipients: ["Dev@Example.com", "dev@example.com", "qa@example.com"], send_when: "failure" });
  assert.deepEqual(r.body, { recipients: ["dev@example.com", "qa@example.com"], send_when: "failure", enabled: true });
  await call("PUT", `/api/collections/${passingId}/reports`, { recipients: ["dev@example.com"], send_when: "failure" });
});

test("rule 'failure': a failing run is emailed with the report attached; a passing one isn't", async () => {
  const before = smtp.mails.length;
  const failed = await run(failingId);
  assert.equal(failed.status, "failed");
  await until(() => smtp.mails.length > before);
  const mail = smtp.mails.at(-1);
  assert.deepEqual(mail.to.sort(), ["dev@example.com", "qa@example.com"]);
  assert.match(mail.raw, /Subject: \[QA\] Failed: Failing <tests> on Test \(1 failed check\)/);
  assert.match(mail.raw, new RegExp(`filename=qa-run-${failed.id}-report\\.html`));
  await until(() => false, 300);
  const events = (await call("GET", `/api/runs/${failed.id}/events/history`)).body.map((e: any) => e.type);
  assert.ok(events.includes("email_sent"), events.join(", "));
  const emails = (await call("GET", `/api/runs/${failed.id}/emails`)).body;
  assert.equal(emails[0].status, "sent");
  assert.equal(emails[0].trigger, "rule");

  const count = smtp.mails.length;
  assert.equal((await run(passingId)).status, "passed");
  await until(() => false, 800);
  assert.equal(smtp.mails.length, count, "no email for a passing run");
});

test("live events: replaying a finished run sends events after 'finished' too, without crashing", async () => {
  // A run whose report was emailed after it finished: "email_sent" comes after "finished".
  const id = (await call("GET", `/api/runs?collection_id=${failingId}`)).body[0].id;
  const types = (await call("GET", `/api/runs/${id}/events/history`)).body.map((e: any) => e.type);
  assert.ok(types.indexOf("email_sent") > types.indexOf("finished"), types.join(", "));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (let i = 0; i < 3; i++) {
    const text = await (await fetch(`${base}/api/runs/${id}/events`)).text();
    assert.ok(text.includes("event: finished") && text.includes("event: email_sent"), text.slice(-300));
  }
  assert.equal((await fetch(`${base}/api/health`)).status, 200, "the server is still up");
});

test("the report: escapes what came from the run, links to the dashboard", async () => {
  const id = (await call("GET", `/api/runs?collection_id=${failingId}`)).body[0].id;
  const r = await call("GET", `/api/runs/${id}/report.html`);
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/html/);
  assert.ok(r.body.includes("Failing &lt;tests&gt;") && !r.body.includes("Failing <tests>"), "names are escaped");
  assert.ok(r.body.includes(`http://qa.local:4000/runs/${id}`));
  assert.match(r.body, /expected 2 to deeply equal 3/);
  assert.match(String((await call("GET", `/api/runs/${id}/report.html?download=1`)).headers["content-disposition"]), /attachment/);
});

test("send now: to given addresses, or to the rule's by default; an error with no addresses at all", async () => {
  const id = (await call("GET", `/api/runs?collection_id=${passingId}`)).body[0].id;
  const r = await call("POST", `/api/runs/${id}/email`, { recipients: ["boss@example.com"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(smtp.mails.at(-1).to, ["boss@example.com"]);
  assert.equal((await call("POST", `/api/runs/${id}/email`, {})).body.recipients[0], "dev@example.com");
  const uid = (await call("POST", "/api/collections/upload", { ...fixtureCollection(), info: { name: "No rule" } })).body.id;
  const noRule = await run(uid);
  assert.equal((await call("POST", `/api/runs/${noRule.id}/email`, {})).status, 400);
});

test("rule 'new_failure': only something newly wrong is emailed", async () => {
  const { reasonToSend } = await import("../src/email.ts");
  const { loadReportRun } = await import("../src/report.ts");
  const cid = Number(db.prepare("INSERT INTO collections (name, source, json, request_count, created_at, updated_at) VALUES ('NF', 'upload', '{}', 3, ?, ?)").run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").lastInsertRowid);
  const exec = (name: string, fail: boolean) => ({ request: name, status: 200, error: null, assertions: [{ name: "c", error: fail ? "x" : null }] });
  const add = (status: string, fails: string[]) => Number(db.prepare(`INSERT INTO runs (collection_id, environment_id, collection_name, environment_label, kind, status, result_json, created_at, finished_at)
    VALUES (?, ?, 'NF', 'Test', 'plain', ?, ?, ?, ?)`).run(cid, envId, status, JSON.stringify({ executions: ["A", "B", "KNOWN BUG - K"].map((n) => exec(n, fails.includes(n))) }), "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z").lastInsertRowid);
  const reason = (id: number) => reasonToSend(db, { ...loadReportRun(db, id)!, collection_id: cid, environment_id: envId }, "new_failure");
  assert.match(String(reason(add("failed", ["A"]))), /first run/);
  assert.equal(reason(add("failed", ["A"])), null, "same failure again: no email");
  assert.equal(reason(add("failed", ["A", "KNOWN BUG - K"])), null, "a known bug doesn't count as new");
  assert.match(String(reason(add("failed", ["A", "B"]))), /new failures: B/);
  assert.equal(reason(add("passed", [])), null, "passing: no email");
  assert.match(String(reason(add("failed", ["A"]))), /passed last time/);
  assert.match(String(reason(add("server_issue", []))), /last time it was failed/);
  assert.equal(reason(add("server_issue", [])), null, "the same server issue again: no email");
});

test("schedules: the cron expression is checked and previewed", async () => {
  assert.equal((await call("GET", "/api/schedules/preview?cron=0 7 * * 1-5")).body.next.length, 3);
  const bad = await call("GET", "/api/schedules/preview?cron=99 7 * * *");
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /isn't valid/);
  assert.equal((await call("GET", "/api/schedules/preview?cron=every day")).status, 400);
  assert.equal((await call("POST", "/api/schedules", { collection_id: passingId, environment_id: envId, kind: "ai", cron: "0 7 * * *" })).status, 400, "AI needs a Postman collection");
});

test("schedules: a due schedule starts an unattended run, and doesn't pile up", async () => {
  const s = (await call("POST", "/api/schedules", { collection_id: passingId, environment_id: envId, kind: "plain", cron: "0 7 * * *" })).body;
  assert.ok(Date.parse(s.next_run_at) > Date.now());
  const due = new Date(Date.parse(s.next_run_at) + 1000);
  const [runId] = scheduler.tick(due);
  assert.ok(runId, "a run was started");
  const r = await waitForRun(app, runId);
  assert.equal(r.status, "passed");
  assert.equal(r.schedule_id, s.id);
  assert.equal(r.unattended, true);
  const after1 = (await call("GET", "/api/schedules")).body.find((x: any) => x.id === s.id);
  assert.ok(Date.parse(after1.next_run_at) > due.getTime(), "moved to the next time");
  assert.equal(after1.last_run.id, runId);

  // A previous run still going: the next tick skips it.
  db.prepare("INSERT INTO runs (collection_id, environment_id, collection_name, environment_label, kind, status, schedule_id, created_at) VALUES (?, ?, 'x', 'Test', 'plain', 'running', ?, ?)").run(passingId, envId, s.id, new Date().toISOString());
  assert.deepEqual(scheduler.tick(new Date(Date.parse(after1.next_run_at) + 1000)), []);
  db.prepare("UPDATE runs SET status = 'cancelled' WHERE schedule_id = ? AND status = 'running'").run(s.id);

  // Disabled schedules don't run.
  await call("PUT", `/api/schedules/${s.id}`, { collection_id: passingId, environment_id: envId, kind: "plain", cron: "0 7 * * *", enabled: false });
  assert.deepEqual(scheduler.tick(new Date(Date.now() + 3 * 86_400_000)), []);
});

test("schedules: on start, missed times are skipped rather than run late", async () => {
  const s = (await call("POST", "/api/schedules", { collection_id: passingId, environment_id: envId, kind: "plain", cron: "*/5 * * * *" })).body;
  db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", s.id);
  scheduler.start(60_000);
  scheduler.stop();
  const next = (await call("GET", "/api/schedules")).body.find((x: any) => x.id === s.id).next_run_at;
  assert.ok(Date.parse(next) > Date.now(), next);
  assert.equal((await call("DELETE", `/api/schedules/${s.id}`)).status, 204);
});
