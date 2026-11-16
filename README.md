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

### Knowledge base (RAG)
The agent is not given the API description up front. It looks things up with a `search_knowledge` tool:

- `rag/ingest.ts` builds `rag/index.json` from the API's published docs and the markdown files in `knowledge/`. Re-run it after changing either: `npx tsx rag/ingest.ts`
- `rag/search.ts` ranks chunks by keyword relevance (BM25). Try a query: `npx tsx rag/search.ts "how do I delete a booking"`

Never commit keys. `.env` is ignored by git.
