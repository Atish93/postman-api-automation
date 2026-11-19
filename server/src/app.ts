// Builds the API server. Kept separate from index.ts so tests can create one without listening on a port.
import Fastify from "fastify";
import { ZodError } from "zod";
import { openDb, type DB } from "./db.ts";
import { HttpError } from "./errors.ts";
import { RunManager } from "./runs/manager.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { postmanRoutes } from "./routes/postman.ts";
import { collectionsRoutes } from "./routes/collections.ts";
import { environmentsRoutes } from "./routes/environments.ts";
import { runsRoutes } from "./routes/runs.ts";

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
  return { app, db, runs };
}
