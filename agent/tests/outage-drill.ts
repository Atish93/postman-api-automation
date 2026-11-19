// Runs the real orchestrator (real agents, real cost) against a fake server that misbehaves,
// to see the server-error stop and the circuit breaker work end to end.
//
//   npm run drill -- 500 <collection uid>   # every request answers 500: expect "Facing server issues", exit code 2
//   npm run drill -- 404 <collection uid>   # every request answers 404: expect the circuit breaker, exit code 3
//
// The collection is downloaded from Postman as usual; only its requests go to the fake server.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [kind, uid] = process.argv.slice(2);
if (!["500", "404"].includes(kind) || !uid) {
  console.log("Usage: npm run drill -- 500|404 <collection uid>");
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.url === "/ping") return res.writeHead(201).end("Created"); // healthy, so the run starts
  res.writeHead(Number(kind)).end(kind === "500" ? "Internal Server Error" : "Not Found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

const real = JSON.parse(readFileSync(new URL("../qa.config.json", import.meta.url), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "qa-drill-"));
const port = (server.address() as any).port;
real.environments.mock = { label: "Mock", baseUrl: `http://127.0.0.1:${port}`, healthPath: "/ping" };
writeFileSync(join(dir, "qa.config.json"), JSON.stringify(real));

const child = spawn("npx", ["tsx", "orchestrator.ts", "--env", "mock", "--regression", uid], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, QA_CONFIG: join(dir, "qa.config.json"), QA_NO_LEARNING: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const code: number = await new Promise((r) => child.on("exit", r));
server.close();
console.log(`\nOrchestrator exit code: ${code}`);
