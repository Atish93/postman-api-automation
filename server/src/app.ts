// Builds the API server. Kept separate from index.ts so tests can create one without listening on a port.
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { openDb, type DB } from "./db.ts";
import { HttpError } from "./errors.ts";
import { RunManager } from "./runs/manager.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { postmanRoutes } from "./routes/postman.ts";
import { collectionsRoutes } from "./routes/collections.ts";
import { dataFileRoutes } from "./routes/datafiles.ts";
import { environmentsRoutes } from "./routes/environments.ts";
import { runsRoutes } from "./routes/runs.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { insightsRoutes } from "./routes/insights.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { scheduleRoutes } from "./routes/schedules.ts";
import { Scheduler } from "./scheduler.ts";
import { notifyRunFinished } from "./email.ts";
import { fileURLToPath } from "node:url";
import { authRoutes } from "./auth.ts";
import { auditHooks, auditRoutes } from "./auditRoutes.ts";
import { pruneAudit } from "./audit.ts";
import { backupRoutes } from "./routes/backups.ts";
import { contractRoutes } from "./routes/contracts.ts";
import { AutoBackup } from "./backups.ts";

// auth: the login (on unless a test turns it off).
export function buildApp(db: DB = openDb(), opts: { logger?: boolean; auth?: boolean } = {}) {
  // Behind a reverse proxy (Caddy, nginx) set QA_TRUST_PROXY=1, so the real address and https are known.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024, trustProxy: process.env.QA_TRUST_PROXY === "1" });
  securityHeaders(app);
  // When a run finishes, email its report if its collection's rule says so, and note that on the run.
  const runs: RunManager = new RunManager(db, async (runId) => {
    const sent = await notifyRunFinished(db, runId);
    if (sent) runs.addEvent(runId, sent.status === "sent" ? "email_sent" : "email_failed", sent);
  });
  const scheduler = new Scheduler(db, runs); // started by index.ts
  const backups = new AutoBackup(db); // started by index.ts
  pruneAudit(db);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "Something went wrong on the server." });
  });

  app.get("/api/health", async () => ({ ok: true }));
  authRoutes(app, db, opts.auth ?? true);
  auditHooks(app, db);
  auditRoutes(app, db);
  backupRoutes(app, db);
  settingsRoutes(app, db, runs);
  postmanRoutes(app, db);
  collectionsRoutes(app, db);
  environmentsRoutes(app, db);
  dataFileRoutes(app, db);
  runsRoutes(app, db, runs);
  dashboardRoutes(app, db);
  insightsRoutes(app, db);
  notificationRoutes(app, db);
  scheduleRoutes(app, db);
  contractRoutes(app, db);

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
  app.addHook("onClose", async () => { scheduler.stop(); backups.stop(); });
  return { app, db, runs, scheduler, backups };
}

// Headers that tell browsers to be strict: only this site's own scripts, no framing, no sniffing.
function securityHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (req.protocol === "https") reply.header("strict-transport-security", "max-age=31536000");
    return payload;
  });
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
