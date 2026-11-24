// The dashboard's database: one SQLite file, using Node's built-in node:sqlite (no native packages).
// Schema changes are numbered migrations; the database remembers how far it got (PRAGMA user_version),
// so later phases can add tables without losing data.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encryptExisting, initSecrets } from "./secrets.ts";
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
  // 2: phase 3 - AI build runs (describe what to test; the agents plan, build and publish a new collection)
  `
  ALTER TABLE runs ADD COLUMN ai_mode TEXT;        -- AI runs only: 'regression' (re-check a collection) or 'build' (create one)
  ALTER TABLE runs ADD COLUMN request TEXT;        -- build: what to test, in the user's words
  ALTER TABLE runs ADD COLUMN workspace_id TEXT;   -- build: the Postman workspace to publish to
  UPDATE runs SET ai_mode = 'regression' WHERE kind = 'ai';
  `,
  // 3: phase 4 - email reports and schedules
  `
  CREATE TABLE collection_reports (
    collection_id INTEGER PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
    recipients    TEXT NOT NULL DEFAULT '[]',   -- JSON array of email addresses
    send_when     TEXT NOT NULL DEFAULT 'failure' CHECK (send_when IN ('always', 'failure', 'new_failure')),
    enabled       INTEGER NOT NULL DEFAULT 1,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE schedules (
    id             INTEGER PRIMARY KEY,
    collection_id  INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    environment_id INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('plain', 'ai')),
    cron           TEXT NOT NULL,               -- 5 fields, in the server's local time
    enabled        INTEGER NOT NULL DEFAULT 1,
    next_run_at    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE emails (
    id         INTEGER PRIMARY KEY,
    run_id     INTEGER REFERENCES runs(id) ON DELETE CASCADE,
    recipients TEXT NOT NULL,                  -- JSON array
    subject    TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
    error      TEXT,
    trigger    TEXT NOT NULL,                  -- 'rule' (sent automatically) or 'manual'
    created_at TEXT NOT NULL
  );
  CREATE INDEX emails_by_run ON emails(run_id);

  ALTER TABLE runs ADD COLUMN schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL;
  ALTER TABLE runs ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0;  -- nobody to answer approvals: they are refused
  `,
  // 4: phase 5 - test-data files (secrets are encrypted in code, see secrets.ts; no schema change)
  `
  CREATE TABLE data_files (
    id            INTEGER PRIMARY KEY,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    format        TEXT NOT NULL CHECK (format IN ('csv', 'json')),
    content       TEXT NOT NULL,                -- the file as uploaded
    columns       TEXT NOT NULL,                -- JSON array of column names
    row_count     INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (collection_id, name)
  );

  ALTER TABLE runs ADD COLUMN data_file_id INTEGER REFERENCES data_files(id) ON DELETE SET NULL;
  ALTER TABLE runs ADD COLUMN data_file_name TEXT;    -- kept if the file is deleted later
  ALTER TABLE schedules ADD COLUMN data_file_id INTEGER REFERENCES data_files(id) ON DELETE SET NULL;
  `,
  // 5: phase 6 - logins and the audit log (the password hash is the setting "admin_password")
  `
  CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,            -- SHA-256 of the cookie's token; the token itself isn't stored
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  );

  CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY,
    at      TEXT NOT NULL,
    actor   TEXT NOT NULL,                       -- 'admin', 'schedule', 'system' or 'cli'
    ip      TEXT,
    action  TEXT NOT NULL,                       -- e.g. 'run.approval', 'environment.update'
    summary TEXT NOT NULL,                       -- in words; never contains secret values
    details TEXT                                 -- JSON
  );
  CREATE INDEX audit_by_time ON audit_log(at);
  CREATE INDEX audit_by_action ON audit_log(action, at);
  `,
  // 6: API contracts - the Contract Analyst agent turns them into test cases and a collection
  `
  CREATE TABLE contracts (
    id               INTEGER PRIMARY KEY,
    name             TEXT NOT NULL,
    source_kind      TEXT NOT NULL CHECK (source_kind IN ('file', 'url', 'postman')),
    source_ref       TEXT,                     -- the URL, or "<workspace id>/<spec id>" for Postman
    filename         TEXT,
    format           TEXT NOT NULL CHECK (format IN ('openapi', 'document')),
    spec_version     TEXT,
    title            TEXT NOT NULL,
    api_version      TEXT,
    servers          TEXT NOT NULL DEFAULT '[]',
    endpoints        TEXT NOT NULL DEFAULT '[]', -- JSON; for documents, filled in from the agent's analysis
    warnings         TEXT NOT NULL DEFAULT '[]',
    original         BLOB NOT NULL,            -- the file as received
    text             TEXT,                     -- documents: the readable text
    hash             TEXT NOT NULL,
    last_changes     TEXT,                     -- JSON: what changed at the last refresh
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    checked_at       TEXT
  );

  CREATE TABLE contract_publications (
    id              INTEGER PRIMARY KEY,
    contract_id     INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
    run_id          INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    workspace_id    TEXT NOT NULL,
    workspace_name  TEXT,
    collection_uid  TEXT NOT NULL,
    collection_name TEXT NOT NULL,
    folder_name     TEXT,                      -- set when added as a folder of an existing collection
    requests        INTEGER NOT NULL,
    published_at    TEXT NOT NULL
  );

  ALTER TABLE runs ADD COLUMN contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL;
  ALTER TABLE runs ADD COLUMN contract_endpoints TEXT;   -- JSON array of the endpoint keys chosen (null: all)
  `,
  `
  ALTER TABLE contracts ADD COLUMN gap_decisions TEXT;   -- JSON: { <gap key>: { intended, at } }, gaps a person marked as intended
  `,
  `
  -- Fix runs: a fix a person chose on a failure's debug page, applied to the parent run's collection.
  ALTER TABLE runs ADD COLUMN parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;
  ALTER TABLE runs ADD COLUMN followup_json TEXT;        -- { collection, request, fix }

  -- What people did from a failure's debug page: re-send the request, ask the debugger again,
  -- mark it as a known bug, or apply a fix (which starts a fix run: child_run_id).
  CREATE TABLE issue_actions (
    id           INTEGER PRIMARY KEY,
    run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    collection   INTEGER NOT NULL DEFAULT 0,           -- which collection of the run (regression runs can have several)
    request      TEXT NOT NULL,                        -- the failing request's name when the action started
    kind         TEXT NOT NULL CHECK (kind IN ('resend', 'debug', 'known_bug', 'fix')),
    status       TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    input_json   TEXT,
    output_json  TEXT,
    message      TEXT,                                 -- why it failed, in words
    cost_usd     REAL,
    child_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    finished_at  TEXT
  );
  CREATE INDEX issue_actions_by_run ON issue_actions (run_id, collection);
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
  initSecrets(path);
  const encrypted = encryptExisting(db); // secrets saved before encryption existed
  if (encrypted) console.log(`Encrypted ${encrypted} secret value(s) that were stored in plain text.`);
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
