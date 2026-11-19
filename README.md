# postman-api-automation

API test automation for the Restful-Booker demo API, built by hand and by a team of AI agents.

## collection/
- `build.js` generates `collection.json`, a 10-request Postman collection (login, create, read, update, delete, plus negative cases).
- `filter-tests.agent-built.json` is the collection the first agent wrote for the name filters.

Run a collection:

    cd collection && npm install && npx newman run collection.json

## agent/
A QA team of agents built with the Claude Agent SDK.

    cd agent && npm install
    export ANTHROPIC_API_KEY=...   # your Anthropic API key
    export POSTMAN_API_KEY=...     # your Postman API key

### The team
| Agent | Job | Tools |
|---|---|---|
| Planner | Turns a request into test cases (JSON) | `search_knowledge` |
| Builder | Turns the approved cases into a collection and runs it once | `search_knowledge`, `run_collection` |
| Debugger | Diagnoses each failure as test defect, flaky, or API bug, by probing the API directly; or triages a widespread outage. Changes nothing | `search_knowledge`, `get_request`, `get_run_details`, `send_request`, `rerun_collection`, `record_diagnosis` |
| Self-healer | Fixes diagnosed test defects with the smallest change | `search_knowledge`, `get_request`, `get_run_details`, `patch_request`, `rerun_collection` |
| Orchestrator | Runs the process and decides what gets published | `Agent` (starts the others), `run_status`, `mark_known_bugs`, approval and Postman tools |

Agents are defined in `agents.ts`, tools and every safety rule in `tools.ts`, settings in `qa.config.json`.

### Running it

    npm run build-tests -- [--env test|stg|prod] "what to test" [workspace id]     # build a new collection
    npm run regression -- [--env test|stg|prod] [collection uid ...]               # re-check published collections

With no uids, regression re-checks every "(agent-built)" collection in the workspace.

Exit codes, for CI: `0` finished, `2` server issues, `3` circuit breaker tripped, `1` other error.

### Settings: `qa.config.json`
- `environments`: base URL and health-check path for `test`, `stg` and `prod`. Fill in `stg` and `prod` before using them.
- `circuitBreaker`: the run stops repairing when this many requests need diagnosis at once: `minFailingRequests` or `failingRequestPercent`% of the collection, whichever is larger, and never more than half the collection. With the defaults: 11 requests trips at 6, 50 at 10, 200 at 30.
- `limits`: per run, at most `healsPerRun` changed requests, `attemptsPerRequest` changes to one request, and `newKnownBugsPerRun` new known bugs without a person's approval.
- `models`: `default`, plus optional `planner`, `builder`, `debugger`, `healer`, `orchestrator` to give one agent a different model. Run the model exam before changing one.

### Rules enforced in code
These live in `tools.ts`, so they hold whatever model an agent runs on:

- **Server issues stop everything.** A health check runs before any agent starts. During the run, any 5xx response or unreachable server (in a collection run or a debugger probe) cancels the run with `Facing server issues, please check <Test/Stg/Prod> Env`.
- **Circuit breaker.** When too many requests fail at once, the debugger only looks for the common cause (outage triage). Healing, marking and saving are refused.
- **Proof or revert.** A healer change is kept only if the next run shows its request passing and nothing else newly failing. Otherwise it is undone automatically.
- **Approval.** Changing an assertion line, a URL or a method waits for you to type `y`. With nobody to answer (CI, or the model exam), it is refused.
- **Scope.** The healer may only change requests diagnosed as test defects, never ones diagnosed as API bugs. The debugger may only probe the environment under test.
- **Known bugs.** API bugs keep their failing checks, and the request is renamed `KNOWN BUG - ...`. Later runs don't re-investigate a known bug that fails the same way.
- **Publishing.** Nothing is published or updated unless every remaining failure is a marked known bug. In build mode, only after you approved the plan. Nothing is saved when nothing changed.
- **Short reports.** Agents see run totals and details of failed requests only; `get_run_details` fetches any single request on demand.
- **Cleanup.** Bookings the debugger creates while probing are deleted when the run ends.
- **Learning.** High-confidence findings are appended to `knowledge/known-issues.md` and added to the search index.

### Checking it
- `npm run check`: checks every rule above directly, with no agents and no cost. Uses a fake server on your machine for the 5xx and circuit-breaker cases.
- `npm run eval [-- --model <model id>]`: **the model exam.** Runs the debugger and healer on collections with known faults (`eval/fixtures/`) and scores them; earlier findings are hidden so the answers can't be looked up. Run it before switching an agent to a different model. Roughly $0.30–0.60 per run.
- `npm run drill -- 500|404 <collection uid>`: an outage drill with the real agents against a fake server: `500` should end with "Facing server issues", `404` with the circuit breaker.
- `npm run typecheck`

`examples/` has logs of real runs.

### Knowledge base (RAG)
The agents are not given the API description up front. They look things up with `search_knowledge`:

- `rag/ingest.ts` builds `rag/index.json` from the API's published docs and the markdown files in `knowledge/`. Re-run it after changing either: `npx tsx rag/ingest.ts`
- `rag/search.ts` ranks chunks by keyword relevance (BM25). Try a query: `npx tsx rag/search.ts "how do I delete a booking"`

`agent.ts` is the original single-agent version, kept for comparison.

Never commit keys. `.env` is ignored by git.
