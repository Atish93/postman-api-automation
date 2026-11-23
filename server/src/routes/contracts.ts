// API contracts: add (file, URL or Postman spec), list, view, refresh, delete; and publishing what a
// contract run built to the Postman workspace and collection the person chooses.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { postman } from "../postman.ts";
import { endpointChanges, MAX_FILE_BYTES, parseContract, type Endpoint, type ParsedContract } from "../contracts.ts";
import { importFromPostman } from "../collections.ts";
import { countRequests } from "./postman.ts";
import { audit } from "../audit.ts";

const json = (s: string | null) => (s ? JSON.parse(s) : null);

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
    servers: JSON.parse(c.servers),
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
    const b = z.object({ workspace_id: z.string().min(1), target: Target }).parse(req.body);
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

    // Bring it into the dashboard too, so it can be run, scheduled and reported on.
    let collectionId: number | null = null;
    try {
      collectionId = await importFromPostman(db, uid);
      db.prepare("UPDATE runs SET collection_id = ? WHERE id = ?").run(collectionId, run.id);
    } catch { /* published to Postman; importing here can be done from the Collections page */ }
    db.prepare(`INSERT INTO contract_publications (contract_id, run_id, workspace_id, workspace_name, collection_uid, collection_name, folder_name, requests, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.contract_id, run.id, ws.id, ws.name, uid, collectionName, folder, requests, now());
    audit(db, { actor: "admin", ip: req.ip, action: "contract.publish",
      summary: `Published ${requests} contract tests from run #${run.id} to workspace "${ws.name}": ${folder ? `folder "${folder}" in collection "${collectionName}"${b.target.kind === "folder" && b.target.replace ? " (replaced)" : ""}` : `new collection "${collectionName}"`}`,
      details: { run_id: run.id, contract_id: run.contract_id, collection_uid: uid } });
    return { workspace: { id: ws.id, name: ws.name }, collection: { uid, name: collectionName, id: collectionId }, folder, requests };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/publications", async (req) =>
    db.prepare("SELECT * FROM contract_publications WHERE run_id = ? ORDER BY id DESC").all(Number(req.params.id)));
}
