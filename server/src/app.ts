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

  // The web app (web/dist, built with `npm run build` in web/), served from the same address.
  // Any non-API path gets index.html, so links into the app work on reload.
  const webDist = process.env.QA_WEB_DIST ?? new URL("../../web/dist/", import.meta.url).pathname;
  if (existsSync(webDist)) {
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
