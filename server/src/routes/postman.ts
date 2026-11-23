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

  // API specs stored in Postman (Spec Hub) in a workspace.
  app.get<{ Params: { id: string } }>("/api/postman/workspaces/:id/specs", async (req) => {
    const specs: any[] = [];
    let cursor: string | null = null;
    do {
      const data = await postman(db, `/specs?workspaceId=${encodeURIComponent(req.params.id)}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      specs.push(...(data.specs ?? []));
      cursor = data.meta?.nextCursor ?? null;
    } while (cursor && specs.length < 500);
    return specs.map((s) => ({ id: s.id, name: s.name, type: s.type ?? null, updated_at: s.updatedAt ?? null }));
  });

  // The top-level folders of a collection, to choose where new tests go.
  app.get<{ Params: { uid: string } }>("/api/postman/collections/:uid/folders", async (req) => {
    const data = await postman(db, `/collections/${encodeURIComponent(req.params.uid)}`);
    return (data.collection?.item ?? []).filter((i: any) => Array.isArray(i.item)).map((f: any) => ({ name: f.name, requests: countRequests(f.item) }));
  });
}

export const countRequests = (items: any[]): number => items.reduce((n, i) => n + (Array.isArray(i.item) ? countRequests(i.item) : 1), 0);
