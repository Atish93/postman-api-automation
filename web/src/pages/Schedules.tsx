import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type Schedule } from "../api.ts";
import { dateTime, relativeTime } from "../format.ts";
import { DAYS, describeCron, fromCron, toCron, type Frequency } from "../schedule.ts";
import { Button, Card, EmptyState, ErrorNote, Field, Icon, KindBadge, Modal, PageHeader, Spinner, StatusBadge, inputClass, useToast } from "../ui.tsx";

const inFuture = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  if (ms < 60_000) return "in under a minute";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
};

// Create or edit a schedule. Without a collection, it offers a choice of collection.
export function ScheduleForm({ open, onClose, collectionId, editing }: { open: boolean; onClose: () => void; collectionId?: number; editing?: Schedule | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const collections = useQuery({ queryKey: ["collections"], queryFn: api.collections, enabled: open });
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments, enabled: open });
  const [form, setForm] = useState(() => ({ collection: 0, environment: 0, kind: "plain" as "plain" | "ai", enabled: true, ...fromCron("0 7 * * 1-5") }));
  useEffect(() => {
    if (!open) return;
    if (editing) setForm({ collection: editing.collection.id, environment: editing.environment.id, kind: editing.kind, enabled: editing.enabled, ...fromCron(editing.cron) });
    else setForm({ collection: collectionId ?? 0, environment: 0, kind: "plain", enabled: true, ...fromCron("0 7 * * 1-5") });
  }, [open, editing, collectionId]);
  const collection = form.collection || collections.data?.[0]?.id || 0;
  const environment = form.environment || envs.data?.[0]?.id || 0;
  const chosen = collections.data?.find((c) => c.id === collection);
  const cron = toCron(form);
  const preview = useQuery({ queryKey: ["schedule-preview", cron], queryFn: () => api.schedulePreview(cron), enabled: open && cron.split(/\s+/).length === 5, retry: false });
  const save = useMutation({
    mutationFn: () => {
      const input = { collection_id: collection, environment_id: environment, kind: form.kind, cron, enabled: form.enabled };
      return editing ? api.updateSchedule(editing.id, input) : api.createSchedule(input);
    },
    onSuccess: (s) => {
      toast("ok", `Scheduled: ${describeCron(s.cron)}`);
      qc.invalidateQueries({ queryKey: ["schedules"] });
      onClose();
    },
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit schedule" : "New schedule"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={save.isPending} disabled={!collection || !environment || !preview.data} onClick={() => save.mutate()}>{editing ? "Save" : "Create schedule"}</Button></>}>
      <div className="space-y-4">
        {!collectionId && (
          <Field label="Collection">
            <select className={inputClass} value={collection} onChange={(e) => set({ collection: Number(e.target.value) })}>
              {collections.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Environment">
          <select className={inputClass} value={environment} onChange={(e) => set({ environment: Number(e.target.value) })}>
            {envs.data?.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </Field>
        <Field label="Kind of run" hint={form.kind === "ai" ? "Scheduled AI runs are unattended: changes that need your approval are refused and listed in the report. Each run costs a few cents." : "Free; the report shows what failed."}>
          <select className={inputClass} value={form.kind} onChange={(e) => set({ kind: e.target.value as "plain" | "ai" })}>
            <option value="plain">Plain run</option>
            <option value="ai" disabled={chosen?.source !== "postman"}>AI run{chosen?.source !== "postman" ? " (needs a collection from Postman)" : ""}</option>
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How often">
            <select className={inputClass} value={form.frequency} onChange={(e) => set({ frequency: e.target.value as Frequency })}>
              <option value="weekdays">Every weekday</option>
              <option value="daily">Every day</option>
              <option value="weekly">Once a week</option>
              <option value="hourly">Every hour</option>
              <option value="custom">Custom (cron)</option>
            </select>
          </Field>
          {["weekdays", "daily", "weekly"].includes(form.frequency) && (
            <Field label="At"><input type="time" className={inputClass} value={form.time} onChange={(e) => set({ time: e.target.value || "07:00" })} /></Field>
          )}
          {form.frequency === "weekly" && (
            <Field label="On">
              <select className={inputClass} value={form.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </Field>
          )}
          {form.frequency === "custom" && (
            <Field label="Cron expression" hint="minute hour day-of-month month day-of-week">
              <input className={`${inputClass} font-mono`} value={form.custom} onChange={(e) => set({ custom: e.target.value })} placeholder="30 6 * * 1-5" />
            </Field>
          )}
        </div>
        <div className="rounded-lg bg-page p-3 text-xs ring-1 ring-line">
          {preview.error ? <span className="text-bad-ink">{(preview.error as Error).message}</span> : preview.data ? (
            <><span className="text-muted">Next runs: </span>{preview.data.next.map((d) => dateTime(d)).join(" · ")}</>
          ) : <span className="text-muted">Checking…</span>}
          <div className="mt-1 text-muted">Times are on this computer's clock. Schedules run while the dashboard server is running.</div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--accent)]" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Enabled</label>
        <ErrorNote error={save.error} />
      </div>
    </Modal>
  );
}

// A list of schedules, with edit, pause and delete. Used here and on a collection's page.
export function ScheduleList({ collectionId, compact }: { collectionId?: number; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["schedules", collectionId ?? "all"], queryFn: () => api.schedules(collectionId), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Schedule | null>(null);
  const toggle = useMutation({
    mutationFn: (s: Schedule) => api.updateSchedule(s.id, { collection_id: s.collection.id, environment_id: s.environment.id, kind: s.kind, cron: s.cron, enabled: !s.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
    onError: (e) => toast("error", e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteSchedule(id),
    onSuccess: () => { toast("ok", "Schedule deleted. Its runs are kept."); qc.invalidateQueries({ queryKey: ["schedules"] }); },
    onError: (e) => toast("error", e.message),
  });
  if (q.isPending) return <div className="flex justify-center py-6 text-muted"><Spinner /></div>;
  if (q.error) return <div className="p-4"><ErrorNote error={q.error} /></div>;
  if (!q.data?.length) return <p className="px-4 py-4 text-sm text-ink-2">No schedules{collectionId ? " for this collection" : ""} yet.</p>;
  return (
    <>
      <ul className="divide-y divide-line">
        {q.data.map((s) => (
          <li key={s.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${s.enabled ? "" : "opacity-60"}`}>
            <Icon name="clock" className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">{describeCron(s.cron)} <KindBadge kind={s.kind} /></div>
              <div className="text-xs text-muted">
                {!compact && <><Link to={`/collections/${s.collection.id}`} className="hover:text-accent">{s.collection.name}</Link> · </>}
                {s.environment.label} · {s.enabled && s.next_run_at ? <span title={dateTime(s.next_run_at)}>next {inFuture(s.next_run_at)}</span> : "paused"}
              </div>
            </div>
            {s.last_run && <Link to={`/runs/${s.last_run.id}`} className="flex items-center gap-2" title={`Last run ${relativeTime(s.last_run.created_at)}`}><StatusBadge status={s.last_run.status} /></Link>}
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(s)}>{s.enabled ? "Pause" : "Resume"}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Edit</Button>
              <Button size="sm" variant="ghost" icon="trash" aria-label="Delete schedule" onClick={() => remove.mutate(s.id)} />
            </div>
          </li>
        ))}
      </ul>
      <ScheduleForm open={!!editing} editing={editing} collectionId={collectionId} onClose={() => setEditing(null)} />
    </>
  );
}

export function SchedulesPage() {
  const [creating, setCreating] = useState(false);
  const collections = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  return (
    <>
      <PageHeader title="Schedules" subtitle="Collections that run by themselves, e.g. every weekday morning on Stg."
        actions={<Button variant="primary" icon="plus" disabled={!collections.data?.length} onClick={() => setCreating(true)}>New schedule</Button>} />
      {collections.data?.length === 0 ? (
        <Card><EmptyState icon="clock" title="Add a collection first">Schedules run a collection on an environment at set times.</EmptyState></Card>
      ) : <Card><ScheduleList /></Card>}
      <ScheduleForm open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
