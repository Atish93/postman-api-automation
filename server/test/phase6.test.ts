// Phase 6: logins, cross-site protection, security headers, the audit log, parallel runs, backups.
process.env.QA_SECRET_KEY = Buffer.alloc(32, 9).toString("base64"); // one key for every database in this file
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeApi, fakePostman, fixtureCollection, waitForRun } from "./helpers.ts";
import { buildApp } from "../src/app.ts";
import { openDb, getSetting } from "../src/db.ts";
import { currentSetupCode, resetLoginLimits } from "../src/auth.ts";
import { RunManager } from "../src/runs/manager.ts";
import { backupNow, listBackups } from "../src/backups.ts";

let api: any, pm: any, app: any, db: any, runs: any;
let cookie = "";
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method, url, payload, headers: { ...(cookie && { cookie }), ...headers } });
  const set = r.headers["set-cookie"];
  return { status: r.statusCode, headers: r.headers, set: Array.isArray(set) ? set[0] : set, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
const cookieFrom = (set: string) => set.split(";")[0];
const PASSWORD = "correct horse battery";

before(async () => {
  api = await fakeApi();
  pm = await fakePostman();
  process.env.POSTMAN_API_BASE = pm.url;
  process.env.QA_RUNS_DIR = mkdtempSync(join(tmpdir(), "qa-p6-runs-"));
  ({ app, db, runs } = buildApp(openDb(":memory:"), { auth: true }));
});
after(async () => { await app.close(); api.close(); pm.close(); });

// ---- Logins ----

test("before a password is set: everything but the login pages is closed; browsers are sent to log in", async () => {
  assert.deepEqual((await call("GET", "/api/auth/status")).body, { enabled: true, setup_needed: true, logged_in: false });
  assert.equal((await call("GET", "/api/health")).status, 200);
  const r = await call("GET", "/api/collections");
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: "Log in first.", login: true });
  const html = await call("GET", "/api/runs/1/report.html", undefined, { accept: "text/html" });
  assert.equal(html.status, 302);
  assert.equal(html.headers.location, "/login?next=%2Fapi%2Fruns%2F1%2Freport.html");
});

