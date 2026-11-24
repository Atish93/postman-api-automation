// A stand-in for agent/followup.ts in the server's tests: no model calls. It reads the job the server wrote,
// emits events like the real one, and writes a result file shaped like the real one's.
//   debug: finds an API bug and suggests a test change.   fix: the collection now passes.
// FAKE_FOLLOWUP_EXIT makes it exit with that code instead (e.g. 1, to test a failed follow-up).
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const at = args.indexOf("--env");
if (at >= 0) args.splice(at, 2);
const job = JSON.parse(readFileSync(args[0], "utf8"));
const emit = (type: string, data: Record<string, unknown>) => console.log(`@@event ${JSON.stringify({ seq: 1, time: new Date().toISOString(), type, ...data })}`);
emit("followup_started", { kind: job.kind, request: job.request });
console.log(`[fake] job for "${job.request}" with ${job.collection?.item?.length ?? 0} items, ${job.failures.length} failures, note: ${job.note ?? "none"}`);

const code = Number(process.env.FAKE_FOLLOWUP_EXIT ?? 0);
const name = job.request;
const result = job.kind === "debug"
  ? {
      collections: [{
        name: job.collection.info.name,
        issues: [{
          request: name, state: "failing",
          probes: [{ for_request: name, purpose: "asked again", method: "GET", url: "http://x/items", status: 500, request_headers: [], request_body: "", response_body: "{}", at: new Date().toISOString() }],
          diagnoses: [{
            request: name, assertion: job.failures.find((f: any) => f.request === name)?.assertion ?? "x", category: "api_bug", confidence: "high",
            evidence: `Probed again (note: ${job.note ?? "none"}).`,
            causes: [{ title: "The endpoint crashes", likelihood: "high", explanation: "It answers 500 every time." }],
            fixes: [
              { kind: "report_api_bug", title: "Report it", detail: "It answers 500.", recommended: true },
              { kind: "change_test", title: "Point it at the right URL", detail: "The test calls the wrong path.", change: "- {{baseUrl}}/wrong\n+ {{baseUrl}}/items" },
            ],
          }],
        }],
      }],
      cost_usd: 0.12, report: "It is an API bug.",
    }
  : {
      environment: { label: "fake" },
      collections: [{
        name: job.collection.info.name, requests: 2, assertions: 2, failed_assertions: 0, failures: [], diagnoses: [], known_bugs: [], known_bugs_now_passing: [],
        changes: [`${name} (url, approved by human): ${job.fix?.title}\n    - {{baseUrl}}/wrong\n    + {{baseUrl}}/items`],
        executions: [], issues: [], collection: job.collection, published: null, updated: null,
      }],
      ...(job.plan && { contract: { name: "c", plan: job.plan, review_rounds: 1, collection: job.collection } }),
      cost_usd: 0.3, report: "Applied the fix; everything passes.",
    };
if (process.env.QA_RESULT_FILE) writeFileSync(process.env.QA_RESULT_FILE, JSON.stringify({ kind: job.kind, exit_code: code, ...result }));
emit("followup_finished", { kind: job.kind, request: name, exit_code: code });
process.exit(code);
