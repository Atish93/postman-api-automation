// Fills a SEPARATE database with 30 days of sample run history, to preview the dashboard.
// The runs are invented (no requests are sent); the collections are the repository's real ones.
//
//   npm run seed:demo -- data/demo.db
//   QA_DB=data/demo.db npm start
//
// Refuses to touch a database that already has collections, environments or runs.
import { readFileSync } from "node:fs";
import { openDb, now } from "../src/db.ts";

const path = process.argv[2];
if (!path || path.endsWith("qa.db")) {
  console.log("Usage: npm run seed:demo -- <path to a new demo database, e.g. data/demo.db>  (never your real qa.db)");
  process.exit(1);
}
const db = openDb(path);
const used = ["collections", "environments", "runs"].some((t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n > 0);
if (used) {
  console.log(`${path} already has data; demo data is only added to an empty database.`);
  process.exit(1);
}

// A small deterministic random generator, so the demo looks the same every time.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(items: [T, number][]): T => {
  let r = rand() * items.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of items) if ((r -= w) < 0) return v;
  return items[0][0];
};

const root = new URL("../../", import.meta.url).pathname;
const requestsOf = (items: any[]): any[] => items.flatMap((i) => (i.item ? requestsOf(i.item) : [i]));
const t0 = now();
const addCollection = (file: string) => {
  const json = JSON.parse(readFileSync(root + file, "utf8"));
  const c = json.collection ?? json;
  const id = Number(db.prepare("INSERT INTO collections (name, source, postman_uid, json, request_count, created_at, updated_at) VALUES (?, 'upload', NULL, ?, ?, ?, ?)")
    .run(c.info.name, JSON.stringify(c), requestsOf(c.item).length, t0, t0).lastInsertRowid);
  return { id, name: c.info.name as string, requests: requestsOf(c.item).map((r) => r.name as string) };
};
const collections = [addCollection("collection/collection.json"), addCollection("collection/filter-tests.agent-built.json")];

const addEnv = (name: string, label: string) =>
  ({ id: Number(db.prepare("INSERT INTO environments (name, label, base_url, health_path, created_at, updated_at) VALUES (?, ?, 'https://restful-booker.herokuapp.com', '/ping', ?, ?)").run(name, label, t0, t0).lastInsertRowid), label });
const envs = [addEnv("test", "Test"), addEnv("stg", "Stg")];

// The one known bug in the sample history, on the first collection.
const KNOWN = "KNOWN BUG - 05 Get booking";

const insertRun = db.prepare(`INSERT INTO runs (collection_id, environment_id, collection_name, environment_label, kind, status, message,
  requests, assertions, failed_assertions, cost_usd, exit_code, result_json, created_at, started_at, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertEvent = db.prepare("INSERT INTO run_events (run_id, seq, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)");

let count = 0;
for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
  const perDay = daysAgo === 0 ? 2 : 1 + Math.floor(rand() * 4);
  for (let n = 0; n < perDay; n++) {
    const c = collections[Math.floor(rand() * collections.length)];
    const e = rand() < 0.7 ? envs[0] : envs[1];
    const kind = rand() < 0.2 ? "ai" : "plain";
    // Things get better over the month: fewer failures in the second half.
    const status = pick<string>([["passed", daysAgo > 14 ? 5 : 8], ["passed_with_known_bugs", c === collections[0] ? 3 : 0], ["failed", daysAgo > 14 ? 3 : 1], ["server_issue", 0.6], ["error", 0.2]]);
    const start = new Date(Date.now() - daysAgo * 86_400_000 - (perDay - n) * 3_600_000 - rand() * 3_000_000);
    const ms = kind === "ai" ? 15_000 + rand() * 300_000 : 2_000 + rand() * 8_000;
    const finish = new Date(start.getTime() + ms);

    const names = c.requests.map((r) => (status === "passed_with_known_bugs" && r.startsWith("05 ") ? KNOWN : r));
    const failingIdx = status === "failed" ? [Math.floor(rand() * names.length)] : status === "passed_with_known_bugs" ? [names.indexOf(KNOWN)] : [];
    const executions = status === "server_issue" ? [] : names.map((name, i) => ({
      request: name, method: "GET", url: "https://restful-booker.herokuapp.com/…", status: failingIdx.includes(i) && status === "failed" ? 404 : 200,
      response_time_ms: Math.round(150 + rand() * 500), error: null, body: "",
      assertions: [{ name: "Status is as documented", error: failingIdx.includes(i) ? "expected response to have status code 200 but got 404" : null }],
    }));
    const failed = executions.reduce((x, ex) => x + ex.assertions.filter((a) => a.error).length, 0);
    const result = { sample: true, environment: { name: e.label.toLowerCase(), label: e.label, base_url: "https://restful-booker.herokuapp.com" }, executions };
    const id = Number(insertRun.run(c.id, e.id, c.name, e.label, kind, status,
      status === "server_issue" ? `Facing server issues, please check ${e.label} Env. Health check answered 503.` : status === "error" ? "Sample: the run stopped with an error." : null,
      executions.length || null, executions.length || null, status === "server_issue" ? null : failed,
      kind === "ai" ? Math.round((0.04 + rand() * 0.4) * 1000) / 1000 : 0, kind === "ai" ? (status === "server_issue" ? 2 : 0) : null,
      JSON.stringify(result), start.toISOString(), start.toISOString(), finish.toISOString()).lastInsertRowid);
    insertEvent.run(id, 1, "status", JSON.stringify({ status: "running" }), start.toISOString());
    insertEvent.run(id, 2, "finished", JSON.stringify({ status }), finish.toISOString());
    count++;
  }
}
console.log(`Demo database ${path}: 2 collections, 2 environments (Test, Stg), ${count} sample runs over 30 days.`);
