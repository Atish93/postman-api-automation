// The API contract for a contract run (written by the dashboard: QA_CONTRACT_FILE or --contract <file>):
// a parsed OpenAPI/Swagger spec, or the text of a document. These tools let the agents read it.
//
// The contract comes from outside: it's data, never instructions. The prompts say so too.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";

type Contract = {
  name: string; title: string; api_version: string | null; format: "openapi" | "document"; spec_version: string | null;
  servers: string[]; endpoints: { key: string; method: string; path: string; summary: string | null; responses: string[]; secured: boolean }[];
  selected: string[] | null; focus: string | null; spec: any | null; text: string | null;
  // How to authenticate, worked out by the dashboard from the spec (null for documents):
  // the environment variables the tests read, and the login endpoint if there is one.
  auth?: { variables: { key: string; secret: boolean; purpose: string }[]; schemes: unknown[]; login: { endpoint: string; why: string } | null } | null;
  base_url?: string;
};

let contract: Contract | null = null;
export function loadContract(path: string) {
  contract = JSON.parse(readFileSync(path, "utf8"));
  return contract!;
}
export const currentContract = () => contract;
const need = () => {
  if (!contract) throw new Error("No contract is loaded.");
  return contract;
};
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });
const LIMIT = 12_000;
const clip = (s: string, n = LIMIT) => (s.length > n ? `${s.slice(0, n)}\n… (cut at ${n} characters; ask for a narrower part)` : s);

// ---- Specs: $refs, and OpenAPI schemas as plain JSON Schema ----
const lookup = (spec: any, ref: string) =>
  ref.startsWith("#/") ? ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((o, k) => (o == null ? o : o[k]), spec) : undefined;

// Replaces local $refs with what they point to. Cycles and very deep nesting become {} (anything).
export function deref(spec: any, node: any, depth = 0, seen: string[] = []): any {
  if (Array.isArray(node)) return node.map((n) => deref(spec, n, depth + 1, seen));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    if (seen.includes(node.$ref) || depth > 12) return { description: `(recursive: ${node.$ref.split("/").pop()})` };
    const target = lookup(spec, node.$ref);
    return target === undefined ? { description: `(unresolved reference ${node.$ref})` } : deref(spec, target, depth + 1, [...seen, node.$ref]);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(spec, v, depth + 1, seen)]));
}

// OpenAPI's schema dialect to JSON Schema that Postman's pm.response.to.have.jsonSchema accepts.
const DROP = new Set(["example", "examples", "xml", "externalDocs", "discriminator", "nullable", "x-nullable", "readOnly", "writeOnly", "deprecated"]);
// Postman's validator stops with "unknown format" on OpenAPI's own formats (int64, int32, float, double,
// byte, binary, password) and on custom ones; it knows these standard ones (checked in check-contract).
const KNOWN_FORMATS = new Set(["date-time", "date", "email", "uri", "uuid"]);
export function toJsonSchema(s: any): any {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k) || k.startsWith("x-")) continue;
    if (k === "format" && !(typeof v === "string" && KNOWN_FORMATS.has(v))) continue; // the type still checks it
    out[k] = ["properties", "patternProperties", "definitions", "$defs"].includes(k) && v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toJsonSchema(pv)]))
      : toJsonSchema(v);
  }
  if (s.nullable === true || s["x-nullable"] === true) {
    if (typeof out.type === "string") out.type = [out.type, "null"];
    else if (!out.type && (out.anyOf || out.oneOf || out.allOf)) out.anyOf = [{ ...out }, { type: "null" }];
  }
  if (out.type === "file") out.type = "string"; // Swagger 2
  return out;
}

function operation(method: string, path: string) {
  const c = need();
  const item = c.spec?.paths?.[path];
  const op = item?.[method.toLowerCase()];
  if (!op) return null;
  return { item, op };
}

