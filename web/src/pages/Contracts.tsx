// API contracts: a separate feature. Add a contract (OpenAPI/Swagger, a link, a Postman spec, or a
// PDF/Word/Markdown document); the Contract Analyst agent writes test cases for you to review; the team
// builds and checks a collection; you choose the Postman workspace and collection it goes to.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api, type ContractDetail, type Endpoint } from "../api.ts";
import { dateTime, money, relativeTime } from "../format.ts";
import { Button, Card, EmptyState, ErrorNote, Field, Icon, MethodBadge, Modal, PageHeader, Spinner, StatusBadge, inputClass, useToast } from "../ui.tsx";

const SOURCE: Record<string, string> = { file: "Uploaded", url: "From a link", postman: "From Postman" };
const formatLabel = (c: { format: string; spec_version: string | null }) =>
  c.format === "openapi" ? (c.spec_version === "2.0" ? "Swagger 2.0" : `OpenAPI ${c.spec_version}`) : "Document";

async function toBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function ContractsPage() {
  const q = useQuery({ queryKey: ["contracts"], queryFn: api.contracts });
  const [adding, setAdding] = useState(false);
  const add = <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add contract</Button>;
  return (
    <>
      <PageHeader title="Contracts" subtitle="Test an API against its contract: the Contract Analyst agent writes test cases for you to review, the team builds and checks them, and you choose where they go in Postman." actions={add} />
      <ErrorNote error={q.error} />
      {q.isPending ? <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div> : !q.data?.length ? (
        <Card><EmptyState icon="file" title="No contracts yet" action={add}>
          Add an OpenAPI or Swagger file, a link to one, a spec from Postman, or the API's documentation as PDF, Word, Markdown or text.
        </EmptyState></Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {q.data.map((c) => (
            <Link key={c.id} to={`/contracts/${c.id}`} className="rounded-xl border border-line bg-card p-4 hover:border-accent">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0"><span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-muted">{c.title}{c.api_version ? ` · v${c.api_version}` : ""}</span></span>
                {c.last_run && <StatusBadge status={c.last_run.status} />}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
                <span className="flex items-center gap-1"><Icon name="file" size={12} />{formatLabel(c)}</span>
                <span>{c.format === "openapi" || c.endpoint_count ? `${c.endpoint_count} endpoint${c.endpoint_count === 1 ? "" : "s"}` : "endpoints found by the agent"}</span>
                <span>{SOURCE[c.source_kind]}</span>
                {c.publications > 0 && <span className="flex items-center gap-1 text-good-ink"><Icon name="check" size={12} />in Postman</span>}
                <span className="text-muted">updated {relativeTime(c.updated_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <AddContractDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddContractDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"file" | "url" | "postman">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [ws, setWs] = useState("");
  const [spec, setSpec] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: open && tab === "postman" });
  const connected = !!settings.data?.postman.connected;
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, enabled: open && tab === "postman" && connected });
  const chosenWs = ws || workspaces.data?.[0]?.id || "";
  const specs = useQuery({ queryKey: ["postman-specs", chosenWs], queryFn: () => api.postmanSpecs(chosenWs), enabled: open && tab === "postman" && !!chosenWs });
  const chosenSpec = spec || specs.data?.[0]?.id || "";

  const add = useMutation({
    mutationFn: async () => {
      if (tab === "file") {
        if (file!.size > 10 * 1024 * 1024) throw new Error("The file is larger than 10 MB.");
        return api.uploadContract(file!.name, await toBase64(file!), name || undefined);
      }
      if (tab === "url") return api.contractFromUrl(url.trim(), name || undefined);
      return api.contractFromPostman(chosenWs, chosenSpec, name || undefined);
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["contracts"] });
      onClose();
      setFile(null); setUrl(""); setName("");
      navigate(`/contracts/${c.id}`);
    },
  });
  const ready = tab === "file" ? !!file : tab === "url" ? /^https?:\/\/\S+$/.test(url.trim()) : !!chosenSpec;
  const tabBtn = (t: typeof tab, label: string, icon: string) => (
    <button type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-card font-medium text-ink shadow-sm ring-1 ring-line" : "text-ink-2 hover:text-ink"}`}>
      <Icon name={icon} size={14} />{label}
    </button>
  );
  return (
    <Modal open={open} onClose={onClose} title="Add a contract"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={add.isPending} disabled={!ready} onClick={() => add.mutate()}>Add contract</Button></>}>
      <div className="space-y-4">
        <div role="tablist" className="inline-flex flex-wrap gap-1 rounded-lg bg-page p-1 ring-1 ring-line">
          {tabBtn("file", "Upload a file", "upload")}{tabBtn("url", "From a link", "globe")}{tabBtn("postman", "From Postman", "plug")}
        </div>
        {tab === "file" && (
          <div>
            <input ref={input} type="file" className="sr-only" aria-label="Choose a contract file"
              accept=".json,.yaml,.yml,.pdf,.docx,.md,.markdown,.txt,.html,.htm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button type="button" onClick={() => input.current?.click()}
              className="flex w-full flex-col items-center gap-1 rounded-lg border-2 border-dashed border-line px-4 py-6 text-sm text-ink-2 hover:border-accent hover:text-ink">
              <Icon name="upload" size={20} />
              {file ? <span className="font-medium text-ink">{file.name} <span className="font-normal text-muted">({Math.max(1, Math.round(file.size / 1024))} KB)</span></span> : "Choose a file"}
              <span className="text-xs text-muted">OpenAPI 3 or Swagger 2 (JSON or YAML), or documentation: PDF, Word (.docx), Markdown, text or HTML. Up to 10 MB.</span>
            </button>
          </div>
        )}
        {tab === "url" && (
          <Field label="Link to the contract" hint="A spec (openapi.json, swagger.yaml) or a documentation page or PDF. It can be fetched again later to see what changed.">
            <input className={`${inputClass} font-mono`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/openapi.json" />
          </Field>
        )}
        {tab === "postman" && (!connected ? (
          <p className="text-sm text-ink-2">Connect Postman in <Link to="/settings" className="text-accent hover:underline" onClick={onClose}>Settings</Link> first.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Workspace">
              <select className={inputClass} value={chosenWs} onChange={(e) => { setWs(e.target.value); setSpec(""); }}>{workspaces.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            </Field>
            <Field label="API spec" hint={specs.data?.length === 0 ? "This workspace has no specs in Postman's Spec Hub." : undefined}>
              <select className={inputClass} value={chosenSpec} onChange={(e) => setSpec(e.target.value)} disabled={!specs.data?.length}>
                {specs.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.type ? ` (${s.type})` : ""}</option>)}
              </select>
            </Field>
          </div>
        ))}
        <Field label="Name (optional)" hint="Defaults to the API's title."><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Payments API v2" /></Field>
        <ErrorNote error={add.error} />
      </div>
    </Modal>
  );
}

export function ContractPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["contracts", id], queryFn: () => api.contract(id) });
  const [selected, setSelected] = useState<Set<string> | null>(null); // null: all
  const [filter, setFilter] = useState("");
  const [generating, setGenerating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = useMutation({
    mutationFn: () => api.refreshContract(id),
    onSuccess: (r) => {
      qc.setQueryData(["contracts", id], r.contract);
      qc.invalidateQueries({ queryKey: ["contracts"] });
      toast("ok", r.changed ? "The contract changed: see what's different below" : "No changes since last time");
    },
    onError: (e) => toast("error", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteContract(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["contracts"] }); navigate("/contracts"); toast("ok", "Contract deleted. Its runs and what was published stay."); },
  });
  const c = q.data;
  const shown = useMemo(() => (c?.endpoints ?? []).filter((e) => !filter || `${e.key} ${e.summary ?? ""} ${e.tags.join(" ")}`.toLowerCase().includes(filter.toLowerCase())), [c, filter]);

  if (q.isPending) return <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div>;
  if (q.error || !c) return <ErrorNote error={q.error} />;
  const all = c.endpoints.map((e) => e.key);
  const isOn = (k: string) => (selected ? selected.has(k) : true);
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s ?? all); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const count = selected ? selected.size : all.length;
  const chosen = selected && selected.size < all.length ? [...selected] : undefined;

  return (
    <>
      <div className="mb-2 text-sm"><Link to="/contracts" className="text-ink-2 hover:text-ink">Contracts</Link></div>
      <PageHeader title={c.name}
        subtitle={<>{c.title}{c.api_version ? ` v${c.api_version}` : ""} · {formatLabel(c)} · {SOURCE[c.source_kind]}{c.source_kind === "url" ? <> (<span className="break-all font-mono text-xs">{c.source_ref}</span>)</> : c.filename ? ` (${c.filename})` : ""} · updated {relativeTime(c.updated_at)}</>}
        actions={<>
          {c.source_kind !== "file" && <Button icon="refresh" busy={refresh.isPending} onClick={() => refresh.mutate()}>Check for changes</Button>}
          <a href={api.contractSourceUrl(c.id)}><Button icon="download">Original</Button></a>
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>Delete</Button>
          <Button variant="primary" icon="sparkle" disabled={c.format === "openapi" && count === 0} onClick={() => setGenerating(true)}>Generate tests</Button>
        </>} />

      <div className="space-y-4">
        {c.last_changes && <ChangesNote ch={c.last_changes} />}
        {c.warnings.length > 0 && (
          <div className="rounded-xl border border-line bg-card px-4 py-3 text-sm">
            {c.warnings.map((w, i) => <p key={i} className="flex gap-2"><Icon name="alert" className="mt-0.5 shrink-0 text-warn-ink" />{w}</p>)}
          </div>
        )}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            {c.format === "document" ? <DocumentCard c={c} /> : (
              <Card title={<span>Endpoints <span className="font-normal text-muted">· {count} of {all.length} chosen for testing</span></span>}
                actions={<button className="text-xs text-accent hover:underline" onClick={() => setSelected(count === all.length ? new Set() : null)}>{count === all.length ? "Choose none" : "Choose all"}</button>}>
                {all.length > 8 && <div className="px-4 pt-3"><input className={inputClass} aria-label="Filter endpoints" placeholder="Filter by path, summary or tag" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>}
                <ul className="divide-y divide-line">
                  {shown.map((e) => <EndpointRow key={e.key} e={e} on={isOn(e.key)} toggle={() => toggle(e.key)} />)}
                </ul>
              </Card>
            )}
          </div>
          <div className="space-y-4 lg:col-span-2">
            <Card title="Test runs">
              {c.runs.length === 0 ? <p className="px-4 py-4 text-sm text-ink-2">None yet. <strong>Generate tests</strong> starts one: you'll review the test cases before anything is built.</p> : (
                <ul className="divide-y divide-line">
                  {c.runs.map((r) => (
                    <li key={r.id}><Link to={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-raised">
                      <StatusBadge status={r.status} /><span className="min-w-0 flex-1 truncate">#{r.id} on {r.environment_label}</span>
                      <span className="text-xs text-muted">{r.cost_usd != null ? `${money(r.cost_usd)} · ` : ""}{relativeTime(r.created_at)}</span>
                    </Link></li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="In Postman">
              {c.published.length === 0 ? <p className="px-4 py-4 text-sm text-ink-2">Nothing yet. After a run passes, you choose the workspace and collection on the run's page.</p> : (
                <ul className="divide-y divide-line">
                  {c.published.map((p) => (
                    <li key={p.id} className="px-4 py-2.5 text-sm">
                      <div className="flex items-center gap-2"><Icon name="check" className="shrink-0 text-good" />
                        <span className="min-w-0 truncate">{p.workspace_name ?? p.workspace_id} → {p.collection_name}{p.folder_name ? ` → ${p.folder_name}` : ""}</span></div>
                      <div className="pl-6 text-xs text-muted">{p.requests} requests · {dateTime(p.published_at)}{p.run_id ? <> · <Link to={`/runs/${p.run_id}`} className="hover:text-accent">run #{p.run_id}</Link></> : ""}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>

      <GenerateDialog c={c} open={generating} onClose={() => setGenerating(false)} endpoints={chosen} count={count} />
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this contract?"
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" icon="trash" busy={remove.isPending} onClick={() => remove.mutate()}>Delete</Button></>}>
        <p className="text-sm text-ink-2">"{c.name}" is removed from the dashboard. Its runs stay in the history, and collections already in Postman aren't touched.</p>
      </Modal>
    </>
  );
}

function EndpointRow({ e, on, toggle }: { e: Endpoint; on: boolean; toggle: () => void }) {
  return (
    <li>
      <label className={`flex cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-raised ${on ? "" : "opacity-60"}`}>
        <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={on} onChange={toggle} aria-label={`Test ${e.key}`} />
        <MethodBadge method={e.method} />
        <span className="min-w-0 flex-1">
          <span className={`block break-all font-mono text-xs ${e.deprecated ? "line-through" : ""}`}>{e.path}</span>
          <span className="block truncate text-xs text-ink-2">{e.summary ?? <span className="text-muted">No summary</span>}</span>
        </span>
        <span className="flex shrink-0 flex-wrap justify-end gap-1">
          {e.secured && <span title="Needs authentication" className="text-muted"><Icon name="lock" size={13} /><span className="sr-only">needs authentication</span></span>}
          {e.responses.slice(0, 4).map((r) => <span key={r} className="rounded bg-raised px-1 font-mono text-[11px] text-ink-2 ring-1 ring-line">{r}</span>)}
        </span>
      </label>
    </li>
  );
}

function DocumentCard({ c }: { c: ContractDetail }) {
  return (
    <Card title="Document">
      <div className="space-y-3 p-4 text-sm">
        <p className="text-ink-2">The Contract Analyst reads the whole document ({(c.text_length ?? 0).toLocaleString("en")} characters) to find the endpoints, their rules and errors. {c.endpoints.length > 0 && "Endpoints it found last time:"}</p>
        {c.endpoints.length > 0 && (
          <ul className="space-y-1">{c.endpoints.map((e) => <li key={e.key} className="flex items-center gap-2"><MethodBadge method={e.method} /><span className="break-all font-mono text-xs">{e.path}</span><span className="truncate text-xs text-ink-2">{e.summary}</span></li>)}</ul>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-accent">Show the text that was read</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-raised p-3 text-xs ring-1 ring-line">{c.text_preview}{(c.text_length ?? 0) > (c.text_preview?.length ?? 0) && "\n…"}</pre>
        </details>
      </div>
    </Card>
  );
}

function ChangesNote({ ch }: { ch: NonNullable<ContractDetail["last_changes"]> }) {
  const none = !ch.added.length && !ch.removed.length && !ch.changed.length;
  return (
    <div className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--status-warning) 60%, transparent)", background: "color-mix(in srgb, var(--status-warning) 8%, var(--card))" }}>
      <p className="flex items-center gap-2 font-medium"><Icon name="alert" className="text-warn-ink" />The contract changed {ch.at ? relativeTime(ch.at) : ""}{ch.from_version !== ch.to_version && ch.to_version ? ` (v${ch.from_version ?? "?"} → v${ch.to_version})` : ""}. Generate the tests again to cover it.</p>
      {none ? <p className="mt-1 text-ink-2">{ch.text_changed ? "The document's text changed." : "Only details changed."}</p> : (
        <ul className="mt-2 space-y-0.5 text-xs">
          {ch.added.map((k) => <li key={k}><span className="text-good-ink">+ added</span> <span className="font-mono">{k}</span></li>)}
          {ch.removed.map((k) => <li key={k}><span className="text-bad-ink">− removed</span> <span className="font-mono">{k}</span></li>)}
          {ch.changed.map((x) => <li key={x.key}><span className="text-warn-ink">~ changed</span> <span className="font-mono">{x.key}</span>: {x.what.join(", ")}</li>)}
        </ul>
      )}
    </div>
  );
}

function GenerateDialog({ c, open, onClose, endpoints, count }: { c: ContractDetail; open: boolean; onClose: () => void; endpoints?: string[]; count: number }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments, enabled: open });
  const [envId, setEnvId] = useState<number | null>(null);
  const [focus, setFocus] = useState("");
  const chosenEnv = envId ?? envs.data?.[0]?.id ?? null;
  const env = envs.data?.find((e) => e.id === chosenEnv);
  const start = useMutation({
    mutationFn: () => api.startRun({ kind: "ai", ai_mode: "contract", contract_id: c.id, environment_id: chosenEnv!, ...(endpoints && { endpoints }), ...(focus.trim() && { request: focus.trim() }) }),
    onSuccess: (run) => { qc.invalidateQueries({ queryKey: ["runs"] }); qc.invalidateQueries({ queryKey: ["contracts"] }); onClose(); navigate(`/runs/${run.id}`); },
  });
  return (
    <Modal open={open} onClose={onClose} title={`Generate tests for "${c.name}"`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="sparkle" busy={start.isPending} disabled={!chosenEnv} onClick={() => start.mutate()}>Start</Button></>}>
      <div className="space-y-4">
        <ol className="space-y-1.5 text-sm text-ink-2">
          <li><strong className="text-ink">1. Analyse.</strong> The Contract Analyst reads {c.format === "openapi" ? `${count === c.endpoints.length ? "every endpoint" : `the ${count} chosen endpoint${count === 1 ? "" : "s"}`}` : "the document"} and writes test cases, each tied to what the contract says.</li>
          <li><strong className="text-ink">2. You review them.</strong> Keep, edit, remove or add cases, or send them back with feedback. Nothing is built before you approve.</li>
          <li><strong className="text-ink">3. Build and check.</strong> The builder writes a Postman collection and runs it on the environment; the debugger and self-healer fix test mistakes, and contract violations are marked as known bugs.</li>
          <li><strong className="text-ink">4. You choose where it goes.</strong> Nothing reaches Postman until you pick the workspace and collection and confirm.</li>
        </ol>
        {envs.data?.length === 0 ? <p className="text-sm">Create an <Link to="/environments/new" className="text-accent hover:underline" onClick={onClose}>environment</Link> for this API first.</p> : (
          <Field label="Environment to check the tests on" hint={env ? <>Requests go to <span className="font-mono">{env.base_url}</span>; credentials come from its variables.{c.servers[0] && !c.servers.some((s) => s.startsWith(env.base_url.replace(/\/$/, ""))) ? <> The contract names <span className="break-all font-mono">{c.servers[0]}</span>.</> : null}</> : undefined}>
            <select className={inputClass} value={chosenEnv ?? ""} onChange={(e) => setEnvId(Number(e.target.value))}>{envs.data?.map((e) => <option key={e.id} value={e.id}>{e.label} ({e.base_url})</option>)}</select>
          </Field>
        )}
        <Field label="Anything to focus on? (optional)" hint="e.g. 'Mostly error handling', 'Skip the admin endpoints', 'Use the sandbox card numbers from section 4'.">
          <textarea className={inputClass} rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} />
        </Field>
        <p className="text-xs text-muted">An AI run: usually well under a dollar for a small API; the cost is shown on the run.</p>
        <ErrorNote error={start.error} />
      </div>
    </Modal>
  );
}
