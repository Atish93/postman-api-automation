// How the agents' events read on the run page and the debug page: an icon and a sentence each.
import { Link } from "react-router";
import type { RunEvent } from "./api.ts";

// ---------- AI runs: what the agents did ----------
export const EVENT_LOOK: Record<string, { icon: string; color?: string }> = {
  agent_message: { icon: "sparkle", color: "var(--accent)" },
  agent_started: { icon: "play" },
  tool_call: { icon: "chevron" },
  collection_loaded: { icon: "folder" },
  collection_run: { icon: "list" },
  diagnosis: { icon: "bug", color: "var(--status-warning)" },
  change_pending: { icon: "refresh" },
  change_kept: { icon: "check", color: "var(--status-good)" },
  change_reverted: { icon: "x", color: "var(--status-critical)" },
  known_bugs_marked: { icon: "bug", color: "var(--status-warning)" },
  learned: { icon: "sparkle" },
  approval_request: { icon: "alert", color: "var(--status-warning)" },
  approval_answer: { icon: "check" },
  server_errors: { icon: "plug", color: "var(--status-serious)" },
  server_issue: { icon: "plug", color: "var(--status-serious)" },
  circuit_breaker: { icon: "pause", color: "var(--status-serious)" },
  published: { icon: "upload", color: "var(--status-good)" },
  collection_imported: { icon: "folder", color: "var(--status-good)" },
  email_sent: { icon: "upload", color: "var(--status-good)" },
  email_failed: { icon: "alert", color: "var(--status-critical)" },
  updated: { icon: "upload", color: "var(--status-good)" },
  cases_approved: { icon: "check", color: "var(--status-good)" },
  followup_started: { icon: "sparkle", color: "var(--accent)" },
  followup_finished: { icon: "check" },
};

// One line of an agent message, without Markdown markers.
export const plain = (t: string) => t.replace(/\*\*|`|^#+\s*/g, "");

export function describe(e: RunEvent): React.ReactNode {
  const d = e.data;
  switch (e.type) {
    case "agent_message": return <><span className="font-medium capitalize">{d.agent}</span>: <span className="text-ink-2">{plain(String(d.text).split("\n")[0]).slice(0, 220)}</span></>;
    case "agent_started": return <><span className="font-medium capitalize">{d.agent}</span> started the <span className="font-medium">{d.target}</span></>;
    case "tool_call": return <><span className="capitalize">{d.agent}</span> <span className="text-ink-2">used</span> <span className="font-mono text-xs">{d.target}</span></>;
    case "collection_loaded": return <>Loaded <span className="font-medium">{d.name}</span></>;
    case "collection_run": return <>Ran the collection: {d.requests} requests, <span className="font-medium">{d.failed_assertions} failed check{d.failed_assertions === 1 ? "" : "s"}</span></>;
    case "diagnosis": return <>Diagnosed <span className="font-medium">{d.request}</span> as <span className="font-medium">{String(d.category).replace("_", " ")}</span> ({d.confidence} confidence)</>;
    case "change_pending": return <>Changed {d.part} of <span className="font-medium">{d.request}</span>{d.approved_by_human ? " (approved by you)" : ""}</>;
    case "change_kept": return <>Kept the change to <span className="font-medium">{d.request}</span>: it now passes</>;
    case "change_reverted": return <>Undid the change to <span className="font-medium">{d.request}</span>: it didn't fix the test</>;
    case "known_bugs_marked": return <>Marked as known bugs: {(d.requests ?? []).join(", ")}</>;
    case "learned": return <>Saved to the knowledge base: <span className="text-ink-2">{d.title}</span></>;
    case "cases_approved": return <>You approved {d.cases} test case{d.cases === 1 ? "" : "s"}{d.edited ? ", with your changes" : ""}</>;
    case "approval_request": return d.kind === "test_cases" ? <>Asked you to review {d.plan?.cases?.length ?? ""} test cases</> : <>Asked for approval{d.request ? ` (${d.request})` : ""}</>;
    case "approval_answer": return <>Your answer: <span className="font-medium">{d.answer === "y" ? "approved" : String(d.answer ?? "").startsWith("{") ? "approved with your changes" : d.answer ?? "no answer"}</span></>;
    case "followup_started": return d.kind === "debug" ? <>The debugger was asked to look at <span className="font-medium">{d.request}</span> again</> : <>The self-healer started applying the chosen fix to <span className="font-medium">{d.request}</span></>;
    case "followup_finished": return <>{d.kind === "debug" ? "The debugger" : "The self-healer"} finished{d.exit_code ? <span className="text-bad-ink"> early (exit code {d.exit_code})</span> : ""}</>;
    case "server_errors": return <>{d.summary}</>;
    case "server_issue": return <span className="font-medium">{d.message}</span>;
    case "circuit_breaker": return <>Circuit breaker tripped: {d.requests_needing_diagnosis} requests failing (trips at {d.trips_at})</>;
    case "published": return <>Published <span className="font-medium">{d.name}</span> to Postman</>;
    case "updated": return <>Saved the collection back to Postman</>;
    case "email_sent": return <>Emailed the report to {(d.recipients ?? []).join(", ")} <span className="text-ink-2">({d.reason})</span></>;
    case "email_failed": return <>Couldn't email the report: <span className="text-ink-2">{d.error}</span></>;
    case "collection_imported": return <>Added <Link to={`/collections/${d.collection_id}`} className="font-medium text-accent hover:underline">{d.name}</Link> to your collections</>;
    default: return null;
  }
}

