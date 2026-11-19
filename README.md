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
| Builder | Turns the approved cases into a passing collection | `search_knowledge`, `run_collection` |
| Orchestrator | Runs plan -> human approval -> build -> publish | `Agent` (starts the others), `request_approval`, `postman_list_collections`, `postman_publish_collection` |

The run pauses at the plan and waits for you to type `y`, or what to change. Publishing is refused in code unless a human approved the plan and the last run had zero failures.

    npx tsx orchestrator.ts "what to test" [workspace id]

`agent.ts` is the earlier single-agent version of the same job, kept for comparison. Shared tools live in `tools.ts`.

### Knowledge base (RAG)
The agent is not given the API description up front. It looks things up with a `search_knowledge` tool:

- `rag/ingest.ts` builds `rag/index.json` from the API's published docs and the markdown files in `knowledge/`. Re-run it after changing either: `npx tsx rag/ingest.ts`
- `rag/search.ts` ranks chunks by keyword relevance (BM25). Try a query: `npx tsx rag/search.ts "how do I delete a booking"`

Never commit keys. `.env` is ignored by git.
