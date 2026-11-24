// Debugging one failure of a run: what failed, the likely causes and probable fixes (from the debugger),
// the request and response as run, what the debugger tried, what the contract and knowledge base say,
// and the log lines about it. Opened from the run page's Debug buttons.
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { api, type Cause, type Fix, type Header, type IssueDetail } from "../api.ts";
import { EVENT_LOOK } from "../events.tsx";
import { dateTime, duration } from "../format.ts";
import { ActivityRow, CategoryChip, DiffBlock, HealerChange, METHOD_COLOR, issueHref } from "../RunParts.tsx";
import { Button, ErrorNote, Icon, Segmented, Spinner, useToast } from "../ui.tsx";

export function DebugPage() {
  const id = Number(useParams().id);
  const [params] = useSearchParams();
  const ref = { collection: Number(params.get("collection") ?? 0), request: params.get("request") ?? "" };
  const q = useQuery({ queryKey: ["run-issue", id, ref.collection, ref.request], queryFn: () => api.runIssue(id, ref), enabled: !!ref.request });
  if (!ref.request) return <ErrorNote error={new Error("No failure chosen. Open one from the run page.")} />;
  if (q.isPending) return <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div>;
  if (q.error) return <><Back id={id} /><ErrorNote error={q.error} /></>;
  return <DebugView d={q.data} collection={ref.collection} />;
}

const Back = ({ id }: { id: number }) => <div className="mb-2 text-sm"><Link to={`/runs/${id}`} className="text-ink-2 hover:text-ink">← Run #{id}</Link></div>;

