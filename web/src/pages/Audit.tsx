// The audit log: who did what, newest first.
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type AuditEntry } from "../api.ts";
import { dateTime, relativeTime } from "../format.ts";
import { Button, Card, EmptyState, ErrorNote, Field, Icon, PageHeader, Spinner, inputClass } from "../ui.tsx";

const GROUPS = [
  { value: "", label: "Everything" },
  { value: "auth.", label: "Logins and password" },
  { value: "run.", label: "Runs and approvals" },
  { value: "environment.", label: "Environments" },
  { value: "collection.", label: "Collections" },
  { value: "settings.", label: "Settings" },
  { value: "schedule.", label: "Schedules" },
  { value: "data_file.", label: "Test data" },
  { value: "backup.", label: "Backups" },
];
const ICON: Record<string, string> = { auth: "key", run: "play", environment: "globe", collection: "folder", settings: "gear", schedule: "clock", data_file: "table", backup: "download" };
const WHO: Record<AuditEntry["actor"], string> = { admin: "You", schedule: "A schedule", system: "The server", cli: "Command line" };
const tone = (a: string) => (/failed|refused/.test(a) ? "text-bad-ink" : /approved/.test(a) ? "text-good-ink" : "text-muted");

export function AuditPage() {
  const [action, setAction] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const log = useInfiniteQuery({
    queryKey: ["audit", action, search],
    queryFn: ({ pageParam }) => api.audit({ action, q: search, before_id: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].id : undefined),
  });
  const rows = log.data?.pages.flat() ?? [];
  const runId = (e: AuditEntry) => (typeof e.details?.run_id === "number" ? e.details.run_id : null);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Who changed what, and when: logins, settings, environments (which keys, never the values), runs and every AI approval." />
      <form className="mb-4 grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <Field label="Show">
          <select className={inputClass} value={action} onChange={(e) => setAction(e.target.value)}>{GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select>
        </Field>
        <Field label="Search"><input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Stg, apiToken, run #12" /></Field>
        <Button type="submit">Search</Button>
      </form>
      <ErrorNote error={log.error} />
      <Card>
        {log.isPending ? <div className="flex justify-center py-10 text-muted"><Spinner /></div> : rows.length === 0 ? (
          <EmptyState icon="list" title={search || action ? "Nothing matches" : "Nothing recorded yet"}>{search || action ? "Try another filter." : "Changes appear here as they happen."}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((e) => (
              <li key={e.id} className="flex gap-3 px-4 py-3">
                <Icon name={ICON[e.action.split(".")[0]] ?? "list"} className={`mt-0.5 shrink-0 ${tone(e.action)}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{e.summary}{runId(e) && <> · <Link to={`/runs/${runId(e)}`} className="text-accent hover:underline">open run</Link></>}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    <span title={dateTime(e.at)}>{relativeTime(e.at)}</span> · {WHO[e.actor]}{e.ip ? ` · ${e.ip}` : ""} · <span className="font-mono">{e.action}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {log.hasNextPage && <div className="border-t border-line p-3 text-center"><Button size="sm" busy={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>Show older</Button></div>}
      </Card>
    </>
  );
}
