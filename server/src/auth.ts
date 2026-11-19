// Logging in: one admin password for the whole dashboard.
//
// - The password is stored only as a salted scrypt hash (setting "admin_password").
// - A login creates a session: a random token in an HttpOnly cookie; only its SHA-256 is stored.
// - Before a password exists, setting one needs a one-time setup code that is printed in the server's
//   log, so on a shared server the first stranger to open the page can't claim it.
// - Failed logins are limited per address (10 per 15 minutes).
// - Requests that change something must come from this dashboard's own pages (Origin check), on top of
//   SameSite=Lax cookies, so other websites can't act with your session.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getSetting, now, setSetting, type DB } from "./db.ts";
import { HttpError } from "./errors.ts";
import { audit } from "./audit.ts";

export const COOKIE = "qa_session";
const SESSION_DAYS = 14;
const MIN_PASSWORD = 10;
const MAX_FAILURES = 10, FAILURE_WINDOW_MS = 15 * 60_000;
const PUBLIC = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/setup"]);

// ---- Passwords ----
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scrypt(pw.normalize("NFKC"), salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString("base64")}:${(await scryptAsync(pw, salt)).toString("base64")}`;
}
export async function verifyPassword(pw: string, stored: string) {
  const [kind, , , , salt, hash] = stored.split(":");
  if (kind !== "scrypt") return false;
  const got = await scryptAsync(pw, Buffer.from(salt, "base64"));
  const want = Buffer.from(hash, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}
export const hasPassword = (db: DB) => !!getSetting(db, "admin_password");

// ---- Setup code (only while no password is set) ----
let setupCode: string | null = null;
export function currentSetupCode(): string {
  if (!setupCode) {
    setupCode = randomBytes(6).toString("hex").toUpperCase().replace(/(.{4})(?=.)/g, "$1-");
    const line = "=".repeat(64);
    console.log(`\n${line}\n  No dashboard password is set yet.\n  Open the dashboard and use this one-time setup code to set one:\n\n      ${setupCode}\n${line}\n`);
  }
  return setupCode;
}

// ---- Sessions ----
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const cookieOf = (req: FastifyRequest) =>
  (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === COOKIE)?.[1] ?? null;
const secure = (req: FastifyRequest) => req.protocol === "https";

function setCookie(req: FastifyRequest, reply: FastifyReply, token: string, maxAge: number) {
  reply.header("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`);
}

