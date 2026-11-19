// Machine-readable events, for a program (the dashboard server) following a run live.
// With QA_EVENTS=1, each event is printed on its own stdout line as: @@event {json}
// Everything else on stdout stays the human-readable log.
const enabled = process.env.QA_EVENTS === "1";
let seq = 0;

export function emit(type: string, data: Record<string, unknown> = {}) {
  if (!enabled) return;
  process.stdout.write(`@@event ${JSON.stringify({ seq: ++seq, time: new Date().toISOString(), type, ...data })}\n`);
}
