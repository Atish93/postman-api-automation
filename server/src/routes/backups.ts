// Backups: list, make one now, download one.
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { backupDir, backupNow, listBackups, NAME } from "../backups.ts";
import { secretsInfo } from "../secrets.ts";

export function backupRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/backups", async () => {
    const s = secretsInfo();
    return { dir: backupDir(db), keep: Number(process.env.QA_BACKUP_KEEP ?? 7), automatic: process.env.QA_BACKUPS !== "off", key_file: s.file ?? null, backups: listBackups(db) };
  });
  app.post("/api/backups", async (_req, reply) => {
    reply.code(201);
    return backupNow(db, "manual");
  });
  app.get<{ Params: { name: string } }>("/api/backups/:name/download", async (req, reply) => {
    const { name } = req.params;
    if (!NAME.test(name) || !listBackups(db).some((b) => b.name === name)) throw new HttpError(404, "Backup not found.");
    reply.header("content-type", "application/vnd.sqlite3");
    reply.header("content-disposition", `attachment; filename="${name}"`);
    return reply.send(createReadStream(join(backupDir(db), name)));
  });
}
