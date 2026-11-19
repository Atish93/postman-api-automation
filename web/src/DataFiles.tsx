// Test-data files: a collection's CSV/JSON tables. A plain run with one runs the collection once per row.
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DataFile } from "./api.ts";
import { relativeTime } from "./format.ts";
import { Button, Card, ErrorNote, Field, Icon, Modal, Spinner, inputClass, useToast } from "./ui.tsx";

const rows = (n: number) => `${n} row${n === 1 ? "" : "s"}`;

// "Test data" choice in the run dialog and the schedule form. Shows nothing if the collection has no files.
export function DataFileSelect({ collectionId, value, onChange }: { collectionId: number; value: number | null; onChange: (id: number | null) => void }) {
  const files = useQuery({ queryKey: ["data-files", collectionId], queryFn: () => api.dataFiles(collectionId) });
  if (!files.data?.length) return null;
  const chosen = files.data.find((f) => f.id === value);
  return (
    <Field label="Test data" hint={chosen ? `The collection runs ${chosen.row_count} time${chosen.row_count === 1 ? "" : "s"}, once per row; each column is a variable, e.g. {{${chosen.columns[0]}}}.` : "Run once, with the environment's values only."}>
      <select className={inputClass} value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">None: run once</option>
        {files.data.map((f) => <option key={f.id} value={f.id}>{f.name} ({rows(f.row_count)})</option>)}
      </select>
    </Field>
  );
}

// The card on a collection's page: upload, preview, download, delete.
export function TestDataCard({ collectionId }: { collectionId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const files = useQuery({ queryKey: ["data-files", collectionId], queryFn: () => api.dataFiles(collectionId) });
  const input = useRef<HTMLInputElement>(null);
  const [replace, setReplace] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [removing, setRemoving] = useState<DataFile | null>(null);

  const upload = useMutation({
    mutationFn: (b: { name: string; content: string; replace?: boolean }) => api.uploadDataFile(collectionId, b),
    onSuccess: (f) => {
      toast("ok", `${f.name}: ${rows(f.row_count)}, ${f.columns.length} column${f.columns.length === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["data-files", collectionId] });
      setReplace(null);
      setPreview(f.id);
    },
    onError: (e, b) => (/already has a data file/.test(e.message) && !b.replace ? setReplace(b) : toast("error", e.message)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteDataFile(id),
    onSuccess: () => { toast("ok", "Data file deleted. Past runs keep its name."); qc.invalidateQueries({ queryKey: ["data-files", collectionId] }); setRemoving(null); },
    onError: (e) => toast("error", e.message),
  });

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_000_000) return toast("error", "The file is larger than 1 MB.");
    upload.mutate({ name: file.name, content: await file.text() });
    if (input.current) input.current.value = "";
  };

  return (
    <Card title="Test data" actions={<>
      <input ref={input} type="file" accept=".csv,.json,text/csv,application/json" className="sr-only" aria-label="Choose a CSV or JSON file" onChange={(e) => pick(e.target.files?.[0])} />
      <Button size="sm" icon="upload" busy={upload.isPending} onClick={() => input.current?.click()}>Upload CSV or JSON</Button>
    </>}>
      <p className="px-4 pt-3 text-xs text-ink-2">
        A plain run with a data file goes once per row. The first CSV row names the variables (or use a JSON list of objects); requests use them as <code className="font-mono">{"{{email}}"}</code> and tests as <code className="font-mono">pm.iterationData.get("email")</code>.
      </p>
      {files.isPending ? <div className="flex justify-center py-6 text-muted"><Spinner /></div> : files.error ? <div className="p-4"><ErrorNote error={files.error} /></div> : !files.data?.length ? (
        <p className="px-4 py-4 text-sm text-muted">No data files yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {files.data.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Icon name="table" className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <button className="truncate text-left text-sm font-medium hover:text-accent" onClick={() => setPreview(f.id)}>{f.name}</button>
                <div className="text-xs text-muted">
                  {rows(f.row_count)} · {f.columns.length} column{f.columns.length === 1 ? "" : "s"} · {f.format.toUpperCase()} · added {relativeTime(f.created_at)}
                  {f.schedules > 0 && <> · used by {f.schedules} schedule{f.schedules === 1 ? "" : "s"}</>}
                </div>
                {f.unused.length > 0 && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-warn-ink"><Icon name="alert" size={12} />Not used by the collection: {f.unused.join(", ")}</div>
                )}
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setPreview(f.id)}>Preview</Button>
                <a href={api.dataFileUrl(f.id)} download><Button size="sm" variant="ghost" icon="download" aria-label={`Download ${f.name}`} /></a>
                <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${f.name}`} onClick={() => setRemoving(f)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <DataPreview id={preview} onClose={() => setPreview(null)} />

      <Modal open={!!replace} onClose={() => setReplace(null)} title={`Replace "${replace?.name}"?`}
        footer={<><Button variant="ghost" onClick={() => setReplace(null)}>Keep the old one</Button><Button variant="primary" busy={upload.isPending} onClick={() => replace && upload.mutate({ ...replace, replace: true })}>Replace</Button></>}>
        <p className="text-sm text-ink-2">This collection already has a file with that name. Schedules that use it will use the new rows from their next run.</p>
      </Modal>
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={`Delete "${removing?.name}"?`}
        footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" icon="trash" busy={remove.isPending} onClick={() => removing && remove.mutate(removing.id)}>Delete</Button></>}>
        <p className="text-sm text-ink-2">Runs that used it keep its name in their history.</p>
        <ErrorNote error={remove.error} />
      </Modal>
    </Card>
  );
}

function DataPreview({ id, onClose }: { id: number | null; onClose: () => void }) {
  const f = useQuery({ queryKey: ["data-file", id], queryFn: () => api.dataFile(id!), enabled: id !== null });
  const d = f.data;
  return (
    <Modal open={id !== null} onClose={onClose} wide title={d ? d.name : "Data file"}>
      {f.isPending ? <div className="flex justify-center py-6 text-muted"><Spinner /></div> : f.error ? <ErrorNote error={f.error} /> : d && (
        <>
          <p className="mb-3 text-sm text-ink-2">
            {rows(d.row_count)}{d.preview && d.preview.length < d.row_count ? `, the first ${d.preview.length} shown` : ""}.
            {d.used.length > 0 && <> The collection uses <span className="font-mono">{d.used.join(", ")}</span>.</>}
            {d.unused.length > 0 && <> Not used: <span className="font-mono">{d.unused.join(", ")}</span>.</>}
          </p>
          <div className="max-h-[50vh] overflow-auto rounded-lg ring-1 ring-line">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-raised text-xs text-ink-2">
                <tr><th className="px-3 py-2 font-medium">Row</th>{d.columns.map((c) => <th key={c} className="px-3 py-2 font-mono font-medium">{c}{d.unused.includes(c) && <span className="ml-1 font-sans text-warn-ink">(unused)</span>}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.preview?.map((r, i) => (
                  <tr key={i}><td className="px-3 py-1.5 text-muted tabular-nums">{i + 1}</td>{d.columns.map((c) => <td key={c} className="max-w-[16rem] truncate px-3 py-1.5 font-mono text-xs" title={r[c]}>{r[c] ?? <span className="text-muted">—</span>}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
