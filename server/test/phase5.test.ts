// Phase 5: secrets encrypted at rest, comparing and copying environments, test-data files.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeApi, fakePostman, testApp, waitForRun, POSTMAN_KEY } from "./helpers.ts";
import { decrypt, encrypt, isEncrypted, SecretError } from "../src/secrets.ts";
import { parseCsv, parseDataFile, columnUse } from "../src/datafiles.ts";

let api: Awaited<ReturnType<typeof fakeApi>>, pm: Awaited<ReturnType<typeof fakePostman>>, app: any, db: any, scheduler: any;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
const env = (name: string, variables: any[]) =>
  call("POST", "/api/environments", { name, label: name.toUpperCase(), base_url: api.url, health_path: "/health", variables });
let testId: number, stgId: number, prodId: number;

before(async () => {
  api = await fakeApi();
  pm = await fakePostman();
  ({ app, db, scheduler } = await testApp(pm.url));
  testId = (await env("test", [{ key: "apiToken", value: "secret-123", secret: true }, { key: "region", value: "eu" }, { key: "timeout", value: "30" }])).body.id;
  stgId = (await env("stg", [{ key: "apiToken", value: "secret-123", secret: true }, { key: "region", value: "us" }])).body.id;
  prodId = (await env("prod", [{ key: "apiToken", value: "prod-999", secret: true }, { key: "region", value: "eu" }, { key: "timeout", value: "30" }])).body.id;
});
after(async () => { await app.close(); api.close(); pm.close(); });

// ---- Encryption ----

test("secrets: encrypt and decrypt; each value gets its own nonce; tampering is caught", () => {
  const a = encrypt("hunter2"), b = encrypt("hunter2");
  assert.ok(isEncrypted(a) && a !== b);
  assert.equal(decrypt(a), "hunter2");
  assert.equal(decrypt("plain-from-before"), "plain-from-before", "values from before encryption pass through");
  const parts = a.split(":");
  parts[4] = Buffer.from("something else").toString("base64");
  assert.throws(() => decrypt(parts.join(":")), SecretError);
});

test("secrets: the database holds no secret in plain text", async () => {
  assert.equal((await call("PUT", "/api/settings/postman", { api_key: POSTMAN_KEY })).status, 200);
  const raw = JSON.stringify([db.prepare("SELECT * FROM variables").all(), db.prepare("SELECT * FROM settings").all()]);
  for (const s of ["secret-123", "prod-999", POSTMAN_KEY]) assert.ok(!raw.includes(s), `${s} is stored in plain text`);
  assert.ok(raw.includes('"eu"'), "ordinary variables stay readable");
  // ...and they still work: Postman accepts the key, the environment shows its mask.
  assert.equal((await call("GET", "/api/postman/workspaces")).status, 200);
  assert.equal((await call("GET", `/api/environments/${testId}`)).body.variables[0].masked, "••••23");
});

test("secrets: marking an existing variable secret (keeping its value) encrypts it", async () => {
  await call("PUT", `/api/environments/${prodId}`, { name: "prod", label: "PROD", base_url: api.url, health_path: "/health",
    variables: [{ key: "apiToken", value: null, secret: true }, { key: "region", value: null, secret: true }, { key: "timeout", value: "30" }] });
  const region = db.prepare("SELECT value FROM variables WHERE environment_id = ? AND key = 'region'").get(prodId) as any;
  assert.ok(isEncrypted(region.value));
  assert.equal(decrypt(region.value), "eu");
  // Back to how it was, for the tests below.
  await call("PUT", `/api/environments/${prodId}`, { name: "prod", label: "PROD", base_url: api.url, health_path: "/health",
    variables: [{ key: "apiToken", value: null, secret: true }, { key: "region", value: "eu" }, { key: "timeout", value: "30" }] });
});

