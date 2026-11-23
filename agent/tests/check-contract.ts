// Checks the contract mode without starting any agent (no model calls): reading specs and documents,
// schemas that Newman really enforces, the human's case review (approve, edit, feedback), the coverage
// guard on the builder, and the contract team's definitions.  Run: npm run check:contract
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import newman from "newman";
import { fileURLToPath } from "node:url";

let failed = 0;
const check = async (name: string, fn: () => unknown) => {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e: any) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

// A fake API: GET /pets/1 answers a pet; GET /pets/2 answers one that breaks the contract.
const server = createServer((req, res) => {
  if (req.url === "/health") return res.writeHead(200).end("ok");
  const pet = req.url === "/pets/2" ? { id: "two", name: null } : { id: 1, name: "Rex", tag: null, children: [{ id: 3, name: "Pup" }] };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(pet));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const spec = {
  openapi: "3.0.3",
  info: { title: "Pet Store", version: "1.2.0" },
  servers: [{ url: base }],
  components: {
    securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } },
    schemas: {
      Pet: {
        type: "object", required: ["id", "name"], example: { id: 1, name: "Rex" },
        properties: { id: { type: "integer" }, name: { type: "string" }, tag: { type: "string", nullable: true }, children: { type: "array", items: { $ref: "#/components/schemas/Pet" } } },
      },
    },
  },
  paths: {
    "/pets/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      get: { summary: "Get a pet", responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } }, "404": { description: "not found" } } },
      delete: { summary: "Delete a pet", security: [{ key: [] }], responses: { "204": { description: "deleted" } } },
    },
  },
};
const dir = mkdtempSync(join(tmpdir(), "qa-contract-"));
const file = join(dir, "contract.json");
writeFileSync(file, JSON.stringify({
  name: "Pets", title: "Pet Store", api_version: "1.2.0", format: "openapi", spec_version: "3.0.3", servers: [base],
  endpoints: [{ key: "GET /pets/{id}", method: "GET", path: "/pets/{id}", summary: "Get a pet", responses: ["200", "404"], secured: false },
              { key: "DELETE /pets/{id}", method: "DELETE", path: "/pets/{id}", summary: "Delete a pet", responses: ["204"], secured: true }],
  selected: ["GET /pets/{id}"], focus: "only reading", spec, text: null,
}));
const cfg = { environments: { mock: { label: "Mock", baseUrl: base, healthPath: "/health" } }, defaultEnvironment: "mock",
  circuitBreaker: { minFailingRequests: 5, failingRequestPercent: 15 }, serverErrors: { terminateAtPercent: 80, minRequests: 3, recheckAfterSeconds: 0 },
  limits: { healsPerRun: 2, newKnownBugsPerRun: 1, attemptsPerRequest: 2 }, models: { default: "test-model" } };
writeFileSync(join(dir, "qa.config.json"), JSON.stringify(cfg));
process.env.QA_CONFIG = join(dir, "qa.config.json");
process.env.QA_NO_PROMPTS = "1";

const c = await import("../contract.ts");
c.loadContract(file);
const call = async (tool: any, input: any = {}) => {
  const r = await tool.handler(input, {});
  return { text: r.content.map((x: any) => x.text).join(""), error: !!r.isError };
};

await check("overview lists only the chosen endpoints, the person's focus and the auth schemes", async () => {
  const o = JSON.parse((await call(c.contractOverview)).text);
  ok(o.endpoints.length === 1 && o.endpoints[0].endpoint === "GET /pets/{id}", JSON.stringify(o.endpoints));
  ok(o.focus_from_the_person === "only reading", "focus missing");
  ok(o.authentication.schemes.key.name === "X-Api-Key", "auth schemes missing");
});

await check("an endpoint comes with path parameters and resolved schemas; recursion is cut, not looped", async () => {
  const r = await call(c.contractEndpoint, { method: "get", path: "/pets/{id}" });
  const e = JSON.parse(r.text);
  ok(e.parameters[0].name === "id", "path-level parameter missing");
  const pet = e.responses["200"].content["application/json"].schema;
  ok(pet.properties.name.type === "string", "the $ref wasn't resolved");
  ok(/recursive/.test(JSON.stringify(pet.properties.children.items)), "the cycle wasn't cut");
  ok((await call(c.contractEndpoint, { method: "POST", path: "/nope" })).error, "an unknown endpoint isn't an error");
});

