// Test helpers: a fake API to run collections against, a fake Postman, and an app with an in-memory database.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const POSTMAN_KEY = "PMAK-test-key-1234";

async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

// The fake API. Its health check is /health.
// mode: "ok" | "down" (health 503) | "outage" (every request 500, health fine) | "one500" (only /items answers 500)
export async function fakeApi() {
  const state = { mode: "ok" as "ok" | "down" | "outage" | "one500", delayMs: 0 }; // delayMs: answer requests this much later
  const server = createServer(async (req, res) => {
    if (state.delayMs && !req.url!.startsWith("/health")) await new Promise((r) => setTimeout(r, state.delayMs));
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/health") return res.writeHead(state.mode === "down" ? 503 : 200).end("OK");
    if (state.mode === "outage" || (state.mode === "one500" && url.pathname === "/items")) return res.writeHead(500).end("Internal Server Error");
    if (url.pathname === "/ping") return res.writeHead(201).end("Created");
    if (url.pathname === "/items") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: 1 }, { id: 2 }]));
    if (url.pathname === "/echo") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: url.searchParams.get("token") }));
    res.writeHead(404).end("Not Found");
  });
  return { url: await listen(server), state, close: () => { server.closeAllConnections(); server.close(); } };
}

const test = (name: string, script: string) => ({ listen: "test", script: { type: "text/javascript", exec: [`pm.test(${JSON.stringify(name)}, () => { ${script} });`] } });

// A collection for the fake API. "02 Items" can be renamed or made to fail via options.
export function fixtureCollection(opts: { failItems?: boolean; itemsName?: string } = {}) {
  return {
    info: { name: "Fake API tests", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: [{ key: "baseUrl", value: "http://example.invalid" }],
    item: [
      { name: "01 Ping", event: [test("Status is 201", "pm.response.to.have.status(201);")], request: { method: "GET", url: "{{baseUrl}}/ping" } },
      {
        name: opts.itemsName ?? "02 Items",
        event: [test("Two items", `pm.expect(pm.response.json().length).to.eql(${opts.failItems ? 3 : 2});`)],
        request: { method: "GET", url: "{{baseUrl}}/items" },
      },
      {
        name: "Folder",
        item: [{ name: "03 Uses an environment variable", event: [test("Token comes from the environment", "pm.expect(pm.response.json().token).to.eql('secret-123');")], request: { method: "GET", url: "{{baseUrl}}/echo?token={{apiToken}}" } }],
      },
    ],
  };
}

// The fake Postman API: checks the key, serves one workspace with one collection.
export async function fakePostman() {
  const collection = { ...fixtureCollection(), info: { ...fixtureCollection().info, name: "Fake API tests (from Postman)" } };
  const server = createServer((req, res) => {
    if (req.headers["x-api-key"] !== POSTMAN_KEY) return res.writeHead(401).end(JSON.stringify({ error: { name: "AuthenticationError" } }));
    const url = new URL(req.url!, "http://x");
    const json = (body: any) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/me") return json({ user: { username: "tester" } });
    if (url.pathname === "/workspaces") return json({ workspaces: [{ id: "ws1", name: "Practice", type: "personal" }] });
    if (url.pathname === "/collections" && url.searchParams.get("workspace") === "ws1") return json({ collections: [{ uid: "1-abc", name: collection.info.name }] });
    if (url.pathname === "/collections/1-abc") return json({ collection });
    res.writeHead(404).end("{}");
  });
  return { url: await listen(server), close: () => { server.closeAllConnections(); server.close(); } };
}

// A fresh app with an in-memory database, pointed at the fake Postman.
export async function testApp(postmanUrl: string) {
  process.env.POSTMAN_API_BASE = postmanUrl;
  process.env.QA_RUNS_DIR = mkdtempSync(join(tmpdir(), "qa-server-runs-"));
  delete process.env.POSTMAN_API_KEY;
  const { buildApp } = await import("../src/app.ts");
  const { openDb } = await import("../src/db.ts");
  return buildApp(openDb(":memory:"), { auth: false }); // logins have their own tests (auth.test.ts)
}

export async function waitForRun(app: any, id: number, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const run = (await app.inject({ method: "GET", url: `/api/runs/${id}` })).json();
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Run ${id} did not finish in time`);
}

// A fake mail server that keeps every email it receives. Logins need the given password.
export async function fakeSmtp(password = "app-pass") {
  const { SMTPServer } = await import("smtp-server");
  const mails: { to: string[]; raw: string }[] = [];
  const server = new SMTPServer({
    secure: false, disabledCommands: ["STARTTLS"], allowInsecureAuth: true, logger: false,
    onAuth(auth, _session, cb) {
      auth.password === password ? cb(null, { user: auth.username }) : cb(Object.assign(new Error("535 Invalid login"), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c) => (raw += c));
      stream.on("end", () => {
        mails.push({ to: (session.envelope.rcptTo as any[]).map((r) => r.address), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.server.address() as any).port as number, mails, close: () => server.close() };
}
