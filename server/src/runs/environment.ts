// Loads an environment with its variables, as runs need it.
import type { DB } from "../db.ts";

export type RunEnvironment = {
  name: string;
  label: string;
  baseUrl: string;
  healthPath: string;
  variables: Record<string, string>;
};

export function loadEnvironment(db: DB, id: number): RunEnvironment {
  const e = db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as any;
  if (!e) throw new Error("The environment no longer exists.");
  const vars = db.prepare("SELECT key, value FROM variables WHERE environment_id = ?").all(id) as any[];
  return {
    name: e.name,
    label: e.label,
    baseUrl: e.base_url,
    healthPath: e.health_path,
    variables: Object.fromEntries(vars.map((v) => [v.key, v.value])),
  };
}

// Why a request got no answer, in words. fetch reports "fetch failed" with the real reason nested
// (sometimes one per address tried, e.g. IPv4 and IPv6).
export function networkReason(e: any): string {
  const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code;
  const words: Record<string, string> = {
    ECONNREFUSED: "connection refused (nothing is listening there)",
    ENOTFOUND: "the host name doesn't exist",
    ETIMEDOUT: "timed out",
    ECONNRESET: "the connection was reset",
    UND_ERR_CONNECT_TIMEOUT: "timed out connecting",
    CERT_HAS_EXPIRED: "its TLS certificate has expired",
  };
  if (e?.name === "TimeoutError") return "no answer within 15 seconds";
  return code ? words[code] ?? code : e?.cause?.message ?? e?.message ?? String(e);
}

export const serverIssueMessage = (label: string) => `Facing server issues, please check ${label} Env`;

// Same check the agents run before starting: a 5xx or no answer means the server is down.
export async function healthCheck(env: RunEnvironment): Promise<string | null> {
  const url = env.baseUrl.replace(/\/$/, "") + env.healthPath;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return res.status >= 500 ? `Health check ${url} answered ${res.status}.` : null;
  } catch (e: any) {
    return `Health check ${url} failed: ${networkReason(e)}.`;
  }
}
