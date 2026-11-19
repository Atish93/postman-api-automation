// Collections: import from Postman, upload a file, list, view, refresh, delete.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { postman } from "../postman.ts";
import { requestsOf, saveCollection } from "../collections.ts";

const summary = (r: any) => ({
  id: r.id, name: r.name, source: r.source, postman_uid: r.postman_uid, request_count: r.request_count,
  created_at: r.created_at, updated_at: r.updated_at, last_run: r.last_run_id ? { id: r.last_run_id, status: r.last_run_status, created_at: r.last_run_at } : null,
});

export function collectionsRoutes(app: FastifyInstance, db: DB) {
  const getRow = (id: number) => {
    const row = db.prepare("SELECT * FROM collections WHERE id = ?").get(id);
    if (!row) throw new HttpError(404, "Collection not found.");
    return row as any;
  };

  const save = (json: unknown, source: "postman" | "upload", uid: string | null) => saveCollection(db, json, source, uid);

  app.get("/api/collections", async () => {
    const rows = db.prepare(`
      SELECT c.*, r.id AS last_run_id, r.status AS last_run_status, r.created_at AS last_run_at
      FROM collections c
      LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE collection_id = c.id ORDER BY id DESC LIMIT 1)
      ORDER BY c.name`).all();
    return rows.map(summary);
  });

  app.get<{ Params: { id: string } }>("/api/collections/:id", async (req) => {
    const row = getRow(Number(req.params.id));
    const json = JSON.parse(row.json);
    return { ...summary(row), description: json.info?.description ?? null, variables: json.variable ?? [], requests: requestsOf(json.item) };
  });

  // The collection file itself, e.g. to open it in Postman or Newman.
  app.get<{ Params: { id: string } }>("/api/collections/:id/json", async (req, reply) => {
    const row = getRow(Number(req.params.id));
    reply.header("content-disposition", `attachment; filename="${row.name.replace(/[^\w.-]+/g, "_")}.postman_collection.json"`);
    return JSON.parse(row.json);
  });

  app.post("/api/collections/import", async (req, reply) => {
    const { uid } = z.object({ uid: z.string().min(1) }).parse(req.body);
    const data = await postman(db, `/collections/${encodeURIComponent(uid)}`);
    const id = save(data.collection, "postman", uid);
    reply.code(201);
    return summary(getRow(id));
  });

  // Upload: the body is the collection JSON itself (as exported from Postman).
  app.post("/api/collections/upload", async (req, reply) => {
    const body: any = req.body;
    const json = body?.collection && body?.collection?.info ? body.collection : body; // accept {collection: ...} too
    const id = save(json, "upload", null);
    reply.code(201);
    return summary(getRow(id));
  });

  // Pull the latest version from Postman.
  app.post<{ Params: { id: string } }>("/api/collections/:id/refresh", async (req) => {
    const row = getRow(Number(req.params.id));
    if (!row.postman_uid) throw new HttpError(400, "This collection was uploaded, not imported from Postman, so it can't be refreshed.");
    const data = await postman(db, `/collections/${encodeURIComponent(row.postman_uid)}`);
    save(data.collection, "postman", row.postman_uid);
    return summary(getRow(row.id));
  });

  app.delete<{ Params: { id: string } }>("/api/collections/:id", async (req, reply) => {
    getRow(Number(req.params.id));
    db.prepare("DELETE FROM collections WHERE id = ?").run(Number(req.params.id)); // its runs stay, with the collection's name
    reply.code(204);
  });
}
