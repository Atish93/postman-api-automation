import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api, type Collection } from "../api.ts";
import { RunDialog } from "../RunDialog.tsx";
import { BuildDialog } from "../BuildDialog.tsx";
import { RunsTable } from "./Runs.tsx";
import { relativeTime } from "../format.ts";
import { Button, Card, EmptyState, ErrorNote, Field, Icon, MethodBadge, Modal, PageHeader, Spinner, StatusBadge, inputClass, useToast } from "../ui.tsx";

// ---------- Import from Postman ----------
function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: open });
  const connected = settings.data?.postman.connected;
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, enabled: open && !!connected });
  const [ws, setWs] = useState<string | null>(null);
  const chosen = ws ?? workspaces.data?.[0]?.id ?? null;
  const cols = useQuery({ queryKey: ["workspace-collections", chosen], queryFn: () => api.workspaceCollections(chosen!), enabled: open && !!chosen });
  const importOne = useMutation({
    mutationFn: (uid: string) => api.importCollection(uid),
    onSuccess: (c) => {
      toast("ok", `Imported "${c.name}"`);
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["workspace-collections"] });
    },
    onError: (e) => toast("error", e.message),
  });

  return (
    <Modal open={open} onClose={onClose} title="Import from Postman" wide footer={<Button onClick={onClose}>Done</Button>}>
      {settings.isPending ? <Spinner /> : !connected ? (
        <EmptyState icon="key" title="Postman isn't connected" action={<Link to="/settings" onClick={onClose}><Button variant="primary">Connect Postman</Button></Link>}>
          Save your Postman API key in Settings, then come back here.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <ErrorNote error={workspaces.error ?? cols.error} />
          <Field label="Workspace">
            <select className={inputClass} value={chosen ?? ""} onChange={(e) => setWs(e.target.value)}>
              {workspaces.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          {cols.isPending && chosen ? <div className="py-6 text-center text-muted"><Spinner /></div> : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {cols.data?.length === 0 && <li className="px-3 py-4 text-sm text-ink-2">This workspace has no collections.</li>}
              {cols.data?.map((c) => (
                <li key={c.uid} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-sm">{c.name}</span>
                  {c.imported ? (
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="flex items-center gap-1 text-xs text-ink-2"><Icon name="check" size={12} className="text-good" />Imported</span>
                      <Button size="sm" variant="ghost" icon="refresh" busy={importOne.isPending && importOne.variables === c.uid} onClick={() => importOne.mutate(c.uid)}>Update</Button>
                    </span>
                  ) : (
                    <Button size="sm" icon="download" busy={importOne.isPending && importOne.variables === c.uid} onClick={() => importOne.mutate(c.uid)}>Import</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------- Upload a collection file ----------
function useUpload() {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        throw new Error(`"${file.name}" isn't valid JSON. Export the collection from Postman (Collection v2.1) and try again.`);
      }
      return api.uploadCollection(json);
    },
    onSuccess: (c) => {
      toast("ok", `Uploaded "${c.name}"`);
      qc.invalidateQueries({ queryKey: ["collections"] });
    },
    onError: (e) => toast("error", e.message),
  });
  const element = (
    <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
      const f = e.target.files?.[0];
      if (f) upload.mutate(f);
      e.target.value = "";
    }} />
  );
  return { element, open: () => input.current?.click(), busy: upload.isPending };
}

// ---------- List ----------
export function CollectionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const [importing, setImporting] = useState(false);
  const [building, setBuilding] = useState(false);
  const [running, setRunning] = useState<Collection | null>(null);
  const upload = useUpload();
  const refresh = useMutation({
    mutationFn: (id: number) => api.refreshCollection(id),
    onSuccess: (c) => { toast("ok", `Updated "${c.name}" from Postman`); qc.invalidateQueries({ queryKey: ["collections"] }); },
    onError: (e) => toast("error", e.message),
  });

  const actions = (
    <>
      <Button icon="upload" busy={upload.busy} onClick={upload.open}>Upload file</Button>
      <Button icon="download" onClick={() => setImporting(true)}>Import from Postman</Button>
      <Button variant="primary" icon="sparkle" onClick={() => setBuilding(true)}>Build with AI</Button>
    </>
  );

  return (
    <>
      <PageHeader title="Collections" subtitle="Postman collections you can run against any environment." actions={actions} />
      {upload.element}
      <ErrorNote error={list.error} />
      {list.isPending ? <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div> : list.data?.length === 0 ? (
        <Card><EmptyState icon="folder" title="No collections yet" action={<div className="flex gap-2">{actions}</div>}>Import a collection from your Postman workspace, upload a collection file, or describe what to test and let the AI agents build one.</EmptyState></Card>
      ) : (
        <Card>
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr><th className="px-4 py-2 font-medium">Name</th><th className="px-4 py-2 font-medium">Source</th><th className="px-4 py-2 text-right font-medium">Requests</th><th className="px-4 py-2 font-medium">Last run</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data?.map((c) => (
                  <tr key={c.id} className="hover:bg-raised">
                    <td className="max-w-xs px-4 py-2.5"><Link to={`/collections/${c.id}`} className="block truncate font-medium hover:text-accent">{c.name}</Link></td>
                    <td className="px-4 py-2.5 text-ink-2">{c.source === "postman" ? "Postman" : "Uploaded"}</td>
                    <td className="tabular px-4 py-2.5 text-right">{c.request_count}</td>
                    <td className="px-4 py-2.5">{c.last_run ? <Link to={`/runs/${c.last_run.id}`} className="flex items-center gap-2"><StatusBadge status={c.last_run.status} /><span className="whitespace-nowrap text-xs text-muted">{relativeTime(c.last_run.created_at)}</span></Link> : <span className="text-xs text-muted">Never run</span>}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        {c.source === "postman" && <Button size="sm" variant="ghost" icon="refresh" title="Pull the latest version from Postman" aria-label={`Update "${c.name}" from Postman`} busy={refresh.isPending && refresh.variables === c.id} onClick={() => refresh.mutate(c.id)} />}
                        <Button size="sm" icon="play" onClick={() => setRunning(c)}>Run</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
      <BuildDialog open={building} onClose={() => setBuilding(false)} />
      {running && <RunDialog collection={running} open onClose={() => setRunning(null)} />}
    </>
  );
}

// ---------- One collection ----------
export function CollectionPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useQuery({ queryKey: ["collections", id], queryFn: () => api.collection(id) });
  const [running, setRunning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = useMutation({
    mutationFn: () => api.refreshCollection(id),
    onSuccess: () => { toast("ok", "Updated from Postman"); qc.invalidateQueries({ queryKey: ["collections"] }); },
    onError: (e) => toast("error", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCollection(id),
    onSuccess: () => { toast("ok", "Collection deleted. Its run history is kept."); qc.invalidateQueries({ queryKey: ["collections"] }); navigate("/collections"); },
    onError: (e) => toast("error", e.message),
  });

  if (c.isPending) return <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div>;
  if (c.error) return <ErrorNote error={c.error} />;
  const col = c.data;

  return (
    <>
      <div className="mb-2 text-sm"><Link to="/collections" className="text-ink-2 hover:text-ink">Collections</Link></div>
      <PageHeader
        title={col.name}
        subtitle={<>{col.request_count} requests · {col.source === "postman" ? "imported from Postman" : "uploaded"} · updated {relativeTime(col.updated_at)}</>}
        actions={<>
          <a href={`/api/collections/${col.id}/json`}><Button icon="download">Download</Button></a>
          {col.source === "postman" && <Button icon="refresh" busy={refresh.isPending} onClick={() => refresh.mutate()}>Update from Postman</Button>}
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>Delete</Button>
          <Button variant="primary" icon="play" onClick={() => setRunning(true)}>Run</Button>
        </>}
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Requests">
          <ul className="divide-y divide-line">
            {col.requests.map((r, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2">
                <MethodBadge method={r.method} />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{r.name}</span>
                  <span className="block truncate font-mono text-xs text-muted">{r.folder ? `${r.folder} · ` : ""}{r.url}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="lg:col-span-2" title="Runs">
          <RunsTable filters={{ collection_id: id }} compact />
        </Card>
      </div>
      <RunDialog collection={col} open={running} onClose={() => setRunning(false)} />
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this collection?"
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" icon="trash" busy={remove.isPending} onClick={() => remove.mutate()}>Delete</Button></>}>
        <p className="text-sm text-ink-2">"{col.name}" is removed from the dashboard. Its runs stay in the history, and {col.source === "postman" ? "the collection in Postman isn't touched" : "you can upload the file again later"}.</p>
      </Modal>
    </>
  );
}
