// Forgot the dashboard password? Run this on the server (npm run reset-password, or
// docker compose exec qa npm run reset-password). It removes the password and logs everyone out;
// the next visit asks for a new one with a setup code printed in the server's log.
import { openDb } from "../src/db.ts";
import { audit } from "../src/audit.ts";

const db = openDb();
db.prepare("DELETE FROM settings WHERE key = 'admin_password'").run();
const n = Number(db.prepare("DELETE FROM sessions").run().changes);
audit(db, { actor: "cli", action: "auth.reset", summary: `Password reset from the command line; ${n} session${n === 1 ? "" : "s"} logged out` });
console.log("The password was removed and everyone was logged out.\nOpen the dashboard to set a new one: the setup code is printed in the server's log.");
