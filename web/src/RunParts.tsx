// The AI run page's sections: the outcome bar, the numbers, the agent report and contract gaps side by
// side, the test cases with their results, the execution logs, and the full report panel.
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type AiCollectionResult, type ContractGap, type IssueCategory, type IssueSummary, type Run, type RunEvent } from "./api.ts";
import { EVENT_LOOK, describe } from "./events.tsx";
import { duration, money } from "./format.ts";
import { Markdown } from "./markdown.tsx";
import { Button, Drawer, FilterPills, Icon, Segmented, Spinner } from "./ui.tsx";

type AiResult = { collections: AiCollectionResult[]; report: string; issues?: IssueSummary[]; contract?: { plan: any; review_rounds: number } };
export const aiResultOf = (r: Run): AiResult | null => (r.result && "collections" in r.result ? (r.result as AiResult) : null);

// ---- Failure categories ----
export const CATEGORY: Record<IssueCategory, { label: string; plural: string; color: string }> = {
  unexplained: { label: "Unexplained", plural: "Unexplained", color: "var(--status-critical)" },
  api_bug: { label: "API bug", plural: "API bugs", color: "var(--status-warning)" },
  known_bug: { label: "Known bug", plural: "Known bugs", color: "var(--status-warning)" },
  test_defect: { label: "Test mistake", plural: "Test mistakes", color: "var(--status-serious)" },
  flaky: { label: "Flaky", plural: "Flaky", color: "var(--status-neutral)" },
  fixed: { label: "Fixed by self-healer", plural: "Fixed", color: "var(--status-good)" },
};
export function CategoryChip({ category }: { category: IssueCategory }) {
  const c = CATEGORY[category];
  return <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: c.color, background: `color-mix(in srgb, ${c.color} 14%, transparent)` }}>{c.label}</span>;
}
export const issueHref = (runId: number, i: { collection: number; request: string }) =>
  `/runs/${runId}/debug?collection=${i.collection}&request=${encodeURIComponent(i.request)}`;

