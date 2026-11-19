// Runs the real orchestrator (real agents, real cost) against a fake server that misbehaves,
// to see the server-error handling and the circuit breaker work end to end.
//
//   npm run drill -- crash <collection uid>  # the real API, but the checkin filter answers 500:
//                                            #   expect it debugged as an API bug, NOT a termination
//   npm run drill -- 500 <collection uid>    # every request answers 500: expect "Facing server issues", exit code 2
//   npm run drill -- 404 <collection uid>    # every request answers 404: expect the circuit breaker, exit code 3
//
// The collection is downloaded from Postman as usual; only its requests go to the fake server.
// Drills are dry runs: nothing is written to Postman or to the knowledge base.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [kind, uid] = process.argv.slice(2);
if (!["crash", "500", "404"].includes(kind) || !uid) {
  console.log("Usage: npm run drill -- crash|500|404 <collection uid>");
  process.exit(1);
}

const real = JSON.parse(readFileSync(new URL("../qa.config.json", import.meta.url), "utf8"));
const upstream = real.environments.test.baseUrl;

const server = createServer(async (req, res) => {
  if (kind !== "crash") {
    if (req.url === "/ping") return res.writeHead(201).end("Created"); // healthy, so the run starts
    return res.writeHead(Number(kind)).end(kind === "500" ? "Internal Server Error" : "Not Found");
  }
  // crash: forward to the real API, except that the checkin filter crashes.
  if (req.method === "GET" && req.url?.includes("checkin=")) return res.writeHead(500).end("Internal Server Error");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "content-length", "connection"].includes(k))) as Record<string, string>;
  try {
    const up = await fetch(upstream + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "text/plain" }).end(Buffer.from(await up.arrayBuffer()));
  } catch {
    res.writeHead(502).end("Bad Gateway");
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "qa-drill-"));
real.environments.mock = { label: "Mock", baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, healthPath: "/ping" };
writeFileSync(join(dir, "qa.config.json"), JSON.stringify(real));

const child = spawn("npx", ["tsx", "orchestrator.ts", "--env", "mock", "--regression", uid], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, QA_CONFIG: join(dir, "qa.config.json"), QA_NO_LEARNING: "1", QA_DRY_RUN: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const code: number = await new Promise((r) => child.on("exit", r));
server.close();
console.log(`\nOrchestrator exit code: ${code}`);
