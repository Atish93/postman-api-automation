// Run reports: a self-contained HTML file (attached to emails, downloadable from the run page)
// and the email's own summary. Inline styles only: email programs ignore style sheets.
// Everything taken from a run is escaped, since responses and test output can contain anything.
import type { DB } from "./db.ts";

export const STATUS: Record<string, { label: string; color: string }> = {
  passed: { label: "Passed", color: "#0ca30c" },
  passed_with_known_bugs: { label: "Passed, known bugs", color: "#c98500" },
  failed: { label: "Failed", color: "#d03b3b" },
  server_issue: { label: "Server issue", color: "#d9662f" },
  circuit_breaker: { label: "Circuit breaker tripped", color: "#d9662f" },
  error: { label: "Error", color: "#6b6a66" },
  cancelled: { label: "Cancelled", color: "#6b6a66" },
  queued: { label: "Queued", color: "#6b6a66" },
  running: { label: "Running", color: "#2a78d6" },
};

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const duration = (ms: number | null) => (ms == null ? "" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "");

export type ReportRun = {
  id: number; kind: string; ai_mode: string | null; status: string; message: string | null;
  collection_name: string; environment_label: string; requests: number | null; assertions: number | null;
  failed_assertions: number | null; cost_usd: number | null; started_at: string | null; finished_at: string | null;
  created_at: string; request: string | null; schedule_id: number | null; unattended: number;
  result: any;
};

export function loadReportRun(db: DB, runId: number): ReportRun | null {
  const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
  if (!r) return null;
  return { ...r, result: r.result_json ? JSON.parse(r.result_json) : null };
}

// What failed, in a shape shared by plain and AI runs.
export function failuresOf(run: ReportRun): { request: string; status: number | null; errors: string[]; knownBug: boolean }[] {
  const r = run.result;
  if (!r) return [];
  if (Array.isArray(r.executions))
    return r.executions
      .filter((e: any) => e.assertions?.some((a: any) => a.error) || e.error || (e.status ?? 0) >= 500)
      .map((e: any) => ({
        request: e.request, status: e.status ?? null, knownBug: e.request.startsWith("KNOWN BUG - "),
        errors: [...(e.error ? [e.error] : []), ...e.assertions.filter((a: any) => a.error).map((a: any) => `${a.name}: ${a.error}`)],
      }));
  const byRequest = new Map<string, string[]>();
  for (const c of r.collections ?? []) for (const f of c.failures ?? []) byRequest.set(f.request, [...(byRequest.get(f.request) ?? []), `${f.assertion}: ${f.error}`]);
  return [...byRequest].map(([request, errors]) => ({ request, status: null, errors, knownBug: request.startsWith("KNOWN BUG - ") }));
}

const runUrl = (run: ReportRun, dashboardUrl: string) => `${dashboardUrl.replace(/\/$/, "")}/runs/${run.id}`;

