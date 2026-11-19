// Formatting for times, durations, money and percentages.

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

export const dateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export const money = (usd: number | null | undefined) =>
  usd == null ? "" : usd === 0 ? "$0" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;

export const percent = (ratio: number | null | undefined) => (ratio == null ? "–" : `${Math.round(ratio * 100)}%`);

export const shortDate = (isoDay: string) =>
  new Date(`${isoDay}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