test("secrets: a key file is created once, readable only by its owner; plain secrets from before are encrypted on start; a different key gives a clear error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-secrets-"));
  const path = join(dir, "qa.db");
  // First start creates the database and the key; "seed" then stores secrets in plain text, as phase 4 did.
  const script = `
    import { openDb } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/db.ts", import.meta.url))).href)};
    import { getSecretSetting } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/secrets.ts", import.meta.url))).href)};
    const db = openDb(process.argv[2]);
    if (process.argv[3] === "seed") {
      db.exec("INSERT INTO environments (name, label, base_url, created_at, updated_at) VALUES ('t', 'T', 'http://x', '', '')");
      db.exec("INSERT INTO variables (environment_id, key, value, secret) VALUES (1, 'tok', 'plain-old', 1), (1, 'r', 'eu', 0)");
      db.exec("INSERT INTO settings VALUES ('smtp_password', 'mail-pass')");
    } else {
      console.log(JSON.stringify({ vars: db.prepare("SELECT key, value FROM variables").all(), pass: getSecretSetting(db, "smtp_password") }));
    }`;
  const runner = join(dir, "open.ts");
  writeFileSync(runner, script);
  const { execFileSync } = await import("node:child_process");
  const run = (arg: string) => execFileSync("npx", ["tsx", runner, path, arg], { encoding: "utf8", stdio: "pipe", env: { ...process.env, QA_SECRET_KEY: "" } });
  run("seed");
  const key = readFileSync(join(dir, "secret.key"), "utf8");
  assert.equal(statSync(join(dir, "secret.key")).mode & 0o777, 0o600);
  const out = run("read"); // second start: encrypts what the seed left in plain text
  assert.match(out, /Encrypted 2 secret value/);
  const after = JSON.parse(out.trim().split("\n").pop()!);
  assert.equal(after.pass, "mail-pass");
  const tok = after.vars.find((v: any) => v.key === "tok").value;
  assert.ok(isEncrypted(tok) && !JSON.stringify(after.vars).includes("plain-old"));
  assert.equal(after.vars.find((v: any) => v.key === "r").value, "eu");
  assert.equal(readFileSync(join(dir, "secret.key"), "utf8"), key, "the key file is kept");
  // With another key, reading a secret fails with an explanation.
  writeFileSync(join(dir, "secret.key"), Buffer.alloc(32, 7).toString("base64"));
  assert.throws(() => run("read"), /can't be decrypted with the key in .*secret\.key/);
});

// ---- Compare and copy ----