function Panel({ icon, iconColor, title, note, actions, children, className = "", tone }: { icon: string; iconColor?: string; title: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; tone?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border bg-card ${className}`} style={{ borderColor: tone ? `color-mix(in srgb, ${tone} 45%, transparent)` : "var(--line)" }}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span style={{ color: iconColor ?? "var(--ink-2)" }}><Icon name={icon} /></span>
          <h2 className="font-semibold">{title}</h2>
          {note && <span className="text-sm text-ink-2">{note}</span>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
const Label = ({ children }: { children: ReactNode }) => <div className="text-xs font-semibold uppercase tracking-wide text-muted">{children}</div>;
const Code = ({ children, className = "" }: { children: ReactNode; className?: string }) =>
  <pre className={`overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-page p-3 font-mono text-xs text-ink-2 ring-1 ring-line ${className}`}>{children}</pre>;
const statusColor = (s?: number | null, error?: string) => (error || (s ?? 0) >= 500 ? "var(--bad-ink)" : (s ?? 0) >= 400 ? "var(--status-warning)" : "var(--good-ink)");

// "expected 500 to equal 400" -> { actual: "500", expected: "400" }
function expectation(error: string) {
  const m = error.match(/^expected (.+?) to (?:equal|eql|be|deeply equal|have status(?: code)?) (.+?)\.?$/i);
  return m ? { actual: m[1], expected: m[2] } : null;
}

function DebugView({ d, collection }: { d: IssueDetail; collection: number }) {
  const { issue, run } = d;
  const x = issue.exchange;
  const toast = useToast();
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast("ok", `${what} copied`), () => toast("error", "Couldn't copy: your browser blocked it"));
  const name = issue.request.replace(/^KNOWN BUG - /, "");
  const title = issue.case_id ? name.replace(new RegExp(`^${issue.case_id}\\s+`), "") : name;
  let path = "";
  try { path = x ? new URL(x.url).pathname : ""; } catch { /* keep it empty */ }
  const checks = x?.assertions ?? [];
  const failed = issue.failed_assertions;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1.5 text-sm text-muted">
        <Link to="/runs" className="text-ink-2 hover:text-ink">Runs</Link><span aria-hidden="true">/</span>
        <Link to={`/runs/${run.id}`} className="text-ink-2 hover:text-ink">Run #{run.id}</Link><span aria-hidden="true">/</span>
        <span className="text-ink">Debug {issue.case_id ?? "failure"}</span>
      </nav>

      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h1 className="flex flex-wrap items-baseline gap-2 text-xl font-semibold">{issue.case_id && <span className="font-mono text-base font-normal text-muted">{issue.case_id}</span>}{title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {x && <code className="rounded bg-raised px-2 py-0.5 font-mono text-xs ring-1 ring-line"><span className="font-semibold" style={{ color: METHOD_COLOR[x.method] }}>{x.method}</span> {d.contract?.path ?? path}</code>}
            <CategoryChip category={issue.category} />
            {issue.confidence && <span className="text-ink-2">{issue.confidence} confidence</span>}
            <span className="text-ink-2">· {failed.length} of {checks.length || failed.length} check{(checks.length || failed.length) === 1 ? "" : "s"} failed · {run.environment_label}</span>
            {issue.state === "passing_now" && <span className="text-good-ink">· passes now</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center overflow-hidden rounded-lg ring-1 ring-line">
            {d.position.previous ? <Link to={issueHref(run.id, d.position.previous)} aria-label="Previous failure" className="px-2.5 py-2 text-ink-2 hover:bg-raised hover:text-ink"><Icon name="chevron" className="rotate-180" /></Link>
              : <span className="px-2.5 py-2 text-muted opacity-40" aria-hidden="true"><Icon name="chevron" className="rotate-180" /></span>}
            <span className="border-x border-line px-3 py-2 text-sm text-ink-2 tabular">Failure {d.position.index + 1} of {d.position.total}</span>
            {d.position.next ? <Link to={issueHref(run.id, d.position.next)} aria-label="Next failure" className="px-2.5 py-2 text-ink-2 hover:bg-raised hover:text-ink"><Icon name="chevron" /></Link>
              : <span className="px-2.5 py-2 text-muted opacity-40" aria-hidden="true"><Icon name="chevron" /></span>}
          </div>
          <a href={api.runIssueBundleUrl(run.id, { collection, request: issue.request })}><Button icon="download">Download debug bundle</Button></a>
        </div>
      </div>

      <div className="space-y-4">
        {/* What failed */}
        <section aria-label="What failed" className="grid overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-4"
          style={{ borderColor: "color-mix(in srgb, var(--bad-ink) 40%, transparent)", background: "color-mix(in srgb, var(--bad-ink) 6%, var(--card))" }}>
          <div className="px-4 py-3"><Label>Failed check{failed.length === 1 ? "" : "s"}</Label>
            <ul className="mt-1 space-y-0.5 font-mono text-xs">{failed.map((f, k) => <li key={k}>{f.assertion}</li>)}</ul>
          </div>
          {(() => {
            const e = failed[0] && expectation(failed[0].error);
            return e ? (<>
              <div className="border-t border-line/50 px-4 py-3 sm:border-l sm:border-t-0"><Label>Expected</Label><div className="mt-1 text-xl font-semibold text-good-ink">{e.expected}</div></div>
              <div className="border-t border-line/50 px-4 py-3 lg:border-l lg:border-t-0"><Label>Actual</Label>
                <div className="mt-1 text-xl font-semibold text-bad-ink">{e.actual} {x?.response_time_ms != null && <span className="text-sm font-normal text-ink-2">· {duration(x.response_time_ms)}</span>}</div></div>
            </>) : (
              <div className="border-t border-line/50 px-4 py-3 sm:border-l sm:border-t-0 lg:col-span-2"><Label>Error</Label>
                <div className="mt-1 space-y-0.5 text-sm text-bad-ink">{failed.map((f, k) => <div key={k}>{f.error}</div>)}</div>
                {x && <div className="mt-1 text-xs text-ink-2">Response {x.error ? `: none (${x.error})` : `${x.status} in ${duration(x.response_time_ms)}`}</div>}
              </div>
            );
          })()}
          <div className="border-t border-line/50 px-4 py-3 sm:border-l lg:border-t-0"><Label>History</Label><History d={d} /></div>
        </section>

        {/* Likely cause + probable fix */}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <CausesPanel d={d} />
          <FixPanel d={d} copy={copy} />
        </div>

        {/* Request and response */}
        <Exchange d={d} />

        {/* Probes + contract and knowledge */}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Panel icon="refresh" title="What the debugger tried" note={issue.probes.length ? `${issue.probes.length} request${issue.probes.length === 1 ? "" : "s"}` : undefined}>
            {issue.probes.length === 0 ? <p className="px-4 py-5 text-sm text-ink-2">The debugger sent no extra requests for this failure.</p> : (
              <ul className="divide-y divide-line">{issue.probes.map((p, k) => <ProbeRow key={k} p={p} />)}</ul>
            )}
          </Panel>
          <ContextPanel d={d} />
        </div>

        <LogsPanel d={d} />
      </div>
    </>
  );
}

function History({ d }: { d: IssueDetail }) {
  const look = { passed: ["var(--status-good)", "passed"], failed: ["var(--bad-ink)", "failed"], not_run: ["var(--status-neutral)", "not run"], unknown: ["var(--line)", "not recorded"] } as const;
  const firstFail = d.history.findIndex((h, k) => h.outcome === "failed" && d.history.slice(k).every((x) => x.outcome !== "passed"));
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-1" aria-label={`Last ${d.history.length} runs: ${d.history.map((h) => look[h.outcome][1]).join(", ")}`}>
        {d.history.map((h) => (
          <Link key={h.run_id} to={`/runs/${h.run_id}`} title={`Run #${h.run_id} · ${look[h.outcome][1]} · ${dateTime(h.at)}`}
            className={`h-3.5 w-3.5 rounded-sm ${h.run_id === d.run.id ? "ring-2 ring-ink/60" : ""}`} style={{ background: look[h.outcome][0] }} />
        ))}
      </div>
      <div className="mt-1 text-xs text-ink-2">{d.history.length <= 1 ? "First run of this test." : firstFail > 0 ? `Failing since Run #${d.history[firstFail].run_id}` : firstFail === 0 ? `Failed in every recorded run` : "Passing before this run"}</div>
    </>
  );
}

