// Encryption at rest for secrets: secret environment variables, the Postman API key, the SMTP password.
// AES-256-GCM with a random nonce per value; stored as "enc:v1:<nonce>:<tag>:<ciphertext>" (base64).
//
// The key comes from QA_SECRET_KEY (base64, 32 bytes) or the file secret.key next to the database,
// created on first start and readable only by its owner. It protects the database file if it leaks
// (a backup, a copy, a commit) - not against someone who can already read every file on this computer.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const PREFIX = "enc:v1:";
let key: Buffer | null = null;
let source: { kind: "env" | "file" | "memory"; file?: string } = { kind: "memory" };

export class SecretError extends Error {}

export function initSecrets(dbPath: string) {
  if (process.env.QA_SECRET_KEY) {
    key = Buffer.from(process.env.QA_SECRET_KEY, "base64");
    if (key.length !== 32) throw new Error("QA_SECRET_KEY must be 32 bytes, base64-encoded (e.g. openssl rand -base64 32).");
    source = { kind: "env" };
  } else if (dbPath === ":memory:") {
    key = randomBytes(32); // an in-memory database (tests) lives no longer than this key
    source = { kind: "memory" };
  } else {
    const file = join(dirname(dbPath), "secret.key");
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch {}
    }
    key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${file} doesn't hold a valid key. Restore it from a backup, or delete it and re-enter your secrets.`);
    source = { kind: "file", file };
  }
}

export const secretsInfo = () => source;
export const isEncrypted = (v: string | null | undefined) => !!v?.startsWith(PREFIX);

export function encrypt(plain: string): string {
  if (!key) throw new Error("Secrets aren't initialised.");
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${nonce.toString("base64")}:${c.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

// Values saved before encryption existed are returned as they are (and encrypted on the next start).
export function decrypt(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  if (!key) throw new Error("Secrets aren't initialised.");
  const [nonce, tag, data] = stored.slice(PREFIX.length).split(":").map((p) => Buffer.from(p, "base64"));
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    const where = source.kind === "file" ? source.file : source.kind === "env" ? "QA_SECRET_KEY" : "this session's key";
    throw new SecretError(`A saved secret can't be decrypted with the key in ${where}: the key changed or the value was altered. Enter the secret again.`);
  }
}

// Secret settings (Postman API key, SMTP password).
export const SECRET_SETTINGS = ["postman_api_key", "smtp_password"];
export function getSecretSetting(db: DatabaseSync, name: string): string | null {
  const v = (db.prepare("SELECT value FROM settings WHERE key = ?").get(name) as any)?.value ?? null;
  return v === null ? null : decrypt(v);
}
export function setSecretSetting(db: DatabaseSync, name: string, value: string | null) {
  if (value === null) db.prepare("DELETE FROM settings WHERE key = ?").run(name);
  else db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name, encrypt(value));
}

// Encrypts anything secret still stored in plain text (from before encryption existed). Safe to run on every start.
export function encryptExisting(db: DatabaseSync) {
  let n = 0;
  for (const v of db.prepare("SELECT id, value FROM variables WHERE secret = 1 AND value NOT LIKE 'enc:v1:%'").all() as any[]) {
    db.prepare("UPDATE variables SET value = ? WHERE id = ?").run(encrypt(v.value), v.id);
    n++;
  }
  for (const name of SECRET_SETTINGS) {
    const v = (db.prepare("SELECT value FROM settings WHERE key = ?").get(name) as any)?.value;
    if (v && !isEncrypted(v)) {
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(encrypt(v), name);
      n++;
    }
  }
  return n;
}
