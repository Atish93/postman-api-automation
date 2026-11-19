# postman-api-automation

API test automation for the Restful-Booker demo API, built by hand and by an AI agent.

## collection/
- `build.js` generates `collection.json`, a 10-request Postman collection (login, create, read, update, delete, plus negative cases).
- `filter-tests.agent-built.json` is the collection the agent wrote for the name filters.

Run a collection:

    cd collection && npm install && npx newman run collection.json

## agent/
`agent.ts` is a QA agent built with the Claude Agent SDK. Given a task, it designs a collection, runs it with Newman, fixes failing tests, and publishes it to a Postman workspace. It refuses to publish unless the last run had zero failures.

    cd agent && npm install
    export ANTHROPIC_API_KEY=...   # your Anthropic API key
    export POSTMAN_API_KEY=...     # your Postman API key
    npx tsx agent.ts "Describe the tests you want and the workspace id to publish to"

### Orchestration: planner, builder, orchestrator
`orchestrator.ts` splits the job across three agents, each with only the tools its job needs:

| Agent | Job | Tools |
|---|---|---|
| Planner | Turns a request into test cases (JSON) | `search_knowledge` |
| Builder | Turns the approved cases into a collection and runs it once | `search_knowledge`, `run_collection` |
| Debugger | Diagnoses each failure as test defect, flaky, or API bug, by probing the API directly. Changes nothing | `search_knowledge`, `get_request`, `send_request`, `rerun_collection`, `record_diagnosis` |
| Self-healer | Fixes diagnosed test defects with the smallest change | `search_knowledge`, `get_request`, `patch_request`, `rerun_collection` |
| Orchestrator | Runs the process and decides what gets published | `Agent` (starts the others), `run_status`, `mark_known_bugs`, approval and Postman tools |

Two modes:

    npx tsx orchestrator.ts "what to test" [workspace id]        # build a new collection
    npx tsx orchestrator.ts --regression [collection uid ...]    # re-check published collections

With no uids, regression re-checks every "(agent-built)" collection in the workspace.

Rules enforced in code (`tools.ts`), not just in the agents' instructions:
- The healer may only change requests the debugger diagnosed as a test defect, and never one diagnosed as an API bug.
- A healer change that touches an assertion line pauses and waits for you to type `y`. With nobody to answer (for example in CI), it is refused.
- API bugs keep their failing checks; the request is renamed `KNOWN BUG - ...`.
- Nothing is published or updated unless every remaining failure is a marked known bug, and in build mode only after you approved the plan.
- The debugger may only send probe requests to the API under test.
- High-confidence findings are appended to `knowledge/known-issues.md` and added to the search index, so later runs recognise them.

`agent.ts` is the earlier single-agent version of the same job, kept for comparison. Shared tools live in `tools.ts`.

### Knowledge base (RAG)
The agent is not given the API description up front. It looks things up with a `search_knowledge` tool:

- `rag/ingest.ts` builds `rag/index.json` from the API's published docs and the markdown files in `knowledge/`. Re-run it after changing either: `npx tsx rag/ingest.ts`
- `rag/search.ts` ranks chunks by keyword relevance (BM25). Try a query: `npx tsx rag/search.ts "how do I delete a booking"`

Never commit keys. `.env` is ignored by git.
