// Backups of the database: a consistent copy taken while the server runs (SQLite's VACUUM INTO).
// Automatic ones are made once a day and the newest QA_BACKUP_KEEP (default 7) are kept; ones you make
// yourself are never deleted automatically. Restore with `npm run restore -- <file>` while the server is stopped.
//
// The encryption key (secret.key) is NOT in the backup: keep a copy of it somewhere safe as well, or the
// secrets in a restored backup can't be read. Keeping them apart means a leaked backup alone exposes no secrets.
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DB } from "./db.ts";
import { HttpError } from "./errors.ts";
import { audit } from "./audit.ts";

export const NAME = /^qa-\d{8}-\d{6}-(auto|manual)\.db$/;
const DAY = 86_400_000;

export const backupDir = (db: DB) => process.env.QA_BACKUP_DIR ?? join(dirname(dbFile(db)), "backups");
function dbFile(db: DB): string {
  const f = (db.prepare("PRAGMA database_list").all() as any[]).find((d) => d.name === "main")?.file;
  if (!f) throw new HttpError(400, "This database lives in memory, so it can't be backed up.");
  return f;
}

export function listBackups(db: DB) {
  const dir = backupDir(db);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => NAME.test(n)).map((name) => {
    const st = statSync(join(dir, name));
    return { name, kind: name.endsWith("-auto.db") ? "auto" as const : "manual" as const, size: st.size, created_at: st.mtime.toISOString() };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

export function backupNow(db: DB, kind: "auto" | "manual") {
  const dir = backupDir(db);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  let name = `qa-${stamp}-${kind}.db`;
  for (let i = 1; existsSync(join(dir, name)); i++) name = `qa-${stamp}-${kind}.db`.replace(/-(\d{6})-/, (_m, t) => `-${String(Number(t) + i).padStart(6, "0")}-`);
  const file = join(dir, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (kind === "auto") prune(db);
  return listBackups(db).find((b) => b.name === name)!;
}

function prune(db: DB) {
  const keep = Math.max(1, Number(process.env.QA_BACKUP_KEEP ?? 7));
  for (const b of listBackups(db).filter((b) => b.kind === "auto").slice(keep)) unlinkSync(join(backupDir(db), b.name));
}

// Makes an automatic backup when the newest one is a day old (checked every hour).
export class AutoBackup {
  private timer: NodeJS.Timeout | null = null;
  constructor(private db: DB) {}
  start(intervalMs = 3_600_000) {
    if (process.env.QA_BACKUPS === "off") return;
    this.check();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref?.();
  }
  check() {
    try {
      const last = listBackups(this.db).find((b) => b.kind === "auto");
      if (last && Date.now() - Date.parse(last.created_at) < DAY - 60_000) return null;
      const b = backupNow(this.db, "auto");
      audit(this.db, { actor: "system", action: "backup.auto", summary: `Daily backup: ${b.name}` });
      return b;
    } catch (e: any) {
      console.error(`Automatic backup failed: ${e.message}`);
      return null;
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
