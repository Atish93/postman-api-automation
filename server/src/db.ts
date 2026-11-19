// The dashboard's database: one SQLite file, using Node's built-in node:sqlite (no native packages).
// Schema changes are numbered migrations; the database remembers how far it got (PRAGMA user_version),
// so later phases can add tables without losing data.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = DatabaseSync;

const migrations: string[] = [
  // 1: phase 1
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE collections (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('postman', 'upload')),
    postman_uid   TEXT UNIQUE,              -- set when imported from Postman
    json          TEXT NOT NULL,            -- the collection (Postman v2.1)
    request_count INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE environments (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,       -- short id used on the command line, e.g. "stg"
    label       TEXT NOT NULL,              -- shown to people, e.g. "Stg"
    base_url    TEXT NOT NULL,
    health_path TEXT NOT NULL DEFAULT '/',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE variables (
    id             INTEGER PRIMARY KEY,
    environment_id INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    key            TEXT NOT NULL,
    value          TEXT NOT NULL,
    secret         INTEGER NOT NULL DEFAULT 0,  -- never returned by the API in full
    UNIQUE (environment_id, key)
  );

  CREATE TABLE runs (
    id                INTEGER PRIMARY KEY,
    collection_id     INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    environment_id    INTEGER REFERENCES environments(id) ON DELETE SET NULL,
    collection_name   TEXT NOT NULL,        -- kept even if the collection is deleted later
    environment_label TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('plain', 'ai')),
    status            TEXT NOT NULL,        -- queued, running, passed, passed_with_known_bugs, failed,
                                            -- server_issue, circuit_breaker, error, cancelled
    message           TEXT,
    requests          INTEGER,
    assertions        INTEGER,
    failed_assertions INTEGER,
    cost_usd          REAL,
    exit_code         INTEGER,
    result_json       TEXT,                 -- full results (per-request for plain runs; the agent's result file for AI runs)
    created_at        TEXT NOT NULL,
    started_at        TEXT,
    finished_at       TEXT
  );
  CREATE INDEX runs_by_collection ON runs(collection_id, created_at);
  CREATE INDEX runs_by_environment ON runs(environment_id, created_at);

  CREATE TABLE run_events (
    id         INTEGER PRIMARY KEY,
    run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    type       TEXT NOT NULL,
    data_json  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, seq)
  );
  `,
];

export function openDb(path = process.env.QA_DB ?? fileURLToPath(new URL("../data/qa.db", import.meta.url))): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  const current = Number((db.prepare("PRAGMA user_version").get() as any).user_version);
  for (let v = current; v < migrations.length; v++) {
    db.exec("BEGIN");
    db.exec(migrations[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  }
  return db;
}

export const now = () => new Date().toISOString();

export function getSetting(db: DB, key: string): string | null {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any)?.value ?? null;
}
export function setSetting(db: DB, key: string, value: string | null) {
  if (value === null) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
