// Typed calls to the dashboard server (see server/README.md for the API).

export type RunStatus =
  | "queued" | "running" | "passed" | "passed_with_known_bugs" | "failed"
  | "server_issue" | "circuit_breaker" | "error" | "cancelled";

export type Settings = {
  postman: { connected: boolean; key_hint: string | null; user?: string | null };
  secrets?: { key_source: "file" | "env" | "memory"; key_file: string | null };
  runs?: { max_parallel: number; running: number; queued: number } | null;
};
export type AuthStatus = { enabled: boolean; setup_needed: boolean; logged_in: boolean };
export type Session = { id: number; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null; current: boolean };
export type AuditEntry = { id: number; at: string; actor: "admin" | "schedule" | "system" | "cli"; ip: string | null; action: string; summary: string; details: Record<string, unknown> | null };
export type Backup = { name: string; kind: "auto" | "manual"; size: number; created_at: string };
export type Backups = { dir: string; keep: number; automatic: boolean; key_file: string | null; backups: Backup[] };
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

export type Variable = { key: string; value: string | null; secret: boolean; masked?: string; unreadable?: boolean };

export type CompareCell = { present: false } | { present: true; secret: boolean; value: string | null; masked?: string };
export type Comparison = {
  environments: { id: number; name: string; label: string; base_url: string; health_path: string }[];
  rows: { key: string; status: "same" | "different" | "missing" | "unknown"; cells: CompareCell[] }[];
  counts: Record<"same" | "different" | "missing" | "unknown", number>;
};
export type CopyResult = {
  dry_run: boolean; added: string[]; overwritten: string[]; unchanged: string[]; skipped: string[]; not_found: string[]; environment: Environment;
};
export type DataFile = {
  id: number; collection_id: number; name: string; format: "csv" | "json"; columns: string[]; row_count: number; created_at: string;
  used: string[]; unused: string[]; schedules: number; preview?: Record<string, string>[];
};
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
  iteration?: number; // runs with a test-data file: which row (from 1)
};
export type AiCollectionResult = {
  name: string; uid: string | null; requests: number; assertions: number; failed_assertions: number;
  failures: { request: string; assertion: string; error: string }[];
  known_bugs: string[]; known_bugs_now_passing: string[]; circuit_breaker_tripped: boolean;
  diagnoses: { request: string; assertion: string; category: string; confidence: string; evidence: string; fix_hint?: string }[];
  changes: string[]; published: { uid: string; name: string } | null; updated: string | null;
};
export type ContractCase = { id: string; endpoint?: string; type: string; title: string; request?: string; expected: string; contract_ref?: string };
export type ContractPlan = {
  collection_name: string; summary?: string; auth?: string; endpoints?: string[]; gaps?: string[]; cases: ContractCase[];
  endpoints_found?: { method: string; path: string; summary?: string }[];
};
export type Endpoint = { key: string; method: string; path: string; summary: string | null; operation_id: string | null; tags: string[]; parameters: number; has_body: boolean; responses: string[]; secured: boolean; deprecated: boolean };
export type ContractSummary = {
  id: number; name: string; title: string; api_version: string | null; format: "openapi" | "document"; spec_version: string | null;
  source_kind: "file" | "url" | "postman"; source_ref: string | null; filename: string | null; endpoint_count: number;
  created_at: string; updated_at: string; checked_at: string | null; last_run: { id: number; status: RunStatus; created_at: string } | null; publications: number;
};
export type Publication = { id: number; contract_id: number | null; run_id: number | null; workspace_id: string; workspace_name: string | null; collection_uid: string; collection_name: string; folder_name: string | null; requests: number; published_at: string };
export type ContractChanges = { added: string[]; removed: string[]; changed: { key: string; what: string[] }[]; text_changed?: boolean; from_version?: string | null; to_version?: string | null; at?: string };
export type AuthVariable = { key: string; secret: boolean; purpose: string; auto?: boolean };
export type ContractAuth = { variables: AuthVariable[]; schemes: { name: string; type: string; detail: string }[]; login: { endpoint: string; why: string } | null };
export type ContractCheck = {
  base_url: string; servers: string[]; base_url_matches: boolean | null; suggested_base_url: string | null;
  credentials: (AuthVariable & { present: boolean })[]; login: ContractAuth["login"];
  probe: { endpoint: string; url: string; status?: number; error?: string; verdict: "ok" | "needs_auth" | "not_found" | "server_error" | "unreachable" } | null;
};
export type ContractDetail = ContractSummary & {
  servers: string[]; auth: ContractAuth | null; endpoints: Endpoint[]; warnings: string[]; last_changes: ContractChanges | null;
  text_preview: string | null; text_length: number | null;
  runs: { id: number; status: RunStatus; environment_label: string; cost_usd: number | null; created_at: string; finished_at: string | null }[];
  published: Publication[];
};
export type PostmanSpec = { id: string; name: string; type: string | null; updated_at: string | null };
export type PublishTarget = { kind: "new"; name: string } | { kind: "folder"; collection_uid: string; folder_name: string; replace: boolean };

