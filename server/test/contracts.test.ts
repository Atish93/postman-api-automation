// API contracts: adding them (file, URL, Postman spec; OpenAPI, Swagger, PDF, Word), refreshing and
// spotting changes, starting a contract run, and publishing only where the person chooses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { fakeApi, fakePostman, testApp, waitForRun, POSTMAN_KEY } from "./helpers.ts";
import { saveFoundEndpoints } from "../src/runs/ai.ts";

let api: any, pm: any, app: any, db: any, specServer: any, specUrl = "";
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
const upload = (filename: string, content: Buffer | string, name?: string) =>
  call("POST", "/api/contracts/upload", { filename, name, content_base64: Buffer.from(content).toString("base64") });

const PETS_YAML = `openapi: 3.0.3
info:
  title: Pet Store
  version: 1.0.0
servers:
  - url: https://pets.example.com/v1
security:
  - key: []
components:
  securitySchemes:
    key: { type: apiKey, in: header, name: X-Api-Key }
  parameters:
    PetId: { name: id, in: path, required: true, schema: { type: integer } }
paths:
  /pets:
    get:
      summary: List pets
      parameters:
        - { name: limit, in: query, schema: { type: integer, maximum: 100 } }
      responses: { '200': { description: ok } }
    post:
      summary: Create a pet
      requestBody: { content: { application/json: { schema: { type: object } } } }
      responses: { '201': { description: created }, '400': { description: invalid } }
  /pets/{id}:
    get:
      summary: Get a pet
      security: []
      parameters: [ { $ref: '#/components/parameters/PetId' } ]
      responses: { '200': { description: ok }, '404': { description: not found } }
`;

// The spec the URL serves; tests change it to check refresh.
let served = { openapi: "3.0.0", info: { title: "Orders", version: "1" }, paths: {
  "/orders": { get: { responses: { "200": { description: "ok" } } }, post: { responses: { "201": { description: "made" } } } },
  "/orders/{id}": { delete: { responses: { "204": { description: "gone" } } } },
} } as any;

// A real (tiny) PDF with selectable text.
function pdf(lines: string[]) {
  const esc = (s: string) => s.replace(/[\\\\()]/g, (c) => "\\\\" + c);
  const stream = `BT /F1 11 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A real (tiny) Word file.
async function docx(paragraphs: string[]) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

before(async () => {
  api = await fakeApi();
  pm = await fakePostman();
  specServer = createServer((req, res) => req.url === "/openapi.json" ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(served)) : res.writeHead(404).end());
  await new Promise<void>((r) => specServer.listen(0, "127.0.0.1", r));
  specUrl = `http://127.0.0.1:${specServer.address().port}/openapi.json`;
  ({ app, db } = await testApp(pm.url));
  await call("PUT", "/api/settings/postman", { api_key: POSTMAN_KEY });
});
after(async () => { await app.close(); api.close(); pm.close(); specServer.close(); });

// ---- Adding contracts ----

let petsId: number;
test("OpenAPI (YAML): endpoints with summaries, responses, auth and shared parameters", async () => {
  const r = await upload("pets.yaml", PETS_YAML);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  petsId = r.body.id;
  assert.deepEqual([r.body.format, r.body.spec_version, r.body.title, r.body.api_version, r.body.name], ["openapi", "3.0.3", "Pet Store", "1.0.0", "Pet Store"]);
  assert.deepEqual(r.body.servers, ["https://pets.example.com/v1"]);
  assert.deepEqual(r.body.endpoints.map((e: any) => e.key), ["GET /pets", "POST /pets", "GET /pets/{id}"]);
  const get = r.body.endpoints.find((e: any) => e.key === "GET /pets/{id}");
  assert.deepEqual([get.summary, get.responses, get.secured, get.parameters], ["Get a pet", ["200", "404"], false, 1], "security: [] opts out; $ref parameter counted");
  assert.equal(r.body.endpoints.find((e: any) => e.key === "POST /pets").has_body, true);
  assert.equal(r.body.endpoints[0].secured, true, "global security applies");
  assert.equal((await upload("again.yaml", PETS_YAML)).status, 409, "the same file twice");
});

test("Swagger 2.0 (JSON): servers from host, bodies from body parameters", async () => {
  const swagger = { swagger: "2.0", info: { title: "Legacy", version: "2" }, host: "legacy.example.com", basePath: "/api", schemes: ["https"],
    paths: { "/users": { post: { parameters: [{ in: "body", name: "u", schema: { type: "object" } }], responses: { "201": { description: "ok" } } } } } };
  const r = await upload("legacy.json", JSON.stringify(swagger), "Legacy users");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.spec_version, r.body.servers[0], r.body.endpoints[0].has_body], ["Legacy users", "2.0", "https://legacy.example.com/api", true]);
});

