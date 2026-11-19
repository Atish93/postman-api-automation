import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, type AiCollectionResult, type Execution, type Run, type RunEvent } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import { dateTime, duration, money } from "../format.ts";
import { Button, Card, ErrorNote, Icon, KindBadge, Spinner, StatusBadge, inputClass, useToast } from "../ui.tsx";

const FINISHED = ["passed", "passed_with_known_bugs", "failed", "server_issue", "circuit_breaker", "error", "cancelled"];

// Follows a run's events live. Reads the server-sent event stream with fetch (so every event type
// arrives), stops when the run finishes, and resumes from the last event if the connection drops.
function useRunEvents(id: number, onFinished: () => void) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  useEffect(() => {
    let stopped = false;
    let last = 0;
    const controller = new AbortController();
    setEvents([]);
    (async () => {
      while (!stopped) {
        try {
          const res = await fetch(`/api/runs/${id}/events?after=${last}`, { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let cut: number;
            while ((cut = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, cut);
              buffer = buffer.slice(cut + 2);
              const data = block.split("\n").find((l) => l.startsWith("data: "));
              if (!data) continue;
              const ev: RunEvent = JSON.parse(data.slice(6));
              last = ev.seq;
              setEvents((es) => [...es, ev]);
              if (ev.type === "finished") { stopped = true; onFinished(); }
            }
          }
          stopped = true; // the server ends the stream when the run has finished
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 2000)); // connection dropped: try again from the last event
        }
      }
    })();
    return () => { stopped = true; controller.abort(); };
  }, [id]);
  return events;
}

