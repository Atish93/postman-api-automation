// Restores the database from a backup. Stop the server first.
//   npm run restore -- data/backups/qa-20261119-020000-auto.db
// The current database is kept next to it as qa.db.before-restore-<time>.
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const from = process.argv[2];
const target = process.env.QA_DB ?? fileURLToPath(new URL("../data/qa.db", import.meta.url));
const fail = (msg: string) => { console.error(msg); process.exit(1); };
if (!from) fail("Which backup? e.g. npm run restore -- data/backups/qa-20261119-020000-auto.db");
if (!existsSync(from)) fail(`There's no file ${from}.`);

// Is the server still running? It must not be writing while the file is swapped.
const port = Number(process.env.PORT ?? 4000);
const running = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
if (running) fail(`The dashboard server is running on port ${port}. Stop it first (Ctrl+C, or docker compose stop), then run this again.`);

// Check the backup before touching anything.
try {
  const b = new DatabaseSync(from, { readOnly: true });
  const ok = (b.prepare("PRAGMA integrity_check").get() as any).integrity_check;
  const version = Number((b.prepare("PRAGMA user_version").get() as any).user_version);
  b.close();
  if (ok !== "ok") fail(`The backup is damaged (${ok}). Choose another one.`);
  if (version < 1) fail("That file isn't a dashboard database.");
} catch (e: any) {
  fail(`That file can't be read as a database: ${e.message}`);
}

if (existsSync(target)) {
  const kept = `${target}.before-restore-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  renameSync(target, kept);
  for (const ext of ["-wal", "-shm"]) if (existsSync(target + ext)) renameSync(target + ext, kept + ext);
  console.log(`The current database was kept as ${kept}`);
}
copyFileSync(from, target);
console.log(`Restored ${from} to ${target}.
Start the server again. Saved secrets can be read only with the same secret.key the backup was made with;
if it was made on another machine, copy that machine's secret.key next to the database first.`);
