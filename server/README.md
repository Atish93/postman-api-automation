# QA dashboard server

The API behind the QA dashboard (phase 1 of `docs/ROADMAP.md`): connect Postman, import collections, manage environments, run collections plainly (Newman) or with the agent team, and keep every run.

## Setup

Needs Node 22.13 or newer (the database uses Node's built-in SQLite).

    cd agent && npm install          # the agents, used by AI runs
    cd ../server && npm install
    export ANTHROPIC_API_KEY=...     # only needed for AI runs
    npm start                        # http://127.0.0.1:4000

The database is `server/data/qa.db` (set `QA_DB` to use another file). Each AI run's settings and result file are kept in `server/data/runs/<id>/`. `PORT` and `HOST` change where it listens.

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

Every run uses the environment's `base_url` as `{{baseUrl}}`, and its variables override the collection's own.

**Runs**
- `POST /api/runs`: queued, then run one at a time. Three kinds:
  - `{ "kind": "plain", "collection_id": 1, "environment_id": 1 }`: Newman only, free.
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

**Run statuses:** `queued`, `running`, `passed`, `passed_with_known_bugs` (the only failures are in `KNOWN BUG` requests), `failed`, `server_issue` ("Facing server issues, please check <Env> Env"), `circuit_breaker`, `error`, `cancelled`.

Plain runs use the same server-issue rule as the agents: a failing health check, or at least 80% of requests (and at least 3) getting server errors. A single 5xx is an ordinary failure.

## Tests

    npm test

Runs against a fake API and a fake Postman on your machine: no real services, no model calls, a few seconds.