function header(run: ReportRun) {
  const s = STATUS[run.status] ?? STATUS.error;
  const kind = run.kind === "ai" ? (run.ai_mode === "build" ? "AI build" : "AI") : "Plain";
  const ms = run.started_at && run.finished_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : null;
  const rows: [string, string][] = [
    ["Collection", esc(run.collection_name)],
    ["Environment", esc(run.environment_label)],
    ["Kind", `${kind}${run.schedule_id ? " · scheduled" : ""}`],
    ["Started", esc(when(run.started_at ?? run.created_at))],
    ...(ms != null ? [["Duration", duration(ms)] as [string, string]] : []),
    ...(run.assertions != null ? [["Checks", `${run.failed_assertions} failed of ${run.assertions}, in ${run.requests} requests`] as [string, string]] : []),
    ...(run.kind === "ai" && run.cost_usd != null ? [["AI cost", `$${run.cost_usd.toFixed(2)}`] as [string, string]] : []),
  ];
  return `
  <p style="margin:0 0 6px"><span style="display:inline-block;padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px;color:#ffffff;background:${s.color}">${esc(s.label)}</span></p>
  <h1 style="margin:8px 0 4px;font-size:20px">Run #${run.id}: ${esc(run.collection_name)}</h1>
  ${run.request ? `<p style="margin:4px 0;color:#52514e">What to test: ${esc(run.request)}</p>` : ""}
  ${run.message ? `<p style="margin:12px 0;padding:10px 12px;border-radius:8px;background:#fdf1ea;border:1px solid #f0c3a9"><strong>${esc(run.message)}</strong></p>` : ""}
  <table style="border-collapse:collapse;margin:12px 0;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#6b6a66">${k}</td><td style="padding:3px 0">${v}</td></tr>`).join("")}</table>`;
}

function failuresTable(run: ReportRun) {
  const fails = failuresOf(run);
  if (!fails.length) return run.status === "passed" ? `<p style="color:#0a7a0a"><strong>Every check passed.</strong></p>` : "";
  const newOnes = fails.filter((f) => !f.knownBug), known = fails.filter((f) => f.knownBug);
  const table = (title: string, list: typeof fails) => !list.length ? "" : `
  <h2 style="font-size:16px;margin:20px 0 8px">${title}</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <tr><th style="text-align:left;padding:6px;border-bottom:1px solid #e1e0d9">Request</th><th style="text-align:left;padding:6px;border-bottom:1px solid #e1e0d9">Status</th><th style="text-align:left;padding:6px;border-bottom:1px solid #e1e0d9">What failed</th></tr>
    ${list.map((f) => `<tr><td style="padding:6px;border-bottom:1px solid #f0efec;vertical-align:top">${esc(f.request.replace("KNOWN BUG - ", ""))}</td><td style="padding:6px;border-bottom:1px solid #f0efec;vertical-align:top;font-family:monospace">${esc(f.status ?? "")}</td><td style="padding:6px;border-bottom:1px solid #f0efec;vertical-align:top">${f.errors.map(esc).join("<br>")}</td></tr>`).join("")}
  </table>`;
  return table("Failures", newOnes) + table("Known bugs (still failing)", known);
}

// The full report: everything in the run.
export function reportHtml(run: ReportRun, dashboardUrl: string): string {
  const r = run.result;
  let details = "";
  if (r && Array.isArray(r.executions)) {
    details = `<h2 style="font-size:16px;margin:24px 0 8px">Every request</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <tr><th style="text-align:left;padding:6px;border-bottom:1px solid #e1e0d9">Request</th><th style="text-align:left;padding:6px;border-bottom:1px solid #e1e0d9">Status</th><th style="text-align:left;padding:6px;border-bottom:1px solid #e1e0d9">Time</th><th style="text-align:left;padding:6px;border-bottom:1px solid #e1e0d9">Checks</th></tr>
      ${r.executions.map((e: any) => `<tr>
        <td style="padding:6px;border-bottom:1px solid #f0efec;vertical-align:top">${esc(e.request)}<div style="color:#898781;font-family:monospace;font-size:12px">${esc(e.method ?? "")} ${esc(e.url ?? "")}</div></td>
        <td style="padding:6px;border-bottom:1px solid #f0efec;vertical-align:top;font-family:monospace">${esc(e.status ?? e.error ?? "")}</td>
        <td style="padding:6px;border-bottom:1px solid #f0efec;vertical-align:top">${e.response_time_ms != null ? `${e.response_time_ms} ms` : ""}</td>
        <td style="padding:6px;border-bottom:1px solid #f0efec;vertical-align:top">${(e.assertions ?? []).map((a: any) => `<div style="color:${a.error ? "#b42323" : "#0a7a0a"}">${a.error ? "✗" : "✓"} ${esc(a.name)}${a.error ? `<div style="color:#52514e">${esc(a.error)}</div>` : ""}</div>`).join("")}</td>
      </tr>`).join("")}
    </table>`;
  } else if (r?.collections) {
    if (r.report) details += `<h2 style="font-size:16px;margin:24px 0 8px">Report from the agents</h2><div style="white-space:pre-wrap;font-size:14px;line-height:1.5;background:#f9f9f7;border:1px solid #e1e0d9;border-radius:8px;padding:12px">${esc(r.report)}</div>`;
    for (const c of r.collections) {
      if (c.diagnoses?.length)
        details += `<h2 style="font-size:16px;margin:24px 0 8px">Diagnoses: ${esc(c.name)}</h2><ul style="font-size:14px">${c.diagnoses.map((d: any) => `<li><strong>${esc(d.request)}</strong>: ${esc(String(d.category).replace("_", " "))} (${esc(d.confidence)})<div style="color:#52514e">${esc(d.evidence)}</div></li>`).join("")}</ul>`;
      if (c.changes?.length)
        details += `<h2 style="font-size:16px;margin:24px 0 8px">Changes by the self-healer</h2><pre style="white-space:pre-wrap;font-size:12px;background:#f9f9f7;border:1px solid #e1e0d9;border-radius:8px;padding:12px">${esc(c.changes.join("\n\n"))}</pre>`;
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Run #${run.id}: ${esc(run.collection_name)} (${esc(STATUS[run.status]?.label ?? run.status)})</title></head>
<body style="margin:0;background:#f9f9f7;color:#0b0b0b;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
<div style="max-width:960px;margin:0 auto;padding:24px 16px;background:#ffffff">
${header(run)}
${failuresTable(run)}
${details}
<p style="margin-top:24px;font-size:13px"><a href="${esc(runUrl(run, dashboardUrl))}" style="color:#2a78d6">Open this run in the QA dashboard</a></p>
</div></body></html>`;
}

// The email itself: the summary and a link; the full report is attached.
export function reportEmail(run: ReportRun, dashboardUrl: string) {
  const s = STATUS[run.status] ?? STATUS.error;
  const fails = failuresOf(run);
  const known = fails.filter((f) => f.knownBug).length;
  const failed = !fails.length ? ""
    : known === fails.length ? ` (${known} known bug${known === 1 ? "" : "s"})`
    : ` (${run.failed_assertions} failed check${run.failed_assertions === 1 ? "" : "s"})`;
  const subject = `[QA] ${s.label}: ${run.collection_name} on ${run.environment_label}${failed}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f9f9f7;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b">
<div style="max-width:640px;margin:0 auto;padding:24px 16px;background:#ffffff">
${header(run)}
${failuresTable(run)}
<p style="margin:20px 0"><a href="${esc(runUrl(run, dashboardUrl))}" style="display:inline-block;padding:8px 14px;border-radius:8px;background:#2a78d6;color:#ffffff;text-decoration:none;font-weight:600">Open the run</a></p>
<p style="font-size:12px;color:#898781">The full report is attached. Sent by your QA dashboard.</p>
</div></body></html>`;
  const text = [
    `${s.label}: ${run.collection_name} on ${run.environment_label}`,
    run.message ?? "",
    run.assertions != null ? `${run.failed_assertions} failed of ${run.assertions} checks, in ${run.requests} requests.` : "",
    ...fails.map((f) => `- ${f.knownBug ? "[known bug] " : ""}${f.request.replace("KNOWN BUG - ", "")}: ${f.errors.join("; ")}`),
    "",
    `Open the run: ${runUrl(run, dashboardUrl)}`,
  ].filter((l, i) => l || i > 2).join("\n");
  return { subject, html, text };
}