// ---------- Approval ----------
function ApprovalCard({ run, request, answered }: { run: Run; request: RunEvent; answered: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [feedback, setFeedback] = useState("");
  const answer = useMutation({
    mutationFn: (text: string) => api.answerApproval(run.id, text),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", run.id] }),
    onError: (e) => toast("error", e.message),
  });
  const d = request.data;
  const isPlan = d.kind === "plan";
  if (answered || FINISHED.includes(run.status)) return null;
  return (
    <section className="rounded-xl border-2 p-4" style={{ borderColor: "var(--status-warning)", background: "color-mix(in srgb, var(--status-warning) 8%, var(--card))" }}>
      <h2 className="flex items-center gap-2 font-semibold"><Icon name="alert" className="text-warning" />The agents are waiting for your approval</h2>
      <p className="mt-1 text-sm text-ink-2">
        {isPlan ? "Review the test plan." : d.kind === "known_bugs_over_limit" ? `Mark ${d.requests?.length} requests as known bugs? That's more than the per-run limit.` : <>The self-healer wants to make a <strong>{d.kind}</strong> to <strong>{d.request}</strong>.</>}
      </p>
      {d.reason && <p className="mt-2 text-sm"><span className="text-ink-2">Reason: </span>{d.reason}</p>}
      {Array.isArray(d.diff) && (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-xs ring-1 ring-line">
          {d.diff.map((l: string, i: number) => (
            <div key={i} style={{ color: l.startsWith("+") ? "var(--good-ink)" : l.startsWith("-") ? "var(--bad-ink)" : undefined }}>{l}</div>
          ))}
        </pre>
      )}
      {d.plan && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-raised p-3 text-xs ring-1 ring-line">{d.plan}</pre>}
      {d.requests && <ul className="mt-2 list-disc pl-5 text-sm">{d.requests.map((r: string) => <li key={r}>{r}</li>)}</ul>}
      {isPlan && <textarea className={`${inputClass} mt-3`} rows={2} placeholder="What should change? (only needed to reject)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" icon="check" busy={answer.isPending && answer.variables === "y"} onClick={() => answer.mutate("y")}>Approve</Button>
        <Button icon="x" busy={answer.isPending && answer.variables !== "y"} disabled={isPlan && !feedback.trim()} onClick={() => answer.mutate(isPlan ? feedback.trim() : "no")}>{isPlan ? "Send back with changes" : "Refuse"}</Button>
      </div>
    </section>
  );
}

// ---------- Plain runs: one row per request ----------
function RequestRow({ e }: { e: Execution | (RunEvent["data"] & { request: string }) }) {
  const [open, setOpen] = useState(false);
  const failed: { name: string; error: string }[] = "assertions" in e && Array.isArray(e.assertions) ? e.assertions.filter((a: any) => a.error) : ((e as { failed_assertions?: { name: string; error: string }[] }).failed_assertions ?? []); // live records list only the failures
  const status = e.status as number | null;
  const tone = e.error || (status ?? 0) >= 500 ? "var(--status-serious)" : failed.length ? "var(--status-critical)" : "var(--status-good)";
  const label = e.error ? "No response" : failed.length ? `${failed.length} failed` : "Passed";
  return (
    <li>
      <button className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="flex w-24 shrink-0 items-center gap-1.5 text-xs">
          <span style={{ color: tone }}><Icon name={e.error || failed.length ? (status && status >= 500 ? "plug" : "x") : "check"} size={13} /></span>
          <span className="text-ink-2">{label}</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{e.request}</span>
        <span className="tabular shrink-0 font-mono text-xs text-ink-2">{status ?? "—"}</span>
        <span className="tabular w-16 shrink-0 text-right text-xs text-muted">{duration(e.response_time_ms)}</span>
        <Icon name="chevron" className={`shrink-0 text-muted transition ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 bg-page px-4 py-3 text-xs">
          {"url" in e && e.url && <div className="font-mono text-ink-2">{(e as Execution).method} {e.url}</div>}
          {e.error && <div className="text-bad-ink">{e.error}</div>}
          {"assertions" in e && Array.isArray(e.assertions) && (
            <ul className="space-y-1">
              {e.assertions.map((a: any, i: number) => (
                <li key={i} className="flex gap-2">
                  <Icon name={a.error ? "x" : "check"} size={13} className={`mt-0.5 shrink-0 ${a.error ? "text-critical" : "text-good"}`} />
                  <span>{a.name}{a.error && <span className="block text-bad-ink">{a.error}</span>}</span>
                </li>
              ))}
            </ul>
          )}
          {!("assertions" in e) && failed.map((a, i) => <div key={i}><span className="font-medium">{a.name}</span>: <span className="text-bad-ink">{a.error}</span></div>)}
          {"body" in e && e.body && <pre className="max-h-48 overflow-auto rounded bg-raised p-2 font-mono ring-1 ring-line">{e.body}</pre>}
        </div>
      )}
    </li>
  );
}

// ---------- AI runs: what the agents did ----------
const EVENT_LOOK: Record<string, { icon: string; color?: string }> = {
  agent_message: { icon: "sparkle", color: "var(--accent)" },
  agent_started: { icon: "play" },
  tool_call: { icon: "chevron" },
  collection_loaded: { icon: "folder" },
  collection_run: { icon: "list" },
  diagnosis: { icon: "bug", color: "var(--status-warning)" },
  change_pending: { icon: "refresh" },
  change_kept: { icon: "check", color: "var(--status-good)" },
  change_reverted: { icon: "x", color: "var(--status-critical)" },
  known_bugs_marked: { icon: "bug", color: "var(--status-warning)" },
  learned: { icon: "sparkle" },
  approval_request: { icon: "alert", color: "var(--status-warning)" },
  approval_answer: { icon: "check" },
  server_errors: { icon: "plug", color: "var(--status-serious)" },
  server_issue: { icon: "plug", color: "var(--status-serious)" },
  circuit_breaker: { icon: "pause", color: "var(--status-serious)" },
  published: { icon: "upload", color: "var(--status-good)" },
  collection_imported: { icon: "folder", color: "var(--status-good)" },
  updated: { icon: "upload", color: "var(--status-good)" },
};

// One line of an agent message, without Markdown markers.
const plain = (t: string) => t.replace(/\*\*|`|^#+\s*/g, "");

function describe(e: RunEvent): React.ReactNode {
  const d = e.data;
  switch (e.type) {
    case "agent_message": return <><span className="font-medium capitalize">{d.agent}</span>: <span className="text-ink-2">{plain(String(d.text).split("\n")[0]).slice(0, 220)}</span></>;
    case "agent_started": return <><span className="font-medium capitalize">{d.agent}</span> started the <span className="font-medium">{d.target}</span></>;
    case "tool_call": return <><span className="capitalize">{d.agent}</span> <span className="text-ink-2">used</span> <span className="font-mono text-xs">{d.target}</span></>;
    case "collection_loaded": return <>Loaded <span className="font-medium">{d.name}</span></>;
    case "collection_run": return <>Ran the collection: {d.requests} requests, <span className="font-medium">{d.failed_assertions} failed check{d.failed_assertions === 1 ? "" : "s"}</span></>;
    case "diagnosis": return <>Diagnosed <span className="font-medium">{d.request}</span> as <span className="font-medium">{String(d.category).replace("_", " ")}</span> ({d.confidence} confidence)</>;
    case "change_pending": return <>Changed {d.part} of <span className="font-medium">{d.request}</span>{d.approved_by_human ? " (approved by you)" : ""}</>;
    case "change_kept": return <>Kept the change to <span className="font-medium">{d.request}</span>: it now passes</>;
    case "change_reverted": return <>Undid the change to <span className="font-medium">{d.request}</span>: it didn't fix the test</>;
    case "known_bugs_marked": return <>Marked as known bugs: {(d.requests ?? []).join(", ")}</>;
    case "learned": return <>Saved to the knowledge base: <span className="text-ink-2">{d.title}</span></>;
    case "approval_request": return <>Asked for approval{d.request ? ` (${d.request})` : ""}</>;
    case "approval_answer": return <>Your answer: <span className="font-medium">{d.answer === "y" ? "approved" : d.answer ?? "no answer"}</span></>;
    case "server_errors": return <>{d.summary}</>;
    case "server_issue": return <span className="font-medium">{d.message}</span>;
    case "circuit_breaker": return <>Circuit breaker tripped: {d.requests_needing_diagnosis} requests failing (trips at {d.trips_at})</>;
    case "published": return <>Published <span className="font-medium">{d.name}</span> to Postman</>;
    case "updated": return <>Saved the collection back to Postman</>;
    case "collection_imported": return <>Added <Link to={`/collections/${d.collection_id}`} className="font-medium text-accent hover:underline">{d.name}</Link> to your collections</>;
    default: return null;
  }
}

function AiResult({ c }: { c: AiCollectionResult }) {
  return (
    <Card title={c.name}>
      <div className="grid gap-4 p-4 text-sm md:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-muted">Result</div>
          <div className="mt-1">{c.requests} requests, {c.failed_assertions} of {c.assertions} checks failed{c.updated ? " · saved to Postman" : c.published ? " · published to Postman" : ""}</div>
          {c.known_bugs.length > 0 && (<>
            <div className="mt-3 text-xs font-medium text-muted">Known bugs</div>
            <ul className="mt-1 space-y-1">{c.known_bugs.map((b) => <li key={b} className="flex gap-2"><Icon name="bug" className="mt-0.5 shrink-0 text-warning" />{b.replace("KNOWN BUG - ", "")}</li>)}</ul>
          </>)}
          {c.known_bugs_now_passing.length > 0 && <p className="mt-2 text-xs text-ink-2">Now passing, may be fixed: {c.known_bugs_now_passing.join(", ")}</p>}
        </div>
        <div>
          <div className="text-xs font-medium text-muted">Diagnoses</div>
          {c.diagnoses.length === 0 ? <p className="mt-1 text-ink-2">None needed.</p> : (
            <ul className="mt-1 space-y-2">{c.diagnoses.map((d, i) => <li key={i}><span className="font-medium">{d.request}</span> <span className="text-ink-2">· {d.category.replace("_", " ")} ({d.confidence})</span><div className="text-xs text-ink-2">{d.evidence}</div></li>)}</ul>
          )}
          {c.changes.length > 0 && (<>
            <div className="mt-3 text-xs font-medium text-muted">Changes by the self-healer</div>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-raised p-2 font-mono text-xs ring-1 ring-line">{c.changes.join("\n\n")}</pre>
          </>)}
        </div>
      </div>
    </Card>
  );
}

// ---------- The page ----------
export function RunPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const toast = useToast();
  const run = useQuery({ queryKey: ["runs", id], queryFn: () => api.run(id) });
  const events = useRunEvents(id, () => { qc.invalidateQueries({ queryKey: ["runs"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); });
  const [showLog, setShowLog] = useState(false);
  const cancel = useMutation({ mutationFn: () => api.cancelRun(id), onError: (e) => toast("error", e.message) });

  const latestStatus = [...events].reverse().find((e) => e.type === "status" || e.type === "finished")?.data.status;
  const pendingApproval = useMemo(() => {
    const req = [...events].reverse().find((e) => e.type === "approval_request");
    if (!req) return null;
    return { req, answered: events.some((e) => e.type === "approval_answer" && e.data.id === req.data.id) };
  }, [events]);

  if (run.isPending) return <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div>;
  if (run.error) return <ErrorNote error={run.error} />;
  const r: Run = { ...run.data, status: FINISHED.includes(run.data.status) ? run.data.status : (latestStatus ?? run.data.status) };
  const going = !FINISHED.includes(r.status);
  const result = r.result;
  const executions = result && "executions" in result ? result.executions : null;
  const live = events.filter((e) => e.type === "request_done").map((e) => ({ ...e.data, request: e.data.request as string }));
  const activity = events.filter((e) => EVENT_LOOK[e.type]);
  const log = events.filter((e) => e.type === "log");

  return (
    <>
      <div className="mb-2 text-sm"><Link to="/runs" className="text-ink-2 hover:text-ink">Runs</Link></div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">Run #{r.id}</h1>
            <StatusBadge status={r.status} /><KindBadge kind={r.kind} mode={r.ai_mode} />
          </div>
          <p className="mt-1 text-sm text-ink-2">
            {r.collection.id ? <Link to={`/collections/${r.collection.id}`} className="hover:text-accent">{r.collection.name}</Link> : r.collection.name}
            {" "}on {r.environment.label} · started {dateTime(r.started_at ?? r.created_at)}
            {r.duration_ms != null && ` · took ${duration(r.duration_ms)}`}{r.kind === "ai" && r.cost_usd != null && ` · AI cost ${money(r.cost_usd)}`}
          </p>
        </div>
        {going && (r.kind === "ai" || r.status === "queued") && <Button variant="danger" icon="ban" busy={cancel.isPending} onClick={() => cancel.mutate()}>Cancel run</Button>}
      </div>

      <div className="space-y-4">
        {r.ai_mode === "build" && r.request && (
          <div className="rounded-xl border border-line bg-card px-4 py-3">
            <div className="text-xs font-medium text-muted">What to test</div>
            <p className="mt-1 text-sm">{r.request}</p>
            {!going && !r.collection.id && r.status !== "cancelled" && <p className="mt-2 text-xs text-ink-2">No collection was published from this run.</p>}
          </div>
        )}
        {r.message && (
          <div className="flex items-start gap-2 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--status-serious) 50%, transparent)", background: "color-mix(in srgb, var(--status-serious) 9%, var(--card))" }}>
            <Icon name={r.status === "circuit_breaker" ? "pause" : "plug"} className="mt-0.5 shrink-0 text-serious" /><span className="font-medium">{r.message}</span>
          </div>
        )}
        {pendingApproval && <ApprovalCard run={r} request={pendingApproval.req} answered={pendingApproval.answered} />}

        {r.assertions != null && (
          <div className="grid grid-cols-3 gap-3">
            {[["Requests", r.requests], ["Checks", r.assertions], ["Failed checks", r.failed_assertions]].map(([label, value]) => (
              <div key={label as string} className="rounded-xl border border-line bg-card px-4 py-3"><div className="text-sm text-ink-2">{label}</div><div className="mt-1 text-2xl font-semibold">{value}</div></div>
            ))}
          </div>
        )}

        {r.kind === "plain" ? (
          <Card title={going ? <span className="flex items-center gap-2">Requests <Spinner size={12} /></span> : "Requests"}>
            {(executions ?? live).length === 0 ? <p className="px-4 py-6 text-sm text-ink-2">{going ? "Waiting for the first request…" : "No requests ran."}</p> : (
              <ul className="divide-y divide-line">{(executions ?? live).map((e, i) => <RequestRow key={i} e={e as any} />)}</ul>
            )}
          </Card>
        ) : (
          <>
            {result && "collections" in result && result.report && <Card title="Report from the agents"><div className="px-4 py-3"><Markdown text={result.report} /></div></Card>}
            {result && "collections" in result && result.collections.map((c, i) => <AiResult key={i} c={c} />)}
            <Card title={going ? <span className="flex items-center gap-2">What the agents are doing <Spinner size={12} /></span> : "What the agents did"}
              actions={log.length > 0 && <button className="text-xs text-accent hover:underline" onClick={() => setShowLog((v) => !v)}>{showLog ? "Hide full log" : `Full log (${log.length} lines)`}</button>}>
              {activity.length === 0 ? <p className="px-4 py-6 text-sm text-ink-2">{going ? "Starting the agents…" : "No activity recorded."}</p> : (
                <ol className="divide-y divide-line">
                  {activity.map((e) => (
                    <li key={e.seq} className="flex gap-3 px-4 py-2 text-sm">
                      <span className="mt-0.5 shrink-0" style={{ color: EVENT_LOOK[e.type].color ?? "var(--muted)" }}><Icon name={EVENT_LOOK[e.type].icon} size={14} /></span>
                      <span className="min-w-0 flex-1 break-words">{describe(e)}</span>
                      <span className="tabular shrink-0 text-xs text-muted">{new Date(e.created_at).toLocaleTimeString()}</span>
                    </li>
                  ))}
                </ol>
              )}
              {showLog && <pre className="max-h-96 overflow-auto border-t border-line bg-page p-3 font-mono text-xs text-ink-2">{log.map((e) => e.data.line).join("\n")}</pre>}
            </Card>
          </>
        )}
      </div>
    </>
  );
}
