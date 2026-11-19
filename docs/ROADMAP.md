# QA dashboard roadmap

A web dashboard around the agent team in `agent/`: connect Postman collections, manage environments and their data, run collections (plain or with the agents), email reports, and keep every run in a dashboard.

## Decisions
- Runs on your own machine first; deployable to a server later without rewriting.
- Single user for now; logins and roles in phase 6.
- Email through any SMTP account (e.g. Gmail with an app password).
- React + TypeScript for the UI; Node + TypeScript for the server; SQLite first, Postgres later.
- Each AI run starts the existing orchestrator as its own process, so runs are isolated and the safety rules in `agent/tools.ts` keep applying unchanged. Plain runs use Newman directly and cost nothing.

## Architecture

    Web UI (React) ──HTTP + live updates──▶ Server (Node)
                                             ├─ REST API, scheduler, email sender
                                             ├─ database: collections, environments, runs, events
                                             ├─ plain runs ──▶ Newman
                                             └─ AI runs ──▶ agent/orchestrator.ts (one process per run)
                                                            · events on stdout (QA_EVENTS=1)
                                                            · approvals answered on stdin
                                                            · result file (QA_RESULT_FILE)
                                                            · settings file per run (QA_CONFIG)

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Engine ready for a UI: events, approvals by another program, result file | **Done** |
| 1 | Server + database: import collections, environments, plain runs, run history | **Done** (`server/`) |
| 2 | Web UI: Dashboard, Collections, Environments, Runs (live log) | **Done** (`web/`) |
| 3 | AI runs from the UI: regression/build, live log, approval buttons, cost | **Done** |
| 4 | Email reports (summary + HTML report + link) and schedules | **Done** |
| 5 | Data across environments: encrypted secrets, compare, copy values, test-data files | **Done** |
| 6 | Hardening: login, parallel runs, Docker, deployment, backups, audit log | **Done** |

### 0. Engine (done)
- `QA_EVENTS=1`: one `@@event {json}` line per event on stdout.
- Approval requests are events with the diff; the answer is one line on stdin.
- `QA_RESULT_FILE=<path>`: everything the run produced, written when it ends.
- Checked by `npm run check:events` (no model calls).

### 1. Server (done)
See `server/README.md`. The run manager already starts AI runs, streams their events and passes approvals, so phase 3 is mostly UI. Tables for recipients and schedules come with phase 4.

1. `server/` project with a SQLite database.
2. Tables: collections, environments, variables, runs, run_events, recipients, schedules.
3. Collections: connect a Postman API key, list workspaces, import; or upload a collection JSON.
4. Environments: create, edit, delete; base URL, health path, variables.
5. Run manager: plain runs through Newman, AI runs through the orchestrator; store results and stream progress.
6. Tests for every endpoint.

### 2. Web UI (done)
See `web/README.md`. It already starts AI runs (regression), follows them live and answers approvals, so phase 3 is left with build mode from the UI (planner → plan approval → builder) and views of known bugs and healer changes across all runs.

1. React app with routing and layout.
2. Collections, Environments and Runs pages; a run's page shows the live log and results.
3. Dashboard: pass rate over time, latest runs, open known bugs, healer changes, AI cost per week.

### 3. AI runs in the UI (done)
Build with AI (describe what to test, approve the plan on the run page, the result is published and imported), Known bugs and AI changes pages, evidence from the debugger or the marked request.

1. Run dialog: collection, environment, plain or AI, regression or build.
2. Live log by agent; approval cards with the diff and Approve / Reject.
3. Known bugs and healer changes as their own views.

### 4. Email and schedules (done)
SMTP settings with a test email; per-collection recipients and when to send (always, on failure, only new failures); the email with summary, link and the full HTML report attached; reports downloadable from every run; schedules with presets or cron, a preview of the next runs, no pile-ups, unattended AI runs.

1. SMTP settings.
2. Recipients per collection; send always, on failure, or on new failures only.
3. Email: summary, link to the run, full HTML report attached.
4. Schedules, e.g. weekdays 07:00 on Stg.

### 5. Data across environments (done)
Secrets encrypted in the database (AES-256-GCM, key in `server/data/secret.key`); Environments → Compare and copy; a Test data card on each collection, a data-file choice when running or scheduling, results grouped by row.

1. Secret variables, the Postman API key and the email password encrypted at rest; existing plain values are encrypted on the next start. Never sent to the browser in full. An AI run's settings file (which holds the environment's secrets for the agent) is readable only by its owner and deleted when the run ends.
2. Side-by-side comparison of environments (same / different / missing; secrets compared on the server); copy chosen values between them, with a preview and without overwriting unless asked.
3. Test-data files (CSV or JSON) for running a collection once per data row; which columns the collection doesn't use; the row of every failure in the run, the report and the email.

### 6. Hardening (done)
Decided: one admin password (no roles), SQLite kept (no Postgres), a shared server with HTTPS, up to N runs at once. See `docs/DEPLOYMENT.md`.

1. Login: one password (scrypt hash), sessions in HttpOnly cookies, a one-time setup code from the server log, a limit on wrong passwords, password reset from the command line, refusal of requests from other websites, strict security headers.
2. Audit log: logins, settings, environments (which keys, never values), collections, test data, schedules, runs, every AI approval answered, backups. It has its own page, with filters.
3. Parallel runs: up to N at once (Settings), never the same collection on the same environment together; queued runs survive a restart.
4. Backups: daily (newest 7 kept), by hand in Settings or `npm run backup`, downloadable; `npm run restore`. The encryption key is kept out of backups.
5. Docker image (non-root, health check, one data volume, including what the agents learn), docker-compose with Caddy for HTTPS, a systemd unit, and the deployment guide.

Later, if the dashboard grows to a team: user accounts with roles, and Postgres.
