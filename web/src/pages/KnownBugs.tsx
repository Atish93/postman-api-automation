import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type KnownBug } from "../api.ts";
import { dateTime, relativeTime } from "../format.ts";
import { Card, EmptyState, ErrorNote, Icon, PageHeader, Spinner } from "../ui.tsx";

type Filter = "open" | "may_be_fixed" | "all";

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[] }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg bg-page p-0.5 ring-1 ring-line" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-sm ${value === o.value ? "bg-raised font-medium text-ink shadow-sm ring-1 ring-line" : "text-ink-2 hover:text-ink"}`}>
          {o.label}{o.count != null && <span className="tabular ml-1.5 text-xs text-muted">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

function BugStatus({ status }: { status: KnownBug["status"] }) {
  const open = status === "open";
  const color = open ? "var(--status-warning)" : "var(--status-good)";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium text-ink"
      style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 40%, transparent)` }}>
      <span style={{ color }}><Icon name={open ? "bug" : "check"} size={12} /></span>{open ? "Open" : "May be fixed"}
    </span>
  );
}

export function KnownBugsPage() {
  const q = useQuery({ queryKey: ["known-bugs"], queryFn: api.knownBugs });
  const [filter, setFilter] = useState<Filter>("open");
  const bugs = q.data ?? [];
  const shown = bugs.filter((b) => filter === "all" || b.status === filter);
  const count = (s: KnownBug["status"]) => bugs.filter((b) => b.status === s).length;

  return (
    <>
      <PageHeader title="Known bugs" subtitle="API bugs the agents confirmed, kept as failing checks until the API is fixed." />
      <div className="mb-4">
        <Segmented value={filter} onChange={setFilter} options={[{ value: "open", label: "Open", count: count("open") }, { value: "may_be_fixed", label: "May be fixed", count: count("may_be_fixed") }, { value: "all", label: "All", count: bugs.length }]} />
      </div>
      <ErrorNote error={q.error} />
      {q.isPending ? <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div> : shown.length === 0 ? (
        <Card>
          <EmptyState icon="bug" title={filter === "may_be_fixed" ? "Nothing looks fixed yet" : "No known bugs"}>
            {filter === "may_be_fixed" ? "A known bug shows here when its check passes again; confirm the fix before removing the KNOWN BUG mark in Postman." : "When the debugger confirms an API bug in an AI run, the check is kept failing, its request is marked KNOWN BUG, and it's listed here."}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((b) => (
            <Card key={`${b.collection.id ?? b.collection.name}-${b.environment}-${b.request}`}>
              <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3">
                <div className="min-w-0">
                  <h2 className="font-medium">{b.request}</h2>
                  <p className="text-xs text-muted">
                    {b.collection.id ? <Link to={`/collections/${b.collection.id}`} className="hover:text-accent">{b.collection.name}</Link> : b.collection.name} · {b.environment}
                  </p>
                </div>
                <BugStatus status={b.status} />
              </div>
              {b.evidence && <p className="px-4 pt-2 text-sm text-ink-2">{b.evidence}</p>}
              {b.status === "may_be_fixed" && <p className="px-4 pt-2 text-sm text-ink-2">Its check passed in the latest run. If the API was fixed, remove "KNOWN BUG - " from the request name in Postman.</p>}
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line px-4 py-2 text-xs">
                <div><dt className="inline text-muted">First seen </dt><dd className="inline" title={dateTime(b.first_seen.at)}>{relativeTime(b.first_seen.at)}</dd></div>
                <div><dt className="inline text-muted">Last failed </dt><dd className="inline" title={dateTime(b.last_failed.at)}><Link to={`/runs/${b.last_failed.run_id}`} className="text-accent hover:underline">{relativeTime(b.last_failed.at)}</Link></dd></div>
                <div><dt className="inline text-muted">Failed in </dt><dd className="tabular inline">{b.times_failed} run{b.times_failed === 1 ? "" : "s"}</dd></div>
                <div><dt className="inline text-muted">Latest run </dt><dd className="inline"><Link to={`/runs/${b.latest_run_id}`} className="text-accent hover:underline">#{b.latest_run_id}</Link></dd></div>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