function SectionCard({ icon, iconColor, title, note, actions, children, className = "" }: { icon: string; iconColor?: string; title: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-w-0 flex-col rounded-xl border border-line bg-card ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span style={{ color: iconColor ?? "var(--ink-2)" }}><Icon name={icon} /></span>
          <h2 className="font-semibold">{title}</h2>
          {note && <span className="text-sm text-ink-2">{note}</span>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

// ---- 1. Outcome: why the run ended as it did, next to whether it can go to Postman ----
const ENDED: Partial<Record<string, { text: string; tone: string; icon: string }>> = {
  passed: { text: "Every check passed.", tone: "var(--status-good)", icon: "check" },
  passed_with_known_bugs: { text: "Passed: the only failures are known bugs.", tone: "var(--status-good)", icon: "check" },
  failed: { text: "Some failures need attention.", tone: "var(--status-critical)", icon: "x" },
  circuit_breaker: { text: "Stopped early: circuit breaker tripped.", tone: "var(--status-serious)", icon: "pause" },
  server_issue: { text: "Stopped: the server had problems.", tone: "var(--status-serious)", icon: "plug" },
  error: { text: "The run ended with an error.", tone: "var(--status-critical)", icon: "alert" },
  cancelled: { text: "Cancelled.", tone: "var(--status-neutral)", icon: "ban" },
};
export function OutcomeBar({ run, publish }: { run: Run; publish?: ReactNode }) {
  const e = ENDED[run.status];
  if (!e) return null;
  const why = run.status === "circuit_breaker"
    ? "Too many requests were failing at once, so the agents stopped instead of diagnosing each one. This usually points to the environment, not the tests."
    : run.message;
  return (
    <section aria-label="Outcome" className="grid overflow-hidden rounded-xl border md:grid-cols-2"
      style={{ borderColor: `color-mix(in srgb, ${e.tone} 45%, transparent)`, background: `color-mix(in srgb, ${e.tone} 7%, var(--card))` }}>
      <div className={`flex gap-3 px-4 py-3 ${publish ? "" : "md:col-span-2"}`}>
        <span className="mt-0.5 shrink-0" style={{ color: e.tone }}><Icon name={e.icon} size={18} /></span>
        <div><div className="font-semibold">{e.text}</div>{why && <div className="text-sm text-ink-2">{why}</div>}</div>
      </div>
      {publish && <div className="border-t border-line bg-card px-4 py-3 md:border-l md:border-t-0">{publish}</div>}
    </section>
  );
}

// ---- 2. The numbers ----
export function StatTiles({ run, issues }: { run: Run; issues: IssueSummary[] }) {
  if (run.assertions == null) return null;
  const failed = run.failed_assertions ?? 0, total = run.assertions;
  const counts = new Map<IssueCategory, number>();
  for (const i of issues) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
  const breakdown = [...counts].map(([c, n]) => `${n} ${(n === 1 && c !== "fixed" ? CATEGORY[c].label : CATEGORY[c].plural).replace(/^(?!API)\w/, (ch) => ch.toLowerCase())}`).join(" · ");
  const cases = aiResultOf(run)?.contract?.plan?.cases?.length;
  const tile = (label: string, value: ReactNode, extra?: ReactNode) => (
    <div key={label} className="rounded-xl border border-line bg-card px-4 py-3">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular">{value}</div>
      {extra}
    </div>
  );
  return (
    <section aria-label="Run numbers" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      {tile("Checks passed", <>{total - failed} <span className="text-base font-normal text-ink-2">/ {total}</span></>,
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--status-critical) 30%, var(--line))" }}>
          <div style={{ width: `${total ? ((total - failed) / total) * 100 : 0}%`, background: "var(--status-good)" }} />
        </div>)}
      {tile("Failed checks", <span className={failed ? "text-bad-ink" : ""}>{failed}</span>, breakdown && <div className="mt-0.5 text-xs text-ink-2">{breakdown}</div>)}
      {tile(cases ? "Requests · Test cases" : "Requests", <>{run.requests ?? "–"}{cases ? <span className="text-base font-normal text-ink-2"> · {cases}</span> : null}</>)}
      {tile("Duration", run.duration_ms != null ? duration(run.duration_ms) : "–")}
      {tile("AI cost", run.cost_usd != null ? money(run.cost_usd) : "–")}
    </section>
  );
}

// ---- 3a. Agent report: one row per failure, with a way into its debug page ----
const FILTERS: { value: "all" | IssueCategory; label: string }[] = [
  { value: "all", label: "All" }, { value: "unexplained", label: "Unexplained" }, { value: "api_bug", label: "API bugs" },
  { value: "known_bug", label: "Known bugs" }, { value: "test_defect", label: "Test mistakes" }, { value: "flaky", label: "Flaky" }, { value: "fixed", label: "Fixed" },
];
export function AgentReportCard({ run, issues, multi, onOpenReport, className }: { run: Run; issues: IssueSummary[]; multi: string[] | null; onOpenReport: () => void; className?: string }) {
  const [filter, setFilter] = useState<"all" | IssueCategory>("all");
  const options = FILTERS.map((f) => ({ ...f, count: f.value === "all" ? issues.length : issues.filter((i) => i.category === f.value).length }))
    .filter((f) => f.value === "all" || f.count > 0);
  const shown = issues.filter((i) => filter === "all" || i.category === filter);
  return (
    <SectionCard className={className} icon="bug" iconColor="var(--status-critical)" title="Agent report" note="why checks failed"
      actions={<Button size="sm" variant="ghost" icon="columns" onClick={onOpenReport}>Full report</Button>}>
      {issues.length === 0 ? <p className="px-4 py-6 text-sm text-ink-2">No failures to explain{run.status === "passed" ? ": every check passed." : "."}</p> : (<>
        {options.length > 2 && <div className="px-4 pt-3"><FilterPills label="Filter failures" value={filter} onChange={setFilter} options={options} /></div>}
        <ul className="max-h-[32rem] flex-1 divide-y divide-line overflow-y-auto py-1">
          {shown.map((i) => (
            <li key={`${i.collection}:${i.request}`} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {i.case_id && <span className="font-mono text-xs text-muted">{i.case_id}</span>}
                  <span className="font-medium">{i.request.replace(/^KNOWN BUG - /, "").replace(/^TC\d+\s+/, "")}</span>
                  <CategoryChip category={i.category} />
                  {i.confidence && <span className="text-xs text-muted">{i.confidence} confidence</span>}
                  {multi && <span className="text-xs text-muted">· {multi[i.collection]}</span>}
                </div>
                {i.summary && <p className="mt-0.5 line-clamp-2 text-sm text-ink-2">{i.summary}</p>}
              </div>
              <Link to={issueHref(run.id, i)} aria-label={`${i.category === "fixed" ? "View fix for" : "Debug"} ${i.request}`}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${i.category === "fixed" ? "text-ink-2 ring-line hover:text-ink" : "bg-accent/15 text-ink ring-accent/50 hover:bg-accent/25"}`}>
                <Icon name={i.category === "fixed" ? "check" : "bug"} size={13} />{i.category === "fixed" ? "View fix" : "Debug"}
              </Link>
            </li>
          ))}
        </ul>
      </>)}
    </SectionCard>
  );
}

// ---- 3b. Contract gaps found by this run ----
export function GapsCard({ run, className }: { run: Run; className?: string }) {
  const contractId = run.contract?.id;
  const q = useQuery({ queryKey: ["contract-gaps", contractId, run.id], queryFn: () => api.contractGaps(contractId!, run.id), enabled: !!contractId });
  const open = (q.data?.gaps ?? []).filter((g) => !g.intended);
  return (
    <SectionCard className={className} icon="alert" iconColor="var(--warn-ink)" title="Contract gaps"
      note={q.data && <span className="rounded-full px-2 py-0.5 text-xs text-warn-ink" style={{ background: "color-mix(in srgb, var(--warn-ink) 14%, transparent)" }}>{open.length} not tested</span>}
      actions={contractId && <Link to={`/contracts/${contractId}?gaps=${run.id}`} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-accent ring-1 ring-line hover:underline">Open contract →</Link>}>
      {q.isPending ? <div className="flex justify-center py-8 text-muted"><Spinner /></div> : !open.length ? (
        <p className="px-4 py-6 text-sm text-ink-2">{q.data?.gaps.length ? "Every gap is marked as intended." : "The analyst found nothing silent or unclear in the parts it tested."}</p>
      ) : (<>
        <p className="px-4 pt-3 text-sm text-ink-2">Where the contract is silent or unclear. Clarify these to get them tested next run.</p>
        <ul className="max-h-[32rem] flex-1 divide-y divide-line overflow-y-auto py-1">
          {open.map((g) => <GapRow key={g.key} g={g} link={`/contracts/${contractId}?gaps=${run.id}#gap-${g.key}`} />)}
        </ul>
      </>)}
    </SectionCard>
  );
}
export function EndpointChips({ keys }: { keys: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {keys.map((k) => {
        const [m, ...p] = k.split(" ");
        return <code key={k} className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs ring-1 ring-line"><span className="font-semibold" style={{ color: METHOD_COLOR[m] }}>{m}</span> {p.join(" ")}</code>;
      })}
    </div>
  );
}
export const METHOD_COLOR: Record<string, string> = { GET: "var(--accent)", POST: "var(--status-good)", PUT: "var(--status-warning)", PATCH: "var(--status-warning)", DELETE: "var(--bad-ink)" };
function GapRow({ g, link }: { g: ContractGap; link: string }) {
  return (
    <li className="px-4 py-2.5">
      {g.endpoints.length > 0 && <EndpointChips keys={g.endpoints} />}
      <p className="mt-1 text-sm">{g.text}</p>
      <div className="mt-0.5 flex flex-wrap justify-between gap-2 text-xs">
        <span className="text-muted">{g.not_tested ? `Not tested: ${g.not_tested}` : ""}</span>
        <Link to={link} className="text-accent hover:underline">View in contract →</Link>
      </div>
    </li>
  );
}

// ---- 4. Test cases (contract runs: the approved plan; others: every request) with their results ----
type CaseRow = { id: string | null; type?: string; method?: string; endpoint?: string; title: string; expected?: string; result: "Passed" | "Failed" | "Known bug" | "Not run" | "–"; note?: string; issue?: IssueSummary };
const RESULT_LOOK: Record<CaseRow["result"], string> = { Passed: "var(--status-good)", Failed: "var(--status-critical)", "Known bug": "var(--status-warning)", "Not run": "var(--status-neutral)", "–": "var(--status-neutral)" };
const TYPE_COLOR: Record<string, string> = { positive: "var(--status-good)", negative: "var(--bad-ink)", security: "var(--status-serious)", edge: "var(--status-warning)" };

export function TestCasesCard({ run }: { run: Run }) {
  const res = aiResultOf(run);
  const plan = res?.contract?.plan;
  const issues = res?.issues ?? [];
  const execs = (res?.collections ?? []).flatMap((c, collection) => (c.executions ?? []).map((e) => ({ ...e, collection })));
  const haveExecs = (res?.collections ?? []).some((c) => c.executions);
  const outcome = (e: (typeof execs)[number] | undefined): Pick<CaseRow, "result" | "note"> => {
    if (!e) return { result: haveExecs ? "Not run" : "–" };
    const bad = e.failed > 0 || !!e.error;
    if (!bad) return { result: "Passed" };
    return { result: e.request.startsWith("KNOWN BUG - ") ? "Known bug" : "Failed", note: e.error ? "no response" : e.status ? `got ${e.status}` : undefined };
  };
  const rows: CaseRow[] = plan?.cases?.length
    ? plan.cases.map((c: any) => {
      const e = execs.find((x) => x.case_id === c.id);
      const [method, ...path] = String(c.endpoint ?? "").split(" ");
      return { id: c.id, type: c.type, method: path.length ? method : undefined, endpoint: path.join(" ") || c.endpoint, title: c.title, expected: c.expected, ...outcome(e),
        issue: issues.find((i) => i.case_id === c.id) };
    })
    : execs.map((e) => ({ id: e.case_id, method: e.method, title: e.request.replace(/^KNOWN BUG - /, ""), ...outcome(e), issue: issues.find((i) => i.collection === e.collection && i.request === e.request) }));
  const [filter, setFilter] = useState<"all" | "failed" | "passed" | "notrun">("all");
  if (!rows.length) return null;
  const is = (r: CaseRow, f: typeof filter) =>
    f === "all" || (f === "failed" && (r.result === "Failed" || r.result === "Known bug")) || (f === "passed" && r.result === "Passed") || (f === "notrun" && r.result === "Not run");
  const n = (f: typeof filter) => rows.filter((r) => is(r, f)).length;
  const shown = rows.filter((r) => is(r, filter));
  return (
    <SectionCard icon="check" iconColor="var(--accent)" title={plan ? "Test cases" : "Requests"}
      note={plan ? `${plan.cases.length}${(res?.contract?.review_rounds ?? 0) > 1 ? ` · approved after ${res!.contract!.review_rounds} reviews` : ""}` : `${rows.length}`}
      actions={haveExecs && <FilterPills label="Filter test cases" value={filter} onChange={setFilter}
        options={[{ value: "all", label: "All", count: rows.length }, { value: "failed", label: "Failed", count: n("failed") }, { value: "passed", label: "Passed", count: n("passed") }, { value: "notrun", label: "Not run", count: n("notrun") }]} />}>
      {plan && (plan.summary || plan.auth) && (
        <details className="group border-b border-line">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-ink-2 hover:text-ink">
            <Icon name="chevron" size={13} className="transition group-open:rotate-90" />About this suite: what it covers and how it authenticates
          </summary>
          <div className="grid gap-4 px-4 pb-4 pl-10 text-sm text-ink-2 md:grid-cols-2">
            {plan.summary && <div><div className="text-xs font-semibold uppercase tracking-wide text-muted">Coverage</div><p className="mt-1">{plan.summary}</p></div>}
            {plan.auth && <div><div className="text-xs font-semibold uppercase tracking-wide text-muted">Authentication</div><p className="mt-1">{plan.auth}</p></div>}
          </div>
        </details>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead><tr className="text-left text-xs text-muted">
            <th scope="col" className="px-4 py-2 font-medium">ID</th>
            {plan && <th scope="col" className="px-2 py-2 font-medium">Type</th>}
            <th scope="col" className="px-2 py-2 font-medium">{plan ? "Endpoint" : "Method"}</th>
            <th scope="col" className="px-2 py-2 font-medium">{plan ? "Case" : "Request"}</th>
            {plan && <th scope="col" className="px-2 py-2 font-medium">Expected</th>}
            <th scope="col" className="px-4 py-2 font-medium">Result</th>
          </tr></thead>
          <tbody className="divide-y divide-line border-t border-line">
            {shown.map((r, k) => (
              <tr key={`${r.id}-${k}`} className="align-top">
                <td className="px-4 py-2 font-mono text-xs text-muted">{r.id ?? ""}</td>
                {plan && <td className="px-2 py-2 text-xs font-medium" style={{ color: TYPE_COLOR[r.type ?? ""] ?? "var(--ink-2)" }}>{r.type}</td>}
                <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">{r.method && <span className="font-semibold" style={{ color: METHOD_COLOR[r.method] }}>{r.method}</span>} {r.endpoint}</td>
                <td className="px-2 py-2">{r.title}</td>
                {plan && <td className="px-2 py-2 text-ink-2">{r.expected}</td>}
                <td className="whitespace-nowrap px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: RESULT_LOOK[r.result], background: `color-mix(in srgb, ${RESULT_LOOK[r.result]} 14%, transparent)` }}>{r.result}</span>
                    {r.issue && (r.result === "Failed" || r.result === "Known bug") && <Link to={issueHref(run.id, r.issue)} className="text-xs font-medium text-accent hover:underline">Debug</Link>}
                  </div>
                  {r.note && <div className="mt-0.5 text-xs text-muted">{r.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!haveExecs && <p className="border-t border-line px-4 py-2 text-xs text-muted">Results per case are shown for runs from now on.</p>}
    </SectionCard>
  );
}

// ---- 5. Execution logs ----
export function ExecutionLogs({ events, going }: { events: RunEvent[]; going: boolean }) {
  const [view, setView] = useState<"activity" | "raw">("activity");
  const activity = events.filter((e) => EVENT_LOOK[e.type]).reverse(); // newest first
  const log = events.filter((e) => e.type === "log");
  return (
    <SectionCard icon="list" title={going ? <span className="flex items-center gap-2">Execution logs <Spinner size={12} /></span> : "Execution logs"}
      actions={<Segmented label="Log view" value={view} onChange={setView} options={[{ value: "activity", label: "Agent activity" }, { value: "raw", label: `Full log · ${log.length} lines` }]} />}>
      {view === "activity" ? (
        activity.length === 0 ? <p className="px-4 py-6 text-sm text-ink-2">{going ? "Starting the agents…" : "No activity recorded."}</p> : (
          <ol className="max-h-[28rem] divide-y divide-line overflow-y-auto">
            {activity.map((e) => <ActivityRow key={e.seq} e={e} />)}
          </ol>
        )
      ) : (
        <pre className="max-h-[28rem] overflow-auto rounded-b-xl bg-page p-3 font-mono text-xs text-ink-2">{log.length ? log.map((e) => e.data.line).join("\n") : "No log lines."}</pre>
      )}
    </SectionCard>
  );
}
export function ActivityRow({ e }: { e: RunEvent }) {
  return (
    <li className="flex gap-3 px-4 py-2 text-sm">
      <span className="tabular w-20 shrink-0 font-mono text-xs text-muted">{new Date(e.created_at).toLocaleTimeString()}</span>
      <span className="mt-0.5 shrink-0" style={{ color: EVENT_LOOK[e.type]?.color ?? "var(--muted)" }}><Icon name={EVENT_LOOK[e.type]?.icon ?? "chevron"} size={14} /></span>
      <span className="min-w-0 flex-1 break-words">{describe(e)}</span>
    </li>
  );
}

// ---- The full report: a panel over the run page ----
export function FullReportPanel({ run, issues, events, open, onClose, onEmail }: { run: Run; issues: IssueSummary[]; events: RunEvent[]; open: boolean; onClose: () => void; onEmail: () => void }) {
  const res = aiResultOf(run);
  const cols = res?.collections ?? [];
  const groups = (Object.keys(CATEGORY) as IssueCategory[]).map((c) => [c, issues.filter((i) => i.category === c)] as const).filter(([, xs]) => xs.length);
  const changes = cols.flatMap((c) => c.changes);
  const knownBugs = cols.flatMap((c) => c.known_bugs);
  const nowPassing = cols.flatMap((c) => c.known_bugs_now_passing);
  const learned = events.filter((e) => e.type === "learned");
  const h3 = "mb-2 text-xs font-semibold uppercase tracking-wide text-muted";
  return (
    <Drawer open={open} onClose={onClose} title="Full report" subtitle={`Run #${run.id} · ${run.environment.label}`}
      footer={<>
        <a href={api.reportUrl(run.id)} target="_blank" rel="noreferrer"><Button icon="file">Open as a document</Button></a>
        <Button icon="upload" onClick={onEmail}>Email report</Button>
      </>}>
      <div className="space-y-6">
        <section aria-label="Summary from the agents">
          <h3 className={h3}>Summary from the agents</h3>
          {res?.report ? <div className="text-sm"><Markdown text={res.report} /></div> : <p className="text-sm text-ink-2">The agents didn't write a summary for this run.</p>}
        </section>

        <section aria-label="Every diagnosis">
          <h3 className={h3}>Every failure · {issues.length}</h3>
          {issues.length === 0 ? <p className="text-sm text-ink-2">None.</p> : (
            <div className="space-y-3">
              {groups.map(([c, xs]) => (
                <div key={c} className="rounded-xl border border-line bg-card">
                  <div className="flex items-center gap-2 border-b border-line px-3 py-2"><CategoryChip category={c} /><span className="text-sm text-ink-2">{xs.length}</span></div>
                  <ul className="divide-y divide-line">
                    {xs.map((i) => (
                      <li key={`${i.collection}:${i.request}`} className="flex items-start gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1 text-sm">
                          <div><span className="font-medium">{i.request.replace(/^KNOWN BUG - /, "")}</span>{i.confidence && <span className="text-xs text-muted"> · {i.confidence}</span>}</div>
                          {i.summary && <p className="mt-0.5 text-ink-2">{i.summary}</p>}
                        </div>
                        <Link to={issueHref(run.id, i)} onClick={onClose} className="shrink-0 text-sm font-medium text-accent hover:underline">{c === "fixed" ? "View fix" : "Debug"}</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {changes.length > 0 && (
          <section aria-label="Changes by the self-healer">
            <h3 className={h3}>Changes by the self-healer · {changes.length}</h3>
            <div className="space-y-2">{changes.map((ch, k) => <HealerChange key={k} text={ch} />)}</div>
          </section>
        )}

        {(knownBugs.length > 0 || nowPassing.length > 0) && (
          <section aria-label="Known bugs" className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-line bg-card p-3">
              <h3 className={h3}>Known bugs still failing · {knownBugs.length}</h3>
              {knownBugs.length ? <ul className="list-disc space-y-0.5 pl-5 text-sm">{knownBugs.map((b) => <li key={b}>{b.replace("KNOWN BUG - ", "")}</li>)}</ul> : <p className="text-sm text-ink-2">None.</p>}
            </div>
            <div className="rounded-xl border border-line bg-card p-3">
              <h3 className={h3}>Now passing, may be fixed · {nowPassing.length}</h3>
              {nowPassing.length ? <><ul className="list-disc space-y-0.5 pl-5 text-sm">{nowPassing.map((b) => <li key={b}>{b.replace("KNOWN BUG - ", "")}</li>)}</ul><p className="mt-1 text-xs text-ink-2">A person should confirm and close the bug.</p></> : <p className="text-sm text-ink-2">None.</p>}
            </div>
          </section>
        )}

        {learned.length > 0 && (
          <section aria-label="Saved to the knowledge base">
            <h3 className={h3}>Saved to the knowledge base · {learned.length}</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-2">{learned.map((e) => <li key={e.seq}>{String(e.data.title ?? "")}</li>)}</ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}

// A healer change as recorded: "<request> (<part>): <reason>" then indented -/+ lines, maybe "(reverted)".
export function HealerChange({ text }: { text: string }) {
  const [head, ...lines] = text.split("\n");
  const reverted = lines.some((l) => l.trim() === "(reverted)");
  const m = head.match(/^(.*?) \((.*?)\): (.*)$/);
  return (
    <div className="rounded-xl border border-line bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{m?.[1] ?? head}</span>
        <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={reverted ? { color: "var(--bad-ink)", background: "color-mix(in srgb, var(--bad-ink) 14%, transparent)" } : { color: "var(--good-ink)", background: "color-mix(in srgb, var(--status-good) 14%, transparent)" }}>{reverted ? "Undone: didn't fix it" : "Kept"}</span>
      </div>
      {m && <p className="mt-1 text-sm text-ink-2"><span className="text-muted">{m[2]}:</span> {m[3]}</p>}
      <DiffBlock lines={lines.filter((l) => l.trim() !== "(reverted)")} />
    </div>
  );
}
export function DiffBlock({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg bg-page p-2 font-mono text-xs ring-1 ring-line">
      {lines.map((l, k) => {
        const t = l.replace(/^ {4}/, "");
        const color = t.startsWith("+") ? "var(--good-ink)" : t.startsWith("-") ? "var(--bad-ink)" : "var(--ink-2)";
        return <div key={k} style={{ color }}>{t || " "}</div>;
      })}
    </pre>
  );
}