test("a PDF and a Word document are read as text; old .doc files and non-specs are refused with a reason", async () => {
  const p = await upload("orders-api.pdf", pdf(["Orders API guide", "POST /orders creates an order.", "quantity must be 1 to 10; otherwise 422."]));
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.format, "document");
  assert.match(p.body.text_preview, /POST \/orders creates an order/);
  assert.deepEqual(p.body.warnings, []);
  assert.equal(p.body.endpoint_count, 0, "for documents the agent finds the endpoints");

  const w = await upload("Payments.docx", await docx(["Payments API", "GET /payments/{id} returns a payment.", "Use the X-Api-Key header."]));
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.match(w.body.text_preview, /GET \/payments\/\{id\} returns a payment/);

  assert.match((await upload("old.doc", "binary")).body.error, /\.docx or PDF/);
  assert.match((await upload("thing.json", '{"hello": "world"}')).body.error, /isn't an OpenAPI or Swagger file/);
  const md = await upload("notes.md", "# Notes\nNothing about endpoints here.");
  assert.match(md.body.warnings[0], /No endpoints like "GET \/path" were spotted/);
});

test("from a URL, and refreshing it says what changed", async () => {
  const r = await call("POST", "/api/contracts/url", { url: specUrl });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal(r.body.endpoint_count, 3);
  assert.equal((await call("POST", `/api/contracts/${id}/refresh`)).body.changed, false);
  served = { ...served, info: { ...served.info, version: "2" }, paths: {
    "/orders": { get: { responses: { "200": { description: "ok" }, "429": { description: "slow down" } } }, post: { responses: { "201": { description: "made" } } } },
    "/orders/{id}/cancel": { post: { responses: { "200": { description: "cancelled" } } } },
  } };
  const changed = await call("POST", `/api/contracts/${id}/refresh`);
  assert.equal(changed.body.changed, true);
  assert.deepEqual(changed.body.changes, { added: ["POST /orders/{id}/cancel"], removed: ["DELETE /orders/{id}"], changed: [{ key: "GET /orders", what: ["new responses 429"] }] });
  assert.equal(changed.body.contract.last_changes.to_version, "2");
  assert.equal((await call("POST", "/api/contracts/url", { url: "ftp://x/spec" })).status, 400);
  assert.equal((await call("POST", `/api/contracts/${petsId}/refresh`)).status, 400, "an upload can't be refreshed");
});

test("from a spec in Postman (Spec Hub)", async () => {
  const specs = await call("GET", "/api/postman/workspaces/ws1/specs");
  assert.deepEqual(specs.body, [{ id: "spec1", name: "Spec Hub API", type: "OPENAPI:3.0", updated_at: null }]);
  const r = await call("POST", "/api/contracts/postman", { workspace_id: "ws1", spec_id: "spec1" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.title, r.body.source_kind, r.body.source_ref, r.body.endpoints[0].key], ["Spec Hub API", "postman", "ws1/spec1", "GET /ping"]);
  pm.spec.content = pm.spec.content.replace("/ping:", "/health:");
  const refreshed = await call("POST", `/api/contracts/${r.body.id}/refresh`);
  assert.deepEqual([refreshed.body.changes.added, refreshed.body.changes.removed], [["GET /health"], ["GET /ping"]]);
});

test("list, rename, download the original, and every addition is in the audit log", async () => {
  const list = (await call("GET", "/api/contracts")).body;
  assert.ok(list.length >= 6);
  assert.equal((await call("PATCH", `/api/contracts/${petsId}`, { name: "Pets v1" })).body.name, "Pets v1");
  const dl = await app.inject({ method: "GET", url: `/api/contracts/${petsId}/source` });
  assert.equal(dl.body, PETS_YAML);
  const log = db.prepare("SELECT summary FROM audit_log WHERE action LIKE 'contract.%'").all().map((r: any) => r.summary);
  assert.ok(log.includes("Added contract \"Pet Store\" (OpenAPI 3.0.3, 3 endpoints) from pets.yaml"), log.join("\n"));
});

// ---- Contract runs ----

let envId: number;
test("a contract run hands the agents the contract (spec, chosen endpoints, focus); a down server stops it before any model call", async () => {
  envId = (await call("POST", "/api/environments", { name: "pets", label: "Pets", base_url: api.url, health_path: "/health" })).body.id;
  assert.match((await call("POST", "/api/runs", { kind: "ai", ai_mode: "contract", environment_id: envId })).body.error, /Choose the contract/);
  assert.match((await call("POST", "/api/runs", { kind: "ai", ai_mode: "contract", contract_id: petsId, environment_id: envId, endpoints: ["GET /nope"] })).body.error, /Not in the contract: GET \/nope/);
  api.state.mode = "down";
  const r = await call("POST", "/api/runs", { kind: "ai", ai_mode: "contract", contract_id: petsId, environment_id: envId, endpoints: ["GET /pets/{id}"], request: "Focus on errors" });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(r.body.contract, { id: petsId, endpoints: ["GET /pets/{id}"] });
  assert.equal(r.body.collection.name, "Contract: Pets v1");
  const run = await waitForRun(app, r.body.id);
  api.state.mode = "ok";
  assert.equal(run.status, "server_issue", run.message);
  const file = join(process.env.QA_RUNS_DIR!, String(run.id), "contract.json");
  assert.ok(existsSync(file));
  const c = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual([c.name, c.format, c.selected, c.focus, c.spec.info.title], ["Pets v1", "openapi", ["GET /pets/{id}"], "Focus on errors", "Pet Store"]);
  const events = (await call("GET", `/api/runs/${run.id}/events/history`)).body;
  assert.equal(events.find((e: any) => e.type === "run_started")?.data.mode, "contract");
});

