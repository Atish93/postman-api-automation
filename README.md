# postman-api-automation

API test automation for the Restful-Booker demo API, built by hand and by a team of AI agents, with a dashboard to run and manage it all (`docs/ROADMAP.md`).

- `agent/`: the agent team (below).
- `server/`: the dashboard's API server: collections, environments, runs. See `server/README.md`.
- `web/`: the dashboard itself. See `web/README.md`. Quick start:

      cd agent && npm install
      cd ../web && npm install && npm run build
      cd ../server && npm install && npm start      # http://127.0.0.1:4000

  The first visit asks you to set a password, using a setup code printed in the server's log. To run it on a server with Docker and HTTPS, see `docs/DEPLOYMENT.md`.
- `collection/`: the first hand-built collection.

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
| Contract Analyst | Contract runs only: reads an API contract (OpenAPI/Swagger, or a PDF/Word/Markdown document) and writes test cases tied to it, plus the gaps where the contract is silent | `contract_overview`, `contract_endpoint`, `contract_response_schema`, `contract_search`, `contract_read` |

Agents are defined in `agents.ts`, tools and every safety rule in `tools.ts` (contract tools in `contract.ts`), settings in `qa.config.json`.

**Contract runs** (started from the dashboard's Contracts page) test any API against its contract:
1. The Contract Analyst reads the contract and writes test cases.
2. You review them: keep, edit, remove or add cases, or send them back with feedback. The edited cases are what gets built.
3. The builder turns them into a collection. It must have exactly one request per approved case: the program refuses anything else. Response schemas from the contract are asserted in full with `pm.response.to.have.jsonSchema` (OpenAPI-only formats such as `int64`, which Postman's validator rejects, are left out; the type is still checked).
   - **Credentials** are set once, in the collection's auth, from variables with fixed names: `{{apiKey}}`, `{{accessToken}}`, `{{username}}`/`{{password}}`. If the API has a login or token endpoint, a collection-level script logs in when no token is stored, saves it to `{{accessToken}}` and every request uses it. The program refuses literal credentials in requests, except in security cases that send a deliberately wrong one.
4. The debugger and self-healer work as usual, with the contract as their documentation. A response that contradicts the contract is an API bug (a "contract violation") and is marked `KNOWN BUG`. The knowledge base isn't used, since it's about another API.
5. Nothing is published by the agents: the dashboard asks which workspace, and a new collection or a folder in an existing one, and publishes only after you confirm.

The contract is treated as data, never as instructions, so text inside a document can't direct the agents.

### Running it

    npm run build-tests -- [--env test|stg|prod] "what to test" [workspace id]     # build a new collection
    npm run regression -- [--env test|stg|prod] [collection uid ...]               # re-check published collections
    npx tsx orchestrator.ts [--env ...] --contract <contract.json>                # contract run (the dashboard writes the file)

With no uids, regression re-checks every "(agent-built)" collection in the workspace.

Exit codes, for CI: `0` finished, `2` server issues, `3` circuit breaker tripped, `1` other error.

### Settings: `qa.config.json`
- `environments`: base URL and health-check path for `test`, `stg` and `prod`. Fill in `stg` and `prod` before using them.
- `serverErrors`: when the run is treated as an outage instead of failures to debug (see below). `recheckAfterSeconds` is the wait before the confirming re-run.
- `circuitBreaker`: the run stops repairing when this many requests need diagnosis at once: `minFailingRequests` or `failingRequestPercent`% of the collection, whichever is larger, and never more than half the collection. With the defaults: 11 requests trips at 6, 50 at 10, 200 at 30.
- `limits`: per run, at most `healsPerRun` changed requests, `attemptsPerRequest` changes to one request, and `newKnownBugsPerRun` new known bugs without a person's approval.
- `models`: `default`, plus optional `planner`, `analyst`, `builder`, `debugger`, `healer`, `orchestrator` to give one agent a different model. Run the model exam before changing one.

### Rules enforced in code
These live in `tools.ts`, so they hold whatever model an agent runs on:

- **Only a real outage stops the run.** A health check runs before any agent starts. During the run, server errors (5xx or no response) end the run with `Facing server issues, please check <Test/Stg/Prod> Env` (exit code 2) only when the server itself looks down: the health check fails, or at least 80% of requests (and at least 3) get server errors in a run *and* in a re-run 15 seconds later. Fewer server errors are ordinary failures: the debugger reproduces them and labels them an API bug (the endpoint crashes on valid input), a test defect (the test sends bad input) or flaky (it doesn't reproduce).
- **Circuit breaker.** When too many requests fail at once, the debugger only looks for the common cause (outage triage). Healing, marking and saving are refused.
- **Proof or revert.** A healer change is kept only if the next run shows its request passing and nothing else newly failing. Otherwise it is undone automatically.
- **Approval.** Changing an assertion line, a URL or a method waits for you to type `y`. With nobody to answer (CI, or the model exam), it is refused.
- **Scope.** The healer may only change requests diagnosed as test defects, never ones diagnosed as API bugs. The debugger may only probe the environment under test.
- **Known bugs.** API bugs keep their failing checks, and the request is renamed `KNOWN BUG - ...`. Later runs don't re-investigate a known bug that fails the same way.
- **Publishing.** Nothing is published or updated unless every remaining failure is a marked known bug. In build mode, only after you approved the plan. Nothing is saved when nothing changed.
- **Short reports.** Agents see run totals and details of failed requests only; `get_run_details` fetches any single request on demand.
- **Cleanup.** Bookings the debugger creates while probing are deleted when the run ends.
- **Learning.** High-confidence findings are appended to `knowledge/known-issues.md` and added to the search index.

### Using it from another program
This is how the dashboard (see `docs/ROADMAP.md`) drives the agents:
- `QA_EVENTS=1`: every event (agent messages, tool calls, collection runs, diagnoses, changes, approvals, server issues, the circuit breaker, publishing) is printed as one `@@event {json}` line on stdout, alongside the normal log.
- Approval requests are events that include the diff; answer by writing one line to the run's stdin (`y`, or anything else to refuse).
- `QA_RESULT_FILE=<path>`: when the run ends, everything it produced is written there: exit code, cost, environment, per-collection numbers, failures, diagnoses, changes, known bugs, what was published, and the orchestrator's report.
- `QA_CONFIG=<path>`: use a different settings file (the server writes one per run).

### Checking it
- `npm run check`: checks every rule above directly, with no agents and no cost.
- `npm run check:contract`: checks contract runs with no agents and no cost: reading specs and documents, response schemas that Newman really enforces (a conforming response passes, a violation fails), your case review (approve, edit, feedback), the one-request-per-case rule, and that nobody in a contract run can publish.
- `npm run check:events`: checks the interface above (events, approvals from another program, result file), with no agents and no cost. Uses a fake server on your machine for the 5xx and circuit-breaker cases.
- `npm run eval [-- --model <model id>]`: **the model exam.** Runs the debugger and healer on collections with known faults (`eval/fixtures/`) and scores them; earlier findings are hidden so the answers can't be looked up. Run it before switching an agent to a different model. Roughly $0.30–0.60 per run.
- `npm run drill -- crash|500|404 <collection uid>`: drills with the real agents against a fake server. `crash` forwards to the real API but makes the checkin filter answer 500: it should be debugged as an API bug, not terminate. `500` (everything fails) should end with "Facing server issues". `404` should trip the circuit breaker. Drills are dry runs (`QA_DRY_RUN=1`): nothing is written to Postman or the knowledge base.
- `npm run typecheck`

`examples/` has logs of real runs.

### Knowledge base (RAG)
The agents are not given the API description up front. They look things up with `search_knowledge`:

- `rag/ingest.ts` builds `rag/index.json` from the API's published docs and the markdown files in `knowledge/`. Re-run it after changing either: `npx tsx rag/ingest.ts`
- `rag/search.ts` ranks chunks by keyword relevance (BM25). Try a query: `npx tsx rag/search.ts "how do I delete a booking"`

`agent.ts` is the original single-agent version, kept for comparison.

Never commit keys. `.env` is ignored by git.
