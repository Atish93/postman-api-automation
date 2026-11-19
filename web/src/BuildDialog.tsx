// Start an AI build run: describe what to test; the agents plan it (you approve the plan),
// build the collection, debug and fix it, and publish it to Postman.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { api } from "./api.ts";
import { Button, EmptyState, ErrorNote, Field, Icon, Modal, Spinner, inputClass } from "./ui.tsx";

const EXAMPLES = [
  "Test creating a booking with missing or invalid fields",
  "Test the firstname and lastname filters on GET /booking, including names that don't exist",
  "Test updating and deleting bookings without a token, with a wrong token, and with a valid one",
];

export function BuildDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: open });
  const connected = settings.data?.postman.connected;
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments, enabled: open });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, enabled: open && !!connected });
  const [request, setRequest] = useState("");
  const [envId, setEnvId] = useState<number | null>(null);
  const [ws, setWs] = useState<string | null>(null);
  const chosenEnv = envId ?? envs.data?.[0]?.id ?? null;
  const chosenWs = ws ?? workspaces.data?.[0]?.id ?? null;
  const ready = request.trim().length >= 15 && chosenEnv && chosenWs;

  const start = useMutation({
    mutationFn: () => api.startRun({ kind: "ai", ai_mode: "build", request: request.trim(), workspace_id: chosenWs!, environment_id: chosenEnv! }),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      onClose();
      navigate(`/runs/${run.id}`);
    },
  });

  let body;
  if (settings.isPending || envs.isPending) body = <div className="py-8 text-center text-muted"><Spinner /></div>;
  else if (!connected)
    body = (
      <EmptyState icon="key" title="Connect Postman first" action={<Link to="/settings" onClick={onClose}><Button variant="primary">Connect Postman</Button></Link>}>
        The agents publish the new collection to your Postman workspace.
      </EmptyState>
    );
  else if (envs.data?.length === 0)
    body = (
      <EmptyState icon="globe" title="Create an environment first" action={<Link to="/environments/new" onClick={onClose}><Button variant="primary">New environment</Button></Link>}>
        The agents need to know which server to test.
      </EmptyState>
    );
  else
    body = (
      <div className="space-y-4">
        <Field label="What should be tested?" hint="A sentence or two, like you'd brief a colleague. The agents look up the API docs and your conventions themselves.">
          <textarea className={inputClass} rows={3} value={request} onChange={(e) => setRequest(e.target.value)} placeholder={EXAMPLES[0]} autoFocus />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" onClick={() => setRequest(ex)} className="rounded-full border border-line px-2.5 py-1 text-left text-xs text-ink-2 hover:border-accent hover:text-ink">{ex}</button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Environment" hint="Where the new tests run">
            <select className={inputClass} value={chosenEnv ?? ""} onChange={(e) => setEnvId(Number(e.target.value))}>
              {envs.data?.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </Field>
          <Field label="Postman workspace" hint="Where the collection is published">
            <select className={inputClass} value={chosenWs ?? ""} onChange={(e) => setWs(e.target.value)} disabled={workspaces.isPending}>
              {workspaces.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
        </div>
        <ol className="space-y-1.5 rounded-lg bg-page p-3 text-xs text-ink-2 ring-1 ring-line">
          {[
            ["sparkle", "The planner writes test cases. You approve the plan, or send it back with changes. Nothing is built before you approve."],
            ["play", "The builder creates the collection and runs it. The debugger and self-healer handle failures; changes to assertions wait for you."],
            ["upload", "It's published to Postman and added to your Collections here, with known API bugs marked."],
          ].map(([icon, text]) => <li key={text} className="flex gap-2"><Icon name={icon} size={13} className="mt-0.5 shrink-0 text-accent" />{text}</li>)}
          <li className="pt-1 text-muted">Usually takes a few minutes and costs roughly $0.30–$1.50 in AI usage, shown on the run.</li>
        </ol>
        <ErrorNote error={workspaces.error ?? start.error} />
      </div>
    );

  return (
    <Modal open={open} onClose={onClose} title="Build a new collection with AI" wide
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {connected && !!envs.data?.length && <Button variant="primary" icon="sparkle" busy={start.isPending} disabled={!ready} onClick={() => start.mutate()}>Start building</Button>}
      </>}
    >
      {body}
    </Modal>
  );
}
