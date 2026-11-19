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
| 3 | AI runs from the UI: regression/build, live log, approval buttons, cost | Next (mostly done in phase 2) |
| 4 | Email reports (summary + HTML report + link) and schedules | |
| 5 | Data across environments: encrypted secrets, compare, copy values, test-data files | |
| 6 | Hardening: logins, Postgres, job queue, Docker, deployment, backups, audit log | |

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

### 3. AI runs in the UI
1. Run dialog: collection, environment, plain or AI, regression or build.
2. Live log by agent; approval cards with the diff and Approve / Reject.
3. Known bugs and healer changes as their own views.

### 4. Email and schedules
1. SMTP settings.
2. Recipients per collection; send always, on failure, or on new failures only.
3. Email: summary, link to the run, full HTML report attached.
4. Schedules, e.g. weekdays 07:00 on Stg.

### 5. Data across environments
1. Secret variables encrypted at rest, never sent to the browser in full.
2. Side-by-side comparison of environments; copy values between them.
3. Test-data files for running a collection once per data row.

### 6. Hardening
Logins and roles, Postgres, a job queue for parallel runs, Docker, deployment guide, backups, audit log of approvals.
