// Compare environments side by side, and copy variables between them.
// Secret values never reach the browser: the server compares and copies them.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { api, type CompareCell, type Comparison } from "../api.ts";
import { Button, Card, EmptyState, ErrorNote, Field, Icon, Modal, PageHeader, Spinner, inputClass, useToast } from "../ui.tsx";

type Status = Comparison["rows"][number]["status"];
const LOOK: Record<Status, { label: string; icon: string; color: string }> = {
  same: { label: "Same", icon: "equal", color: "var(--status-good)" },
  different: { label: "Different", icon: "x", color: "var(--status-critical)" },
  missing: { label: "Missing", icon: "minus", color: "var(--status-serious)" },
  unknown: { label: "Can't tell", icon: "alert", color: "var(--status-warning)" },
};
const StatusTag = ({ s }: { s: Status }) => (
  <span className="inline-flex items-center gap-1 text-xs text-ink-2"><span style={{ color: LOOK[s].color }}><Icon name={LOOK[s].icon} size={13} /></span>{LOOK[s].label}</span>
);

export function ComparePage() {
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments });
  const [params, setParams] = useSearchParams();
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [copy, setCopy] = useState<{ from?: number; to?: number; keys?: string[] } | null>(null);

  // Chosen environments live in the address (?ids=1,2), so a comparison can be bookmarked. Default: the first three.
  const all = envs.data ?? [];
  const fromUrl = (params.get("ids") ?? "").split(",").map(Number).filter((id) => all.some((e) => e.id === id));
  const ids = fromUrl.length ? fromUrl : all.slice(0, 3).map((e) => e.id);
  const toggle = (id: number) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setParams(next.length ? { ids: all.filter((e) => next.includes(e.id)).map((e) => e.id).join(",") } : {}, { replace: true });
  };
  const cmp = useQuery({ queryKey: ["compare", ids], queryFn: () => api.compareEnvironments(ids), enabled: ids.length >= 2 });
  const rows = (cmp.data?.rows ?? []).filter((r) => !onlyDiff || r.status !== "same");
  const settingDiff = (k: "base_url" | "health_path") => new Set(cmp.data?.environments.map((e) => e[k])).size > 1;

  if (envs.isPending) return <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div>;
  return (
    <>
      <div className="mb-2 text-sm"><Link to="/environments" className="text-ink-2 hover:text-ink">Environments</Link></div>
      <PageHeader title="Compare environments" subtitle="Every variable side by side. Secrets are compared on the server and never shown."
        actions={all.length >= 2 && <Button variant="primary" icon="copy" onClick={() => setCopy({ from: ids[0], to: ids[1] })}>Copy values</Button>} />
      <ErrorNote error={envs.error} />
      {all.length < 2 ? (
        <Card><EmptyState icon="columns" title="You need two environments to compare" action={<Link to="/environments/new"><Button variant="primary" icon="plus">New environment</Button></Link>}>Create Test, Stg and Prod to see where their values differ.</EmptyState></Card>
      ) : (
        <div className="space-y-4">
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">Environments to compare</legend>
            {all.map((e) => (
              <label key={e.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${ids.includes(e.id) ? "border-accent bg-raised" : "border-line"}`}>
                <input type="checkbox" className="accent-[var(--accent)]" checked={ids.includes(e.id)} onChange={() => toggle(e.id)} />{e.label}
              </label>
            ))}
          </fieldset>

          {ids.length < 2 ? <p className="text-sm text-ink-2">Choose at least two environments.</p> : cmp.error ? <ErrorNote error={cmp.error} /> : !cmp.data ? (
            <div className="flex justify-center py-10 text-muted"><Spinner /></div>
          ) : (
            <Card title={
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>Variables</span>
                {(["same", "different", "missing", "unknown"] as Status[]).filter((s) => cmp.data.counts[s]).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 text-xs font-normal"><StatusTag s={s} /><span className="tabular text-ink">{cmp.data.counts[s]}</span></span>
                ))}
              </span>
            } actions={<label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" className="accent-[var(--accent)]" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />Only differences</label>}>
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-sm">
                  <thead className="text-xs text-ink-2">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium">Variable</th>
                      {cmp.data.environments.map((e) => <th key={e.id} className="px-4 py-2 font-medium"><Link to={`/environments/${e.id}`} className="hover:text-accent">{e.label}</Link></th>)}
                      <th className="px-4 py-2"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {(["base_url", "health_path"] as const).filter((k) => !onlyDiff || settingDiff(k)).map((k) => (
                      <tr key={k} className="bg-page/50">
                        <td className="px-4 py-2 align-top"><div className="text-ink-2">{k === "base_url" ? "Base URL" : "Health check"}</div><StatusTag s={settingDiff(k) ? "different" : "same"} /></td>
                        {cmp.data.environments.map((e) => <td key={e.id} className="max-w-[18rem] truncate px-4 py-2 align-top font-mono text-xs" title={e[k]}>{e[k]}</td>)}
                        <td />
                      </tr>
                    ))}
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td className="px-4 py-2 align-top"><div className="font-mono text-xs">{r.key}</div><StatusTag s={r.status} /></td>
                        {r.cells.map((c, i) => <td key={i} className="max-w-[18rem] px-4 py-2 align-top"><Cell c={c} /></td>)}
                        <td className="px-4 py-2 text-right align-top">
                          {r.status !== "same" && (
                            <Button size="sm" variant="ghost" icon="copy" aria-label={`Copy ${r.key}`} onClick={() => {
                              const from = r.cells.findIndex((c) => c.present);
                              const to = r.cells.findIndex((c) => !c.present);
                              setCopy({ from: cmp.data.environments[from]?.id, to: cmp.data.environments[to >= 0 ? to : from === 0 ? 1 : 0]?.id, keys: [r.key] });
                            }} />
                          )}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={cmp.data.environments.length + 2} className="px-4 py-6 text-sm text-ink-2">{onlyDiff ? "No differences: every variable matches." : "None of these environments has variables."}</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
      {copy && <CopyDialog initial={copy} onClose={() => setCopy(null)} />}
    </>
  );
}

function Cell({ c }: { c: CompareCell }) {
  if (!c.present) return <span className="text-xs text-muted">not set</span>;
  if (c.secret) return <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-2"><Icon name="lock" size={12} className="text-muted" /><span className="sr-only">secret</span>{c.masked}</span>;
  return <span className="block truncate font-mono text-xs" title={c.value ?? ""}>{c.value === "" ? <span className="text-muted">(empty)</span> : c.value}</span>;
}

// Copy chosen variables from one environment to another. It previews what will change before anything is written.
function CopyDialog({ initial, onClose }: { initial: { from?: number; to?: number; keys?: string[] }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments });
  const all = envs.data ?? [];
  const [from, setFrom] = useState(initial.from ?? all[0]?.id ?? 0);
  const [to, setTo] = useState(initial.to ?? all.find((e) => e.id !== (initial.from ?? all[0]?.id))?.id ?? 0);
  const [keys, setKeys] = useState<string[]>(initial.keys ?? []);
  const [overwrite, setOverwrite] = useState(false);
  const source = all.find((e) => e.id === from);
  const sourceKeys = useMemo(() => source?.variables.map((v) => v.key) ?? [], [source]);
  useEffect(() => { setKeys((k) => k.filter((x) => sourceKeys.includes(x))); }, [sourceKeys]);

  const body = { source_id: from, keys, overwrite };
  const ready = from > 0 && to > 0 && from !== to && keys.length > 0;
  const preview = useQuery({ queryKey: ["copy-preview", body, to], queryFn: () => api.copyVariables(to, { ...body, dry_run: true }), enabled: ready, retry: false });
  const run = useMutation({
    mutationFn: () => api.copyVariables(to, { ...body, dry_run: false }),
    onSuccess: (r) => {
      const n = r.added.length + r.overwritten.length;
      toast("ok", `Copied ${n} value${n === 1 ? "" : "s"} to ${r.environment.label}`);
      qc.invalidateQueries({ queryKey: ["environments"] });
      qc.invalidateQueries({ queryKey: ["compare"] });
      onClose();
    },
  });
  const p = preview.data;
  const what = (k: string) =>
    !p ? null : p.added.includes(k) ? ["add", "var(--status-good)", "plus"] : p.overwritten.includes(k) ? ["replace", "var(--status-serious)", "refresh"]
      : p.skipped.includes(k) ? ["keep (differs)", "var(--muted)", "minus"] : p.unchanged.includes(k) ? ["already the same", "var(--muted)", "equal"] : null;
  const changes = p ? p.added.length + p.overwritten.length : 0;
  const target = all.find((e) => e.id === to);

  return (
    <Modal open onClose={onClose} title="Copy values between environments" wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="copy" busy={run.isPending} disabled={!ready || !changes} onClick={() => run.mutate()}>{!keys.length ? "Choose variables" : !p ? "Copy" : changes ? `Copy ${changes} value${changes === 1 ? "" : "s"} to ${target?.label}` : "Nothing to copy"}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From">
            <select className={inputClass} value={from} onChange={(e) => { const f = Number(e.target.value); setFrom(f); if (f === to) setTo(all.find((x) => x.id !== f)?.id ?? 0); }}>{all.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
          </Field>
          <Field label="To">
            <select className={inputClass} value={to} onChange={(e) => setTo(Number(e.target.value))}>{all.filter((e) => e.id !== from).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
          </Field>
        </div>
        <fieldset>
          <div className="mb-2 flex items-center justify-between gap-2">
            <legend className="text-sm font-medium">Variables to copy</legend>
            {sourceKeys.length > 0 && <button type="button" className="text-xs text-accent hover:underline" onClick={() => setKeys(keys.length === sourceKeys.length ? [] : sourceKeys)}>{keys.length === sourceKeys.length ? "Clear" : "Select all"}</button>}
          </div>
          {sourceKeys.length === 0 ? <p className="text-sm text-ink-2">{source?.label} has no variables.</p> : (
            <ul className="max-h-64 divide-y divide-line overflow-auto rounded-lg ring-1 ring-line">
              {source!.variables.map((v) => {
                const w = keys.includes(v.key) ? what(v.key) : null;
                return (
                  <li key={v.key}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-raised">
                      <input type="checkbox" className="accent-[var(--accent)]" checked={keys.includes(v.key)} onChange={(e) => setKeys((k) => (e.target.checked ? [...k, v.key] : k.filter((x) => x !== v.key)))} />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{v.key}{v.secret && <Icon name="lock" size={11} className="ml-1 inline text-muted" />}</span>
                      {w && <span className="flex shrink-0 items-center gap-1 text-xs text-ink-2"><span style={{ color: w[1] }}><Icon name={w[2]} size={12} /></span>{w[0]}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Replace values that already exist in {target?.label ?? "the target"}<span className="block text-xs text-ink-2">Off: only variables it doesn't have are added; different values are kept.</span></span>
        </label>
        {p && p.skipped.length > 0 && !overwrite && <p className="text-xs text-ink-2">{p.skipped.length} chosen variable{p.skipped.length === 1 ? " has" : "s have"} a different value in {target?.label} and will be kept.</p>}
        <p className="flex items-center gap-1.5 text-xs text-muted"><Icon name="lock" size={12} />Secrets are copied on the server and stay secret in {target?.label ?? "the target"}.</p>
        <ErrorNote error={preview.error ?? run.error} />
      </div>
    </Modal>
  );
}
