import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api, type EnvironmentInput } from "../api.ts";
import { Button, Card, EmptyState, ErrorNote, Field, Icon, Modal, PageHeader, Spinner, inputClass, useToast } from "../ui.tsx";

export function EnvironmentsPage() {
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments });
  const newButton = <Link to="/environments/new"><Button variant="primary" icon="plus">New environment</Button></Link>;
  return (
    <>
      <PageHeader title="Environments" subtitle="Where collections run: a base URL, a health check and variables." actions={newButton} />
      <ErrorNote error={envs.error} />
      {envs.isPending ? <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div> : envs.data?.length === 0 ? (
        <Card><EmptyState icon="globe" title="No environments yet" action={newButton}>Add one for each place you test, e.g. Test, Stg and Prod.</EmptyState></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {envs.data?.map((e) => (
            <Link key={e.id} to={`/environments/${e.id}`} className="rounded-xl border border-line bg-card p-4 hover:border-accent">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{e.label}</span>
                <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-ink-2 ring-1 ring-line">{e.name}</span>
              </div>
              <div className="mt-2 truncate font-mono text-xs text-ink-2">{e.base_url}</div>
              <div className="mt-3 flex gap-3 text-xs text-muted">
                <span>Health check {e.health_path}</span>
                <span>{e.variables.length} variable{e.variables.length === 1 ? "" : "s"}{e.variables.some((v) => v.secret) ? `, ${e.variables.filter((v) => v.secret).length} secret` : ""}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

type Row = { key: string; value: string; secret: boolean; masked?: string; keep?: boolean };
const blank: Row = { key: "", value: "", secret: false };

export function EnvironmentEditPage() {
  const params = useParams();
  const isNew = !params.id;
  const id = Number(params.id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ["environments", id], queryFn: () => api.environment(id), enabled: !isNew });
  const [form, setForm] = useState({ name: "", label: "", base_url: "", health_path: "/" });
  const [rows, setRows] = useState<Row[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const e = existing.data;
    if (!e) return;
    setForm({ name: e.name, label: e.label, base_url: e.base_url, health_path: e.health_path });
    // A saved secret starts out kept: its value isn't sent back, only a masked hint.
    setRows(e.variables.map((v) => (v.secret ? { key: v.key, value: "", secret: true, masked: v.masked, keep: true } : { key: v.key, value: v.value ?? "", secret: false })));
  }, [existing.data]);

  const save = useMutation({
    mutationFn: () => {
      const input: EnvironmentInput = {
        ...form,
        variables: rows.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.secret && r.keep && !r.value ? null : r.value, secret: r.secret })),
      };
      return isNew ? api.createEnvironment(input) : api.updateEnvironment(id, input);
    },
    onSuccess: (e) => {
      toast("ok", `Saved "${e.label}"`);
      qc.invalidateQueries({ queryKey: ["environments"] });
      navigate("/environments");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteEnvironment(id),
    onSuccess: () => { toast("ok", "Environment deleted. Its runs are kept."); qc.invalidateQueries({ queryKey: ["environments"] }); navigate("/environments"); },
    onError: (e) => toast("error", e.message),
  });

  if (!isNew && existing.isPending) return <div className="flex justify-center py-20 text-muted"><Spinner size={24} /></div>;
  if (existing.error) return <ErrorNote error={existing.error} />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
      <div className="mb-2 text-sm"><Link to="/environments" className="text-ink-2 hover:text-ink">Environments</Link></div>
      <PageHeader title={isNew ? "New environment" : `Edit ${existing.data?.label}`} actions={!isNew && <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>Delete</Button>} />
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-4">
        <Card title="Details">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Name" hint="Shown everywhere, e.g. Stg"><input className={inputClass} required value={form.label} onChange={set("label")} placeholder="Stg" /></Field>
            <Field label="Short id" hint="Lowercase letters, digits, - or _. Used by the agents, e.g. stg"><input className={`${inputClass} font-mono`} required value={form.name} onChange={set("name")} placeholder="stg" /></Field>
            <Field label="Base URL" hint="Requests use it as {{baseUrl}}"><input className={`${inputClass} font-mono`} required type="url" value={form.base_url} onChange={set("base_url")} placeholder="https://stg.example.com" /></Field>
            <Field label="Health check path" hint="Checked before every run; a 5xx or no answer means the server is down"><input className={`${inputClass} font-mono`} required value={form.health_path} onChange={set("health_path")} placeholder="/health" /></Field>
          </div>
        </Card>

        <Card title="Variables" actions={<Button type="button" size="sm" icon="plus" onClick={() => setRows((r) => [...r, { ...blank }])}>Add variable</Button>}>
          <p className="px-4 pt-3 text-xs text-ink-2">Values here override the collection's own variables. Mark credentials as secret: they're never shown again after saving.</p>
          {rows.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No variables.</p> : (
            <div className="space-y-2 p-4">
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto_auto] sm:items-center">
                  <input aria-label="Variable name" className={`${inputClass} font-mono`} value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} placeholder="apiToken" />
                  <input
                    aria-label="Value"
                    className={`${inputClass} font-mono max-sm:col-span-2 max-sm:row-start-2`}
                    type={r.secret ? "password" : "text"}
                    value={r.value}
                    onChange={(e) => setRow(i, { value: e.target.value })}
                    placeholder={r.keep ? `Unchanged (${r.masked})` : "value"}
                    autoComplete="off"
                  />
                  <label className="flex items-center gap-1.5 text-sm text-ink-2 max-sm:row-start-3"><input type="checkbox" checked={r.secret} onChange={(e) => setRow(i, { secret: e.target.checked, keep: e.target.checked && r.keep })} className="accent-[var(--accent)]" />Secret</label>
                  <button type="button" className="justify-self-end rounded p-1.5 text-muted hover:text-bad-ink max-sm:row-start-1" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove ${r.key || "variable"}`}><Icon name="trash" /></button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <Link to="/environments"><Button type="button" variant="ghost">Cancel</Button></Link>
          <Button type="submit" variant="primary" busy={save.isPending}>{isNew ? "Create environment" : "Save changes"}</Button>
        </div>
      </form>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this environment?"
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" icon="trash" busy={remove.isPending} onClick={() => remove.mutate()}>Delete</Button></>}>
        <p className="text-sm text-ink-2">"{existing.data?.label}" and its variables are deleted. Runs made against it stay in the history.</p>
      </Modal>
    </>
  );
}
