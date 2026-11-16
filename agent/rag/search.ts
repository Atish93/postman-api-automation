// Step 2 of RAG: find the chunks most relevant to a question.
// This uses keyword ranking (BM25, via MiniSearch): chunks score higher when they contain the
// query's words, especially rare ones. Try it: npx tsx rag/search.ts "how do I delete a booking"
import MiniSearch from "minisearch";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Chunk } from "./ingest.ts";

const chunks: Chunk[] = JSON.parse(readFileSync(new URL("./index.json", import.meta.url), "utf8"));

const index = new MiniSearch<Chunk>({
  fields: ["title", "text"], // what is searched
  storeFields: ["source", "title", "text"], // what comes back
});
index.addAll(chunks);

export function search(query: string, limit = 3) {
  return index
    .search(query, { boost: { title: 2 }, prefix: true, fuzzy: 0.2 })
    .slice(0, limit)
    .map((r) => ({ score: Number(r.score.toFixed(2)), source: r.source, title: r.title, text: r.text }));
}

// Lets you run this file directly to see what a query retrieves.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const query = process.argv.slice(2).join(" ");
  for (const r of search(query)) console.log(`${r.score}\t[${r.source}] ${r.title}`);
}
