// Builds the API server. Kept separate from index.ts so tests can create one without listening on a port.
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { openDb, type DB } from "./db.ts";
import { HttpError } from "./errors.ts";
import { RunManager } from "./runs/manager.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { postmanRoutes } from "./routes/postman.ts";
import { collectionsRoutes } from "./routes/collections.ts";
import { environmentsRoutes } from "./routes/environments.ts";
import { runsRoutes } from "./routes/runs.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { insightsRoutes } from "./routes/insights.ts";
import { fileURLToPath } from "node:url";

export function buildApp(db: DB = openDb(), opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  const runs = new RunManager(db);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "Something went wrong on the server." });
  });

  app.get("/api/health", async () => ({ ok: true }));
  settingsRoutes(app, db);
  postmanRoutes(app, db);
  collectionsRoutes(app, db);
  environmentsRoutes(app, db);
  runsRoutes(app, db, runs);
  dashboardRoutes(app, db);
  insightsRoutes(app, db);

  // The web app (web/dist, built with `npm run build` in web/), served from the same address.
  // Any non-API path gets index.html, so links into the app work on reload.
  const webDist = process.env.QA_WEB_DIST ?? fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (!existsSync(webDist)) {
    app.get("/", async (_req, reply) => reply.type("text/html").send(NOT_BUILT(webDist)));
  } else {
    // wildcard: files are looked up on disk per request, so rebuilding the web app needs no server restart.
    app.register(fastifyStatic, { root: webDist, wildcard: true });
    // App pages get index.html; a missing API path or file (e.g. /assets/x.js) is a real 404.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") || /\.[a-z0-9]+(\?|$)/i.test(req.url)
        ? reply.code(404).send({ error: "Not found." })
        : reply.type("text/html").sendFile("index.html"));
  }
  return { app, db, runs };
}

// Shown at / when the web app hasn't been built, instead of a bare 404.
const NOT_BUILT = (dir: string) => `<!doctype html><meta charset="utf-8"><title>QA Dashboard</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.4rem">The API is running, but the web app isn't built yet</h1>
<p>Build it once, then restart the server (Ctrl+C, then <code>npm start</code>) and reload this page:</p>
<pre style="background:#f0efec;padding:.75rem;border-radius:.5rem">cd web
npm install
npm run build</pre>
<p style="color:#52514e">Looked for it in: <code>${dir.replace(/[<>&]/g, "")}</code></p></body>`;