test("setup: needs the code from the server log and a long enough password; then you're logged in", async () => {
  assert.equal((await call("POST", "/api/auth/setup", { code: "0000-0000-0000", password: PASSWORD })).status, 400);
  assert.match((await call("POST", "/api/auth/setup", { code: currentSetupCode(), password: "short" })).body.error, /at least 10/);
  const r = await call("POST", "/api/auth/setup", { code: currentSetupCode().toLowerCase(), password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.set, /^qa_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600$/);
  cookie = cookieFrom(r.set);
  assert.equal((await call("GET", "/api/auth/status")).body.logged_in, true);
  assert.equal((await call("GET", "/api/collections")).status, 200);
  assert.equal((await call("POST", "/api/auth/setup", { code: "x", password: PASSWORD })).status, 409);
  // Stored as a salted hash, never the password; the session token isn't stored either.
  const stored = getSetting(db, "admin_password")!;
  assert.match(stored, /^scrypt:32768:8:1:/);
  assert.ok(!stored.includes(PASSWORD));
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM sessions").all()).includes(cookie.split("=")[1]));
});

test("login: a wrong password is refused, and too many are blocked for a while", async () => {
  const saved = cookie; cookie = "";
  assert.equal((await call("POST", "/api/auth/login", { password: "nope" })).status, 401);
  for (let i = 0; i < 9; i++) await call("POST", "/api/auth/login", { password: "nope" });
  const blocked = await call("POST", "/api/auth/login", { password: PASSWORD });
  assert.equal(blocked.status, 429, "even the right password waits");
  assert.match(blocked.body.error, /Try again in \d+ minute/);
  resetLoginLimits();
  const ok = await call("POST", "/api/auth/login", { password: PASSWORD });
  assert.equal(ok.status, 200);
  cookie = cookieFrom(ok.set);
  assert.equal((await call("GET", "/api/auth/sessions")).body.length, 2);
  cookie = saved;
});

test("changing the password logs out every other session; logout ends this one", async () => {
  const other = cookie;
  cookie = cookieFrom((await call("POST", "/api/auth/login", { password: PASSWORD })).set);
  assert.equal((await call("POST", "/api/auth/password", { current: "wrong", password: "another long one" })).status, 400);
  const r = await call("POST", "/api/auth/password", { current: PASSWORD, password: "another long one" });
  assert.equal(r.status, 200);
  cookie = cookieFrom(r.set);
  assert.equal((await call("GET", "/api/collections")).status, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/collections", headers: { cookie: other } })).statusCode, 401, "the other session ended");
  const out = await call("POST", "/api/auth/logout");
  assert.match(out.set, /Max-Age=0/);
  assert.equal((await call("GET", "/api/collections")).status, 401);
  cookie = cookieFrom((await call("POST", "/api/auth/login", { password: "another long one" })).set);
});

test("changes from another website are refused; the dashboard's own pages are fine", async () => {
  const bad = await call("POST", "/api/collections/upload", fixtureCollection(), { origin: "https://evil.example", host: "dash.example" });
  assert.equal(bad.status, 403);
  const ok = await call("POST", "/api/collections/upload", fixtureCollection(), { origin: "http://localhost:80", host: "localhost:80" });
  assert.equal(ok.status, 201);
});

test("security headers on every response", async () => {
  const r = await call("GET", "/api/health");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(String(r.headers["content-security-policy"]), /script-src 'self';.*frame-ancestors 'none'/);
});

// ---- Audit log ----

test("audit log: logins, environment changes (keys, never values), runs; newest first, filterable", async () => {
  const env = await call("POST", "/api/environments", { name: "test", label: "Test", base_url: api.url, health_path: "/health",
    variables: [{ key: "apiToken", value: "secret-123", secret: true }, { key: "region", value: "eu" }, { key: "old", value: "x" }] });
  await call("PUT", `/api/environments/${env.body.id}`, { name: "test", label: "Test", base_url: api.url, health_path: "/health",
    variables: [{ key: "apiToken", value: "secret-456", secret: true }, { key: "region", value: "eu" }, { key: "fresh", value: "y" }] });
  const col = (await call("GET", "/api/collections")).body[0];
  const run = await call("POST", "/api/runs", { collection_id: col.id, environment_id: env.body.id });
  await waitForRun({ inject: (o: any) => app.inject({ ...o, headers: { cookie } }) }, run.body.id);

  const log = (await call("GET", "/api/audit")).body;
  const summaries = log.map((e: any) => e.summary);
  assert.ok(summaries.includes("Updated environment Test: added fresh; changed apiToken; removed old"), summaries.join("\n"));
  assert.ok(summaries.some((s: string) => /^Created environment Test .*apiToken \(secret\)/.test(s)));
  assert.ok(summaries.includes(`Started plain run #${run.body.id}: Fake API tests on Test`));
  assert.ok(summaries.includes("Wrong password") && summaries.includes("Set the dashboard password") && summaries.includes("Changed the password; other sessions were logged out"));
  assert.ok(log[0].id > log[log.length - 1].id, "newest first");
  const all = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
  for (const secret of ["secret-123", "secret-456", PASSWORD]) assert.ok(!all.includes(secret), `${secret} is in the audit log`);
  assert.ok((await call("GET", "/api/audit?action=auth.")).body.every((e: any) => e.action.startsWith("auth.")));
  assert.equal((await call("GET", "/api/audit?q=fresh")).body.length, 1);
  assert.equal(log.find((e: any) => e.action === "run.start").ip, "127.0.0.1");
});

test("audit log: an answered approval says what was approved", async () => {
  // A run waiting for approval, as the agents would leave it: the request event, then the answer.
  const id = Number(db.prepare("INSERT INTO runs (collection_name, environment_label, kind, ai_mode, status, created_at) VALUES ('C', 'Test', 'ai', 'regression', 'running', '')").run().lastInsertRowid);
  db.prepare("INSERT INTO run_events (run_id, seq, type, data_json, created_at) VALUES (?, 1, 'approval_request', ?, '')").run(id, JSON.stringify({ kind: "assertion", request: "02 Items" }));
  // Not waiting in this process, so the route answers 409 and nothing is logged...
  assert.equal((await call("POST", `/api/runs/${id}/approval`, { answer: "y" })).status, 409);
  assert.equal((await call("GET", "/api/audit?action=run.approved")).body.length, 0);
  // ...but when the run is waiting, the answer is logged with what was asked.
  const real = runs.answerApproval;
  runs.answerApproval = () => true;
  try {
    assert.equal((await call("POST", `/api/runs/${id}/approval`, { answer: "y" })).status, 200);
    assert.equal((await call("POST", `/api/runs/${id}/approval`, { answer: "no, the API is wrong" })).status, 200);
  } finally {
    runs.answerApproval = real;
  }
  const [refused, approved] = (await call("GET", "/api/audit?action=run.")).body.filter((e: any) => /^run\.(approved|refused)$/.test(e.action));
  assert.equal(approved.summary, `Approved an assertion change to "02 Items" (run #${id})`);
  assert.equal(refused.summary, `Refused an assertion change to "02 Items" (run #${id})`);
});

test("case review: an edited plan (thousands of characters) is accepted and logged as an approval with changes", async () => {
  const id = Number(db.prepare("INSERT INTO runs (collection_name, environment_label, kind, ai_mode, status, created_at) VALUES ('Contract: Pets', 'Test', 'ai', 'contract', 'running', '')").run().lastInsertRowid);
  const cases = Array.from({ length: 12 }, (_, i) => ({ id: `TC${String(i + 1).padStart(2, "0")}`, type: "positive", title: `Case ${i + 1}`, expected: "200. Body is a JSON array matching the 200 array-of-Pet schema; every item has a string name and an array photoUrls. ".repeat(3) }));
  db.prepare("INSERT INTO run_events (run_id, seq, type, data_json, created_at) VALUES (?, 1, 'approval_request', ?, '')").run(id, JSON.stringify({ id: 1, kind: "test_cases", plan: { collection_name: "Pets", cases } }));
  const real = runs.answerApproval;
  const received: string[] = [];
  runs.answerApproval = (_id: number, answer: string) => (received.push(answer), true);
  try {
    const edited = JSON.stringify({ collection_name: "Pets", cases: cases.slice(0, 10) });
    assert.ok(edited.length > 3000, `the edited plan is ${edited.length} characters`);
    const r = await call("POST", `/api/runs/${id}/approval`, { answer: edited });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(received[0], edited, "the whole plan reaches the agents");
    assert.equal((await call("POST", `/api/runs/${id}/approval`, { answer: "Please add negative cases" })).status, 200);
    assert.equal((await call("POST", `/api/runs/${id}/approval`, { answer: "x".repeat(6000) })).status, 400, "plain feedback stays short");
  } finally {
    runs.answerApproval = real;
  }
  const log = (await call("GET", `/api/audit?q=run%20%23${id}`)).body.map((e: any) => `${e.action}: ${e.summary}`);
  assert.ok(log.includes(`run.approved: Approved 10 test cases with changes (run #${id})`), log.join("\n"));
  assert.ok(log.includes(`run.refused: Sent the test cases back with feedback (run #${id})`), log.join("\n"));
});

// ---- Parallel runs ----

test("parallel runs: up to the setting at once, never the same collection on the same environment together", async () => {
  const envId = (await call("GET", "/api/environments")).body[0].id;
  const c1 = (await call("GET", "/api/collections")).body[0].id;
  const c2 = (await call("POST", "/api/collections/upload", { ...fixtureCollection(), info: { ...fixtureCollection().info, name: "Second" } })).body.id;
  const c3 = (await call("POST", "/api/collections/upload", { ...fixtureCollection(), info: { ...fixtureCollection().info, name: "Third" } })).body.id;
  assert.equal((await call("PUT", "/api/settings/runs", { max_parallel: 2 })).status, 200);
  assert.equal((await call("PUT", "/api/settings/runs", { max_parallel: 20 })).status, 400);
  api.state.delayMs = 400;
  const start = async (c: number) => (await call("POST", "/api/runs", { collection_id: c, environment_id: envId })).body.id;
  const a = await start(c1), b = await start(c1), c = await start(c2), d = await start(c3);
  const status = (await call("GET", "/api/settings")).body.runs;
  assert.deepEqual([status.max_parallel, status.running, status.queued], [2, 2, 2]);
  const state = async (id: number) => (await call("GET", `/api/runs/${id}`)).body.status;
  assert.deepEqual([await state(a), await state(b), await state(c), await state(d)], ["running", "queued", "running", "queued"], "b waits for a (same collection), c goes ahead");
  const wait = (id: number) => waitForRun({ inject: (o: any) => app.inject({ ...o, headers: { cookie } }) }, id);
  const done = await Promise.all([a, b, c, d].map(wait));
  api.state.delayMs = 0;
  assert.ok(done.every((r) => r.requests === 3), "every run completed"); // (the token changed above, so one check fails: that's fine here)
  const [ra, rb] = done;
  assert.ok(Date.parse(rb.started_at) >= Date.parse(ra.finished_at), "same collection + environment ran one after the other");
});

test("queued runs wait through a restart; running ones are marked as interrupted", async () => {
  const mem = openDb(":memory:");
  const add = (status: string) => Number(mem.prepare("INSERT INTO runs (collection_name, environment_label, kind, status, created_at) VALUES ('C', 'E', 'plain', ?, '')").run(status).lastInsertRowid);
  const running = add("running"), queued = add("queued");
  const m = new RunManager(mem);
  assert.equal((mem.prepare("SELECT status FROM runs WHERE id = ?").get(running) as any).status, "error");
  assert.deepEqual(m.status().queued, [queued]);
});

// ---- Backups ----

test("backups: made while running, listed, downloadable; automatic ones once a day, only the newest kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-p6-backup-"));
  const fdb = openDb(join(dir, "qa.db"));
  fdb.prepare("INSERT INTO settings (key, value) VALUES ('marker', 'before-backup')").run();
  const { app: fapp, backups } = buildApp(fdb, { auth: false });
  const made = await fapp.inject({ method: "POST", url: "/api/backups" });
  assert.equal(made.statusCode, 201);
  const name = made.json().name;
  assert.match(name, /^qa-\d{8}-\d{6}-manual\.db$/);
  const list = (await fapp.inject({ method: "GET", url: "/api/backups" })).json();
  assert.equal(list.backups[0].name, name);
  assert.equal(list.dir, join(dir, "backups"));
  const dl = await fapp.inject({ method: "GET", url: `/api/backups/${name}/download` });
  assert.equal(dl.rawPayload.subarray(0, 15).toString(), "SQLite format 3");
  assert.equal((await fapp.inject({ method: "GET", url: "/api/backups/..%2Fqa.db/download" })).statusCode, 404);
  assert.ok(!readdirSync(join(dir, "backups")).includes("secret.key"), "the key isn't in the backups folder");

  assert.ok(backups.check(), "the first automatic backup is made");
  assert.equal(backups.check(), null, "not again the same day");
  process.env.QA_BACKUP_KEEP = "2";
  for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 1100)); backupNow(fdb, "auto"); }
  delete process.env.QA_BACKUP_KEEP;
  const after = listBackups(fdb);
  assert.equal(after.filter((b) => b.kind === "auto").length, 2);
  assert.equal(after.filter((b) => b.kind === "manual").length, 1, "your own backups are kept");

  // Restore: the server isn't running for this database, so the command goes ahead.
  fdb.prepare("UPDATE settings SET value = 'after-backup' WHERE key = 'marker'").run();
  await fapp.close();
  fdb.close();
  const out = execFileSync("npx", ["tsx", "scripts/restore.ts", join(dir, "backups", name)], { encoding: "utf8", env: { ...process.env, QA_DB: join(dir, "qa.db"), PORT: "59998" } });
  assert.match(out, /Restored/);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("qa.db.before-restore-")));
  const restored = openDb(join(dir, "qa.db"));
  assert.equal(getSetting(restored, "marker"), "before-backup");

  // Forgot the password: the reset command removes it and every session.
  restored.prepare("INSERT INTO settings (key, value) VALUES ('admin_password', 'scrypt:x')").run();
  restored.close();
  const reset = execFileSync("npx", ["tsx", "scripts/reset-password.ts"], { encoding: "utf8", env: { ...process.env, QA_DB: join(dir, "qa.db") } });
  assert.match(reset, /password was removed/);
  const again = openDb(join(dir, "qa.db"));
  assert.equal(getSetting(again, "admin_password"), null);
  assert.ok(existsSync(join(dir, "qa.db")));
});
