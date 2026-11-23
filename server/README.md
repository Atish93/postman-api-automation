# QA dashboard server

The API behind the QA dashboard (phase 1 of `docs/ROADMAP.md`): connect Postman, import collections, manage environments, run collections plainly (Newman) or with the agent team, and keep every run.

## Setup

Needs Node 22.13 or newer (the database uses Node's built-in SQLite).

    cd agent && npm install          # the agents, used by AI runs
    cd ../server && npm install
    export ANTHROPIC_API_KEY=...     # only needed for AI runs
    npm start                        # http://127.0.0.1:4000

**Logging in.** The first visit asks you to set a password with a one-time setup code printed in this server's log. Forgot it? Run `npm run reset-password` here (the server can keep running), then set a new one. Commands: `npm run backup`, `npm run restore -- <file>` (with the server stopped), `npm run reset-password`. To run it on a server with Docker and HTTPS, see `docs/DEPLOYMENT.md`.

**After pulling a new version**, run `npm install` in `agent/`, `server/` and `web/` (a new version may add packages; the server says which are missing), then `npm run build` in `web/`.

The database is `server/data/qa.db` (set `QA_DB` to use another file). Each AI run's result file is kept in `server/data/runs/<id>/` (its settings file, which holds the environment's secrets, is deleted when the run ends). `PORT` and `HOST` change where it listens.

**Secrets** (secret variables, the Postman API key, the email password) are encrypted in the database with AES-256-GCM. The key is created on first start in `server/data/secret.key` (readable only by you), or comes from `QA_SECRET_KEY` (32 random bytes, base64: `openssl rand -base64 32`). **Back up the key together with the database**: without it the saved secrets can't be read, and you'd need to enter them again. Secrets saved by an earlier version are encrypted on the next start. This protects copies of the database; it doesn't protect against someone who can read every file on your computer.

## API

**Settings and Postman**
- `GET /api/settings`: whether Postman is connected, and the key's last 4 characters.
- `PUT /api/settings/postman` `{ "api_key": "PMAK-..." }`: checked against Postman, then saved. `null` forgets it.
- `GET /api/postman/workspaces`, `GET /api/postman/workspaces/:id/collections`: browse Postman; each collection says whether it's imported.

**Collections**
- `POST /api/collections/import` `{ "uid": "..." }`: import from Postman (importing again updates it).
- `POST /api/collections/upload`: body is a collection file exported from Postman (v2.1).
- `GET /api/collections`: all, with each one's last run. `GET /api/collections/:id`: details and its requests.
- `GET /api/collections/:id/json`: download the collection file.
- `POST /api/collections/:id/refresh`: pull the latest version from Postman.
- `DELETE /api/collections/:id`: its run history is kept.

**Environments**
- `GET /api/environments`, `GET /api/environments/:id`
- `POST /api/environments`, `PUT /api/environments/:id`:

      { "name": "stg", "label": "Stg", "base_url": "https://stg.example.com", "health_path": "/health",
        "variables": [ { "key": "apiToken", "value": "...", "secret": true }, { "key": "region", "value": "eu" } ] }

  Secret values are never returned: you get `"masked": "••••ab"`. To keep a secret's value when updating, send it with `"value": null`.
- `DELETE /api/environments/:id`
- `GET /api/environments/compare?ids=1,2,3`: every variable in any of them, each environment's value, and `same` / `different` / `missing` (or `unknown` if a secret can't be decrypted). Secrets are compared here and returned only masked.
- `POST /api/environments/:id/copy-from` `{ "source_id": 2, "keys": ["apiToken", "region"], "overwrite": false, "dry_run": true }`: copy variables from another environment into this one. Answers which keys were (or, with `dry_run`, would be) `added`, `overwritten`, left `unchanged`, `skipped` (different, and `overwrite` is off) or `not_found`. Secrets are copied on the server and stay secret.

Every run uses the environment's `base_url` as `{{baseUrl}}`, and its variables override the collection's own.

**Runs**
- `POST /api/runs`: queued, then run one at a time. Three kinds:
  - `{ "kind": "plain", "collection_id": 1, "environment_id": 1 }`: Newman only, free. Add `"data_file_id"` to run once per row of a test-data file.
  - `{ "kind": "ai", "ai_mode": "regression", "collection_id": 1, "environment_id": 1 }`: the agents re-check a collection: debug, heal, mark known bugs, update it in Postman. Needs a collection imported from Postman.
  - `{ "kind": "ai", "ai_mode": "build", "request": "what to test", "workspace_id": "…", "environment_id": 1 }`: the agents plan (you approve the plan), build, fix and publish a new collection to that workspace; it's then imported here and the run linked to it.
- `GET /api/runs?collection_id=&environment_id=&status=&kind=&limit=&before_id=`: newest first.
- `GET /api/runs/:id`: summary and full results.
- `GET /api/runs/:id/events`: **live**, as server-sent events. You get everything so far, then each new event; the stream ends when the run finishes.
- `GET /api/runs/:id/events/history?after=<seq>`: the same events as a list.
- `POST /api/runs/:id/approval` `{ "answer": "y" }`: answer an AI run's pending approval (anything other than `y` refuses).
- `POST /api/runs/:id/cancel`: cancel a queued run or a running AI run.

**Across runs**
- `GET /api/known-bugs`: every known bug per collection and environment: open or possibly fixed, first seen, last failed, how many runs it failed in, and the evidence (from the debugger, or from what the agents wrote on the marked request).
- `GET /api/changes`: every change the self-healer made: the request, which part, the reason, the diff, whether you approved it, and whether it was kept, undone, or never proven.
- `GET /api/dashboard?days=30`: the dashboard's figures.