function startSession(db: DB, req: FastifyRequest, reply: FastifyReply) {
  const token = randomBytes(32).toString("base64url");
  const t = new Date();
  db.prepare("INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sha(token), t.toISOString(), t.toISOString(), new Date(t.getTime() + SESSION_DAYS * 86_400_000).toISOString(), req.ip, String(req.headers["user-agent"] ?? "").slice(0, 200));
  setCookie(req, reply, token, SESSION_DAYS * 86_400);
}

// The session this request belongs to, if it's valid. Sliding expiry: use keeps it alive.
export function sessionOf(db: DB, req: FastifyRequest): { id: number } | null {
  const token = cookieOf(req);
  if (!token) return null;
  const s = db.prepare("SELECT id, last_seen_at, expires_at FROM sessions WHERE token_hash = ?").get(sha(token)) as any;
  if (!s) return null;
  if (s.expires_at < now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
    return null;
  }
  if (Date.now() - Date.parse(s.last_seen_at) > 60_000)
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(now(), new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(), s.id);
  return { id: s.id };
}

// ---- Failed-login limit, per address ----
const failures = new Map<string, number[]>();
function tooManyFailures(ip: string) {
  const recent = (failures.get(ip) ?? []).filter((t) => Date.now() - t < FAILURE_WINDOW_MS);
  failures.set(ip, recent);
  if (recent.length >= MAX_FAILURES) {
    const wait = Math.ceil((recent[0] + FAILURE_WINDOW_MS - Date.now()) / 60_000);
    throw new HttpError(429, `Too many wrong passwords. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`);
  }
}
const noteFailure = (ip: string) => failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
export const resetLoginLimits = () => failures.clear();

// ---- Guard and routes ----
export function authRoutes(app: FastifyInstance, db: DB, enabled: boolean) {
  const NewPassword = z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters.`).max(200);

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    // Changes must come from this dashboard's own pages: a browser sends Origin on cross-site requests.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && path.startsWith("/api/")) {
      const origin = req.headers.origin;
      if (origin) {
        // Compare as URLs, so a default port (":80", ":443") written or not doesn't matter.
        const hostOf = (u: string) => { try { return new URL(u).host; } catch { return null; } };
        const own = hostOf(`${req.protocol}://${req.headers.host}`) ?? hostOf(`http://${req.headers.host}`);
        if (!own || hostOf(origin) !== own) return reply.code(403).send({ error: "This request came from another website, so it was refused." });
      }
    }
    if (!enabled || !path.startsWith("/api/") || PUBLIC.has(path)) return;
    if (sessionOf(db, req)) return;
    // A link opened in the browser (e.g. a report from an email): log in, then come back.
    if (req.method === "GET" && /text\/html/.test(String(req.headers.accept ?? "")))
      return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
    return reply.code(401).send({ error: "Log in first.", login: true });
  });

  app.get("/api/auth/status", async (req) => {
    if (!enabled) return { enabled: false, setup_needed: false, logged_in: true };
    const setup = !hasPassword(db);
    if (setup) currentSetupCode(); // make sure there is one, and it's in the log
    return { enabled: true, setup_needed: setup, logged_in: !setup && !!sessionOf(db, req) };
  });

  app.post("/api/auth/setup", async (req, reply) => {
    if (hasPassword(db)) throw new HttpError(409, "A password is already set. Log in instead.");
    const b = z.object({ code: z.string().trim(), password: NewPassword }).parse(req.body);
    tooManyFailures(req.ip);
    const want = currentSetupCode();
    const ok = b.code.toUpperCase().replace(/[^0-9A-F]/g, "") === want.replace(/-/g, "");
    if (!ok) {
      noteFailure(req.ip);
      audit(db, { actor: "admin", ip: req.ip, action: "auth.setup_failed", summary: "Wrong setup code" });
      throw new HttpError(400, "That setup code isn't right. It's printed in the server's log (the terminal or `docker compose logs`).");
    }
    setSetting(db, "admin_password", await hashPassword(b.password));
    setupCode = null;
    startSession(db, req, reply);
    audit(db, { actor: "admin", ip: req.ip, action: "auth.setup", summary: "Set the dashboard password" });
    return { ok: true };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { password } = z.object({ password: z.string().min(1, "Enter the password.") }).parse(req.body);
    const stored = getSetting(db, "admin_password");
    if (!stored) throw new HttpError(409, "No password is set yet. Set one first.");
    tooManyFailures(req.ip);
    if (!(await verifyPassword(password, stored))) {
      noteFailure(req.ip);
      audit(db, { actor: "admin", ip: req.ip, action: "auth.login_failed", summary: "Wrong password" });
      throw new HttpError(401, "Wrong password.");
    }
    failures.delete(req.ip);
    startSession(db, req, reply);
    audit(db, { actor: "admin", ip: req.ip, action: "auth.login", summary: "Logged in" });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = cookieOf(req);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
    setCookie(req, reply, "", 0);
    audit(db, { actor: "admin", ip: req.ip, action: "auth.logout", summary: "Logged out" });
    return { ok: true };
  });

  // Change the password. Every other session is ended; this one stays logged in.
  app.post("/api/auth/password", async (req, reply) => {
    const b = z.object({ current: z.string(), password: NewPassword }).parse(req.body);
    tooManyFailures(req.ip);
    if (!(await verifyPassword(b.current, getSetting(db, "admin_password") ?? ""))) {
      noteFailure(req.ip);
      throw new HttpError(400, "The current password is wrong.");
    }
    setSetting(db, "admin_password", await hashPassword(b.password));
    db.prepare("DELETE FROM sessions").run();
    startSession(db, req, reply);
    audit(db, { actor: "admin", ip: req.ip, action: "auth.password_changed", summary: "Changed the password; other sessions were logged out" });
    return { ok: true };
  });

  app.get("/api/auth/sessions", async (req) => {
    const mine = sessionOf(db, req)?.id;
    return (db.prepare("SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE expires_at > ? ORDER BY last_seen_at DESC").all(now()) as any[])
      .map((s) => ({ ...s, current: s.id === mine }));
  });

  app.post("/api/auth/logout-others", async (req) => {
    const mine = sessionOf(db, req)?.id ?? -1;
    const n = Number(db.prepare("DELETE FROM sessions WHERE id != ?").run(mine).changes);
    audit(db, { actor: "admin", ip: req.ip, action: "auth.logout_others", summary: `Logged out ${n} other session${n === 1 ? "" : "s"}` });
    return { ended: n };
  });
}
