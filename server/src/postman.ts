// Talks to the Postman API with the key saved in settings (or POSTMAN_API_KEY).
// POSTMAN_API_BASE can point it elsewhere, which the tests use for a fake Postman.
import { getSetting, type DB } from "./db.ts";
import { HttpError } from "./errors.ts";

const base = () => process.env.POSTMAN_API_BASE ?? "https://api.getpostman.com";

export function postmanKey(db: DB): string | null {
  return getSetting(db, "postman_api_key") ?? process.env.POSTMAN_API_KEY ?? null;
}

// Shown instead of the key: enough to recognise it, not enough to use it.
export function keyHint(key: string | null) {
  return key ? `…${key.slice(-4)}` : null;
}

export async function postman(db: DB, path: string) {
  const key = postmanKey(db);
  if (!key) throw new HttpError(400, "Postman is not connected. Save your Postman API key in settings first.");
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(30_000) });
  } catch (e: any) {
    throw new HttpError(502, `Could not reach Postman: ${e.cause?.code ?? e.message}`);
  }
  const body = await res.text();
  if (res.status === 401) throw new HttpError(400, "Postman rejected the API key. Check it in settings.");
  if (res.status === 404) throw new HttpError(404, "Not found in Postman.");
  if (!res.ok) throw new HttpError(502, `Postman answered ${res.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}