test("for a document, the endpoints the agent found are kept on the contract", async () => {
  const docId = (await call("GET", "/api/contracts")).body.find((c: any) => c.filename === "orders-api.pdf").id;
  saveFoundEndpoints(db, docId, { plan: { endpoints_found: [{ method: "post", path: "/orders", summary: "Create an order", responses: [201, 422] }] } });
  const c = (await call("GET", `/api/contracts/${docId}`)).body;
  assert.deepEqual(c.endpoints.map((e: any) => [e.key, e.summary, e.responses]), [["POST /orders", "Create an order", ["201", "422"]]]);
});

// ---- Publishing: only where the person chooses ----

const built = {
  info: { name: "Pet Store Contract Tests (agent-built)", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  variable: [{ key: "petId", value: "" }],
  item: [{ name: "TC01 Get a pet", request: { method: "GET", url: "{{baseUrl}}/pets/1" } }, { name: "TC02 Unknown pet", request: { method: "GET", url: "{{baseUrl}}/pets/999" } }],
};
const finishedRun = (status: string) => Number(db.prepare(`INSERT INTO runs (collection_name, environment_label, environment_id, kind, ai_mode, contract_id, status, result_json, created_at, finished_at)
  VALUES ('Contract: Pets v1', 'Pets', ?, 'ai', 'contract', ?, ?, ?, '', '')`).run(envId, petsId, status, JSON.stringify({ contract: { name: "Pets v1", collection: built, plan: { cases: [] } } })).lastInsertRowid);

test("publish as a new collection in the chosen workspace; it's also added to the dashboard", async () => {
  const id = finishedRun("passed_with_known_bugs");
  const r = await call("POST", `/api/runs/${id}/publish`, { workspace_id: "ws1", target: { kind: "new", name: "Pets contract tests" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.workspace.name, r.body.collection.name, r.body.folder, r.body.requests], ["Practice", "Pets contract tests", null, 2]);
  assert.equal(pm.store.get(r.body.collection.uid).item.length, 2);
  assert.ok(r.body.collection.id, "imported into the dashboard");
  assert.equal((await call("GET", `/api/runs/${id}`)).body.collection.id, r.body.collection.id);
  assert.equal((await call("POST", `/api/runs/${id}/publish`, { workspace_id: "ws1", target: { kind: "new", name: "Pets contract tests" } })).status, 409, "the name is taken now");
  const c = (await call("GET", `/api/contracts/${petsId}`)).body;
  assert.equal(c.published[0].collection_name, "Pets contract tests");
  assert.ok(db.prepare("SELECT summary FROM audit_log WHERE action = 'contract.publish'").all().some((r: any) => /to workspace "Practice": new collection "Pets contract tests"/.test(r.summary)));
});

test("publish as a folder of an existing collection: variables merged; a taken folder name needs 'replace'", async () => {
  const id = finishedRun("passed");
  const folders = async () => (await call("GET", "/api/postman/collections/1-abc/folders")).body;
  const before = await folders();
  const target = { kind: "folder", collection_uid: "1-abc", folder_name: "Pets contract" };
  const r = await call("POST", `/api/runs/${id}/publish`, { workspace_id: "ws1", target });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.folder, "Pets contract");
  const after = await folders();
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.find((f: any) => f.name === "Pets contract"), { name: "Pets contract", requests: 2 });
  assert.ok(pm.store.get("1-abc").variable.some((v: any) => v.key === "petId") && pm.store.get("1-abc").variable.some((v: any) => v.key === "baseUrl"), "variables merged, existing kept");
  const again = await call("POST", `/api/runs/${id}/publish`, { workspace_id: "ws1", target });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already has a folder named "Pets contract"/);
  assert.equal((await call("POST", `/api/runs/${id}/publish`, { workspace_id: "ws1", target: { ...target, replace: true } })).status, 200);
  assert.equal((await folders()).filter((f: any) => f.name === "Pets contract").length, 1, "replaced, not duplicated");
});

test("refused: unexplained failures, another kind of run, an unknown workspace", async () => {
  const failing = finishedRun("failed");
  const r = await call("POST", `/api/runs/${failing}/publish`, { workspace_id: "ws1", target: { kind: "new", name: "X" } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /aren't marked as known bugs/);
  const ok = finishedRun("passed");
  assert.equal((await call("POST", `/api/runs/${ok}/publish`, { workspace_id: "nope", target: { kind: "new", name: "X" } })).status, 404);
  const plain = Number(db.prepare("INSERT INTO runs (collection_name, environment_label, kind, status, created_at) VALUES ('c', 'e', 'plain', 'passed', '')").run().lastInsertRowid);
  assert.equal((await call("POST", `/api/runs/${plain}/publish`, { workspace_id: "ws1", target: { kind: "new", name: "X" } })).status, 400);
});
