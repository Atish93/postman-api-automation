// Views across all runs: known bugs, and the changes the self-healer made.
import type { FastifyInstance } from "fastify";
import type { DB } from "../db.ts";

const PREFIX = "KNOWN BUG - ";
const strip = (name: string) => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);

// From one run's stored results: which KNOWN BUG requests it ran, and which of them failed.
function knownBugsIn(resultJson: string | null) {
  const present = new Set<string>(), failing = new Set<string>();
  const evidence = new Map<string, string>();
  if (!resultJson) return { present, failing, evidence };
  const r = JSON.parse(resultJson);
  if (Array.isArray(r.executions)) {
    for (const e of r.executions) {
      if (!e.request?.startsWith(PREFIX)) continue;
      present.add(strip(e.request));
      if (e.assertions?.some((a: any) => a.error) || e.error || (e.status ?? 0) >= 500) failing.add(strip(e.request));
    }
  } else {
    for (const c of r.collections ?? []) {
      for (const n of c.known_bugs ?? []) present.add(strip(n));
      for (const f of c.failures ?? []) if (f.request?.startsWith(PREFIX)) failing.add(strip(f.request));
      for (const d of c.diagnoses ?? []) if (d.category === "api_bug") evidence.set(strip(d.request), d.evidence);
    }
  }
  return { present, failing, evidence };
}

function evidenceFromCollection(db: DB, collectionId: number, request: string): string | null {
  const row = db.prepare("SELECT json FROM collections WHERE id = ?").get(collectionId) as any;
  if (!row) return null;
  const find = (items: any[] = []): any => items.map((i) => (i.item ? find(i.item) : i.name === PREFIX + request ? i : null)).find(Boolean);
  const item = find(JSON.parse(row.json).item);
  const d = item?.request?.description;
  const text = typeof d === "string" ? d : d?.content;
  const m = text?.match(/fails because of an API bug:\s*([\s\S]*)/);
  return m ? m[1].replace(/^- [^:]+:\s*/gm, "").trim() || null : null;
}

export function insightsRoutes(app: FastifyInstance, db: DB) {
  // Every known bug, per collection and environment: open (failing in the latest run) or possibly fixed (passing in it).
  app.get("/api/known-bugs", async () => {
    const runs = db.prepare(`SELECT id, collection_id, collection_name, environment_id, environment_label, finished_at, result_json FROM runs
      WHERE finished_at IS NOT NULL AND status IN ('passed', 'passed_with_known_bugs', 'failed') ORDER BY id`).all() as any[];
    type Bug = {
      request: string; collection: { id: number | null; name: string }; environment: string;
      first_seen: { run_id: number; at: string }; last_failed: { run_id: number; at: string };
      times_failed: number; evidence: string | null; status: "open" | "may_be_fixed"; latest_run_id: number;
    };
    const bugs = new Map<string, Bug>();
    const latestRun = new Map<string, number>(); // collection+environment -> latest run id
    const keyOf = (r: any) => `${r.collection_id ?? "deleted:" + r.collection_name}|${r.environment_id ?? "deleted:" + r.environment_label}`;

    for (const r of runs) {
      const scope = keyOf(r);
      latestRun.set(scope, r.id);
      const { present, failing, evidence } = knownBugsIn(r.result_json);
      for (const name of present) {
        const k = `${scope}|${name}`;
        let b = bugs.get(k);
        if (!b && failing.has(name)) {
          b = {
            request: name, collection: { id: r.collection_id, name: r.collection_name }, environment: r.environment_label,
            first_seen: { run_id: r.id, at: r.finished_at }, last_failed: { run_id: r.id, at: r.finished_at },
            times_failed: 0, evidence: null, status: "open", latest_run_id: r.id,
          };
          bugs.set(k, b);
        }
        if (!b) continue;
        b.latest_run_id = r.id;
        b.status = failing.has(name) ? "open" : "may_be_fixed";
        if (failing.has(name)) {
          b.times_failed++;
          b.last_failed = { run_id: r.id, at: r.finished_at };
        }
        if (evidence.has(name)) b.evidence = evidence.get(name)!;
      }
    }
    // Only bugs still part of the latest run of their collection + environment.
    const list = [...bugs.entries()]
      .filter(([k, b]) => latestRun.get(k.split("|").slice(0, 2).join("|")) === b.latest_run_id)
      .map(([, b]) => b);
    // No diagnosis in the runs (e.g. only repeats since)? Use the evidence the agents wrote into the
    // request's description when they marked it, from the collection as last imported.
    for (const b of list) if (!b.evidence && b.collection.id) b.evidence = evidenceFromCollection(db, b.collection.id, b.request);
    return list.sort((a, b) => (a.status === b.status ? b.last_failed.at.localeCompare(a.last_failed.at) : a.status === "open" ? -1 : 1));
  });

  // Every change the self-healer made, with what happened to it.
  app.get("/api/changes", async () => {
    const events = db.prepare(`SELECT e.run_id, e.seq, e.type, e.data_json, e.created_at, r.collection_id, r.collection_name, r.environment_label
      FROM run_events e JOIN runs r ON r.id = e.run_id
      WHERE e.type IN ('change_pending', 'change_kept', 'change_reverted') ORDER BY e.run_id DESC, e.seq`).all() as any[];
    const changes: any[] = [];
    for (const e of events) {
      const d = JSON.parse(e.data_json);
      if (e.type === "change_pending") {
        changes.push({
          run_id: e.run_id, at: e.created_at, collection: { id: e.collection_id, name: e.collection_name }, environment: e.environment_label,
          request: d.request, part: d.part, reason: d.reason, diff: d.diff ?? [], approved_by_human: !!d.approved_by_human, outcome: "unproven",
        });
      } else {
        // The proof-or-revert result for the latest unresolved change to this request in this run.
        const c = [...changes].reverse().find((x) => x.run_id === e.run_id && x.request === d.request && x.outcome === "unproven");
        if (c) c.outcome = e.type === "change_kept" ? "kept" : "reverted";
      }
    }
    return changes;
  });
}
