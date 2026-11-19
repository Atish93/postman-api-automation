// Who gets a collection's run reports by email, and when.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type ReportRule } from "./api.ts";
import { Button, Card, ErrorNote, Icon, inputClass, useToast } from "./ui.tsx";

const WHEN: { value: ReportRule["send_when"]; label: string; text: string }[] = [
  { value: "new_failure", label: "Only new failures", text: "Something fails that didn't last time, or a run stops passing. No repeat emails about the same problem." },
  { value: "failure", label: "Every failure", text: "Every run that doesn't pass." },
  { value: "always", label: "Every run", text: "Including runs that pass." },
];
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function ReportsCard({ collectionId }: { collectionId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rule = useQuery({ queryKey: ["report-rule", collectionId], queryFn: () => api.reportRule(collectionId) });
  const email = useQuery({ queryKey: ["email-settings"], queryFn: api.emailSettings });
  const [draft, setDraft] = useState<ReportRule | null>(null);
  const [input, setInput] = useState("");
  useEffect(() => { if (rule.data) setDraft(rule.data); }, [rule.data]);
  const save = useMutation({
    mutationFn: (r: ReportRule) => api.saveReportRule(collectionId, r),
    onSuccess: (r) => { qc.setQueryData(["report-rule", collectionId], r); toast("ok", "Report settings saved"); },
  });
  if (!draft) return null;

  const add = () => {
    const parts = input.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((p) => !isEmail(p));
    if (bad.length) return toast("error", `Not an email address: ${bad.join(", ")}`);
    setDraft({ ...draft, recipients: [...new Set([...draft.recipients, ...parts])] });
    setInput("");
  };
  const changed = JSON.stringify(draft) !== JSON.stringify(rule.data);

  return (
    <Card title="Reports by email">
      <div className="space-y-4 p-4">
        {email.data && !email.data.configured && (
          <p className="flex items-start gap-2 rounded-lg bg-page p-3 text-xs text-ink-2 ring-1 ring-line">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-warning" />
            <span>Email isn't set up yet, so nothing will be sent. <Link to="/settings" className="text-accent hover:underline">Add your mail server in Settings</Link>.</span>
          </p>
        )}
        <div>
          <div className="mb-1 text-sm font-medium">Send to</div>
          <div className="flex flex-wrap gap-1.5">
            {draft.recipients.map((r) => (
              <span key={r} className="inline-flex items-center gap-1 rounded-full bg-raised py-0.5 pl-2.5 pr-1 text-xs ring-1 ring-line">
                {r}<button className="rounded-full p-0.5 text-muted hover:text-bad-ink" aria-label={`Remove ${r}`} onClick={() => setDraft({ ...draft, recipients: draft.recipients.filter((x) => x !== r) })}><Icon name="x" size={12} /></button>
              </span>
            ))}
            {!draft.recipients.length && <span className="text-xs text-muted">No one yet.</span>}
          </div>
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input aria-label="Email addresses" className={inputClass} placeholder="name@example.com, another@example.com" value={input} onChange={(e) => setInput(e.target.value)} />
            <Button type="submit" disabled={!input.trim()}>Add</Button>
          </form>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm font-medium">When</legend>
          {WHEN.map((w) => (
            <label key={w.value} className="flex cursor-pointer gap-2.5 text-sm">
              <input type="radio" name={`when-${collectionId}`} className="mt-1 accent-[var(--accent)]" checked={draft.send_when === w.value} onChange={() => setDraft({ ...draft, send_when: w.value })} />
              <span><span className="font-medium">{w.label}</span><span className="block text-xs text-ink-2">{w.text}</span></span>
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--accent)]" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />Send reports for this collection</label>
        <ErrorNote error={save.error} />
        <div className="flex justify-end"><Button variant="primary" disabled={!changed} busy={save.isPending} onClick={() => save.mutate(draft)}>Save</Button></div>
      </div>
    </Card>
  );
}
