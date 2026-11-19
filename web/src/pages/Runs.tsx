import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { api, type Run, type RunStatus } from "../api.ts";
import { duration, money, relativeTime } from "../format.ts";
import { Button, Card, EmptyState, ErrorNote, KindBadge, PageHeader, STATUS, Spinner, StatusBadge, inputClass } from "../ui.tsx";

const PAGE = 25;
const COMPACT = 8; // the short list on a collection's page
const active = (runs: Run[] | undefined) => runs?.some((r) => r.status === "queued" || r.status === "running");

// The run history, newest first. Refreshes itself while any listed run is still going.
export function RunsTable({ filters, compact }: { filters: Record<string, string | number | undefined>; compact?: boolean }) {
  const q = useInfiniteQuery({
    queryKey: ["runs", filters],
    queryFn: ({ pageParam }) => api.runs({ ...filters, limit: compact ? COMPACT : PAGE, before_id: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (!compact && last.length === PAGE ? last[last.length - 1].id : undefined),
    refetchInterval: (query) => (active(query.state.data?.pages.flat()) ? 3000 : false),
  });
  const runs = q.data?.pages.flat();
  if (q.isPending) return <div className="flex justify-center py-10 text-muted"><Spinner /></div>;
  if (q.error) return <div className="p-4"><ErrorNote error={q.error} /></div>;
  if (!runs?.length) return <EmptyState icon="list" title="No runs yet">Start one from the Collections page.</EmptyState>;

  if (compact)
    return (
      <ul className="divide-y divide-line">
        {runs.map((r) => (
          <li key={r.id}>
            <Link to={`/runs/${r.id}`} className="flex items-center gap-2 px-4 py-2.5 hover:bg-raised">
              <StatusBadge status={r.status} />
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{r.environment.label} · {relativeTime(r.created_at)}</span>
              <KindBadge kind={r.kind} mode={r.ai_mode} />
            </Link>
          </li>
        ))}
        {runs.length === COMPACT && (
          <li className="p-2 text-center">
            <Link to={`/runs?${new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`} className="text-xs text-accent hover:underline">All runs</Link>
          </li>
        )}
      </ul>
    );

  return (
    <>
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Run</th><th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2 font-medium">Collection</th>
              <th className="px-4 py-2 font-medium">Environment</th><th className="px-4 py-2 font-medium">Kind</th><th className="px-4 py-2 text-right font-medium">Failed checks</th>
              <th className="px-4 py-2 text-right font-medium">Duration</th><th className="px-4 py-2 text-right font-medium">AI cost</th><th className="px-4 py-2 font-medium">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {runs.map((r) => (
              <tr key={r.id} className="hover:bg-raised">
                <td className="tabular px-4 py-2.5"><Link to={`/runs/${r.id}`} className="font-medium text-accent hover:underline">#{r.id}</Link></td>
                <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                <td className="max-w-56 truncate px-4 py-2.5">{r.collection.name}</td>
                <td className="px-4 py-2.5 text-ink-2">{r.environment.label}</td>
                <td className="px-4 py-2.5"><KindBadge kind={r.kind} mode={r.ai_mode} /></td>
                <td className="tabular px-4 py-2.5 text-right">{r.assertions == null ? "" : `${r.failed_assertions} of ${r.assertions}`}</td>
                <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink-2">{duration(r.duration_ms)}</td>
                <td className="tabular px-4 py-2.5 text-right text-ink-2">{r.kind === "ai" ? money(r.cost_usd) : ""}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-ink-2" title={r.created_at}>{relativeTime(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && <div className="border-t border-line p-2 text-center"><Button size="sm" variant="ghost" busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Show older runs</Button></div>}
    </>
  );
}

export function RunsPage() {
  const [params, setParams] = useSearchParams();
  const collections = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments });
  const filters = {
    collection_id: params.get("collection_id") ?? undefined,
    environment_id: params.get("environment_id") ?? undefined,
    status: params.get("status") ?? undefined,
    kind: params.get("kind") ?? undefined,
  };
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  const select = (k: keyof typeof filters, label: string, options: { value: string; label: string }[]) => (
    <label className="min-w-36 flex-1 sm:flex-none">
      <span className="sr-only">{label}</span>
      <select className={inputClass} value={filters[k] ?? ""} onChange={(e) => setFilter(k, e.target.value)}>
        <option value="">{label}: all</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
  return (
    <>
      <PageHeader title="Runs" subtitle="Every run, newest first." />
      <div className="mb-3 flex flex-wrap gap-2">
        {select("collection_id", "Collection", (collections.data ?? []).map((c) => ({ value: String(c.id), label: c.name })))}
        {select("environment_id", "Environment", (envs.data ?? []).map((e) => ({ value: String(e.id), label: e.label })))}
        {select("status", "Status", (Object.keys(STATUS) as RunStatus[]).map((s) => ({ value: s, label: STATUS[s].label })))}
        {select("kind", "Kind", [{ value: "plain", label: "Plain" }, { value: "ai", label: "AI" }])}
      </div>
      <Card><RunsTable filters={filters} /></Card>
    </>
  );
}