// ---- Causes and fixes: from the debugger's diagnoses (older diagnoses only have evidence and a hint) ----
const LIKELY = { high: { label: "High", color: "var(--bad-ink)", width: 80 }, medium: { label: "Medium", color: "var(--status-warning)", width: 50 }, low: { label: "Low", color: "var(--ink-2)", width: 20 } };
function causesOf(d: IssueDetail): Cause[] {
  const all = d.issue.diagnoses.flatMap((x) => x.causes ?? []);
  const seen = new Set<string>();
  return all.filter((c) => !seen.has(c.title) && seen.add(c.title)).slice(0, 3);
}
function fixesOf(d: IssueDetail): Fix[] {
  const fixes = d.issue.diagnoses.flatMap((x) => x.fixes ?? []);
  if (fixes.length) return [...fixes].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended)).slice(0, 3);
  // Older diagnoses: their hint is the fix.
  return d.issue.diagnoses.filter((x) => x.fix_hint).map((x) => ({ kind: x.category === "api_bug" ? "report_api_bug" : "change_test", title: "Suggested by the debugger", detail: x.fix_hint! }));
}
function notDiagnosed(d: IssueDetail) {
  if (d.issue.category === "known_bug") return "This is a known bug failing the same way as before, so the agents didn't investigate it again. Its evidence is in the request's description in Postman.";
  return d.run.status === "circuit_breaker"
    ? "The run stopped (circuit breaker) before the debugger recorded a finding for this failure. What it tried so far is below."
    : d.run.status === "server_issue" ? "The run stopped because of server problems before this failure was diagnosed."
    : "The debugger didn't record a finding for this failure.";
}