export type Run = {
  id: number; kind: "plain" | "ai"; ai_mode: "regression" | "build" | "contract" | null; request: string | null; status: RunStatus; message: string | null;
  schedule_id: number | null; unattended: boolean;
  data_file: { id: number | null; name: string } | null;
  contract: { id: number | null; endpoints: string[] | null } | null;
  collection: { id: number | null; name: string }; environment: { id: number | null; label: string };
  requests: number | null; assertions: number | null; failed_assertions: number | null;
  cost_usd: number | null; exit_code: number | null;
  created_at: string; started_at: string | null; finished_at: string | null; duration_ms: number | null;
  result?:
    | { environment: { label: string; base_url: string }; executions: Execution[] }
    | { environment: { label: string; base_url: string }; collections: AiCollectionResult[]; report: string; cost_usd: number; server_issue: string | null;
        contract?: { name: string; plan: ContractPlan | null; review_rounds: number; collection: any } }
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
  | { kind: "plain"; collection_id: number; environment_id: number; data_file_id?: number }
  | { kind: "ai"; ai_mode: "regression"; collection_id: number; environment_id: number }
  | { kind: "ai"; ai_mode: "build"; request: string; workspace_id: string; environment_id: number }
  | { kind: "ai"; ai_mode: "contract"; contract_id: number; environment_id: number; endpoints?: string[]; request?: string };

export type EmailSettings = { configured: boolean; host: string; port: number; secure: boolean; user: string; from: string; dashboard_url: string; has_password: boolean };
export type ReportRule = { recipients: string[]; send_when: "always" | "failure" | "new_failure"; enabled: boolean };
export type Schedule = {
  id: number; kind: "plain" | "ai"; cron: string; enabled: boolean; next_run_at: string | null;
  collection: { id: number; name: string }; environment: { id: number; label: string };
  data_file: { id: number; name: string } | null;
  last_run: { id: number; status: RunStatus; created_at: string } | null;
};
export type ScheduleInput = { collection_id: number; environment_id: number; kind: "plain" | "ai"; cron: string; enabled: boolean; data_file_id: number | null };
export type SentEmail = { id: number; run_id: number; recipients: string[]; subject: string; status: "sent" | "failed"; error: string | null; trigger: "rule" | "manual"; created_at: string };

export class ApiError extends Error {}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  // Logged out (the session expired, or the password changed elsewhere): go to the login page and come back.
  if (res.status === 401 && data?.login && !/^\/(login|setup)/.test(location.pathname)) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  if (!res.ok) throw new ApiError(data?.error ?? `The server answered ${res.status}.`);
  return data as T;
}

