// Saving collections (shared by the collections routes and AI build runs).
import { z } from "zod";
import { now, type DB } from "./db.ts";
import { postman } from "./postman.ts";

export function requestsOf(items: any[] = [], folder: string | null = null): any[] {
  return items.flatMap((it) =>
    it.item
      ? requestsOf(it.item, folder ? `${folder} / ${it.name}` : it.name)
      : [{ name: it.name, folder, method: it.request?.method ?? "GET", url: typeof it.request?.url === "string" ? it.request.url : it.request?.url?.raw ?? "" }],
  );
}

// A Postman v2.1 collection: info.name and an item list.
const CollectionJson = z.object({ info: z.object({ name: z.string().min(1) }).passthrough(), item: z.array(z.any()) }).passthrough();

// Saves a collection; one imported from Postman again (same uid) is updated, not duplicated. Returns its id.
export function saveCollection(db: DB, json: unknown, source: "postman" | "upload", uid: string | null): number {
  const parsed = CollectionJson.parse(json);
  const count = requestsOf(parsed.item).length;
  const existing = uid ? (db.prepare("SELECT id FROM collections WHERE postman_uid = ?").get(uid) as any) : null;
  if (existing) {
    db.prepare("UPDATE collections SET name = ?, json = ?, request_count = ?, updated_at = ? WHERE id = ?").run(parsed.info.name, JSON.stringify(parsed), count, now(), existing.id);
    return existing.id as number;
  }
  const t = now();
  return Number(db.prepare("INSERT INTO collections (name, source, postman_uid, json, request_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(parsed.info.name, source, uid, JSON.stringify(parsed), count, t, t).lastInsertRowid);
}

export async function importFromPostman(db: DB, uid: string): Promise<number> {
  const data = await postman(db, `/collections/${encodeURIComponent(uid)}`);
  return saveCollection(db, data.collection, "postman", uid);
}
