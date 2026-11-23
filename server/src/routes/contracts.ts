// API contracts: add (file, URL or Postman spec), list, view, refresh, delete; and publishing what a
// contract run built to the Postman workspace and collection the person chooses.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { postman } from "../postman.ts";
import { authOf, endpointChanges, MAX_FILE_BYTES, parseContract, resolveServers, type Endpoint, type ParsedContract } from "../contracts.ts";
import { parse as parseYaml } from "yaml";
import { loadEnvironment, networkReason } from "../runs/environment.ts";
import { encrypt } from "../secrets.ts";
import { importFromPostman } from "../collections.ts";
import { countRequests } from "./postman.ts";
import { audit } from "../audit.ts";

const json = (s: string | null) => (s ? JSON.parse(s) : null);

// The stored spec as an object (OpenAPI contracts), cached by content.
const specCache = new Map<string, any>();
export function specOf(c: any): any | null {
  if (c.format !== "openapi") return null;
  if (!specCache.has(c.hash)) {
    const t = Buffer.from(c.original).toString("utf8").replace(/^\uFEFF/, "").trim();
    specCache.set(c.hash, t.startsWith("{") ? JSON.parse(t) : parseYaml(t, { maxAliasCount: 100 }));
  }
  return specCache.get(c.hash);
}
export const serversOf = (c: any) => resolveServers(JSON.parse(c.servers), c.source_kind === "url" ? c.source_ref : null);
const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

