// Contract runs on the run page: reviewing the analyst's test cases (keep, edit, remove, add, or send
// back), what was approved, and adding the result to the Postman workspace and collection you choose.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type ContractCase, type ContractPlan, type Run } from "./api.ts";
import { dateTime } from "./format.ts";
import { Button, ErrorNote, Field, Icon, Modal, Spinner, inputClass, useToast } from "./ui.tsx";

const TYPES = ["setup", "positive", "negative", "security", "edge", "cleanup"];
const TYPE_COLOR: Record<string, string> = { positive: "var(--status-good)", negative: "var(--status-critical)", security: "var(--status-serious)", edge: "var(--status-warning)" };

type Row = ContractCase & { keep: boolean; added?: boolean };
const same = (a: ContractCase, b: ContractCase) => a.title === b.title && a.expected === b.expected && a.type === b.type && (a.endpoint ?? "") === (b.endpoint ?? "") && (a.request ?? "") === (b.request ?? "");

function PlanFacts({ plan }: { plan: ContractPlan }) {
  return (
    <div className="space-y-2 text-sm">
      {plan.summary && <p>{plan.summary}</p>}
      {plan.auth && <p><span className="text-ink-2">Authentication: </span>{plan.auth}</p>}
      {!!plan.gaps?.length && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-warn-ink"><Icon name="alert" size={12} />Where the contract is silent or unclear (not tested)</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-2">{plan.gaps.map((g, i) => <li key={i}>{typeof g === "string" ? g : g.text}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// The first approval: the test cases.
export function CaseReview({ run, plan }: { run: Run; plan: ContractPlan }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>(() => plan.cases.map((c) => ({ ...c, keep: true })));
  const [open, setOpen] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  useEffect(() => setRows(plan.cases.map((c) => ({ ...c, keep: true }))), [plan]);
  const original = useMemo(() => new Map(plan.cases.map((c) => [c.id, c])), [plan]);
  const kept = rows.filter((r) => r.keep);
  const edited = rows.some((r) => !r.keep || r.added || !same(r, original.get(r.id)!));
  const answer = useMutation({
    mutationFn: (text: string) => api.answerApproval(run.id, text),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", run.id] }),
    onError: (e) => toast("error", e.message),
  });
  const approve = () => {
    if (!edited) return answer.mutate("y");
    const cases = kept.map(({ keep: _k, added: _a, ...c }) => c);
    answer.mutate(JSON.stringify({ ...plan, cases }));
  };
  const set = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addCase = () => {
    const next = Math.max(0, ...rows.map((r) => Number(r.id.slice(2)) || 0)) + 1;
    const id = `TC${String(next).padStart(2, "0")}`;
    setRows((rs) => [...rs, { id, type: "negative", endpoint: rs[rs.length - 1]?.endpoint ?? "", title: "", expected: "", keep: true, added: true }]);
    setOpen(id);
  };
  const invalid = kept.some((r) => !r.title.trim() || !r.expected.trim());
  const endpoints = [...new Set(rows.map((r) => r.endpoint || "Other"))];
  const setKeep = (match: (r: Row) => boolean, keep: boolean) => setRows((rs) => rs.map((r) => (match(r) ? { ...r, keep } : r)));

  return (
    <section className="rounded-xl border-2 p-4" style={{ borderColor: "var(--status-warning)", background: "color-mix(in srgb, var(--status-warning) 6%, var(--card))" }}>
      <h2 className="flex items-center gap-2 font-semibold"><Icon name="alert" className="text-warning" />Review the test cases</h2>
      <p className="mt-1 text-sm text-ink-2">The Contract Analyst wrote {plan.cases.length} cases for <strong className="text-ink">{plan.collection_name}</strong>. Untick a case to drop it, open one to edit it, or add your own. Nothing is built until you approve.</p>
      <div className="mt-3"><PlanFacts plan={plan} /></div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-2">{kept.length} of {rows.length} cases selected</span>
        <Button size="sm" icon="check" disabled={kept.length === rows.length} onClick={() => setKeep(() => true, true)}>Select all</Button>
        <Button size="sm" icon="x" disabled={kept.length === 0} onClick={() => setKeep(() => true, false)}>Deselect all</Button>
      </div>
      <div className="mt-3 space-y-3">
        {endpoints.map((ep) => {
          const inGroup = rows.filter((r) => (r.endpoint || "Other") === ep);
          const on = inGroup.filter((r) => r.keep).length;
          return (
          <div key={ep}>
            <label className="mb-1 flex w-fit cursor-pointer items-center gap-2 font-mono text-xs text-ink-2">
              <GroupCheckbox checked={on === inGroup.length} partial={on > 0 && on < inGroup.length} label={`All cases for ${ep}`}
                onChange={(v) => setKeep((r) => (r.endpoint || "Other") === ep, v)} />
              {ep} <span className="font-sans text-muted">({on}/{inGroup.length})</span>
            </label>
            <ul className="divide-y divide-line overflow-hidden rounded-lg bg-card ring-1 ring-line">
              {rows.filter((r) => (r.endpoint || "Other") === ep).map((r) => (
                <li key={r.id} className={r.keep ? "" : "opacity-50"}>
                  <div className="flex items-start gap-3 px-3 py-2">
                    <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={r.keep} onChange={(e) => set(r.id, { keep: e.target.checked })} aria-label={`Keep ${r.id}`} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                      <span className="flex flex-wrap items-center gap-x-2 text-sm">
                        <span className="font-mono text-xs text-muted">{r.id}</span>
                        <span className="inline-flex items-center gap-1 text-xs text-ink-2"><span className="inline-block size-2 rounded-full" style={{ background: TYPE_COLOR[r.type] ?? "var(--muted)" }} />{r.type}</span>
                        <span className={r.keep ? "" : "line-through"}>{r.title || <span className="text-muted">(new case)</span>}</span>
                        {(r.added || (original.get(r.id) && !same(r, original.get(r.id)!))) && <span className="rounded bg-raised px-1 text-[11px] text-accent ring-1 ring-line">{r.added ? "added" : "edited"}</span>}
                      </span>
                      <span className="block text-xs text-ink-2">Expect: {r.expected || <span className="text-muted">…</span>}</span>
                    </button>
                    <Icon name="chevron" className={`mt-1 shrink-0 text-muted transition ${open === r.id ? "rotate-90" : ""}`} />
                  </div>
                  {open === r.id && (
                    <div className="grid gap-3 border-t border-line bg-page px-3 py-3 sm:grid-cols-2">
                      <Field label="Title"><input className={inputClass} value={r.title} onChange={(e) => set(r.id, { title: e.target.value })} /></Field>
                      <Field label="Kind"><select className={inputClass} value={r.type} onChange={(e) => set(r.id, { type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
                      <Field label="Endpoint"><input className={`${inputClass} font-mono`} value={r.endpoint ?? ""} onChange={(e) => set(r.id, { endpoint: e.target.value })} placeholder="POST /orders" /></Field>
                      <Field label="Request"><input className={inputClass} value={r.request ?? ""} onChange={(e) => set(r.id, { request: e.target.value })} placeholder="what to send" /></Field>
                      <div className="sm:col-span-2"><Field label="Expected"><textarea className={inputClass} rows={2} value={r.expected} onChange={(e) => set(r.id, { expected: e.target.value })} placeholder="status and what the response must show" /></Field></div>
                      {r.contract_ref && <p className="text-xs text-muted sm:col-span-2">From the contract: {r.contract_ref}</p>}
                      {r.added && <div className="sm:col-span-2"><Button size="sm" variant="ghost" icon="trash" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>Remove this new case</Button></div>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start">
        <Button variant="primary" icon="check" disabled={!kept.length || invalid} busy={answer.isPending && !answer.variables?.startsWith("Please")} onClick={approve}>
          {edited ? `Approve ${kept.length} case${kept.length === 1 ? "" : "s"} with my changes` : `Approve all ${kept.length} cases`}
        </Button>
        <Button icon="plus" onClick={addCase}>Add a case</Button>
      </div>
      {invalid && <p className="mt-2 text-xs text-bad-ink">Every case needs a title and an expected result.</p>}
      <div className="mt-4 border-t border-line pt-3">
        <Field label="Or send them back to the analyst" hint="Say what to change; it writes a new set and you review again.">
          <textarea className={inputClass} rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. Add boundary cases for quantity, and drop the admin endpoints" />
        </Field>
        <Button className="mt-2" icon="x" disabled={!feedback.trim()} busy={answer.isPending && answer.variables === feedback.trim()} onClick={() => answer.mutate(feedback.trim())}>Send back with feedback</Button>
      </div>
    </section>
  );
}

// A checkbox for a group of cases: checked, unchecked, or partly (some cases kept).
export function GroupCheckbox({ checked, partial, label, onChange }: { checked: boolean; partial: boolean; label: string; onChange: (v: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} type="checkbox" className="accent-[var(--accent)]" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

// After the run: what was approved, and where it went (or a button to choose).
// Contract runs, once finished: whether the tests can go to Postman, and where they went. Shown in the
// run page's outcome bar; the test cases themselves are in the run page's Test cases card.
export function PublishStatus({ run }: { run: Run }) {
  const result = run.result && "collections" in run.result ? run.result : null;
  const c = result?.contract;
  const pubs = useQuery({ queryKey: ["run-publications", run.id], queryFn: () => api.runPublications(run.id) });
  const [publishing, setPublishing] = useState(false);
  if (!c) return null;
  const built = c.collection;
  const publishable = ["passed", "passed_with_known_bugs"].includes(run.status) && !!built?.item?.length;
  const unexplained = (result?.issues ?? []).filter((i) => i.category === "unexplained").length;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
      <div className="flex min-w-0 flex-1 basis-60 gap-3">
        <Icon name={pubs.data?.length ? "check" : publishable ? "upload" : "alert"} size={18}
          className={`mt-0.5 shrink-0 ${pubs.data?.length ? "text-good" : publishable ? "text-accent" : "text-warn-ink"}`} />
        <div className="min-w-0 space-y-1">
          <div className="font-semibold">{pubs.data?.length ? "Added to Postman" : publishable ? "Ready for Postman" : "Not added to Postman"}</div>
          {pubs.data?.map((p) => (
            <p key={p.id} className="text-ink-2">{p.requests} requests in <strong className="text-ink">{p.workspace_name ?? p.workspace_id}</strong> → {p.folder_name ? <>folder <strong className="text-ink">{p.folder_name}</strong> in </> : null}<strong className="text-ink">{p.collection_name}</strong> <span className="text-xs text-muted">({dateTime(p.published_at)})</span></p>
          ))}
          {!pubs.data?.length && (
            <p className="text-ink-2">{!built?.item?.length ? "No collection was built in this run."
              : publishable ? `The collection is built and checked${run.status === "passed_with_known_bugs" ? "; its only failures are known bugs" : ""}. Choose where it goes.`
              : `${unexplained ? `${unexplained} failure${unexplained === 1 ? " is" : "s are"} unexplained` : "Some failures aren't explained"}. Fix the environment or the contract, then generate again.`}</p>
          )}
          {run.collection.id && <p><Link to={`/collections/${run.collection.id}`} className="text-accent hover:underline">Open it in Collections</Link></p>}
        </div>
      </div>
      <Button variant={pubs.data?.length || !publishable ? "secondary" : "primary"} icon="upload" disabled={!publishable} onClick={() => setPublishing(true)}>
        {pubs.data?.length ? "Add it somewhere else too" : "Add to Postman"}
      </Button>
      {publishing && <PublishDialog run={run} defaultName={c.plan?.collection_name ?? `${c.name} Contract Tests`} contractName={c.name} requests={countRequests(built?.item)}
        testBaseUrl={(result as any)?.environment?.base_url ?? ""} onClose={() => setPublishing(false)} />}
    </div>
  );
}

const countRequests = (items: any[] = []): number => items.reduce((n, i) => n + (Array.isArray(i.item) ? countRequests(i.item) : 1), 0);

// The second approval: which workspace, and a new collection or a folder in an existing one.
function PublishDialog({ run, defaultName, contractName, requests, testBaseUrl, onClose }: { run: Run; defaultName: string; contractName: string; requests: number; testBaseUrl: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const [ws, setWs] = useState("");
  const [mode, setMode] = useState<"new" | "folder">("new");
  const [name, setName] = useState(defaultName);
  const [colUid, setColUid] = useState("");
  const [folder, setFolder] = useState(`${contractName} contract tests`);
  const [replace, setReplace] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A new collection is a new project: its environments, each with a base URL.
  const [envRows, setEnvRows] = useState([{ label: "Test", base_url: testBaseUrl }, { label: "Stg", base_url: "" }, { label: "Prod", base_url: "" }]);
  const [toDashboard, setToDashboard] = useState(true);
  const contract = useQuery({ queryKey: ["contracts", run.contract?.id], queryFn: () => api.contract(run.contract!.id!), enabled: !!run.contract?.id });
  const credVars = contract.data?.auth?.variables ?? [];
  const filled = envRows.filter((e) => e.base_url.trim());
  const badUrl = filled.some((e) => !/^https?:\/\/\S+$/.test(e.base_url.trim()));
  const dupLabel = new Set(filled.map((e) => e.label.trim().toLowerCase())).size !== filled.length || filled.some((e) => !e.label.trim());
  const setRow = (i: number, patch: Partial<{ label: string; base_url: string }>) => setEnvRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosenWs = ws || workspaces.data?.[0]?.id || "";
  const wsName = workspaces.data?.find((w) => w.id === chosenWs)?.name ?? "";
  const collections = useQuery({ queryKey: ["workspace-collections", chosenWs], queryFn: () => api.workspaceCollections(chosenWs), enabled: !!chosenWs });
  const chosenCol = colUid || collections.data?.[0]?.uid || "";
  const colName = collections.data?.find((c) => c.uid === chosenCol)?.name ?? "";
  const folders = useQuery({ queryKey: ["collection-folders", chosenCol], queryFn: () => api.collectionFolders(chosenCol), enabled: mode === "folder" && !!chosenCol });
  const nameTaken = mode === "new" && !!collections.data?.some((c) => c.name === name.trim());
  const folderTaken = mode === "folder" && !!folders.data?.some((f) => f.name === folder.trim());
  const ready = !!chosenWs && (mode === "new" ? !!name.trim() && !nameTaken && !badUrl && !dupLabel : !!chosenCol && !!folder.trim() && (!folderTaken || replace));

  const publish = useMutation({
    mutationFn: () => api.publishRun(run.id, chosenWs, mode === "new" ? { kind: "new", name: name.trim() } : { kind: "folder", collection_uid: chosenCol, folder_name: folder.trim(), replace },
      mode === "new" ? filled.map((e) => ({ label: e.label.trim(), base_url: e.base_url.trim() })) : [], mode === "new" && toDashboard),
    onSuccess: (r) => {
      toast("ok", `Added ${r.requests} requests to ${r.workspace.name} → ${r.folder ? `${r.collection.name} → ${r.folder}` : r.collection.name}${r.environments.length ? `, with ${r.environments.length} environment${r.environments.length === 1 ? "" : "s"}` : ""}`);
      for (const k of [["run-publications", run.id], ["runs", run.id], ["contracts"], ["collections"], ["workspace-collections"], ["environments"]]) qc.invalidateQueries({ queryKey: k });
      onClose();
    },
    onError: () => setConfirming(false),
  });
  const where = mode === "new" ? <>a new collection <strong>{name.trim()}</strong></> : <>{folderTaken ? "replace the folder" : "a new folder"} <strong>{folder.trim()}</strong> in the collection <strong>{colName}</strong></>;

  return (
    <Modal open onClose={onClose} title="Add the tests to Postman"
      footer={confirming ? <>
        <Button variant="ghost" onClick={() => setConfirming(false)}>Back</Button>
        <Button variant="primary" icon="upload" busy={publish.isPending} onClick={() => publish.mutate()}>Yes, add them</Button>
      </> : <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ready} onClick={() => setConfirming(true)}>Continue</Button>
      </>}>
      {workspaces.isPending ? <div className="py-6 text-center text-muted"><Spinner /></div> : workspaces.error ? <ErrorNote error={workspaces.error} /> : confirming ? (
        <div className="space-y-3 text-sm">
          <p>Add <strong>{requests} requests</strong> to the workspace <strong>{wsName}</strong>, as {where}?</p>
          {mode === "new" && filled.length > 0 && (
            <div>
              <p>And create {filled.length === 1 ? "this environment" : "these environments"} in the workspace{toDashboard ? " and in the dashboard" : ""}:</p>
              <ul className="mt-1 space-y-0.5">{filled.map((e) => <li key={e.label}><strong>{name.trim()} - {e.label}</strong>: <span className="break-all font-mono text-xs">{e.base_url.trim()}</span></li>)}</ul>
              {credVars.length > 0 && <p className="mt-1 text-xs text-ink-2">Each also gets {credVars.map((v) => `{{${v.key}}}`).join(", ")}, empty: enter the values in Postman{toDashboard ? " and the dashboard" : ""}.</p>}
            </div>
          )}
          {mode === "folder" && folderTaken && <p className="flex gap-2 text-warn-ink"><Icon name="alert" className="mt-0.5 shrink-0" />The folder's current requests will be replaced.</p>}
          <p className="text-ink-2">It's also added to the dashboard's Collections, so you can run, schedule and email it.</p>
          <ErrorNote error={publish.error} />
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Workspace">
            <select className={inputClass} value={chosenWs} onChange={(e) => { setWs(e.target.value); setColUid(""); }}>{workspaces.data?.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.type})</option>)}</select>
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Where in the workspace</legend>
            {([["new", "A new collection", "Its own collection, named below."], ["folder", "A folder in an existing collection", "Next to the requests already there, e.g. the API's main collection."]] as const).map(([v, t, d]) => (
              <label key={v} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${mode === v ? "border-accent bg-raised" : "border-line hover:bg-raised"}`}>
                <input type="radio" name="where" className="mt-1 accent-[var(--accent)]" checked={mode === v} onChange={() => setMode(v)} />
                <span><span className="block text-sm font-medium">{t}</span><span className="block text-xs text-ink-2">{d}</span></span>
              </label>
            ))}
          </fieldset>
          {mode === "new" ? (<>
            <Field label="Collection name" error={nameTaken ? "This workspace already has a collection with that name." : undefined}>
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Environments for this project</legend>
              <p className="text-xs text-ink-2">The base URL for each place the API runs, including any path like /api/v3. Leave a row empty to skip it. Each environment gets <span className="font-mono">{"{{baseUrl}}"}</span>{credVars.length ? <> and the credential variables {credVars.map((v) => <span key={v.key} className="font-mono">{`{{${v.key}}}`} </span>)}(empty, to fill in)</> : null}.</p>
              {envRows.map((r, i) => (
                <div key={i} className="grid grid-cols-[6rem_1fr_auto] gap-2">
                  <input className={inputClass} aria-label={`Environment ${i + 1} name`} value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
                  <input className={`${inputClass} font-mono`} aria-label={`${r.label || `Environment ${i + 1}`} base URL`} value={r.base_url} onChange={(e) => setRow(i, { base_url: e.target.value })} placeholder={`https://${(r.label || "env").toLowerCase()}.api.example.com/v1`} />
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${r.label || "row"}`} onClick={() => setEnvRows((rs) => rs.filter((_, j) => j !== i))} />
                </div>
              ))}
              {envRows.length < 6 && <Button size="sm" icon="plus" onClick={() => setEnvRows((rs) => [...rs, { label: "", base_url: "" }])}>Add an environment</Button>}
              {badUrl && <p className="text-xs text-bad-ink">Base URLs start with http:// or https://.</p>}
              {dupLabel && <p className="text-xs text-bad-ink">Give each environment its own name.</p>}
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--accent)]" checked={toDashboard} onChange={(e) => setToDashboard(e.target.checked)} />Also add them to the dashboard's Environments</label>
            </fieldset>
          </>) : collections.data?.length === 0 ? <p className="text-sm text-ink-2">This workspace has no collections yet: add the tests as a new collection.</p> : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Collection">
                <select className={inputClass} value={chosenCol} onChange={(e) => setColUid(e.target.value)}>{collections.data?.map((c) => <option key={c.uid} value={c.uid}>{c.name}</option>)}</select>
              </Field>
              <Field label="Folder name" hint={folders.data ? `${folders.data.length} folder${folders.data.length === 1 ? "" : "s"} there now` : undefined}>
                <input className={inputClass} value={folder} onChange={(e) => setFolder(e.target.value)} />
              </Field>
              {folderTaken && (
                <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                  <span>A folder with this name exists: replace it<span className="block text-xs text-ink-2">Or change the name to add a new folder.</span></span></label>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