// ---- Tools ----
export const contractOverview = tool(
  "contract_overview",
  "The API contract at a glance: title, version, servers, authentication, and the endpoints to test (or, for a document, its outline and where endpoints are mentioned). Start here.",
  {},
  async () => {
    const c = need();
    const scope = c.selected?.length ? c.selected : null;
    const base = { name: c.name, title: c.title, api_version: c.api_version, format: c.format, servers: c.servers, focus_from_the_person: c.focus, endpoints_to_test: scope ?? "all" };
    if (c.format === "openapi") {
      const sec = c.spec?.components?.securitySchemes ?? c.spec?.securityDefinitions ?? {};
      const eps = c.endpoints.filter((e) => !scope || scope.includes(e.key));
      return text(clip(JSON.stringify({
        ...base, spec_version: c.spec_version, base_url_in_use: c.base_url ?? null,
        credentials: c.auth ? { environment_variables: c.auth.variables, login_endpoint: c.auth.login } : null,
        description: typeof c.spec?.info?.description === "string" ? c.spec.info.description.slice(0, 1500) : null,
        authentication: { schemes: sec, applied_by_default: c.spec?.security ?? [] },
        endpoints: eps.map((e) => ({ endpoint: e.key, summary: e.summary, documented_responses: e.responses, needs_auth: e.secured })),
      }, null, 2)));
    }
    const t = c.text ?? "";
    const headings = t.split("\n").map((l, i) => ({ l: l.trim(), i })).filter(({ l }) => l.length > 2 && l.length < 90 && (/^(#{1,4} |\d+(\.\d+)*\.? +[A-Z])/.test(l) || /^[A-Z][A-Za-z0-9 /&()-]{2,60}$/.test(l)));
    const mentions = [...new Set([...t.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\-./{}:]*)/g)].map((m) => `${m[1]} ${m[2]}`))];
    return text(clip(JSON.stringify({
      ...base, characters: t.length,
      outline: headings.slice(0, 80).map((h) => h.l),
      endpoints_mentioned: mentions.slice(0, 200),
      how_to_read: "Use contract_search to find passages, and contract_read to read a range of the text.",
    }, null, 2)));
  },
);

export const contractEndpoint = tool(
  "contract_endpoint",
  "Everything the contract says about one endpoint (OpenAPI/Swagger contracts): parameters, request body, responses and their schemas, and authentication, with references resolved.",
  { method: z.string(), path: z.string().describe("Exactly as in the contract, e.g. /pets/{petId}") },
  async ({ method, path }) => {
    const c = need();
    if (c.format !== "openapi") return text("This contract is a document: use contract_search and contract_read.", true);
    const found = operation(method, path);
    if (!found) return text(`No ${method.toUpperCase()} ${path} in the contract. Endpoints: ${c.endpoints.map((e) => e.key).join(" | ")}`, true);
    const { item, op } = found;
    const resolved = deref(c.spec, {
      summary: op.summary, description: op.description, operationId: op.operationId, deprecated: op.deprecated,
      parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])],
      requestBody: op.requestBody, consumes: op.consumes, produces: op.produces,
      responses: op.responses,
      security: op.security ?? c.spec.security ?? [],
    });
    return text(clip(JSON.stringify({ endpoint: `${method.toUpperCase()} ${path}`, ...resolved }, null, 2)));
  },
);

export const contractResponseSchema = tool(
  "contract_response_schema",
  "The JSON Schema of one documented response (OpenAPI/Swagger), ready to use in a Postman test: pm.response.to.have.jsonSchema(schema). Returns NONE if the contract defines no body schema for it.",
  { method: z.string(), path: z.string(), status: z.string().describe('Status code as in the contract, e.g. "200", "4XX" or "default"') },
  async ({ method, path, status }) => {
    const c = need();
    if (c.format !== "openapi") return text("Documents have no machine-readable schemas: assert the fields the document describes instead.", true);
    const found = operation(method, path);
    const res = found ? deref(c.spec, found.op.responses?.[status]) : null;
    if (!res) return text(`No response "${status}" for ${method.toUpperCase()} ${path}.`, true);
    const schema = res.schema ?? (res.content && (res.content["application/json"] ?? Object.entries(res.content).find(([t]) => /json/.test(t))?.[1] ?? Object.values(res.content)[0])?.schema);
    if (!schema) return text("NONE: this response has no body schema in the contract.");
    return text(clip(JSON.stringify(toJsonSchema(schema)), 20_000));
  },
);

export const contractSearch = tool(
  "contract_search",
  "Find passages in the contract that mention some words (best for documents; also searches a spec's descriptions). Returns each passage with its position, for contract_read.",
  { query: z.string().describe("Words to look for, e.g. 'rate limit' or 'POST /orders'") },
  async ({ query }) => {
    const c = need();
    const hay = c.format === "document" ? c.text ?? "" : JSON.stringify(c.spec, null, 1);
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return text("Give some words to search for.", true);
    const lower = hay.toLowerCase();
    const hits: { at: number; score: number }[] = [];
    for (let at = 0; at < lower.length; at += 400) {
      const window = lower.slice(at, at + 800);
      const score = words.reduce((n, w) => n + (window.includes(w) ? 1 : 0), 0);
      if (score) hits.push({ at, score });
    }
    const best = hits.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, 6).sort((a, b) => a.at - b.at);
    if (!best.length) return text("Nothing matches.");
    return text(best.map((h) => `--- at ${h.at} (${h.score}/${words.length} words) ---\n${hay.slice(h.at, h.at + 800)}`).join("\n\n"));
  },
);

