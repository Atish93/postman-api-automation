// API contracts: OpenAPI 3 / Swagger 2 (JSON or YAML), or a document (PDF, Word, Markdown, text, HTML)
// that describes the API in prose. Specs are parsed here into a list of endpoints; documents are kept as
// text, and the Contract Analyst agent finds the endpoints in them.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { HttpError } from "./errors.ts";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 400_000;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export type Endpoint = {
  key: string;                 // "GET /pets/{id}"
  method: string;
  path: string;
  summary: string | null;
  operation_id: string | null;
  tags: string[];
  parameters: number;
  has_body: boolean;
  responses: string[];         // documented status codes, e.g. ["200", "404"]
  secured: boolean;
  deprecated: boolean;
  fingerprint: string;         // changes when anything in the operation changes (schemas, descriptions...)
};

export type ParsedContract = {
  format: "openapi" | "document";
  spec_version: string | null; // "3.0.3", "2.0"; null for documents
  title: string;
  version: string | null;      // the API's own version (info.version)
  servers: string[];
  endpoints: Endpoint[];       // empty for documents until the agent has read them
  spec: unknown | null;        // the spec as an object (openapi)
  text: string | null;         // the readable text (documents)
  warnings: string[];
  hash: string;
};

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// Which kind of file this is, from its name and first bytes.
function kindOf(filename: string, bytes: Buffer): "pdf" | "docx" | "html" | "text" {
  const name = filename.toLowerCase();
  if (bytes.subarray(0, 5).toString() === "%PDF-" || name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx") || (bytes[0] === 0x50 && bytes[1] === 0x4b && name.endsWith(".docx"))) return "docx";
  if (name.endsWith(".doc")) throw new HttpError(400, "Old Word files (.doc) can't be read. Save it as .docx or PDF and upload that.");
  if (/\.html?$/.test(name)) return "html";
  return "text";
}

const htmlToText = (html: string) =>
  html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// Reads a structured spec if the text is one (JSON or YAML with "openapi" or "swagger").
function asSpec(text: string): any | null {
  const t = text.trim();
  let doc: any;
  try {
    doc = t.startsWith("{") ? JSON.parse(t) : parseYaml(t, { maxAliasCount: 100 });
  } catch {
    return null;
  }
  return doc && typeof doc === "object" && (typeof doc.openapi === "string" || doc.swagger === "2.0" || doc.swagger === 2) ? doc : null;
}

export async function parseContract(filename: string, bytes: Buffer): Promise<ParsedContract> {
  if (!bytes.length) throw new HttpError(400, "The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(400, `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const hash = sha256(bytes);
  const kind = kindOf(filename, bytes);
  if (kind === "text") {
    const text = bytes.toString("utf8").replace(/^﻿/, "");
    const spec = asSpec(text);
    if (spec) return { ...fromSpec(spec), hash };
    if (/^\s*[{[]/.test(text) || /\.(json|ya?ml)$/i.test(filename))
      throw new HttpError(400, `"${filename}" isn't an OpenAPI or Swagger file: it needs an "openapi: 3.x" or "swagger: 2.0" field at the top. If it's documentation, upload it as PDF, Word, Markdown or text.`);
    return fromDocument(filename, text, hash);
  }
  if (kind === "html") return fromDocument(filename, htmlToText(bytes.toString("utf8")), hash);
  if (kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    let text: string;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      text = (await extractText(pdf, { mergePages: true })).text as string;
    } catch (e: any) {
      throw new HttpError(400, `The PDF can't be read: ${e.message}`);
    }
    if (!text.trim()) throw new HttpError(400, "The PDF has no text to read (it may be scanned images). Upload a PDF with selectable text, or the Word/Markdown original.");
    return fromDocument(filename, text, hash);
  }
  const mammoth = (await import("mammoth")).default;
  let text: string;
  try {
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  } catch (e: any) {
    throw new HttpError(400, `The Word file can't be read: ${e.message}`);
  }
  if (!text.trim()) throw new HttpError(400, "The Word file has no text.");
  return fromDocument(filename, text, hash);
}

function fromDocument(filename: string, raw: string, hash: string): ParsedContract {
  const warnings: string[] = [];
  let text = raw.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  if (text.length > MAX_TEXT_CHARS) {
    warnings.push(`The document is long: only the first ${MAX_TEXT_CHARS.toLocaleString("en")} characters are used.`);
    text = text.slice(0, MAX_TEXT_CHARS);
  }
  const mentioned = new Set([...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\-./{}:]*)/g)].map((m) => `${m[1]} ${m[2]}`));
  if (!mentioned.size) warnings.push("No endpoints like \"GET /path\" were spotted in the text; the agent will look for them, but a structured spec gives better tests.");
  const title = (text.split("\n").find((l) => l.trim().length > 3)?.trim().slice(0, 120)) || filename.replace(/\.[^.]+$/, "");
  return { format: "document", spec_version: null, title, version: null, servers: [], endpoints: [], spec: null, text, warnings, hash };
}

