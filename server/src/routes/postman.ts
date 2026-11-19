// Browsing Postman: workspaces, and the collections in one.
import type { FastifyInstance } from "fastify";
import type { DB } from "../db.ts";
import { postman } from "../postman.ts";

export function postmanRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/postman/workspaces", async () => {
    const data = await postman(db, "/workspaces");
    return data.workspaces.map((w: any) => ({ id: w.id, name: w.name, type: w.type }));
  });

  app.get<{ Params: { id: string } }>("/api/postman/workspaces/:id/collections", async (req) => {
    const data = await postman(db, `/collections?workspace=${encodeURIComponent(req.params.id)}`);
    const imported = new Set((db.prepare("SELECT postman_uid FROM collections WHERE postman_uid IS NOT NULL").all() as any[]).map((r) => r.postman_uid));
    return data.collections.map((c: any) => ({ uid: c.uid, name: c.name, imported: imported.has(c.uid) }));
  });
}