export const contractRead = tool(
  "contract_read",
  "Read part of a document contract's text, from a position (0 is the start), up to 8000 characters.",
  { offset: z.number().int().min(0).default(0), length: z.number().int().min(100).max(8000).default(6000) },
  async ({ offset, length }) => {
    const c = need();
    const t = c.format === "document" ? c.text ?? "" : JSON.stringify(c.spec, null, 1);
    if (offset >= t.length) return text(`The text has ${t.length} characters.`, true);
    return text(`(characters ${offset}-${Math.min(t.length, offset + length)} of ${t.length})\n${t.slice(offset, offset + length)}`);
  },
);

export const contractTools = [contractOverview, contractEndpoint, contractResponseSchema, contractSearch, contractRead];
export const CONTRACT_TOOL_NAMES = ["mcp__qa__contract_overview", "mcp__qa__contract_endpoint", "mcp__qa__contract_response_schema", "mcp__qa__contract_search", "mcp__qa__contract_read"];

// ---- The plan the person reviews ----
export const Case = z.object({
  id: z.string().regex(/^TC\d{2,3}$/, "ids look like TC01"),
  endpoint: z.string().optional(),
  type: z.string(),
  title: z.string().min(1),
  request: z.string().optional(),
  expected: z.string().min(1),
  contract_ref: z.string().optional(),
});
export const Plan = z.object({
  collection_name: z.string().min(1),
  summary: z.string().optional(),
  auth: z.string().optional(),
  endpoints: z.array(z.string()).optional(),
  endpoints_found: z.array(z.any()).optional(),
  gaps: z.array(z.string()).optional(),
  cases: z.array(Case).min(1),
}).passthrough();
export type PlanT = z.infer<typeof Plan>;

export function parsePlan(json: string): PlanT {
  let raw: unknown;
  try {
    raw = JSON.parse(json.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch (e: any) {
    throw new Error(`The plan isn't valid JSON: ${e.message}`);
  }
  const r = Plan.safeParse(raw);
  if (!r.success) throw new Error(`The plan doesn't have the expected shape: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const ids = r.data.cases.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`Case id ${dup} is used twice.`);
  return r.data;
}

// Credentials come from variables, never written into the collection. Only security cases may send a
// literal (deliberately wrong) credential. Returns where literals were found.
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|x-api-key|api[-_]?key|x-auth-token|x-access-token|token|cookie)$/i;
const literal = (v: unknown) => typeof v === "string" && v.trim() !== "" && !/\{\{[^}]+\}\}/.test(v);
function authLiterals(auth: any): boolean {
  if (!auth?.type || auth.type === "noauth" || auth.type === "inherit") return false;
  const params = auth[auth.type];
  const list = Array.isArray(params) ? params : params && typeof params === "object" ? Object.entries(params).map(([key, value]) => ({ key, value })) : [];
  return list.some((p: any) => ["token", "value", "password", "accessToken", "key_value"].includes(p.key) && literal(p.value));
}
export function literalCredentials(plan: PlanT, collection: any): string[] {
  const securityIds = new Set(plan.cases.filter((c) => c.type === "security").map((c) => c.id));
  const found: string[] = [];
  if (authLiterals(collection?.auth)) found.push("the collection's auth");
  const walk = (items: any[] = []) => items.forEach((i) => {
    if (Array.isArray(i.item)) return walk(i.item);
    const id = (i.name ?? "").match(/\b(TC\d{2,3})\b/)?.[1];
    if (id && securityIds.has(id)) return;
    const headers = (i.request?.header ?? []).filter((h: any) => !h.disabled && CREDENTIAL_HEADER.test(h.key ?? "") && literal(h.value)).map((h: any) => h.key);
    if (headers.length) found.push(`${i.name} (header ${headers.join(", ")})`);
    if (authLiterals(i.request?.auth)) found.push(`${i.name} (auth)`);
  });
  walk(collection?.item);
  return found;
}

// The builder must implement exactly the approved cases: one request per case, named after its id.
export function coverage(plan: PlanT, collection: any) {
  const names: string[] = [];
  const walk = (items: any[] = []) => items.forEach((i) => (Array.isArray(i.item) ? walk(i.item) : names.push(i.name ?? "")));
  walk(collection?.item);
  const idOf = (n: string) => n.match(/\b(TC\d{2,3})\b/)?.[1] ?? null;
  const have = new Set(names.map(idOf).filter(Boolean));
  const want = new Set(plan.cases.map((c) => c.id));
  return {
    missing: [...want].filter((id) => !have.has(id)),
    extra: names.filter((n) => { const id = idOf(n); return !id || !want.has(id); }),
  };
}