// ---- OpenAPI / Swagger ----

// Follows a local "$ref" ("#/components/schemas/Pet"). Remote refs are reported, not fetched.
function resolveRef(spec: any, ref: string): any {
  if (!ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((o, k) => (o == null ? o : o[k]), spec);
}

export function fromSpec(spec: any): Omit<ParsedContract, "hash"> {
  const warnings: string[] = [];
  const v3 = typeof spec.openapi === "string";
  if (v3 && !/^3\./.test(spec.openapi)) warnings.push(`OpenAPI ${spec.openapi} is newer than this reader knows; it is read as 3.x.`);
  const remote = new Set<string>();
  JSON.stringify(spec, (k, val) => { if (k === "$ref" && typeof val === "string" && !val.startsWith("#")) remote.add(val.split("#")[0]); return val; });
  if (remote.size) warnings.push(`It refers to other files (${[...remote].slice(0, 3).join(", ")}); those parts can't be read. Upload a single bundled file for complete tests.`);

  const servers: string[] = v3
    ? (spec.servers ?? []).map((s: any) => s?.url).filter(Boolean)
    : spec.host ? (spec.schemes?.length ? spec.schemes : ["https"]).map((s: string) => `${s}://${spec.host}${spec.basePath ?? ""}`) : [];
  const globalSecurity = (spec.security ?? []).length > 0;
  const endpoints: Endpoint[] = [];
  for (const [path, rawItem] of Object.entries<any>(spec.paths ?? {})) {
    const item = rawItem?.$ref ? resolveRef(spec, rawItem.$ref) ?? {} : rawItem ?? {};
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => (p?.$ref ? resolveRef(spec, p.$ref) : p)).filter(Boolean);
      endpoints.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? (typeof op.description === "string" ? op.description.split("\n")[0].slice(0, 160) : null),
        operation_id: op.operationId ?? null,
        tags: op.tags ?? [],
        parameters: params.filter((p: any) => p.in !== "body").length,
        has_body: v3 ? !!op.requestBody : params.some((p: any) => p.in === "body" || p.in === "formData"),
        responses: Object.keys(op.responses ?? {}),
        secured: op.security ? op.security.length > 0 : globalSecurity,
        deprecated: !!op.deprecated,
        fingerprint: sha256(JSON.stringify([op, item.parameters ?? null])).slice(0, 16),
      });
    }
  }
  if (!endpoints.length) warnings.push("The spec has no endpoints (paths).");
  return {
    format: "openapi",
    spec_version: v3 ? spec.openapi : "2.0",
    title: String(spec.info?.title ?? "Untitled API").slice(0, 200),
    version: spec.info?.version != null ? String(spec.info.version) : null,
    servers,
    endpoints,
    spec,
    text: null,
    warnings,
  };
}

// What changed between two versions of a contract's endpoints (after a refresh).
export function endpointChanges(before: Endpoint[], after: Endpoint[]) {
  const b = new Map(before.map((e) => [e.key, e])), a = new Map(after.map((e) => [e.key, e]));
  const changed: { key: string; what: string[] }[] = [];
  for (const [key, e] of a) {
    const old = b.get(key);
    if (!old) continue;
    const what: string[] = [];
    const added = e.responses.filter((r) => !old.responses.includes(r)), removed = old.responses.filter((r) => !e.responses.includes(r));
    if (added.length) what.push(`new responses ${added.join(", ")}`);
    if (removed.length) what.push(`responses removed ${removed.join(", ")}`);
    if (e.parameters !== old.parameters) what.push(`parameters ${old.parameters} → ${e.parameters}`);
    if (e.has_body !== old.has_body) what.push(e.has_body ? "now takes a body" : "no longer takes a body");
    if (e.secured !== old.secured) what.push(e.secured ? "now needs auth" : "no longer needs auth");
    if (e.deprecated && !old.deprecated) what.push("deprecated");
    if (!what.length && e.fingerprint !== old.fingerprint) what.push("details changed (schemas, parameters or descriptions)");
    if (what.length) changed.push({ key, what });
  }
  return {
    added: [...a.keys()].filter((k) => !b.has(k)),
    removed: [...b.keys()].filter((k) => !a.has(k)),
    changed,
  };
}

// ---- Where the API lives, and how it authenticates ----