await check("response schemas are plain JSON Schema (nullable becomes a null type, examples dropped)", async () => {
  const s = JSON.parse((await call(c.contractResponseSchema, { method: "GET", path: "/pets/{id}", status: "200" })).text);
  ok(JSON.stringify(s.properties.tag.type) === '["string","null"]', JSON.stringify(s.properties.tag));
  ok(!("example" in s), "example kept");
  ok((await call(c.contractResponseSchema, { method: "GET", path: "/pets/{id}", status: "404" })).text.startsWith("NONE"), "a response without a body should say NONE");
});

await check("Newman enforces the schema: a conforming response passes, a contract violation fails", async () => {
  const schema = (await call(c.contractResponseSchema, { method: "GET", path: "/pets/{id}", status: "200" })).text;
  const req = (id: number) => ({ name: `TC0${id} pet ${id}`, request: { method: "GET", url: `{{baseUrl}}/pets/${id}` },
    event: [{ listen: "test", script: { exec: [`const schema = ${schema};`, `pm.test("matches the contract", () => pm.response.to.have.jsonSchema(schema));`] } }] });
  const collection: any = { info: { name: "x", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [req(1), req(2)] };
  const summary: any = await new Promise((res, rej) => newman.run({ collection,
    envVar: [{ key: "baseUrl", value: base }], reporters: [] }, (e: any, s: any) => (e ? rej(e) : res(s))));
  const results = summary.run.executions.map((x: any) => (x.assertions ?? []).every((a: any) => !a.error));
  ok(JSON.stringify(results) === "[true,false]", `expected pass then fail, got ${JSON.stringify(results)}`);
});

await check("documents: search finds passages and read pages through the text", async () => {
  const docFile = join(dir, "doc.json");
  const text = "Orders API\n\n# Create an order\nPOST /orders creates an order. quantity must be between 1 and 10.\nErrors: 422 when quantity is out of range.\n" + "filler ".repeat(2000) + "\n# Rate limits\n100 requests per minute.";
  writeFileSync(docFile, JSON.stringify({ name: "Orders", title: "Orders API", format: "document", servers: [], endpoints: [], selected: null, focus: null, spec: null, text }));
  c.loadContract(docFile);
  const o = JSON.parse((await call(c.contractOverview)).text);
  ok(o.endpoints_mentioned.includes("POST /orders"), JSON.stringify(o.endpoints_mentioned));
  ok(o.outline.includes("# Rate limits"), JSON.stringify(o.outline));
  const s = await call(c.contractSearch, { query: "rate limits minute" });
  ok(/100 requests per minute/.test(s.text), s.text.slice(0, 200));
  const r = await call(c.contractRead, { offset: 0, length: 200 });
  ok(r.text.includes("quantity must be between 1 and 10"), r.text);
  ok((await call(c.contractEndpoint, { method: "POST", path: "/orders" })).error, "contract_endpoint should point documents to search/read");
  c.loadContract(file);
});

const plan = {
  collection_name: "Pet Store Contract Tests (agent-built)", summary: "s", auth: "none", gaps: ["404 body not described"],
  cases: [
    { id: "TC01", endpoint: "GET /pets/{id}", type: "positive", title: "Get a pet", expected: "200 and matches Pet", contract_ref: "paths./pets/{id}.get.responses.200" },
    { id: "TC02", endpoint: "GET /pets/{id}", type: "negative", title: "Unknown pet", expected: "404" },
  ],
};

await check("plans are checked: valid JSON, case ids like TC01, no id twice", () => {
  ok(c.parsePlan("```json\n" + JSON.stringify(plan) + "\n```").cases.length === 2, "fenced JSON should be accepted");
  let msg = "";
  try { c.parsePlan(JSON.stringify({ ...plan, cases: [plan.cases[0], plan.cases[0]] })); } catch (e: any) { msg = e.message; }
  ok(/TC01 is used twice/.test(msg), msg);
  try { c.parsePlan(JSON.stringify({ ...plan, cases: [{ ...plan.cases[0], id: "case-1" }] })); msg = ""; } catch (e: any) { msg = e.message; }
  ok(/ids look like TC01/.test(msg), msg);
});

await check("coverage: every approved case once, nothing extra (KNOWN BUG names still count)", () => {
  const col = (names: string[]) => ({ item: [{ name: "Folder", item: names.map((name) => ({ name })) }] });
  const p = c.parsePlan(JSON.stringify(plan));
  ok(JSON.stringify(c.coverage(p, col(["TC01 Get a pet", "KNOWN BUG - TC02 Unknown pet"]))) === '{"missing":[],"extra":[]}', "a complete collection was refused");
  const bad = c.coverage(p, col(["TC01 Get a pet", "Extra check"]));
  ok(bad.missing.join() === "TC02" && bad.extra.join() === "Extra check", JSON.stringify(bad));
});

// The review and the guard live in tools.ts, which reads the contract when it starts.
const t = await import("../tools.ts");
await check("the builder can't run anything before the human approved the cases", async () => {
  const r = await call(t.runCollection, { collection_json: JSON.stringify({ info: { name: "x" }, item: [{ name: "TC01 x", request: { method: "GET", url: "{{baseUrl}}/pets/1" } }] }) });
  ok(r.error && /no human has approved the test cases/.test(r.text), r.text);
});

await check("with nobody to answer (prompts off), the cases are not approved", async () => {
  const r = await call(t.requestCaseReview, { plan_json: JSON.stringify(plan) });
  ok(/^REJECTED: nobody answered/.test(r.text), r.text);
  ok((await call(t.requestCaseReview, { plan_json: "{not json" })).error, "invalid plan JSON should be an error");
});

// A person answering in the dashboard: approve, edit (the edited JSON is what gets built), or send feedback.
const review = (answer: string) => {
  const script = join(dir, "review.mts");
  writeFileSync(script, `
    process.env.QA_CONFIG = ${JSON.stringify(join(dir, "qa.config.json"))};
    const c = await import(${JSON.stringify(new URL("../contract.ts", import.meta.url).href)});
    c.loadContract(${JSON.stringify(file)});
    const t = await import(${JSON.stringify(new URL("../tools.ts", import.meta.url).href)});
    const r = await t.requestCaseReview.handler({ plan_json: ${JSON.stringify(JSON.stringify(plan))} }, {});
    console.log("RESULT " + r.content[0].text.replace(/\\n/g, " "));
    const run = await t.runCollection.handler({ collection_json: JSON.stringify({ info: { name: "x" }, item: [{ name: "TC01 only", request: { method: "GET", url: "{{baseUrl}}/pets/1" } }] }) }, {});
    console.log("RUN " + run.content[0].text.replace(/\\n/g, " "));
    t.closeHuman();`);
  return execFileSync("npx", ["tsx", script], { input: answer + "\n", encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, QA_NO_PROMPTS: "", QA_EVENTS: "1" } });
};