export function contractRoutes(app: FastifyInstance, db: DB) {
  const get = (id: number) => {
    const c = db.prepare("SELECT * FROM contracts WHERE id = ?").get(id) as any;
    if (!c) throw new HttpError(404, "Contract not found.");
    return c;
  };
  const summary = (c: any) => {
    const last = db.prepare("SELECT id, status, created_at FROM runs WHERE contract_id = ? ORDER BY id DESC LIMIT 1").get(c.id) as any;
    const pubs = (db.prepare("SELECT COUNT(*) AS n FROM contract_publications WHERE contract_id = ?").get(c.id) as any).n;
    return {
      id: c.id, name: c.name, title: c.title, api_version: c.api_version, format: c.format, spec_version: c.spec_version,
      source_kind: c.source_kind, source_ref: c.source_ref, filename: c.filename,
      endpoint_count: JSON.parse(c.endpoints).length, created_at: c.created_at, updated_at: c.updated_at, checked_at: c.checked_at,
      last_run: last ?? null, publications: pubs,
    };
  };
  const detail = (c: any) => ({
    ...summary(c),
    servers: serversOf(c),
    auth: authOf(specOf(c)),
    endpoints: JSON.parse(c.endpoints) as Endpoint[],
    warnings: JSON.parse(c.warnings),
    last_changes: json(c.last_changes),
    text_preview: c.text ? c.text.slice(0, 4000) : null,
    text_length: c.text?.length ?? null,
    runs: (db.prepare("SELECT id, status, environment_label, cost_usd, created_at, finished_at FROM runs WHERE contract_id = ? ORDER BY id DESC LIMIT 20").all(c.id) as any[]),
    published: db.prepare("SELECT * FROM contract_publications WHERE contract_id = ? ORDER BY id DESC").all(c.id),
  });

  const store = (p: ParsedContract, src: { name?: string; kind: "file" | "url" | "postman"; ref: string | null; filename: string | null; original: Buffer }) => {
    const dup = db.prepare("SELECT id, name FROM contracts WHERE hash = ?").get(p.hash) as any;
    if (dup) throw new HttpError(409, `This contract is already here, as "${dup.name}".`);
    const t = now();
    return Number(db.prepare(`INSERT INTO contracts (name, source_kind, source_ref, filename, format, spec_version, title, api_version, servers, endpoints, warnings, original, text, hash, created_at, updated_at, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(src.name?.trim() || p.title, src.kind, src.ref, src.filename, p.format, p.spec_version, p.title, p.version, JSON.stringify(p.servers), JSON.stringify(p.endpoints),
        JSON.stringify(p.warnings), src.original, p.text, p.hash, t, t, t).lastInsertRowid);
  };
  const added = (req: any, id: number) => {
    const c = get(id);
    audit(db, { actor: "admin", ip: req.ip, action: "contract.add", summary: `Added contract "${c.name}" (${c.format === "openapi" ? `OpenAPI ${c.spec_version}, ${JSON.parse(c.endpoints).length} endpoints` : "document"}) from ${c.source_kind === "file" ? c.filename : c.source_ref}`, details: { contract_id: id } });
    return detail(c);
  };

  // Downloads a contract from a URL. Only http(s); limited in size and time.
  async function download(url: string): Promise<{ bytes: Buffer; filename: string }> {
    let u: URL;
    try { u = new URL(url); } catch { throw new HttpError(400, "That isn't a valid URL."); }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "Only http:// and https:// links can be fetched.");
    let res: Response;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json, application/yaml, text/yaml, application/pdf, */*" } });
    } catch (e: any) {
      throw new HttpError(502, `Couldn't fetch it: ${e.cause?.code ?? e.message}`);
    }
    if (!res.ok) throw new HttpError(502, `${u.host} answered ${res.status}.`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) throw new HttpError(400, "The file is larger than 10 MB.");
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "";
    const last = decodeURIComponent(u.pathname.split("/").pop() || "contract");
    const filename = /\.\w+$/.test(last) ? last : last + (/pdf/.test(type) ? ".pdf" : /html/.test(type) ? ".html" : /ya?ml/.test(type) ? ".yaml" : ".json");
    return { bytes, filename };
  }

  // A spec stored in Postman: its root file.
  async function fromPostmanSpec(workspaceId: string, specId: string) {
    const files = (await postman(db, `/specs/${encodeURIComponent(specId)}/files`)).files ?? [];
    const root = files.find((f: any) => f.type === "ROOT") ?? files[0];
    if (!root) throw new HttpError(400, "That spec has no files.");
    const file = await postman(db, `/specs/${encodeURIComponent(specId)}/files/${encodeURIComponent(root.path)}`);
    const content = file.content ?? file.file?.content;
    if (typeof content !== "string") throw new HttpError(502, "Postman didn't return the spec's content.");
    const parsed = await parseContract(root.path, Buffer.from(content));
    if (files.length > 1) parsed.warnings.push(`The spec has ${files.length} files; only its root file (${root.path}) was read.`);
    return { parsed, filename: root.path, original: Buffer.from(content), ref: `${workspaceId}/${specId}` };
  }

  app.get("/api/contracts", async () => (db.prepare("SELECT * FROM contracts ORDER BY updated_at DESC").all() as any[]).map(summary));
  app.get<{ Params: { id: string } }>("/api/contracts/:id", async (req) => detail(get(Number(req.params.id))));

  app.post("/api/contracts/upload", { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const b = z.object({ name: z.string().max(120).optional(), filename: z.string().min(1).max(200), content_base64: z.string().min(1) }).parse(req.body);
    const bytes = Buffer.from(b.content_base64, "base64");
    const p = await parseContract(b.filename, bytes);
    reply.code(201);
    return added(req, store(p, { name: b.name, kind: "file", ref: null, filename: b.filename, original: bytes }));
  });

  app.post("/api/contracts/url", async (req, reply) => {
    const b = z.object({ url: z.string().trim().min(1), name: z.string().max(120).optional() }).parse(req.body);
    const { bytes, filename } = await download(b.url);
    const p = await parseContract(filename, bytes);
    reply.code(201);
    return added(req, store(p, { name: b.name, kind: "url", ref: b.url, filename, original: bytes }));
  });

  app.post("/api/contracts/postman", async (req, reply) => {
    const b = z.object({ workspace_id: z.string().min(1), spec_id: z.string().min(1), name: z.string().max(120).optional() }).parse(req.body);
    const s = await fromPostmanSpec(b.workspace_id, b.spec_id);
    reply.code(201);
    return added(req, store(s.parsed, { name: b.name, kind: "postman", ref: s.ref, filename: s.filename, original: s.original }));
  });

  // Fetch a URL or Postman contract again and say what changed.
  app.post<{ Params: { id: string } }>("/api/contracts/:id/refresh", async (req) => {
    const c = get(Number(req.params.id));
    let p: ParsedContract, original: Buffer;
    if (c.source_kind === "url") {
      const d = await download(c.source_ref);
      p = await parseContract(d.filename, d.bytes);
      original = d.bytes;
    } else if (c.source_kind === "postman") {
      const [ws, spec] = String(c.source_ref).split("/");
      const s = await fromPostmanSpec(ws, spec);
      p = s.parsed;
      original = s.original;
    } else throw new HttpError(400, "An uploaded contract can't be refreshed: upload the new version as a new contract.");
    const t = now();
    if (p.hash === c.hash) {
      db.prepare("UPDATE contracts SET checked_at = ? WHERE id = ?").run(t, c.id);
      return { changed: false, contract: detail(get(c.id)) };
    }
    const changes = c.format === "openapi" && p.format === "openapi" ? endpointChanges(JSON.parse(c.endpoints), p.endpoints) : { added: [], removed: [], changed: [], text_changed: true };
    db.prepare(`UPDATE contracts SET format = ?, spec_version = ?, title = ?, api_version = ?, servers = ?, endpoints = ?, warnings = ?, original = ?, text = ?, hash = ?,
      last_changes = ?, updated_at = ?, checked_at = ? WHERE id = ?`)
      .run(p.format, p.spec_version, p.title, p.version, JSON.stringify(p.servers), JSON.stringify(p.format === "openapi" ? p.endpoints : JSON.parse(c.endpoints)), JSON.stringify(p.warnings),
        original, p.text, p.hash, JSON.stringify({ ...changes, from_version: c.api_version, to_version: p.version, at: t }), t, t, c.id);
    audit(db, { actor: "admin", ip: req.ip, action: "contract.refresh", summary: `Contract "${c.name}" changed: ${[changes.added.length && `${changes.added.length} endpoints added`, changes.removed.length && `${changes.removed.length} removed`, changes.changed.length && `${changes.changed.length} changed`].filter(Boolean).join(", ") || "the text changed"}`, details: { contract_id: c.id } });
    return { changed: true, changes, contract: detail(get(c.id)) };
  });

  app.patch<{ Params: { id: string } }>("/api/contracts/:id", async (req) => {
    const c = get(Number(req.params.id));
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    db.prepare("UPDATE contracts SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), c.id);
    return detail(get(c.id));
  });

  app.get<{ Params: { id: string } }>("/api/contracts/:id/source", async (req, reply) => {
    const c = get(Number(req.params.id));
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${String(c.filename ?? "contract").replace(/[^\w.-]+/g, "_")}"`);
    return Buffer.from(c.original);
  });

  app.delete<{ Params: { id: string } }>("/api/contracts/:id", async (req, reply) => {
    const c = get(Number(req.params.id));
    db.prepare("DELETE FROM contracts WHERE id = ?").run(c.id); // its runs and publications stay
    audit(db, { actor: "admin", ip: req.ip, action: "contract.delete", summary: `Deleted contract "${c.name}"`, details: { contract_id: c.id } });
    reply.code(204);
  });

  // ---- Publishing what a contract run built: only where the person says, after they confirm ----
  const Target = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(200) }),
    z.object({ kind: z.literal("folder"), collection_uid: z.string().min(1), folder_name: z.string().trim().min(1).max(200), replace: z.boolean().default(false) }),
  ]);

  app.post<{ Params: { id: string } }>("/api/runs/:id/publish", async (req) => {
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(req.params.id)) as any;
    if (!run) throw new HttpError(404, "Run not found.");
    if (run.ai_mode !== "contract") throw new HttpError(400, "Only contract runs are published from here.");
    const b = z.object({
      workspace_id: z.string().min(1), target: Target,
      // A new collection is a new project: its environments (e.g. Test, Stg, Prod) with their base URLs.
      environments: z.array(z.object({
        label: z.string().trim().min(1).max(40),
        base_url: z.string().trim().url().refine((u) => /^https?:\/\//.test(u), "Must start with http:// or https://"),
      })).max(6).default([]),
      add_to_dashboard: z.boolean().default(false),
    }).parse(req.body);
    const labels = b.environments.map((e) => e.label.toLowerCase());
    if (new Set(labels).size !== labels.length) throw new HttpError(400, "Each environment needs its own name.");
    const result = json(run.result_json);
    const built = result?.contract?.collection;
    if (!built?.item?.length) throw new HttpError(400, "This run didn't build a collection to publish.");
    // Same rule as the agents: publish only when every remaining failure is a marked known bug.
    if (!["passed", "passed_with_known_bugs"].includes(run.status))
      throw new HttpError(409, "This run has failures that aren't marked as known bugs, so it can't be published. Fix the contract or the environment and generate the tests again.");

    const ws = (await postman(db, "/workspaces")).workspaces?.find((w: any) => w.id === b.workspace_id);
    if (!ws) throw new HttpError(404, "That workspace wasn't found in your Postman account.");
    const requests = countRequests(built.item);
    let uid: string, collectionName: string, folder: string | null = null;

    if (b.target.kind === "new") {
      const name = b.target.name;
      const collection = { ...built, info: { ...built.info, name, _postman_id: undefined } };
      const existing = (await postman(db, `/collections?workspace=${encodeURIComponent(ws.id)}`)).collections ?? [];
      if (existing.some((c: any) => c.name === name)) throw new HttpError(409, `The workspace already has a collection named "${name}". Choose another name, or add the tests to it as a folder.`);
      const made = await postman(db, `/collections?workspace=${encodeURIComponent(ws.id)}`, { method: "POST", body: { collection } });
      uid = made.collection.uid;
      collectionName = made.collection.name;
    } else {
      const t = b.target;
      const current = (await postman(db, `/collections/${encodeURIComponent(t.collection_uid)}`)).collection;
      if (!current) throw new HttpError(404, "That collection wasn't found.");
      const clash = (current.item ?? []).findIndex((i: any) => i.name === t.folder_name);
      if (clash >= 0 && !t.replace) throw new HttpError(409, `"${current.info.name}" already has a folder named "${t.folder_name}". Choose another name, or replace it.`);
      const newFolder = { name: t.folder_name, description: built.info?.description ?? `Contract tests generated from "${result.contract?.name ?? "a contract"}".`, item: built.item, event: built.event };
      const item = [...(current.item ?? [])];
      if (clash >= 0) item[clash] = newFolder; else item.push(newFolder);
      // Variables the new tests need that the collection doesn't define yet.
      const have = new Set((current.variable ?? []).map((v: any) => v.key));
      const variable = [...(current.variable ?? []), ...(built.variable ?? []).filter((v: any) => !have.has(v.key))];
      await postman(db, `/collections/${encodeURIComponent(t.collection_uid)}`, { method: "PUT", body: { collection: { ...current, item, variable } } });
      uid = t.collection_uid;
      collectionName = current.info.name;
      folder = t.folder_name;
    }

    // The project's environments: in the Postman workspace, and in the dashboard if asked. Each has the base URL
    // and the credential variables the tests read (empty: secrets are entered by people, in Postman or here).
    const contract = run.contract_id ? db.prepare("SELECT * FROM contracts WHERE id = ?").get(run.contract_id) as any : null;
    const authVars = (contract ? authOf(specOf(contract))?.variables : null) ?? [];
    const madeEnvs: { label: string; postman_uid: string | null; dashboard_id: number | null }[] = [];
    for (const e of b.environments) {
      const values = [{ key: "baseUrl", value: e.base_url.replace(/\/+$/, ""), type: "default", enabled: true },
        ...authVars.map((v) => ({ key: v.key, value: "", type: v.secret ? "secret" : "default", enabled: true }))];
      const made = await postman(db, `/environments?workspace=${encodeURIComponent(ws.id)}`, { method: "POST", body: { environment: { name: `${collectionName} - ${e.label}`, values } } });
      let dashboardId: number | null = null;
      if (b.add_to_dashboard) {
        const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        let name = `${slug(collectionName).slice(0, 20)}-${slug(e.label)}`.replace(/^-+/, "").slice(0, 32) || "env";
        if (!/^[a-z0-9]/.test(name)) name = `e${name}`;
        for (let i = 2; db.prepare("SELECT 1 FROM environments WHERE name = ?").get(name); i++) name = `${name.replace(/-\d+$/, "").slice(0, 29)}-${i}`;
        const t = now();
        dashboardId = Number(db.prepare("INSERT INTO environments (name, label, base_url, health_path, created_at, updated_at) VALUES (?, ?, ?, '/', ?, ?)")
          .run(name, `${collectionName.slice(0, 40)} ${e.label}`.slice(0, 50), e.base_url.replace(/\/+$/, ""), t, t).lastInsertRowid);
        const ins = db.prepare("INSERT INTO variables (environment_id, key, value, secret) VALUES (?, ?, ?, ?)");
        for (const v of authVars) ins.run(dashboardId, v.key, v.secret ? encrypt("") : "", v.secret ? 1 : 0);
      }
      madeEnvs.push({ label: e.label, postman_uid: made.environment?.uid ?? made.environment?.id ?? null, dashboard_id: dashboardId });
    }

    // Bring it into the dashboard too, so it can be run, scheduled and reported on.
    let collectionId: number | null = null;
    try {
      collectionId = await importFromPostman(db, uid);
      db.prepare("UPDATE runs SET collection_id = ? WHERE id = ?").run(collectionId, run.id);
    } catch { /* published to Postman; importing here can be done from the Collections page */ }
    db.prepare(`INSERT INTO contract_publications (contract_id, run_id, workspace_id, workspace_name, collection_uid, collection_name, folder_name, requests, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.contract_id, run.id, ws.id, ws.name, uid, collectionName, folder, requests, now());
    audit(db, { actor: "admin", ip: req.ip, action: "contract.publish",
      summary: `Published ${requests} contract tests from run #${run.id} to workspace "${ws.name}": ${folder ? `folder "${folder}" in collection "${collectionName}"${b.target.kind === "folder" && b.target.replace ? " (replaced)" : ""}` : `new collection "${collectionName}"`}${madeEnvs.length ? `, with environments ${madeEnvs.map((e) => e.label).join(", ")}${b.add_to_dashboard ? " (also in the dashboard)" : ""}` : ""}`,
      details: { run_id: run.id, contract_id: run.contract_id, collection_uid: uid } });
    return { workspace: { id: ws.id, name: ws.name }, collection: { uid, name: collectionName, id: collectionId }, folder, requests, environments: madeEnvs, credential_variables: authVars };
  });

  // Before a run: is the environment the API this contract describes, and are its credentials there?
  // Calls one real endpoint, so a wrong base URL shows now instead of as 22 failed requests.
  app.get<{ Params: { id: string }; Querystring: { environment_id?: string; endpoints?: string } }>("/api/contracts/:id/check", async (req) => {
    const c = get(Number(req.params.id));
    if (!db.prepare("SELECT 1 FROM environments WHERE id = ?").get(Number(req.query.environment_id))) throw new HttpError(404, "Environment not found.");
    const env = loadEnvironment(db, Number(req.query.environment_id));
    const servers = serversOf(c);
    const base = env.baseUrl.replace(/\/+$/, "");
    const concrete = servers.filter((s) => /^https?:\/\//i.test(s) && !s.includes("{"));
    const auth = authOf(specOf(c));
    const credentials = (auth?.variables ?? []).map((v) => ({ ...v, present: !!env.variables[v.key]?.trim() }));

    let probe: any = null;
    const spec = specOf(c);
    if (spec) {
      const chosen = new Set(String(req.query.endpoints ?? "").split(",").filter(Boolean));
      const eps: Endpoint[] = JSON.parse(c.endpoints);
      const gets = eps.filter((e) => e.method === "GET" && !e.path.includes("{"));
      const pick = gets.find((e) => chosen.has(e.key) && !e.secured) ?? gets.find((e) => chosen.has(e.key)) ?? gets.find((e) => !e.secured) ?? gets[0];
      if (pick) {
        // Fill required query parameters with a value the contract allows (first enum value, default or example).
        const op = spec.paths?.[pick.path]?.get ?? {};
        const params = [...(spec.paths?.[pick.path]?.parameters ?? []), ...(op.parameters ?? [])].filter((p: any) => p?.in === "query" && p.required);
        const q = new URLSearchParams();
        for (const p of params) {
          const s = p.schema ?? p;
          const v = s.enum?.[0] ?? s.default ?? p.example ?? s.example ?? (s.type === "integer" || s.type === "number" ? 1 : "x");
          q.set(p.name, Array.isArray(v) ? String(v[0]) : String(v));
        }
        const url = `${base}${pick.path}${q.size ? `?${q}` : ""}`;
        const headers: Record<string, string> = { accept: "application/json" };
        const key = (auth?.schemes ?? []).find((s) => s.type === "apiKey" && s.detail.startsWith("header"));
        if (key && env.variables.apiKey) headers[key.detail.match(/"(.+)"/)![1]] = env.variables.apiKey;
        if (env.variables.accessToken) headers.authorization = `Bearer ${env.variables.accessToken}`;
        try {
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: "manual" });
          const s = res.status;
          const verdict = s === 404 || s === 405 ? "not_found" : s >= 500 ? "server_error" : s === 401 || s === 403 ? "needs_auth" : "ok";
          probe = { endpoint: pick.key, url, status: s, verdict };
        } catch (e: any) {
          probe = { endpoint: pick.key, url, error: networkReason(e), verdict: "unreachable" };
        }
      }
    }
    return {
      base_url: env.baseUrl, servers,
      base_url_matches: concrete.length ? concrete.some((s) => norm(s) === norm(base)) : null,
      suggested_base_url: concrete[0] ?? null,
      credentials, login: auth?.login ?? null, probe,
    };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/publications", async (req) =>
    db.prepare("SELECT * FROM contract_publications WHERE run_id = ? ORDER BY id DESC").all(Number(req.params.id)));
}