// A spec's servers can be relative ("/api/v3"): resolve them against the URL the spec came from.
export function resolveServers(servers: string[], sourceUrl: string | null): string[] {
  return servers.map((s) => {
    if (/^https?:\/\//i.test(s) || !sourceUrl) return s;
    try { return new URL(s, sourceUrl).toString().replace(/\/$/, ""); } catch { return s; }
  });
}

// how: where a person gets the value (shown when it isn't set); auto: the tests fetch it themselves.
export type AuthVariable = { key: string; secret: boolean; purpose: string; auto?: boolean; how?: string };
export type Login = { endpoint: string; why: string; kind: "endpoint" | "password" | "client_credentials" };
export type ContractAuth = { variables: AuthVariable[]; schemes: { name: string; type: string; detail: string }[]; login: Login | null };
const BROWSER_FLOWS = new Set(["implicit", "authorizationCode", "accessCode"]);

const LOGIN_PATH = /\/(log-?in|sign-?in|auth(enticate)?|token|oauth\/token|sessions?)$/i;

// The environment variables the tests read, from the spec's security schemes and any login endpoint.
// Names are fixed by convention so the agents, the dashboard and Postman environments agree:
// apiKey, accessToken, username, password.
export function authOf(spec: any): ContractAuth | null {
  if (!spec || typeof spec !== "object") return null;
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  const vars = new Map<string, AuthVariable>();
  const add = (v: AuthVariable) => { if (!vars.has(v.key)) vars.set(v.key, v); };
  const out: ContractAuth["schemes"] = [];
  let login: ContractAuth["login"] = null;
  let apiKeys = 0;
  for (const [name, raw] of Object.entries<any>(schemes)) {
    const s = raw?.$ref ? undefined : raw;
    if (!s) continue;
    const type = String(s.type ?? "");
    if (type === "apiKey") {
      const key = apiKeys++ ? `apiKey_${name.replace(/\W+/g, "_")}` : "apiKey";
      const where = s.in === "header" ? "header" : s.in === "cookie" ? "cookie" : "query parameter";
      add({ key, secret: true, purpose: `API key for "${name}", sent in the ${where} "${s.name}"`,
        how: "Issued by the API's provider (for example from its developer portal); no endpoint hands it out, so a script can't fetch it. Only needed if the server checks it." });
      out.push({ name, type: "apiKey", detail: `${s.in} "${s.name}"` });
    } else if ((type === "http" && /^basic$/i.test(s.scheme)) || type === "basic") {
      add({ key: "username", secret: false, purpose: `User name for "${name}" (HTTP basic)` });
      add({ key: "password", secret: true, purpose: `Password for "${name}" (HTTP basic)` });
      out.push({ name, type: "basic", detail: "HTTP basic" });
    } else if (type === "http" || type === "oauth2" || type === "openIdConnect") {
      // OAuth2's password and client-credentials flows post to a token URL: the tests can fetch the token
      // themselves. The browser flows (implicit, authorization code) need a person to sign in.
      const flowNames: string[] = s.flows ? Object.keys(s.flows) : s.flow ? [s.flow] : [];
      const password = s.flows?.password?.tokenUrl ?? (s.flow === "password" ? s.tokenUrl : null);
      const client = s.flows?.clientCredentials?.tokenUrl ?? (s.flow === "application" ? s.tokenUrl : null);
      if (password && !login) login = { endpoint: `POST ${password}`, why: `the OAuth2 password flow of "${name}"`, kind: "password" };
      else if (client && !login) login = { endpoint: `POST ${client}`, why: `the OAuth2 client-credentials flow of "${name}"`, kind: "client_credentials" };
      const browserOnly = type === "oauth2" && flowNames.length > 0 && flowNames.every((f) => BROWSER_FLOWS.has(f));
      add({ key: "accessToken", secret: true, purpose: `Access token for "${name}" (${type === "http" ? `HTTP ${s.scheme}` : type})`,
        how: browserOnly
          ? `OAuth2 ${flowNames.join("/")} needs a person to sign in through a browser, which a script can't do. Get a token once (in Postman: Authorization, OAuth 2.0, Get New Access Token) and paste it here; it lasts until it expires. Only needed if the server checks it.`
          : type === "openIdConnect" ? "Get a token from the identity provider and paste it here."
          : "A token the API gives you after logging in. If the contract has a login endpoint, the tests fetch it themselves." });
      const flows = flowNames.join(", ");
      out.push({ name, type, detail: type === "http" ? `HTTP ${s.scheme}` : `${type}${flows ? ` (${flows})` : ""}` });
    }
  }
  // An unsecured POST to a login-like path is the login endpoint.
  if (!login) {
    for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
      if (item?.post && LOGIN_PATH.test(path)) { login = { endpoint: `POST ${path}`, why: "its path looks like a login", kind: "endpoint" }; break; }
    }
  }
  if (login) {
    if (login.kind === "client_credentials") {
      add({ key: "clientId", secret: false, purpose: `Client id for ${login.endpoint}`, how: "From the API's provider, when you register an app or a service account." });
      add({ key: "clientSecret", secret: true, purpose: `Client secret for ${login.endpoint}`, how: "From the API's provider, with the client id." });
    } else {
      add({ key: "username", secret: false, purpose: `User name for logging in (${login.endpoint})`, how: "A test account on the environment under test." });
      add({ key: "password", secret: true, purpose: `Password for logging in (${login.endpoint})`, how: "The test account's password." });
    }
    vars.set("accessToken", { key: "accessToken", secret: true, auto: true, purpose: `Filled in by the tests: they log in with ${login.endpoint} once and share the token` });
  }
  return { variables: [...vars.values()], schemes: out, login };
}