export const api = {
  authStatus: () => request<AuthStatus>("GET", "/auth/status"),
  setup: (code: string, password: string) => request<{ ok: true }>("POST", "/auth/setup", { code, password }),
  login: (password: string) => request<{ ok: true }>("POST", "/auth/login", { password }),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  changePassword: (current: string, password: string) => request<{ ok: true }>("POST", "/auth/password", { current, password }),
  sessions: () => request<Session[]>("GET", "/auth/sessions"),
  logoutOthers: () => request<{ ended: number }>("POST", "/auth/logout-others"),
  audit: (f: { action?: string; q?: string; before_id?: number } = {}) => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return request<AuditEntry[]>("GET", `/audit${q.size ? `?${q}` : ""}`);
  },
  backups: () => request<Backups>("GET", "/backups"),
  backupNow: () => request<Backup>("POST", "/backups"),
  backupUrl: (name: string) => `/api/backups/${encodeURIComponent(name)}/download`,
  saveRunSettings: (max_parallel: number) => request<{ max_parallel: number }>("PUT", "/settings/runs", { max_parallel }),

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
  compareEnvironments: (ids: number[]) => request<Comparison>("GET", `/environments/compare?ids=${ids.join(",")}`),
  copyVariables: (targetId: number, body: { source_id: number; keys: string[]; overwrite: boolean; dry_run: boolean }) =>
    request<CopyResult>("POST", `/environments/${targetId}/copy-from`, body),

  dataFiles: (collectionId: number) => request<DataFile[]>("GET", `/collections/${collectionId}/data-files`),
  dataFile: (id: number) => request<DataFile>("GET", `/data-files/${id}`),
  uploadDataFile: (collectionId: number, body: { name: string; content: string; replace?: boolean }) => request<DataFile>("POST", `/collections/${collectionId}/data-files`, body),
  deleteDataFile: (id: number) => request<void>("DELETE", `/data-files/${id}`),
  dataFileUrl: (id: number) => `/api/data-files/${id}/download`,

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

  emailSettings: () => request<EmailSettings>("GET", "/settings/email"),
  saveEmailSettings: (s: Omit<EmailSettings, "configured" | "has_password"> & { password: string | null }) => request<EmailSettings>("PUT", "/settings/email", s),
  sendTestEmail: (to: string) => request<{ ok: true }>("POST", "/settings/email/test", { to }),
  reportRule: (collectionId: number) => request<ReportRule>("GET", `/collections/${collectionId}/reports`),
  saveReportRule: (collectionId: number, r: ReportRule) => request<ReportRule>("PUT", `/collections/${collectionId}/reports`, r),
  runEmails: (runId: number) => request<SentEmail[]>("GET", `/runs/${runId}/emails`),
  emailRun: (runId: number, recipients?: string[]) => request<{ status: string; recipients: string[] }>("POST", `/runs/${runId}/email`, { recipients }),
  reportUrl: (runId: number, download = false) => `/api/runs/${runId}/report.html${download ? "?download=1" : ""}`,
  schedules: (collectionId?: number) => request<Schedule[]>("GET", `/schedules${collectionId ? `?collection_id=${collectionId}` : ""}`),
  schedulePreview: (cron: string) => request<{ next: string[] }>("GET", `/schedules/preview?cron=${encodeURIComponent(cron)}`),
  createSchedule: (s: ScheduleInput) => request<Schedule>("POST", "/schedules", s),
  updateSchedule: (id: number, s: ScheduleInput) => request<Schedule>("PUT", `/schedules/${id}`, s),
  deleteSchedule: (id: number) => request<void>("DELETE", `/schedules/${id}`),

  contracts: () => request<ContractSummary[]>("GET", "/contracts"),
  contract: (id: number) => request<ContractDetail>("GET", `/contracts/${id}`),
  uploadContract: (filename: string, content_base64: string, name?: string) => request<ContractDetail>("POST", "/contracts/upload", { filename, content_base64, name }),
  contractFromUrl: (url: string, name?: string) => request<ContractDetail>("POST", "/contracts/url", { url, name }),
  contractFromPostman: (workspace_id: string, spec_id: string, name?: string) => request<ContractDetail>("POST", "/contracts/postman", { workspace_id, spec_id, name }),
  refreshContract: (id: number) => request<{ changed: boolean; changes?: ContractChanges; contract: ContractDetail }>("POST", `/contracts/${id}/refresh`),
  renameContract: (id: number, name: string) => request<ContractDetail>("PATCH", `/contracts/${id}`, { name }),
  deleteContract: (id: number) => request<void>("DELETE", `/contracts/${id}`),
  contractSourceUrl: (id: number) => `/api/contracts/${id}/source`,
  postmanSpecs: (workspaceId: string) => request<PostmanSpec[]>("GET", `/postman/workspaces/${encodeURIComponent(workspaceId)}/specs`),
  collectionFolders: (uid: string) => request<{ name: string; requests: number }[]>("GET", `/postman/collections/${encodeURIComponent(uid)}/folders`),
  contractCheck: (id: number, environmentId: number, endpoints?: string[]) =>
    request<ContractCheck>("GET", `/contracts/${id}/check?environment_id=${environmentId}${endpoints?.length ? `&endpoints=${encodeURIComponent(endpoints.join(","))}` : ""}`),
  publishRun: (runId: number, workspace_id: string, target: PublishTarget, environments: { label: string; base_url: string }[] = [], add_to_dashboard = false) =>
    request<{ workspace: { id: string; name: string }; collection: { uid: string; name: string; id: number | null }; folder: string | null; requests: number;
      environments: { label: string; postman_uid: string | null; dashboard_id: number | null }[]; credential_variables: AuthVariable[] }>("POST", `/runs/${runId}/publish`, { workspace_id, target, environments, add_to_dashboard }),
  runPublications: (runId: number) => request<Publication[]>("GET", `/runs/${runId}/publications`),

  dashboard: (days = 30) => request<Dashboard>("GET", `/dashboard?days=${days}`),
};