test("compare: every key across environments, with same / different / missing; secrets compared without being shown", async () => {
  const r = await call("GET", `/api/environments/compare?ids=${testId},${stgId},${prodId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.environments.map((e: any) => e.label), ["TEST", "STG", "PROD"]);
  const row = (k: string) => r.body.rows.find((x: any) => x.key === k);
  assert.equal(row("apiToken").status, "different");
  assert.equal(row("region").status, "different");
  assert.equal(row("timeout").status, "missing");
  assert.deepEqual(row("timeout").cells.map((c: any) => c.present), [true, false, true]);
  assert.ok(!JSON.stringify(r.body).includes("secret-123") && !JSON.stringify(r.body).includes("prod-999"));
  assert.equal(row("apiToken").cells[0].masked, "••••23");
  // Two environments whose secret matches.
  const two = await call("GET", `/api/environments/compare?ids=${testId},${stgId}`);
  assert.equal(two.body.rows.find((x: any) => x.key === "apiToken").status, "same");
  assert.deepEqual(two.body.counts, { same: 1, different: 1, missing: 1, unknown: 0 });
  assert.equal((await call("GET", `/api/environments/compare?ids=${testId}`)).status, 400);
  assert.equal((await call("GET", `/api/environments/compare?ids=${testId},99999`)).status, 404);
});

test("copy: preview first; adds missing, skips differing values unless overwriting, secrets stay secret", async () => {
  const keys = ["apiToken", "region", "timeout", "nope"];
  const preview = await call("POST", `/api/environments/${stgId}/copy-from`, { source_id: prodId, keys, dry_run: true });
  assert.equal(preview.status, 200);
  assert.deepEqual([preview.body.added, preview.body.skipped, preview.body.not_found], [["timeout"], ["apiToken", "region"], ["nope"]]);
  assert.equal((await call("GET", `/api/environments/${stgId}`)).body.variables.length, 2, "a preview changes nothing");

  const over = await call("POST", `/api/environments/${stgId}/copy-from`, { source_id: prodId, keys, dry_run: true, overwrite: true });
  assert.deepEqual(over.body.overwritten, ["apiToken", "region"]);

  const done = await call("POST", `/api/environments/${stgId}/copy-from`, { source_id: prodId, keys: ["apiToken", "timeout"], overwrite: true });
  assert.deepEqual([done.body.added, done.body.overwritten], [["timeout"], ["apiToken"]]);
  const vars = done.body.environment.variables;
  assert.deepEqual(vars.find((v: any) => v.key === "apiToken"), { key: "apiToken", value: null, masked: "••••99", secret: true });
  assert.equal(vars.find((v: any) => v.key === "region").value, "us", "not chosen, not touched");
  const stored = db.prepare("SELECT value FROM variables WHERE environment_id = ? AND key = 'apiToken'").get(stgId) as any;
  assert.ok(isEncrypted(stored.value) && decrypt(stored.value) === "prod-999");

  const again = await call("POST", `/api/environments/${stgId}/copy-from`, { source_id: prodId, keys: ["apiToken"] });
  assert.deepEqual(again.body.unchanged, ["apiToken"]);
  assert.equal((await call("POST", `/api/environments/${stgId}/copy-from`, { source_id: stgId, keys: ["region"] })).status, 400);
});

// ---- Test-data files ----

test("CSV parsing: quotes, commas and newlines inside quotes, CRLF, BOM, blank lines", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n\r\n2,"line1\nline2"\n'), [["a", "b"], ["1", 'x, "y"'], ["2", "line1\nline2"]]);
  assert.throws(() => parseCsv('a\n"open'), /never closed/);
  assert.throws(() => parseDataFile("d.csv", "a,b\n1"), /Row 1 has 1 values but the header has 2/);
  assert.throws(() => parseDataFile("d.csv", "a,a\n1,2"), /same name/);
  assert.throws(() => parseDataFile("d.csv", "a,b\n"), /at least one row/);
  assert.throws(() => parseDataFile("d.json", '{"a": 1}'), /list of objects/);
  assert.deepEqual(parseDataFile("d.json", '[{"a": 1, "b": {"c": true}}, {"a": "x"}]'), { format: "json", columns: ["a", "b"], rows: [{ a: "1", b: '{"c":true}' }, { a: "x" }] });
  assert.deepEqual(columnUse('{"url": "{{baseUrl}}/u?e={{ email }}", "exec": ["pm.iterationData.get(\\"expected\\")"]}', ["email", "expected", "other"]), { used: ["email", "expected"], unused: ["other"] });
});

// A collection that sends each row's token and checks the echo against the row's expected value.
const dataCollection = {
  info: { name: "Data-driven", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [{
    name: "Echo the token",
    event: [{ listen: "test", script: { type: "text/javascript", exec: ['pm.test("echo matches", () => pm.expect(pm.response.json().token).to.eql(pm.iterationData.get("expected")));'] } }],
    request: { method: "GET", url: "{{baseUrl}}/echo?token={{token}}" },
  }],
};
let dataCollectionId: number, fileId: number;

test("data files: upload, list with column use, preview, download, replace", async () => {
  dataCollectionId = (await call("POST", "/api/collections/upload", dataCollection)).body.id;
  const csv = "token,expected,notes\nabc,abc,first\ndef,WRONG,second\nghi,ghi,third\n";
  const r = await call("POST", `/api/collections/${dataCollectionId}/data-files`, { name: "users.csv", content: csv });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  fileId = r.body.id;
  assert.equal(r.body.row_count, 3);
  assert.deepEqual([r.body.format, r.body.columns, r.body.used, r.body.unused], ["csv", ["token", "expected", "notes"], ["token", "expected"], ["notes"]]);
  assert.deepEqual(r.body.preview[1], { token: "def", expected: "WRONG", notes: "second" });
  assert.equal((await call("POST", `/api/collections/${dataCollectionId}/data-files`, { name: "users.csv", content: csv })).status, 409);
  assert.equal((await call("POST", `/api/collections/${dataCollectionId}/data-files`, { name: "bad.csv", content: "a,b\n1" })).status, 400);
  assert.equal((await call("GET", `/api/collections/${dataCollectionId}/data-files`)).body.length, 1);
  const dl = await app.inject({ method: "GET", url: `/api/data-files/${fileId}/download` });
  assert.equal(dl.body, csv);
  assert.match(dl.headers["content-type"], /text\/csv/);
});

test("data files: a plain run goes once per row, and failures say which row", async () => {
  const r = await call("POST", "/api/runs", { collection_id: dataCollectionId, environment_id: testId, kind: "plain", data_file_id: fileId });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const run = await waitForRun(app, r.body.id);
  assert.equal(run.status, "failed");
  assert.equal(run.requests, 3);
  assert.deepEqual(run.data_file, { id: fileId, name: "users.csv" });
  assert.deepEqual(run.result.data_file, { name: "users.csv", rows: 3 });
  assert.deepEqual(run.result.executions.map((e: any) => [e.iteration, e.assertions[0].error === null]), [[1, true], [2, false], [3, true]]);
  const live = (await call("GET", `/api/runs/${run.id}/events/history`)).body.filter((e: any) => e.type === "request_done");
  assert.deepEqual(live.map((e: any) => e.data.iteration), [1, 2, 3]);
  const report = await app.inject({ method: "GET", url: `/api/runs/${run.id}/report.html` });
  assert.match(report.body, /Echo the token \(row 2\)/);
  assert.match(report.body, /users\.csv: 3 rows/);
});

test("data files: plain runs only, own collection only; schedules use them; in use can't be deleted; runs keep the name", async () => {
  assert.match((await call("POST", "/api/runs", { collection_id: dataCollectionId, environment_id: testId, kind: "ai", data_file_id: fileId })).body.error, /plain runs/);
  const other = (await call("POST", "/api/collections/upload", { ...dataCollection, info: { ...dataCollection.info, name: "Other" } })).body.id;
  assert.match((await call("POST", "/api/runs", { collection_id: other, environment_id: testId, data_file_id: fileId })).body.error, /different collection/);

  const s = await call("POST", "/api/schedules", { collection_id: dataCollectionId, environment_id: testId, cron: "0 3 * * *", data_file_id: fileId });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual(s.body.data_file, { id: fileId, name: "users.csv" });
  const [runId] = scheduler.tick(new Date(Date.parse(s.body.next_run_at) + 1000));
  const run = await waitForRun(app, runId);
  assert.equal(run.requests, 3, "the scheduled run used the data file");
  assert.equal(run.data_file.name, "users.csv");
  const del = await call("DELETE", `/api/data-files/${fileId}`);
  assert.equal(del.status, 409);
  assert.match(del.body.error, /1 schedule uses this file/);
  await call("DELETE", `/api/schedules/${s.body.id}`);
  assert.equal((await call("DELETE", `/api/data-files/${fileId}`)).status, 204);
  const runs = (await call("GET", `/api/runs?collection_id=${dataCollectionId}`)).body;
  assert.ok(runs.length && runs.every((r: any) => r.data_file?.name === "users.csv" && r.data_file.id === null));
});
