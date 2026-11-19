// Makes a backup now, e.g. from cron or before an upgrade: npm run backup
// Safe while the server is running.
import { openDb } from "../src/db.ts";
import { backupNow } from "../src/backups.ts";
import { audit } from "../src/audit.ts";

const db = openDb();
const b = backupNow(db, "manual");
audit(db, { actor: "cli", action: "backup.create", summary: `Made a backup from the command line: ${b.name}` });
console.log(`Backup made: ${b.name} (${Math.round(b.size / 1024)} KB)\nThe encryption key (secret.key) isn't in it: keep a copy of that too.`);
