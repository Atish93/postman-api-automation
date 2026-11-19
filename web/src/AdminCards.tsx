// Settings cards for running the dashboard: the password and sessions, runs at the same time, backups.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import { relativeTime, dateTime } from "./format.ts";
import { Button, Card, ErrorNote, Field, Icon, Spinner, inputClass, useToast } from "./ui.tsx";

const browser = (ua: string | null) => {
  if (!ua) return "Unknown browser";
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl|node|undici/i.test(ua) ? "Script" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
};

export function PasswordCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["auth"], queryFn: api.authStatus });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions, enabled: !!status.data?.enabled });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => { setCurrent(""); setNext(""); toast("ok", "Password changed. Other sessions were logged out."); qc.invalidateQueries({ queryKey: ["sessions"] }); },
  });
  const others = useMutation({
    mutationFn: api.logoutOthers,
    onSuccess: (r) => { toast("ok", `Logged out ${r.ended} other session${r.ended === 1 ? "" : "s"}`); qc.invalidateQueries({ queryKey: ["sessions"] }); },
    onError: (e) => toast("error", e.message),
  });
  if (!status.data?.enabled) return null;
  const otherCount = sessions.data?.filter((s) => !s.current).length ?? 0;
  return (
    <Card title="Password and sessions">
      <form className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
        <Field label="Current password"><input className={inputClass} type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 10 characters"><input className={inputClass} type="password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Button type="submit" variant="primary" busy={change.isPending} disabled={!current || next.length < 10} className="sm:mb-5">Change</Button>
      </form>
      <div className="px-4"><ErrorNote error={change.error} /></div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 pt-3 text-sm font-medium">
        Logged in on
        {otherCount > 0 && <Button size="sm" variant="ghost" busy={others.isPending} onClick={() => others.mutate()}>Log out the other {otherCount}</Button>}
      </div>
      {sessions.isPending ? <div className="p-4 text-muted"><Spinner /></div> : (
        <ul className="divide-y divide-line">
          {sessions.data?.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <Icon name="monitor" className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                {browser(s.user_agent)}{s.current && <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-xs text-ink-2 ring-1 ring-line">this one</span>}
                <span className="block text-xs text-muted">{s.ip ?? "unknown address"} · active {relativeTime(s.last_seen_at)} · since {dateTime(s.created_at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RunsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [n, setN] = useState(2);
  const r = settings.data?.runs;
  useEffect(() => { if (r) setN(r.max_parallel); }, [r?.max_parallel]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api.saveRunSettings(n),
    onSuccess: () => { toast("ok", `Up to ${n} run${n === 1 ? "" : "s"} at the same time`); qc.invalidateQueries({ queryKey: ["settings"] }); },
  });
  if (!r) return null;
  return (
    <Card title="Runs">
      <form className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="flex-1">
          <Field label="Runs at the same time" hint="Others wait in the queue. Two runs of the same collection on the same environment never run together, since they'd use the same data. More at once means more load on the API you test. An AI run costs the same whether or not others run beside it.">
            <select className={inputClass} value={n} onChange={(e) => setN(Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8].map((v) => <option key={v} value={v}>{v}{v === 1 ? " (one after another)" : ""}</option>)}
            </select>
          </Field>
        </div>
        <Button type="submit" variant="primary" busy={save.isPending} disabled={n === r.max_parallel} className="sm:mb-5">Apply</Button>
      </form>
      <p className="px-4 pb-4 text-xs text-muted">Now: {r.running} running, {r.queued} waiting.</p>
      <div className="px-4"><ErrorNote error={save.error} /></div>
    </Card>
  );
}

const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

export function BackupsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["backups"], queryFn: api.backups, retry: false });
  const make = useMutation({
    mutationFn: api.backupNow,
    onSuccess: (b) => { toast("ok", `Backup made: ${b.name}`); qc.invalidateQueries({ queryKey: ["backups"] }); },
    onError: (e) => toast("error", e.message),
  });
  return (
    <Card title="Backups" actions={<Button size="sm" icon="download" busy={make.isPending} onClick={() => make.mutate()}>Back up now</Button>}>
      {q.isPending ? <div className="p-4 text-muted"><Spinner /></div> : q.error ? <div className="p-4"><ErrorNote error={q.error} /></div> : q.data && (
        <>
          <div className="space-y-2 p-4 text-sm text-ink-2">
            <p>{q.data.automatic ? <>A backup of the database is made automatically every day; the newest {q.data.keep} are kept. Ones you make here are kept until you delete them.</> : "Automatic backups are off (QA_BACKUPS=off)."} They're in <code className="break-all font-mono text-ink">{q.data.dir}</code>.</p>
            <p className="flex gap-2"><Icon name="lock" className="mt-0.5 shrink-0 text-muted" /><span>Backups don't include the encryption key{q.data.key_file && <> (<code className="break-all font-mono text-ink">{q.data.key_file}</code>)</>}, so a copied backup alone exposes no secrets. Keep a copy of the key somewhere safe too: a backup restored without it loses its saved secrets.</span></p>
            <p className="text-xs text-muted">To restore: stop the server, then run <code className="font-mono">npm run restore -- &lt;backup file&gt;</code> in the server folder.</p>
          </div>
          {q.data.backups.length === 0 ? <p className="border-t border-line px-4 py-3 text-sm text-muted">No backups yet.</p> : (
            <ul className="max-h-72 divide-y divide-line overflow-auto border-t border-line">
              {q.data.backups.map((b) => (
                <li key={b.name} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <Icon name={b.kind === "auto" ? "clock" : "download"} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{b.name}</span>
                    <span className="text-xs text-muted">{b.kind === "auto" ? "Daily" : "Made by hand"} · {relativeTime(b.created_at)} · {size(b.size)}</span>
                  </span>
                  <a href={api.backupUrl(b.name)} download><Button size="sm" variant="ghost" icon="download" aria-label={`Download ${b.name}`} /></a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
