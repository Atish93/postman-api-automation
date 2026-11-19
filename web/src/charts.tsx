// Dashboard charts. Rules followed (see the dataviz guidelines):
// - outcomes use the fixed status colours, always with an icon + label in the legend and tooltip
// - thin marks: bars at most 24px wide, 2px surface gap between stacked segments, 4px rounded top on
//   the top segment only (square at the baseline); a 2px line for the trend
// - one y-axis per chart; hairline grid; muted tick labels in tabular figures
// - every chart has a hover tooltip and a table view
import { useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Dashboard } from "./api.ts";
import { percent, shortDate } from "./format.ts";
import { Icon } from "./ui.tsx";

type Day = Dashboard["daily"][number];

// Bottom of the stack first.
export const OUTCOMES = [
  { key: "passed", label: "Passed", color: "var(--status-good)", icon: "check" },
  { key: "known_bugs", label: "Passed, known bugs", color: "var(--status-warning)", icon: "bug" },
  { key: "failed", label: "Failed", color: "var(--status-critical)", icon: "x" },
  { key: "server_issue", label: "Server issue", color: "var(--status-serious)", icon: "plug" },
  { key: "other", label: "Other (error, breaker)", color: "var(--status-neutral)", icon: "alert" },
] as const;

const axisTick = { fill: "var(--muted)", fontSize: 11, fontVariantNumeric: "tabular-nums" } as const;

function Legend({ items }: { items: { label: string; color: string; icon: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: i.color }} />
          <Icon name={i.icon} size={12} className="text-muted" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function TooltipBox({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-line bg-raised px-3 py-2 text-xs text-ink shadow-lg">{children}</div>;
}

function ChartFrame({ title, legend, table, children }: { title: string; legend?: ReactNode; table: ReactNode; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="rounded-xl border border-line bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button className="text-xs text-accent hover:underline" onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </header>
      {legend && <div className="px-4 pt-2">{legend}</div>}
      <div className="px-2 pb-3 pt-2">{asTable ? <div className="max-h-64 overflow-auto px-2">{table}</div> : children}</div>
    </section>
  );
}

// A stacked segment: rounded on top only if it is the top non-empty segment of its day.
function Segment(props: any) {
  const { x, y, width, height, fill, payload, dataKey } = props;
  if (!height || height <= 0) return null;
  const top = [...OUTCOMES].reverse().find((o) => (payload[o.key] ?? 0) > 0)?.key;
  const gap = 2; // surface gap between stacked segments
  const h = Math.max(height - gap, 1);
  const r = dataKey === top ? Math.min(4, width / 2, h) : 0;
  const yy = y + (dataKey === top ? 0 : gap);
  const path = r
    ? `M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + width - r} Q${x + width},${yy} ${x + width},${yy + r} V${yy + h} Z`
    : `M${x},${yy} H${x + width} V${yy + h} H${x} Z`;
  return <path d={path} style={{ fill }} />;
}

export function RunsPerDayChart({ daily }: { daily: Day[] }) {
  const table = (
    <table className="w-full text-xs">
      <thead className="text-left text-muted">
        <tr><th className="py-1 font-medium">Day</th>{OUTCOMES.map((o) => <th key={o.key} className="py-1 text-right font-medium">{o.label}</th>)}<th className="py-1 text-right font-medium">Total</th></tr>
      </thead>
      <tbody className="tabular">
        {[...daily].reverse().filter((d) => d.total).map((d) => (
          <tr key={d.date} className="border-t border-line">
            <td className="py-1">{shortDate(d.date)}</td>
            {OUTCOMES.map((o) => <td key={o.key} className="py-1 text-right">{d[o.key]}</td>)}
            <td className="py-1 text-right font-medium">{d.total}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartFrame title="Runs per day" legend={<Legend items={[...OUTCOMES]} />} table={table}>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap="22%" maxBarSize={24}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} axisLine={{ stroke: "var(--axis)" }} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} width={40} />
            <Tooltip
              cursor={{ fill: "var(--line)", opacity: 0.5 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as Day;
                return (
                  <TooltipBox>
                    <div className="mb-1 font-medium">{shortDate(d.date)}</div>
                    {d.total === 0 ? <div className="text-muted">No runs</div> : (
                      <>
                        {OUTCOMES.filter((o) => d[o.key] > 0).map((o) => (
                          <div key={o.key} className="flex items-center gap-1.5">
                            <span className="inline-block size-2 rounded-sm" style={{ background: o.color }} />
                            <span className="text-ink-2">{o.label}</span>
                            <span className="tabular ml-auto pl-3 font-medium">{d[o.key]}</span>
                          </div>
                        ))}
                        <div className="mt-1 border-t border-line pt-1 text-ink-2">{d.total} runs · {percent(d.pass_rate)} passed</div>
                      </>
                    )}
                  </TooltipBox>
                );
              }}
            />
            {OUTCOMES.map((o) => (
              <Bar key={o.key} dataKey={o.key} stackId="runs" fill={o.color} shape={<Segment />} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}

export function PassRateChart({ daily }: { daily: Day[] }) {
  const data = daily.map((d) => ({ ...d, rate: d.pass_rate == null ? null : Math.round(d.pass_rate * 1000) / 10 }));
  const table = (
    <table className="w-full text-xs">
      <thead className="text-left text-muted"><tr><th className="py-1 font-medium">Day</th><th className="py-1 text-right font-medium">Pass rate</th><th className="py-1 text-right font-medium">Runs</th></tr></thead>
      <tbody className="tabular">
        {[...daily].reverse().filter((d) => d.total).map((d) => (
          <tr key={d.date} className="border-t border-line"><td className="py-1">{shortDate(d.date)}</td><td className="py-1 text-right">{percent(d.pass_rate)}</td><td className="py-1 text-right">{d.total}</td></tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartFrame title="Pass rate per day" table={table}>
      <p className="px-2 text-xs text-muted">Runs that passed, including those whose only failures are known bugs. Days without runs are skipped.</p>
      <div className="mt-1 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -4 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} axisLine={{ stroke: "var(--axis)" }} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={axisTick} axisLine={false} tickLine={false} width={48} />
            <Tooltip
              cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as Day;
                return (
                  <TooltipBox>
                    <div className="mb-1 font-medium">{shortDate(d.date)}</div>
                    {d.total ? <div><span className="font-medium">{percent(d.pass_rate)}</span> <span className="text-ink-2">of {d.total} runs passed</span></div> : <div className="text-muted">No runs</div>}
                  </TooltipBox>
                );
              }}
            />
            <Line
              type="linear" dataKey="rate" connectNulls stroke="var(--accent)" strokeWidth={2} isAnimationActive={false}
              dot={{ r: 3, fill: "var(--accent)", stroke: "var(--card)", strokeWidth: 2 }}
              activeDot={{ r: 5, fill: "var(--accent)", stroke: "var(--card)", strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
