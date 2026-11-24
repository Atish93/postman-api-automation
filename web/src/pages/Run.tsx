import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, type Execution, type Run, type RunEvent } from "../api.ts";
import { CaseReview, PublishStatus } from "../ContractRun.tsx";
import { AgentReportCard, ExecutionLogs, FullReportPanel, GapsCard, OutcomeBar, StatTiles, TestCasesCard, aiResultOf } from "../RunParts.tsx";
import { dateTime, duration, money } from "../format.ts";
import { Button, Card, ErrorNote, Icon, KindBadge, Modal, Spinner, StatusBadge, inputClass, useToast } from "../ui.tsx";
import { relativeTime } from "../format.ts";

// Email this run's report now: to the collection's recipients, or to addresses typed here.
function EmailReportDialog({ run, open, onClose }: { run: Run; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rule = useQuery({ queryKey: ["report-rule", run.collection.id], queryFn: () => api.reportRule(run.collection.id!), enabled: open && !!run.collection.id });
  const [to, setTo] = useState("");
  useEffect(() => { if (open && rule.data) setTo(rule.data.recipients.join(", ")); }, [open, rule.data]);
  const send = useMutation({
    mutationFn: () => api.emailRun(run.id, to.split(/[\s,;]+/).filter(Boolean)),
    onSuccess: (r) => { toast("ok", `Report sent to ${r.recipients.join(", ")}`); qc.invalidateQueries({ queryKey: ["run-emails", run.id] }); onClose(); },
  });
  return (
    <Modal open={open} onClose={onClose} title="Email this report"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="upload" busy={send.isPending} disabled={!to.trim()} onClick={() => send.mutate()}>Send</Button></>}>
      <div className="space-y-3">
        <label className="block"><span className="mb-1 block text-sm font-medium">To</span>
          <input className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, another@example.com" /></label>
        <p className="text-xs text-ink-2">The email has a summary and a link to this run; the full report is attached.</p>
        <ErrorNote error={send.error} />
      </div>
    </Modal>
  );
}

