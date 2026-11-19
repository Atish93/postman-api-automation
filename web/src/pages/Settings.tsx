import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import { EmailSettingsCard } from "../EmailSettingsCard.tsx";
import { BackupsCard, PasswordCard, RunsCard } from "../AdminCards.tsx";
import { Button, Card, ErrorNote, Field, Icon, PageHeader, Spinner, inputClass, useToast } from "../ui.tsx";

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (k: string | null) => api.savePostmanKey(k),
    onSuccess: (s, k) => {
      setKey("");
      qc.setQueryData(["settings"], s);
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      toast("ok", k ? `Connected to Postman${s.postman.user ? ` as ${s.postman.user}` : ""}` : "Postman key removed");
    },
  });
  const p = settings.data?.postman;
  const s = settings.data?.secrets;

  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-2xl space-y-4">
        <Card title="Postman">
          <div className="space-y-4 p-4">
            {settings.isPending ? <Spinner /> : (
              <div className="flex items-center gap-2 text-sm">
                <Icon name={p?.connected ? "check" : "x"} className={p?.connected ? "text-good" : "text-muted"} />
                {p?.connected ? <>Connected · key ending <span className="font-mono">{p.key_hint}</span></> : "Not connected"}
              </div>
            )}
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (key.trim()) save.mutate(key.trim()); }}>
              <div className="flex-1">
                <Field label={p?.connected ? "Replace the API key" : "Postman API key"} hint={<>Create one in Postman: your avatar → Settings → API keys. It's checked with Postman, then stored encrypted on this machine only.</>}>
                  <input className={`${inputClass} font-mono`} type="password" autoComplete="off" placeholder="PMAK-…" value={key} onChange={(e) => setKey(e.target.value)} />
                </Field>
              </div>
              <Button type="submit" variant="primary" busy={save.isPending && save.variables !== null} disabled={!key.trim()} className="sm:mb-5">Save key</Button>
            </form>
            <ErrorNote error={save.error} />
            {p?.connected && <Button variant="danger" size="sm" busy={save.isPending && save.variables === null} onClick={() => save.mutate(null)}>Remove the key</Button>}
          </div>
        </Card>
        <EmailSettingsCard />
        <PasswordCard />
        <RunsCard />
        <BackupsCard />
        <Card title="Saved secrets">
          <div className="space-y-2 p-4 text-sm text-ink-2">
            <p className="flex items-start gap-2"><Icon name="lock" className="mt-0.5 shrink-0 text-good" /><span>Secret environment variables, the Postman API key and the email password are stored encrypted (AES-256-GCM). They're decrypted only when a run or an email needs them.</span></p>
            {s?.key_source === "file" && <p>The encryption key is in <code className="break-all font-mono text-ink">{s.key_file}</code>. Back it up together with the database: a copy of the database without it can't be read, and if it's lost you'll need to enter your secrets again.</p>}
            {s?.key_source === "env" && <p>The encryption key comes from the <code className="font-mono text-ink">QA_SECRET_KEY</code> environment variable. Keep it somewhere safe: without it, saved secrets can't be read.</p>}
            {s?.key_source === "memory" && <p>This server uses a temporary key: secrets saved now are lost when it stops.</p>}
            <p className="text-xs text-muted">This protects copies of the database (backups, a file shared by mistake). Anyone who can read every file on this computer can read the key too.</p>
          </div>
        </Card>
        <Card title="AI runs">
          <div className="space-y-2 p-4 text-sm text-ink-2">
            <p>AI runs use your Anthropic API key, read from the <code className="font-mono text-ink">ANTHROPIC_API_KEY</code> environment variable when the server starts. It isn't stored or shown here.</p>
            <p>Each AI run's cost is shown on the run and on the dashboard. Plain runs are free.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
