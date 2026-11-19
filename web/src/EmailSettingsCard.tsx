// The mail server used for run reports.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import { Button, Card, ErrorNote, Field, Icon, inputClass, useToast } from "./ui.tsx";

export function EmailSettingsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["email-settings"], queryFn: api.emailSettings });
  const [f, setF] = useState({ host: "", port: 465, secure: true, user: "", from: "", dashboard_url: "http://127.0.0.1:4000" });
  const [password, setPassword] = useState("");
  const [testTo, setTestTo] = useState("");
  useEffect(() => {
    if (q.data) {
      const { host, port, secure, user, from, dashboard_url } = q.data;
      setF({ host, port, secure, user, from, dashboard_url });
      setTestTo((t) => t || user);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.saveEmailSettings({ ...f, password: password || null }),
    onSuccess: (s) => { setPassword(""); qc.setQueryData(["email-settings"], s); toast("ok", "Email settings saved"); },
  });
  const test = useMutation({
    mutationFn: () => api.sendTestEmail(testTo.trim()),
    onSuccess: () => toast("ok", `Test email sent to ${testTo.trim()}. Check the inbox (and spam).`),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: k === "port" ? Number(e.target.value) : e.target.value });
  const gmail = () => setF({ ...f, host: "smtp.gmail.com", port: 465, secure: true });

  return (
    <Card title="Email" actions={<button className="text-xs text-accent hover:underline" onClick={gmail}>Use Gmail settings</button>}>
      <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="text-sm text-ink-2">The mail server that sends run reports. For Gmail, use an <a className="text-accent hover:underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">app password</a> (needs 2-step verification), not your normal password.</p>
        <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
          <Field label="SMTP server"><input className={`${inputClass} font-mono`} required value={f.host} onChange={set("host")} placeholder="smtp.gmail.com" /></Field>
          <Field label="Port"><input className={`${inputClass} font-mono`} required type="number" value={f.port} onChange={set("port")} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--accent)]" checked={f.secure} onChange={(e) => setF({ ...f, secure: e.target.checked })} />Use SSL (port 465). Leave off for port 587, which upgrades to TLS by itself.</label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username"><input className={inputClass} value={f.user} onChange={set("user")} placeholder="you@gmail.com" autoComplete="off" /></Field>
          <Field label="Password" hint={q.data?.has_password ? "Saved. Leave empty to keep it." : "For Gmail: the 16-character app password."}>
            <input className={`${inputClass} font-mono`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={q.data?.has_password ? "••••••••" : ""} autoComplete="new-password" />
          </Field>
          <Field label="From" hint="Optional; defaults to the username"><input className={inputClass} value={f.from} onChange={set("from")} placeholder="QA Dashboard <you@gmail.com>" /></Field>
          <Field label="Dashboard address" hint="Used for the links in emails"><input className={`${inputClass} font-mono`} required type="url" value={f.dashboard_url} onChange={set("dashboard_url")} /></Field>
        </div>
        <ErrorNote error={save.error} />
        <div className="flex justify-end"><Button type="submit" variant="primary" busy={save.isPending}>Save</Button></div>
      </form>
      {q.data?.configured && (
        <form className="flex flex-col gap-2 border-t border-line p-4 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); test.mutate(); }}>
          <div className="flex-1"><Field label="Send a test email to"><input className={inputClass} type="email" required value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field></div>
          <Button type="submit" icon="sparkle" busy={test.isPending}>Send test</Button>
        </form>
      )}
      {test.error && <div className="px-4 pb-4"><ErrorNote error={test.error} /></div>}
      {test.isSuccess && <p className="flex items-center gap-1.5 px-4 pb-4 text-sm text-good-ink"><Icon name="check" size={14} />Sent.</p>}
    </Card>
  );
}