function EmailsSent({ runId, going }: { runId: number; going: boolean }) {
  const q = useQuery({ queryKey: ["run-emails", runId], queryFn: () => api.runEmails(runId), refetchInterval: going ? 3000 : false });
  if (!q.data?.length) return null;
  return (
    <Card title="Emails">
      <ul className="divide-y divide-line">
        {q.data.map((e) => (
          <li key={e.id} className="flex gap-3 px-4 py-2.5 text-sm">
            <Icon name={e.status === "sent" ? "check" : "x"} className={`mt-0.5 shrink-0 ${e.status === "sent" ? "text-good" : "text-critical"}`} />
            <div className="min-w-0 flex-1">
              <div>{e.status === "sent" ? "Sent" : "Couldn't send"} to {e.recipients.join(", ")} <span className="text-muted">· {e.trigger === "rule" ? "by the collection's report rule" : "by you"}</span></div>
              {e.error && <div className="text-xs text-bad-ink">{e.error}</div>}
            </div>
            <span className="shrink-0 text-xs text-muted">{relativeTime(e.created_at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

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
  if (d.kind === "test_cases" && d.plan) return <CaseReview run={run} plan={d.plan} />;
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
function RowHeading({ row, items }: { row: number; items: any[] }) {
  const bad = items.filter((x) => x.error || (x.status ?? 0) >= 500 || (x.assertions ?? x.failed_assertions ?? []).some((a: any) => a.error)).length;
  return (
    <li className="flex items-center gap-2 bg-raised px-4 py-1.5 text-xs font-medium text-ink-2">
      <Icon name="table" size={12} />Row {row}
      <span className="font-normal text-muted">· {bad ? `${bad} of ${items.length} request${items.length === 1 ? "" : "s"} failed` : `${items.length} request${items.length === 1 ? "" : "s"} passed`}</span>
    </li>
  );
}

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
        {typeof e.iteration === "number" && <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-xs text-ink-2 ring-1 ring-line tabular">row {e.iteration}</span>}
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

export function RunPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const toast = useToast();
  const run = useQuery({ queryKey: ["runs", id], queryFn: () => api.run(id) });
  const events = useRunEvents(id, () => { qc.invalidateQueries({ queryKey: ["runs"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); });
  const [reportOpen, setReportOpen] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const cancel = useMutation({ mutationFn: () => api.cancelRun(id), onError: (e) => toast("error", e.message) });

  const emailEvents = events.filter((e) => e.type === "email_sent" || e.type === "email_failed").length;
  useEffect(() => {
    if (emailEvents) qc.invalidateQueries({ queryKey: ["run-emails", id] }); // the report was just emailed
  }, [emailEvents, id, qc]);
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
  const ai = aiResultOf(r);
  const issues = ai?.issues ?? [];

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
          {r.data_file && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted"><Icon name="table" size={12} />Test data: {r.data_file.name}{executions && "data_file" in (result as any) ? `, ${(result as any).data_file.rows} rows, once per row` : ""}{r.data_file.id === null && " (since deleted)"}</p>}
          {r.contract?.id && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted"><Icon name="file" size={12} /><span>From the contract <Link to={`/contracts/${r.contract.id}`} className="text-accent hover:underline">{r.collection.name.replace(/^Contract: /, "")}</Link>{r.contract.endpoints ? `, ${r.contract.endpoints.length} chosen endpoint${r.contract.endpoints.length === 1 ? "" : "s"}` : ""}</span></p>}
          {r.schedule_id && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted"><Icon name="clock" size={12} />Started by a <Link to="/schedules" className="text-accent hover:underline">schedule</Link>{r.kind === "ai" && ". Unattended: changes needing approval were refused"}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {going && (r.kind === "ai" || r.status === "queued") && <Button variant="danger" icon="ban" busy={cancel.isPending} onClick={() => cancel.mutate()}>Cancel run</Button>}
          {!going && <a href={api.reportUrl(r.id)} target="_blank" rel="noreferrer"><Button icon="list">Open report</Button></a>}
          {!going && <Button icon="upload" onClick={() => setEmailing(true)}>Email report</Button>}
        </div>
      </div>

      <div className="space-y-4">
        {r.ai_mode === "build" && r.request && (
          <div className="rounded-xl border border-line bg-card px-4 py-3">
            <div className="text-xs font-medium text-muted">What to test</div>
            <p className="mt-1 text-sm">{r.request}</p>
            {!going && !r.collection.id && r.status !== "cancelled" && <p className="mt-2 text-xs text-ink-2">No collection was published from this run.</p>}
          </div>
        )}
        {going && r.message && (
          <div className="flex items-start gap-2 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--status-serious) 50%, transparent)", background: "color-mix(in srgb, var(--status-serious) 9%, var(--card))" }}>
            <Icon name="plug" className="mt-0.5 shrink-0 text-serious" /><span className="font-medium">{r.message}</span>
          </div>
        )}
        {pendingApproval && <ApprovalCard run={r} request={pendingApproval.req} answered={pendingApproval.answered} />}
        {!going && <OutcomeBar run={r} publish={r.ai_mode === "contract" ? <PublishStatus run={r} /> : undefined} />}
        <StatTiles run={r} issues={issues} />
        <EmailsSent runId={r.id} going={going} />

        {r.kind === "plain" ? (
          <Card title={going ? <span className="flex items-center gap-2">Requests <Spinner size={12} /></span> : "Requests"}>
            {(executions ?? live).length === 0 ? <p className="px-4 py-6 text-sm text-ink-2">{going ? "Waiting for the first request…" : "No requests ran."}</p> : (
              <ul className="divide-y divide-line">{(executions ?? live).map((e: any, i, all: any[]) => (
                <Fragment key={i}>
                  {/* With a data file: a heading where each row's requests start, with how that row did. */}
                  {typeof e.iteration === "number" && e.iteration !== all[i - 1]?.iteration && <RowHeading row={e.iteration} items={all.filter((x) => x.iteration === e.iteration)} />}
                  <RequestRow e={e} />
                </Fragment>
              ))}</ul>
            )}
          </Card>
        ) : (
          <>
            {ai && (
              <div className={`grid items-stretch gap-4 ${r.ai_mode === "contract" ? "lg:grid-cols-2" : ""}`}>
                <AgentReportCard run={r} issues={issues} multi={ai.collections.length > 1 ? ai.collections.map((c) => c.name) : null} onOpenReport={() => setReportOpen(true)} />
                {r.ai_mode === "contract" && <GapsCard run={r} />}
              </div>
            )}
            {ai && <TestCasesCard run={r} />}
            <ExecutionLogs events={events} going={going} />
            {ai && <FullReportPanel run={r} issues={issues} events={events} open={reportOpen} onClose={() => setReportOpen(false)} onEmail={() => { setReportOpen(false); setEmailing(true); }} />}
          </>
        )}
      </div>
      <EmailReportDialog run={r} open={emailing} onClose={() => setEmailing(false)} />
    </>
  );
}
