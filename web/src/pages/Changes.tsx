import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type HealerChange } from "../api.ts";
import { dateTime, relativeTime } from "../format.ts";
import { Card, EmptyState, ErrorNote, Icon, PageHeader, Spinner } from "../ui.tsx";
import { Segmented } from "./KnownBugs.tsx";

const OUTCOME: Record<HealerChange["outcome"], { label: string; icon: string; color: string; note: string }> = {
  kept: { label: "Kept", icon: "check", color: "var(--status-good)", note: "The next run showed the request passing, and nothing else broke." },
  reverted: { label: "Undone", icon: "x", color: "var(--status-critical)", note: "It didn't fix the request, or broke another one, so it was undone automatically." },
  unproven: { label: "Not proven", icon: "clock", color: "var(--status-neutral)", note: "The run ended before the change was checked, so it wasn't saved." },
};

const PART: Record<string, string> = { headers: "headers", body: "body", url: "URL", method: "method", test_script: "test script", prerequest_script: "pre-request script" };

export function ChangesPage() {
  const q = useQuery({ queryKey: ["changes"], queryFn: api.changes });
  const [filter, setFilter] = useState<"all" | HealerChange["outcome"]>("all");
  const changes = q.data ?? [];
  const shown = changes.filter((c) => filter === "all" || c.outcome === filter);
  const count = (o: HealerChange["outcome"]) => changes.filter((c) => c.outcome === o).length;

  return (
    <>
      <PageHeader title="AI changes" subtitle="Every change the self-healer made to a test, and what happened to it." />
      <div className="mb-4">
        <Segmented value={filter} onChange={setFilter} options={[
          { value: "all", label: "All", count: changes.length },
          { value: "kept", label: "Kept", count: count("kept") },
          { value: "reverted", label: "Undone", count: count("reverted") },
          { value: "unproven", label: "Not proven", count: count("unproven") },
        ]} />
      </div>
      <ErrorNote error={q.error} />
      {q.isPending ? <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div> : shown.length === 0 ? (
        <Card>
          <EmptyState icon="refresh" title="No changes yet">
            When an AI run finds a broken test, the self-healer fixes it with the smallest change; each one is listed here with its diff.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((c, i) => {
            const o = OUTCOME[c.outcome];
            return (
              <Card key={`${c.run_id}-${i}`}>
                <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3">
                  <div className="min-w-0">
                    <h2 className="font-medium">{c.request}</h2>
                    <p className="text-xs text-muted">
                      {c.collection.id ? <Link to={`/collections/${c.collection.id}`} className="hover:text-accent">{c.collection.name}</Link> : c.collection.name} · {c.environment} · changed its {PART[c.part] ?? c.part}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {c.approved_by_human && <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs text-ink-2"><Icon name="check" size={12} />Approved by you</span>}
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium text-ink" title={o.note}
                      style={{ background: `color-mix(in srgb, ${o.color} 16%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${o.color} 40%, transparent)` }}>
                      <span style={{ color: o.color }}><Icon name={o.icon} size={12} /></span>{o.label}
                    </span>
                  </div>
                </div>
                <p className="px-4 pt-2 text-sm text-ink-2">{c.reason}</p>
                {c.diff.length > 0 && (
                  <pre className="relative mx-4 mt-2 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-xs ring-1 ring-line">
                    {c.diff.map((l, j) => <div key={j} style={{ color: l.trimStart().startsWith("+") ? "var(--good-ink)" : l.trimStart().startsWith("-") ? "var(--bad-ink)" : undefined }}>{l}</div>)}
                  </pre>
                )}
                <div className="mt-3 flex flex-wrap gap-x-6 border-t border-line px-4 py-2 text-xs">
                  <span className="text-ink-2">{o.note}</span>
                  <span className="ml-auto text-muted" title={dateTime(c.at)}><Link to={`/runs/${c.run_id}`} className="text-accent hover:underline">Run #{c.run_id}</Link> · {relativeTime(c.at)}</span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