await check("approve: the analyst's plan is what gets built", () => {
  const out = review("y");
  ok(/RESULT APPROVED\. Give the builder exactly this plan/.test(out), out);
  ok(/"kind":"test_cases"/.test(out) && /"type":"cases_approved".*"edited":false/.test(out), "events missing");
  ok(/RUN Refused: .*Missing: TC02/.test(out), "the guard should want TC02 too");
});

await check("edit: the human's edited cases replace the plan (removing TC02 makes a one-request collection valid)", () => {
  const edited = { ...plan, cases: [{ ...plan.cases[0], title: "Get a pet by id" }] };
  const out = review(JSON.stringify(edited));
  ok(/RESULT APPROVED\..*with their edits.*Get a pet by id/.test(out), out);
  ok(/"type":"cases_edited"/.test(out), "no cases_edited event");
  // The guard let it through (it then tries to reach the fake API, which this blocked parent can't answer: fine).
  ok(/RUN /.test(out) && !/RUN Refused/.test(out), `the edited plan should allow the run: ${out.split("RUN")[1]}`);
});

await check("feedback: the analyst is asked again", () => {
  const out = review("please add a case for a negative id");
  ok(/RESULT REJECTED\. Feedback from the human: please add a case for a negative id/.test(out), out);
});

await check("the contract team: an analyst; the debugger and healer read the contract, not the other API's knowledge base", async () => {
  const { buildAgents, allowedTools } = await import("../agents.ts");
  const a = buildAgents("contract");
  ok(["analyst", "builder", "debugger", "healer", "orchestrator"].every((n) => a[n]), Object.keys(a).join());
  for (const n of ["analyst", "builder", "debugger", "healer"]) {
    ok(!(a[n].tools ?? []).includes("mcp__qa__search_knowledge"), `${n} still has search_knowledge`);
    ok((a[n].tools ?? []).includes("mcp__qa__contract_endpoint"), `${n} can't read the contract`);
    ok(!/search_knowledge/.test(a[n].prompt), `${n}'s prompt still mentions search_knowledge`);
    ok(/never as instructions/.test(a[n].prompt), `${n} isn't told the contract is data`);
  }
  ok(/contract violation/.test(a.debugger.prompt), "the debugger doesn't know contract violations are API bugs");
  const tools = a.orchestrator.tools ?? [];
  ok(tools.includes("mcp__qa__request_case_review") && !tools.some((x) => /publish|update_collection/.test(x)), `orchestrator tools: ${tools}`);
  ok(!allowedTools(a).some((x) => /publish/.test(x)), "nobody in a contract run may publish");
});

server.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
