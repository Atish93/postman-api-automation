// Used by check-events.ts: asks for one assertion-change approval, then prints the outcome.
import { loadCollectionFile, recordDiagnosis, patchRequest, closeHuman } from "../../tools.ts";
import { fileURLToPath } from "node:url";
const x: any = {};
loadCollectionFile(fileURLToPath(new URL("../../eval/fixtures/booking-lifecycle-faults.json", import.meta.url)));
await recordDiagnosis.handler({ request: "09 Delete booking", assertion: "x", category: "test_defect", confidence: "high", evidence: "check-events" }, x);
const r: any = await patchRequest.handler(
  { request_name: "09 Delete booking", part: "test_script", new_value: 'pm.test("Deleted", () => pm.response.to.have.status(201));', reason: "check-events" },
  x,
);
console.log(`OUTCOME ${r.isError ? "refused" : "applied"}`);
closeHuman();
