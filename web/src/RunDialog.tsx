// Start a run: choose the environment, and plain or AI.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { api, type Collection } from "./api.ts";
import { Button, ErrorNote, Field, Icon, Modal, inputClass } from "./ui.tsx";

export function RunDialog({ collection, open, onClose }: { collection: Pick<Collection, "id" | "name" | "source">; open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const envs = useQuery({ queryKey: ["environments"], queryFn: api.environments, enabled: open });
  const [envId, setEnvId] = useState<number | null>(null);
  const [kind, setKind] = useState<"plain" | "ai">("plain");
  const chosenEnv = envId ?? envs.data?.[0]?.id ?? null;
  const aiAllowed = collection.source === "postman";

  const start = useMutation({
    mutationFn: () => api.startRun(kind === "ai" ? { kind, ai_mode: "regression", collection_id: collection.id, environment_id: chosenEnv! } : { kind, collection_id: collection.id, environment_id: chosenEnv! }),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      onClose();
      navigate(`/runs/${run.id}`);
    },
  });

  const option = (value: "plain" | "ai", title: string, text: string, disabledReason?: string) => (
    <label className={`flex gap-3 rounded-lg border p-3 ${kind === value ? "border-accent bg-raised" : "border-line"} ${disabledReason ? "opacity-60" : "cursor-pointer hover:bg-raised"}`}>
      <input type="radio" name="kind" className="mt-1 accent-[var(--accent)]" checked={kind === value} disabled={!!disabledReason} onChange={() => setKind(value)} />
      <span>
        <span className="flex items-center gap-1.5 text-sm font-medium">{value === "ai" && <Icon name="sparkle" size={14} className="text-accent" />}{title}</span>
        <span className="block text-xs text-ink-2">{disabledReason ?? text}</span>
      </span>
    </label>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Run "${collection.name}"`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="play" busy={start.isPending} disabled={!chosenEnv} onClick={() => start.mutate()}>Start run</Button>
      </>}
    >
      <div className="space-y-4">
        {envs.data?.length === 0 ? (
          <p className="text-sm text-ink-2">You need an environment first. <Link to="/environments/new" className="text-accent hover:underline" onClick={onClose}>Create one</Link>.</p>
        ) : (
          <Field label="Environment">
            <select className={inputClass} value={chosenEnv ?? ""} onChange={(e) => setEnvId(Number(e.target.value))}>
              {envs.data?.map((e) => <option key={e.id} value={e.id}>{e.label} ({e.base_url})</option>)}
            </select>
          </Field>
        )}
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Kind of run</legend>
          {option("plain", "Plain run", "Runs the collection with Newman. Free, usually done in seconds.")}
          {option("ai", "AI run", "The agents re-check the collection: they debug failures, fix broken tests, mark API bugs as known bugs and update the collection in Postman. Costs a few cents; changes to assertions wait for your approval.",
            aiAllowed ? undefined : "AI runs need a collection imported from Postman. This one was uploaded.")}
        </fieldset>
        <ErrorNote error={start.error} />
      </div>
    </Modal>
  );
}
