// Step 1 of RAG: turn source documents into small searchable chunks and save them to rag/index.json.
// Run with: npx tsx rag/ingest.ts
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

export type Chunk = { id: string; source: string; title: string; text: string };

const stripHtml = (s = "") => s.replace(/<[^>]+>/g, "").trim();

// Source A: the API's published documentation. One chunk per endpoint.
async function apiDocChunks(): Promise<Chunk[]> {
  const res = await fetch("https://restful-booker.herokuapp.com/apidoc/api_data.json");
  if (!res.ok) throw new Error(`Could not fetch API docs: ${res.status}`);
  const endpoints: any[] = await res.json();

  const fields = (group: any) =>
    Object.entries(group?.fields ?? {})
      .flatMap(([section, list]) =>
        (list as any[]).map(
          (f) => `- ${f.field} (${f.type}${f.optional ? ", optional" : ""}) [${section}]: ${stripHtml(f.description)}`,
        ),
      )
      .join("\n");
  const examples = (list: any[] = []) => list.map((e) => `${e.title}\n${e.content}`).join("\n\n");

  return endpoints.map((e) => ({
    id: `api:${e.name}`,
    source: "API documentation",
    title: `${e.type.toUpperCase()} /${e.url} (${e.title})`,
    text: [
      stripHtml(e.description),
      e.parameter && `Parameters:\n${fields(e.parameter)}`,
      e.header && `Headers:\n${fields(e.header)}`,
      e.examples?.length && `Request examples:\n${examples(e.examples)}`,
      e.success && `Success response:\n${fields(e.success)}\n${examples(e.success.examples)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  }));
}

// Source B: our own markdown notes in knowledge/. One chunk per "## " section.
function markdownChunks(): Chunk[] {
  return readdirSync("knowledge")
    .filter((f) => f.endsWith(".md"))
    .flatMap((file) =>
      readFileSync(`knowledge/${file}`, "utf8")
        .split(/^## /m)
        .slice(1)
        .map((section) => {
          const [title, ...body] = section.split("\n");
          return { id: `${file}:${title.trim()}`, source: file, title: title.trim(), text: body.join("\n").trim() };
        }),
    );
}

const chunks = [...(await apiDocChunks()), ...markdownChunks()];
writeFileSync("rag/index.json", JSON.stringify(chunks, null, 2));
console.log(`Indexed ${chunks.length} chunks:`);
for (const c of chunks) console.log(`  [${c.source}] ${c.title} (${c.text.length} chars)`);
