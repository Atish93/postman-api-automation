import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type Dashboard } from "../api.ts";
import { PassRateChart, RunsPerDayChart } from "../charts.tsx";
import { money, percent, relativeTime } from "../format.ts";
import { Card, EmptyState, ErrorNote, Icon, KindBadge, PageHeader, Spinner, StatusBadge } from "../ui.tsx";

// A headline number. Values use proportional figures; the delta says what it's compared with.
function StatTile({ label, value, delta, note }: { label: string; value: string; delta?: { text: string; tone: "good" | "bad" | "neutral"; arrow?: "up" | "down" }; note?: string }) {
  const tone = delta?.tone === "good" ? "text-good-ink" : delta?.tone === "bad" ? "text-bad-ink" : "text-ink-2";
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
      {delta && (
        <div className={`mt-1 flex items-center gap-1 text-xs ${tone}`}>
          {delta.arrow && <span aria-hidden="true">{delta.arrow === "up" ? "▲" : "▼"}</span>}
          {delta.text}
        </div>
      )}
      {note && <div className="mt-1 text-xs text-muted">{note}</div>}
    </div>
  );
}

function tiles(d: Dashboard) {
  const tw = d.this_week, lw = d.last_week;
  const runDiff = tw.runs - lw.runs;
  const rateDiff = tw.pass_rate != null && lw.pass_rate != null ? Math.round((tw.pass_rate - lw.pass_rate) * 100) : null;
  const collections = new Set(d.known_bugs.map((b) => b.collection)).size;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Runs, last 7 days"
        value={String(tw.runs)}
        delta={{ text: runDiff === 0 ? "Same as the 7 days before" : `${runDiff > 0 ? "+" : ""}${runDiff} vs the 7 days before`, tone: "neutral" }}
      />
      <StatTile
        label="Pass rate, last 7 days"
        value={percent(tw.pass_rate)}
        delta={rateDiff == null ? { text: tw.pass_rate == null ? "No finished runs yet" : "No runs the 7 days before", tone: "neutral" }
          : { text: rateDiff === 0 ? "Same as the 7 days before" : `${rateDiff > 0 ? "+" : ""}${rateDiff} points vs the 7 days before`, tone: rateDiff > 0 ? "good" : rateDiff < 0 ? "bad" : "neutral", arrow: rateDiff > 0 ? "up" : rateDiff < 0 ? "down" : undefined }}
      />
      <StatTile label="Open known bugs" value={String(d.known_bugs.length)} note={d.known_bugs.length ? `In ${collections} collection${collections === 1 ? "" : "s"}` : "None failing in the latest runs"} />
      <StatTile label="AI cost, last 7 days" value={money(tw.ai_cost_usd) || "$0"} note={`${tw.ai_runs} AI run${tw.ai_runs === 1 ? "" : "s"} · ${money(lw.ai_cost_usd) || "$0"} the 7 days before`} />
    </div>
  );
}

function GettingStarted() {
  const steps = [
    { to: "/settings", icon: "key", title: "Connect Postman", text: "Save your Postman API key." },
    { to: "/collections", icon: "folder", title: "Add a collection", text: "Import one from Postman, or upload a file." },
    { to: "/environments", icon: "globe", title: "Create an environment", text: "Its base URL and variables, e.g. Test or Stg." },
    { to: "/collections", icon: "play", title: "Run it", text: "Plain (free) or with the AI agents." },
  ];
  return (
    <Card>
      <EmptyState icon="sparkle" title="No runs yet">Four steps to your first run:</EmptyState>
      <ol className="grid gap-3 px-4 pb-6 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Link to={s.to} className="flex h-full gap-3 rounded-lg border border-line bg-raised p-3 hover:border-accent">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-page text-xs font-semibold ring-1 ring-line">{i + 1}</span>
              <span><span className="block text-sm font-medium">{s.title}</span><span className="block text-xs text-ink-2">{s.text}</span></span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function DashboardPage() {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api.dashboard(30), refetchInterval: 15_000 });
  if (q.isPending) return <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div>;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  const anyRuns = d.latest_runs.length > 0;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Runs across all collections and environments." />
      {!anyRuns ? <GettingStarted /> : (
        <div className="space-y-4">
          {tiles(d)}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RunsPerDayChart daily={d.daily} />
            <PassRateChart daily={d.daily} />
          </div>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3" title="Latest runs" actions={<Link to="/runs" className="text-xs text-accent hover:underline">All runs</Link>}>
              <ul className="divide-y divide-line">
                {d.latest_runs.map((r) => (
                  <li key={r.id}>
                    <Link to={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised">
                      <span className="w-40 shrink-0 max-sm:w-auto"><StatusBadge status={r.status} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{r.collection}</span>
                        <span className="block text-xs text-muted">{r.environment} · {relativeTime(r.finished_at ?? r.created_at)}</span>
                      </span>
                      <KindBadge kind={r.kind} mode={r.ai_mode} />
                      <Icon name="chevron" className="text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="lg:col-span-2" title="Open known bugs" actions={<Link to="/known-bugs" className="text-xs text-accent hover:underline">All known bugs</Link>}>
              {d.known_bugs.length === 0 ? (
                <p className="px-4 py-6 text-sm text-ink-2">No known bugs are failing in the latest runs.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {d.known_bugs.map((b) => (
                    <li key={`${b.run_id}-${b.request}`}>
                      <Link to={`/runs/${b.run_id}`} className="flex gap-3 px-4 py-2.5 hover:bg-raised">
                        <Icon name="bug" className="mt-0.5 shrink-0 text-warning" />
                        <span className="min-w-0">
                          <span className="block text-sm">{b.request}</span>
                          <span className="block truncate text-xs text-muted">{b.collection} · {b.environment}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