function CausesPanel({ d }: { d: IssueDetail }) {
  const causes = causesOf(d);
  const diag = d.issue.diagnoses;
  return (
    <Panel icon="sparkle" iconColor="var(--status-warning)" title="Likely cause" note={causes.length ? "ranked by the debugger" : undefined}>
      {causes.length ? (
        <ol className="divide-y divide-line">
          {causes.map((c, k) => {
            const l = LIKELY[c.likelihood] ?? LIKELY.low;
            return (
              <li key={k} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="font-semibold">{k + 1}. {c.title}</div>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: l.color, background: `color-mix(in srgb, ${l.color} 14%, transparent)` }}>{l.label} likelihood</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line"><div className="h-full" style={{ width: `${l.width}%`, background: l.color }} /></div>
                <p className="mt-2 text-sm text-ink-2">{c.explanation}</p>
                {(c.evidence_for?.length || c.evidence_against?.length) ? (
                  <ul className="mt-1.5 space-y-0.5 text-xs">
                    {c.evidence_for?.map((e, j) => <li key={`f${j}`} className="flex gap-1.5"><span className="w-2.5 font-bold text-good-ink" aria-label="supports">+</span><span className="text-ink-2">{e}</span></li>)}
                    {c.evidence_against?.map((e, j) => <li key={`a${j}`} className="flex gap-1.5"><span className="w-2.5 font-bold text-bad-ink" aria-label="argues against">−</span><span className="text-ink-2">{e}</span></li>)}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : diag.length ? (
        <div className="space-y-3 px-4 py-3 text-sm">
          {diag.map((x, k) => (
            <div key={k}><div className="font-medium">{x.assertion}: <span className="text-ink-2">{x.category.replace("_", " ")} ({x.confidence} confidence)</span></div><p className="mt-0.5 text-ink-2">{x.evidence}</p></div>
          ))}
        </div>
      ) : <p className="px-4 py-4 text-sm text-ink-2">{notDiagnosed(d)}</p>}
    </Panel>
  );
}

const FIX_KIND: Record<Fix["kind"], string> = { report_api_bug: "Report as API bug", change_test: "Change the test", fix_environment: "Fix the environment", clarify_contract: "Clarify the contract" };
function FixPanel({ d, copy }: { d: IssueDetail; copy: (text: string, what: string) => void }) {
  const fixes = fixesOf(d);
  const [pick, setPick] = useState(0);
  const f = fixes[Math.min(pick, fixes.length - 1)];
  return (
    <Panel icon="gear" iconColor="var(--accent)" title={d.issue.category === "fixed" ? "What fixed it" : "Probable fix"} tone="var(--accent)">
      {d.issue.changes.length > 0 && (
        <div className="space-y-2 border-b border-line px-4 py-3">
          <Label>Changed by the self-healer</Label>
          {d.issue.changes.map((c, k) => <HealerChange key={k} text={c} />)}
        </div>
      )}
      {!f ? (
        d.issue.changes.length ? null : <p className="px-4 py-4 text-sm text-ink-2">{d.issue.diagnoses.length ? "The debugger didn't suggest a fix." : notDiagnosed(d).replace(" What it tried so far is below.", "")} Use the evidence below, or download the debug bundle to share it.</p>
      ) : (
        <div className="space-y-3 px-4 py-3">
          {fixes.length > 1 && (
            <div role="tablist" aria-label="Fix options" className="flex flex-wrap gap-1.5">
              {fixes.map((x, k) => (
                <button key={k} role="tab" aria-selected={k === pick} onClick={() => setPick(k)}
                  className={`rounded-full px-3 py-1 text-xs ring-1 ${k === pick ? "bg-accent/15 text-ink ring-accent" : "text-ink-2 ring-line hover:text-ink"}`}>{FIX_KIND[x.kind] ?? x.title}</button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {f.recommended && <span className="rounded-full px-2 py-0.5 font-medium text-warning" style={{ background: "color-mix(in srgb, var(--status-warning) 14%, transparent)" }}>Recommended</span>}
            {fixes.length === 1 && <span className="text-ink-2">{FIX_KIND[f.kind]}</span>}
          </div>
          <div className="font-semibold">{f.title}</div>
          {f.kind === "report_api_bug"
            ? <div className="rounded-lg bg-page p-3 ring-1 ring-line"><Label>Bug report draft</Label><p className="mt-1 whitespace-pre-line text-sm text-ink-2">{f.detail}</p></div>
            : <p className="whitespace-pre-line text-sm">{f.detail}</p>}
          {f.change && <DiffBlock lines={f.change.split("\n")} />}
          <div className="flex flex-wrap gap-2">
            {f.kind === "report_api_bug" && <Button icon="copy" onClick={() => copy(bugReport(d, f), "Bug report")}>Copy bug report</Button>}
            {f.change && <Button icon="copy" onClick={() => copy(f.change!, "Change")}>Copy change</Button>}
            {f.kind !== "report_api_bug" && !f.change && <Button icon="copy" onClick={() => copy(f.detail, "Fix")}>Copy</Button>}
          </div>
        </div>
      )}
      <p className="border-t border-line px-4 py-2 text-xs text-muted">Suggestions come from the debugger's probes{d.contract ? ", the contract" : ""} and the knowledge base. Nothing changes until someone acts on them.</p>
    </Panel>
  );
}
function bugReport(d: IssueDetail, f: Fix) {
  const x = d.issue.exchange;
  return [
    f.title, "", f.detail, "",
    x ? `Request: ${x.method} ${x.url}` : "", x ? `Response: ${x.error ? `no response (${x.error})` : x.status}` : "",
    `Failed check: ${d.issue.failed_assertions.map((a) => `${a.assertion} (${a.error})`).join("; ")}`,
    `Seen in run #${d.run.id} on ${d.run.environment_label}, ${dateTime(d.run.created_at)}.`,
  ].filter((l, k, all) => l || all[k - 1]).join("\n");
}

// ---- Request and response ----
function Exchange({ d }: { d: IssueDetail }) {
  const [tab, setTab] = useState<"body" | "headers" | "checks">("body");
  const x = d.issue.exchange;
  const headers = (h: Header[]) => (h.length ? h.map((v) => `${v.key}: ${v.value}`).join("\n") : "(none)");
  const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
  return (
    <Panel icon="refresh" title="Request and response" note={x ? `as sent in the run, ${new Date(x.at).toLocaleTimeString()}` : undefined}
      actions={x && <Segmented label="Show" value={tab} onChange={setTab} options={[{ value: "body", label: "Body" }, { value: "headers", label: "Headers" }, { value: "checks", label: "Checks" }]} />}>
      {!x ? <p className="px-4 py-4 text-sm text-ink-2">This run was recorded before request and response details were kept. Runs from now on have them.</p> : (<>
        <div className="grid lg:grid-cols-2">
          <div className="min-w-0 space-y-2 px-4 py-3">
            <Label>Request</Label>
            <div className="break-all font-mono text-xs"><span className="font-semibold" style={{ color: METHOD_COLOR[x.method] }}>{x.method}</span> {x.url}</div>
            <Code className="max-h-80">{tab === "body" ? (x.request_body ? pretty(x.request_body) : "(empty body)") : tab === "headers" ? headers(x.request_headers) : (d.issue.test_script || "(no test script)")}</Code>
            {tab === "checks" && d.issue.prerequest_script && <><Label>Pre-request script</Label><Code className="max-h-48">{d.issue.prerequest_script}</Code></>}
          </div>
          <div className="min-w-0 space-y-2 border-t border-line px-4 py-3 lg:border-l lg:border-t-0">
            <Label>Response</Label>
            <div className="font-mono text-xs">{x.error ? <span className="font-semibold text-bad-ink">No response: {x.error}</span> : <><span className="font-semibold" style={{ color: statusColor(x.status) }}>{x.status}</span> · {duration(x.response_time_ms)}{x.response_size != null ? ` · ${x.response_size} B` : ""}</>}</div>
            {tab === "checks" ? (
              <ul className="space-y-1 rounded-lg bg-page p-3 text-xs ring-1 ring-line">
                {x.assertions.map((a, k) => (
                  <li key={k} className="flex gap-2"><Icon name={a.error ? "x" : "check"} size={13} className={`mt-0.5 shrink-0 ${a.error ? "text-critical" : "text-good"}`} />
                    <span>{a.name}{a.error && <span className="block text-bad-ink">{a.error}</span>}</span></li>
                ))}
              </ul>
            ) : <Code className="max-h-80">{tab === "body" ? (x.body ? pretty(x.body) : "(empty body)") : headers(x.response_headers)}</Code>}
          </div>
        </div>
        <p className="border-t border-line px-4 py-2 text-xs text-muted">Secrets such as tokens and API keys are hidden before they are stored.</p>
      </>)}
    </Panel>
  );
}

function ProbeRow({ p }: { p: IssueDetail["issue"]["probes"][number] }) {
  const [open, setOpen] = useState(false);
  let shortUrl = p.url;
  try { const u = new URL(p.url); shortUrl = u.pathname + u.search; } catch { /* keep it */ }
  return (
    <li>
      <button className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="min-w-0 flex-1">
          <span className="block text-sm">{p.purpose ?? "Probe"}</span>
          <span className="block truncate font-mono text-xs text-ink-2"><span style={{ color: METHOD_COLOR[p.method] }}>{p.method}</span> {shortUrl}</span>
        </span>
        <span className="shrink-0 font-mono text-sm font-semibold" style={{ color: statusColor(p.status, p.error) }}>{p.error ? "none" : p.status}</span>
        <Icon name="chevron" className={`mt-0.5 shrink-0 text-muted transition ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 bg-page px-4 py-3 text-xs">
          {p.request_headers.length > 0 && <div><Label>Headers sent</Label><Code>{p.request_headers.map((h) => `${h.key}: ${h.value}`).join("\n")}</Code></div>}
          {p.request_body && <div><Label>Body sent</Label><Code>{p.request_body}</Code></div>}
          <div><Label>Response {p.response_time_ms != null ? `· ${duration(p.response_time_ms)}` : ""}</Label><Code className="max-h-48">{p.error ? `No response: ${p.error}` : p.response_body || "(empty)"}</Code></div>
        </div>
      )}
    </li>
  );
}

function ContextPanel({ d }: { d: IssueDetail }) {
  return (
    <Panel icon="file" title={d.run.contract_id ? "Contract and knowledge base" : "Knowledge base"}>
      <div className="space-y-4 px-4 py-3 text-sm">
        {d.contract && (
          <div>
            <div className="flex justify-between gap-2"><Label>Contract says</Label><Link to={`/contracts/${d.contract.contract_id}?gaps=${d.run.id}`} className="text-xs text-accent hover:underline">Open in contract</Link></div>
            {d.contract.excerpt ? <Code className="mt-1 max-h-72">{d.contract.excerpt}</Code>
              : <p className="mt-1 text-ink-2">{d.contract.key}{d.contract.summary ? `: ${d.contract.summary}` : ""}. Documented responses: {d.contract.responses.join(", ") || "none"}.</p>}
          </div>
        )}
        {d.gaps.map((g) => (
          <div key={g.key} className="flex gap-2 rounded-lg border p-3" style={{ background: "color-mix(in srgb, var(--warn-ink) 8%, transparent)", borderColor: "color-mix(in srgb, var(--warn-ink) 30%, transparent)" }}>
            <Icon name="alert" className="mt-0.5 shrink-0 text-warn-ink" />
            <div><strong className="font-semibold">Contract gap{g.intended ? " (marked as intended)" : ""}.</strong> <span className="text-ink-2">{g.text}</span></div>
          </div>
        ))}
        <div>
          <Label>Knowledge base</Label>
          {d.knowledge.length ? (
            <ul className="mt-1 space-y-2">{d.knowledge.map((k, i) => <li key={i}><div className="font-medium">{k.title}</div><p className="whitespace-pre-line text-xs text-ink-2">{k.text}</p></li>)}</ul>
          ) : <p className="mt-1 text-ink-2">Nothing about this endpoint yet. High-confidence findings are saved there for future runs.</p>}
        </div>
      </div>
    </Panel>
  );
}

function LogsPanel({ d }: { d: IssueDetail }) {
  const [view, setView] = useState<"steps" | "raw">("steps");
  const steps = d.logs.filter((e) => EVENT_LOOK[e.type]);
  const raw = d.logs.map((e) => `[${new Date(e.created_at).toLocaleTimeString()}] ${e.type === "log" ? e.data.line : `${e.type} ${JSON.stringify(e.data)}`}`);
  return (
    <Panel icon="list" title="Logs for this failure" note={`only lines about ${d.issue.case_id ?? "this request"}`}
      actions={<Segmented label="Log view" value={view} onChange={setView} options={[{ value: "steps", label: "Steps" }, { value: "raw", label: `Raw · ${raw.length}` }]} />}>
      {view === "steps" ? (
        steps.length ? <ol className="divide-y divide-line">{steps.map((e) => <ActivityRow key={e.seq} e={e} />)}</ol>
          : <p className="px-4 py-4 text-sm text-ink-2">No agent activity mentions this request.</p>
      ) : <pre className="max-h-96 overflow-auto rounded-b-xl bg-page p-3 font-mono text-xs text-ink-2">{raw.join("\n") || "No log lines."}</pre>}
    </Panel>
  );
}

