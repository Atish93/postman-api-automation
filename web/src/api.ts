// Typed calls to the dashboard server (see server/README.md for the API).

export type RunStatus =
  | "queued" | "running" | "passed" | "passed_with_known_bugs" | "failed"
  | "server_issue" | "circuit_breaker" | "error" | "cancelled";

export type Settings = { postman: { connected: boolean; key_hint: string | null; user?: string | null } };
export type Workspace = { id: string; name: string; type: string };
export type PostmanCollection = { uid: string; name: string; imported: boolean };

export type Collection = {
  id: number; name: string; source: "postman" | "upload"; postman_uid: string | null; request_count: number;
  created_at: string; updated_at: string; last_run: { id: number; status: RunStatus; created_at: string } | null;
};
export type CollectionDetail = Collection & {
  description: string | null;
  requests: { name: string; folder: string | null; method: string; url: string }[];
};

export type Variable = { key: string; value: string | null; secret: boolean; masked?: string };
export type Environment = {
  id: number; name: string; label: string; base_url: string; health_path: string;
  variables: Variable[]; created_at: string; updated_at: string;
};
export type EnvironmentInput = Omit<Environment, "id" | "created_at" | "updated_at" | "variables"> & {
  variables: { key: string; value: string | null; secret: boolean }[];
};

export type Execution = {
  request: string; method?: string; url?: string; status: number | null; response_time_ms: number | null;
  error: string | null; body?: string; assertions: { name: string; error: string | null }[];
};
export type AiCollectionResult = {
  name: string; uid: string | null; requests: number; assertions: number; failed_assertions: number;
  failures: { request: string; assertion: string; error: string }[];
  known_bugs: string[]; known_bugs_now_passing: string[]; circuit_breaker_tripped: boolean;
  diagnoses: { request: string; assertion: string; category: string; confidence: string; evidence: string; fix_hint?: string }[];
  changes: string[]; published: { uid: string; name: string } | null; updated: string | null;
};
export type Run = {
  id: number; kind: "plain" | "ai"; ai_mode: "regression" | "build" | null; request: string | null; status: RunStatus; message: string | null;
  collection: { id: number | null; name: string }; environment: { id: number | null; label: string };
  requests: number | null; assertions: number | null; failed_assertions: number | null;
  cost_usd: number | null; exit_code: number | null;
  created_at: string; started_at: string | null; finished_at: string | null; duration_ms: number | null;
  result?:
    | { environment: { label: string; base_url: string }; executions: Execution[] }
    | { environment: { label: string; base_url: string }; collections: AiCollectionResult[]; report: string; cost_usd: number; server_issue: string | null }
    | null;
};
export type RunEvent = { seq: number; type: string; data: Record<string, any>; created_at: string };

export type Dashboard = {
  days: number;
  this_week: { runs: number; pass_rate: number | null; ai_cost_usd: number; ai_runs: number };
  last_week: { runs: number; pass_rate: number | null; ai_cost_usd: number; ai_runs: number };
  daily: { date: string; passed: number; known_bugs: number; failed: number; server_issue: number; other: number; total: number; pass_rate: number | null }[];
  known_bugs: { request: string; collection: string; environment: string; run_id: number; seen_at: string }[];
  latest_runs: { id: number; kind: "plain" | "ai"; ai_mode: "regression" | "build" | null; status: RunStatus; collection: string; environment: string; failed_assertions: number | null; cost_usd: number | null; created_at: string; finished_at: string | null }[];
};

export type KnownBug = {
  request: string; collection: { id: number | null; name: string }; environment: string;
  first_seen: { run_id: number; at: string }; last_failed: { run_id: number; at: string };
  times_failed: number; evidence: string | null; status: "open" | "may_be_fixed"; latest_run_id: number;
};
export type HealerChange = {
  run_id: number; at: string; collection: { id: number | null; name: string }; environment: string;
  request: string; part: string; reason: string; diff: string[]; approved_by_human: boolean; outcome: "kept" | "reverted" | "unproven";
};
export type StartRun =
  | { kind: "plain"; collection_id: number; environment_id: number }
  | { kind: "ai"; ai_mode: "regression"; collection_id: number; environment_id: number }
  | { kind: "ai"; ai_mode: "build"; request: string; workspace_id: string; environment_id: number };

export class ApiError extends Error {}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `The server answered ${res.status}.`);
  return data as T;
}

export const api = {
  settings: () => request<Settings>("GET", "/settings"),
  savePostmanKey: (api_key: string | null) => request<Settings>("PUT", "/settings/postman", { api_key }),
  workspaces: () => request<Workspace[]>("GET", "/postman/workspaces"),
  workspaceCollections: (id: string) => request<PostmanCollection[]>("GET", `/postman/workspaces/${encodeURIComponent(id)}/collections`),

  collections: () => request<Collection[]>("GET", "/collections"),
  collection: (id: number) => request<CollectionDetail>("GET", `/collections/${id}`),
  importCollection: (uid: string) => request<Collection>("POST", "/collections/import", { uid }),
  uploadCollection: (json: unknown) => request<Collection>("POST", "/collections/upload", json),
  refreshCollection: (id: number) => request<Collection>("POST", `/collections/${id}/refresh`),
  deleteCollection: (id: number) => request<void>("DELETE", `/collections/${id}`),

  environments: () => request<Environment[]>("GET", "/environments"),
  environment: (id: number) => request<Environment>("GET", `/environments/${id}`),
  createEnvironment: (e: EnvironmentInput) => request<Environment>("POST", "/environments", e),
  updateEnvironment: (id: number, e: EnvironmentInput) => request<Environment>("PUT", `/environments/${id}`, e),
  deleteEnvironment: (id: number) => request<void>("DELETE", `/environments/${id}`),

  runs: (filters: Record<string, string | number | undefined> = {}) => {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return request<Run[]>("GET", `/runs${q.size ? `?${q}` : ""}`);
  },
  run: (id: number) => request<Run>("GET", `/runs/${id}`),
  startRun: (body: StartRun) => request<Run>("POST", "/runs", body),
  knownBugs: () => request<KnownBug[]>("GET", "/known-bugs"),
  changes: () => request<HealerChange[]>("GET", "/changes"),
  answerApproval: (id: number, answer: string) => request<{ ok: true }>("POST", `/runs/${id}/approval`, { answer }),
  cancelRun: (id: number) => request<{ ok: true }>("POST", `/runs/${id}/cancel`),

  dashboard: (days = 30) => request<Dashboard>("GET", `/dashboard?days=${days}`),
};
