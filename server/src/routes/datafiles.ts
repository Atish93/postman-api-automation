// Test-data files of a collection: upload (CSV or JSON), list, preview, download, delete.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { now, type DB } from "../db.ts";
import { HttpError } from "../errors.ts";
import { columnUse, parseDataFile } from "../datafiles.ts";

const PREVIEW_ROWS = 20;

export function dataFileRoutes(app: FastifyInstance, db: DB) {
  const collection = (id: number) => {
    const c = db.prepare("SELECT id, json FROM collections WHERE id = ?").get(id) as any;
    if (!c) throw new HttpError(404, "Collection not found.");
    return c;
  };
  const get = (id: number) => {
    const f = db.prepare("SELECT * FROM data_files WHERE id = ?").get(id) as any;
    if (!f) throw new HttpError(404, "Data file not found.");
    return f;
  };
  const view = (f: any, withRows = false) => {
    const columns: string[] = JSON.parse(f.columns);
    const c = db.prepare("SELECT json FROM collections WHERE id = ?").get(f.collection_id) as any;
    const schedules = (db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE data_file_id = ?").get(f.id) as any).n;
    return {
      id: f.id, collection_id: f.collection_id, name: f.name, format: f.format, columns, row_count: f.row_count, created_at: f.created_at,
      ...columnUse(c?.json ?? "", columns), schedules,
      ...(withRows && { preview: parseDataFile(f.name, f.content).rows.slice(0, PREVIEW_ROWS) }),
    };
  };

  app.get<{ Params: { id: string } }>("/api/collections/:id/data-files", async (req) => {
    collection(Number(req.params.id));
    return (db.prepare("SELECT * FROM data_files WHERE collection_id = ? ORDER BY name").all(Number(req.params.id)) as any[]).map((f) => view(f));
  });

  app.post<{ Params: { id: string } }>("/api/collections/:id/data-files", { bodyLimit: 3_000_000 }, async (req, reply) => {
    const c = collection(Number(req.params.id));
    const b = z.object({
      name: z.string().trim().min(1).max(120),
      content: z.string().min(1, "The file is empty."),
      replace: z.boolean().default(false), // a file with the same name is replaced instead of refused
    }).parse(req.body);
    const parsed = parseDataFile(b.name, b.content);
    const existing = db.prepare("SELECT id FROM data_files WHERE collection_id = ? AND name = ?").get(c.id, b.name) as any;
    if (existing && !b.replace) throw new HttpError(409, `This collection already has a data file named "${b.name}".`);
    let id: number;
    if (existing) {
      db.prepare("UPDATE data_files SET format = ?, content = ?, columns = ?, row_count = ?, created_at = ? WHERE id = ?")
        .run(parsed.format, b.content, JSON.stringify(parsed.columns), parsed.rows.length, now(), existing.id);
      id = existing.id;
    } else {
      id = Number(db.prepare("INSERT INTO data_files (collection_id, name, format, content, columns, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(c.id, b.name, parsed.format, b.content, JSON.stringify(parsed.columns), parsed.rows.length, now()).lastInsertRowid);
    }
    reply.code(existing ? 200 : 201);
    return view(get(id), true);
  });

  app.get<{ Params: { id: string } }>("/api/data-files/:id", async (req) => view(get(Number(req.params.id)), true));

  app.get<{ Params: { id: string } }>("/api/data-files/:id/download", async (req, reply) => {
    const f = get(Number(req.params.id));
    reply.header("content-type", f.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${f.name.replace(/[^\w.-]+/g, "_")}"`);
    return f.content;
  });

  app.delete<{ Params: { id: string } }>("/api/data-files/:id", async (req, reply) => {
    const f = get(Number(req.params.id));
    const used = (db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE data_file_id = ?").get(f.id) as any).n;
    if (used) throw new HttpError(409, `${used} schedule${used > 1 ? "s use" : " uses"} this file. Change or delete ${used > 1 ? "them" : "it"} first.`);
    db.prepare("DELETE FROM data_files WHERE id = ?").run(f.id); // past runs keep the file's name
    reply.code(204);
  });
}