**Email reports**
- `GET /api/settings/email`, `PUT /api/settings/email` `{ "host", "port", "secure", "user", "from", "dashboard_url", "password" }`: the mail server. The password is never returned; send `null` to keep it, `""` to clear it. Gmail: `smtp.gmail.com`, port 465, secure, with an [app password](https://myaccount.google.com/apppasswords).
- `POST /api/settings/email/test` `{ "to" }`: send a test email.
- `GET` / `PUT /api/collections/:id/reports` `{ "recipients": [...], "send_when": "always" | "failure" | "new_failure", "enabled" }`: who gets a collection's reports, and when. `new_failure` emails only when something fails that didn't last time (known bugs don't count), or a run stops passing.
- `GET /api/runs/:id/report.html` (`?download=1` to save it): the full report.
- `POST /api/runs/:id/email` `{ "recipients"?: [...] }`: email a run's report now (to the collection's recipients if none are given).
- `GET /api/runs/:id/emails`: what was sent for a run, or why it couldn't be.

**Schedules** (5-field cron, in this computer's local time; they run while the server is running, and missed times aren't made up later)
- `GET /api/schedules?collection_id=`, `POST /api/schedules` `{ "collection_id", "environment_id", "kind": "plain" | "ai", "cron": "0 7 * * 1-5", "enabled" }`, `PUT` / `DELETE /api/schedules/:id`.
- `GET /api/schedules/preview?cron=…`: the next 3 times, or why the expression is invalid.
- A schedule doesn't start a new run while its previous one is still going. Scheduled AI runs are unattended: changes that need approval are refused and appear in the report.

**Test-data files** (CSV with a header row, or a JSON list of objects; up to 1 MB and 1000 rows). A plain run with one runs the collection once per row; each column is a variable (`{{email}}`, `pm.iterationData.get("email")`), and every result says which `iteration` (row, from 1) it belongs to.
- `GET /api/collections/:id/data-files`, `POST /api/collections/:id/data-files` `{ "name": "users.csv", "content": "…", "replace": false }`: list and upload. Each file says which of its columns the collection `used` and which it didn't (`unused`).
- `GET /api/data-files/:id` (with the first 20 rows), `GET /api/data-files/:id/download`, `DELETE /api/data-files/:id` (refused while a schedule uses it; runs keep its name).
- Schedules take `"data_file_id"` too (plain runs only).

**Logins** (every other `/api` path needs a session cookie; without one: `401 { "login": true }`, or a redirect to `/login` for pages opened in a browser)
- `GET /api/auth/status`: `{ enabled, setup_needed, logged_in }`.
- `POST /api/auth/setup` `{ "code", "password" }`: the first password (the code is in the server log). `POST /api/auth/login` `{ "password" }`, `POST /api/auth/logout`.
- `POST /api/auth/password` `{ "current", "password" }`: change it; other sessions end. `GET /api/auth/sessions`, `POST /api/auth/logout-others`.
- Requests that change something are refused (403) when the browser says they came from another website.

**Audit log**: `GET /api/audit?action=run.&q=Stg&before_id=`: newest first, 100 at a time.

**Backups**: `GET /api/backups`, `POST /api/backups` (one now), `GET /api/backups/:name/download`. Daily automatic backups; see `docs/DEPLOYMENT.md`.

**Runs at the same time**: `PUT /api/settings/runs` `{ "max_parallel": 1-8 }` (default 2). Two runs of the same collection on the same environment never run together.

**Contracts** (an API contract the Contract Analyst agent turns into tests)
- `POST /api/contracts/upload` `{ "filename", "content_base64", "name"? }`: OpenAPI 3 or Swagger 2 (JSON or YAML), or a document: PDF, Word (.docx), Markdown, text, HTML. Up to 10 MB. Old `.doc` files and scanned PDFs without text are refused with a reason.
- `POST /api/contracts/url` `{ "url", "name"? }`, `POST /api/contracts/postman` `{ "workspace_id", "spec_id", "name"? }` (specs: `GET /api/postman/workspaces/:id/specs`).
- `GET /api/contracts`, `GET /api/contracts/:id` (endpoints, warnings, runs, where it was published), `PATCH` (rename), `DELETE`, `GET /api/contracts/:id/source` (the original file).
- `POST /api/contracts/:id/refresh` (links and Postman specs): `{ changed, changes: { added, removed, changed } }`.
- Start a run: `POST /api/runs` `{ "kind": "ai", "ai_mode": "contract", "contract_id", "environment_id", "endpoints"?: ["GET /pets"], "request"?: "what to focus on" }`. The cases are reviewed on the run (approval kind `test_cases`; answer `y`, the edited plan as JSON, or feedback).
- Publish what it built, where the person chose: `POST /api/runs/:id/publish` `{ "workspace_id", "target": { "kind": "new", "name" } | { "kind": "folder", "collection_uid", "folder_name", "replace" } }`. Refused unless the run passed (failures only in known bugs). Folders: `GET /api/postman/collections/:uid/folders`. Published collections are imported into the dashboard too.

**Run statuses:** `queued`, `running`, `passed`, `passed_with_known_bugs` (the only failures are in `KNOWN BUG` requests), `failed`, `server_issue` ("Facing server issues, please check <Env> Env"), `circuit_breaker`, `error`, `cancelled`.

Plain runs use the same server-issue rule as the agents: a failing health check, or at least 80% of requests (and at least 3) getting server errors. A single 5xx is an ordinary failure.

## Tests

    npm test

Runs against a fake API, a fake Postman and a fake mail server on your machine: no real services, no model calls, nothing sent.
