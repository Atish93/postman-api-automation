// Friendly schedule presets <-> 5-field cron expressions (server's local time).

export type Frequency = "weekdays" | "daily" | "weekly" | "hourly" | "custom";
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function toCron(f: { frequency: Frequency; time: string; weekday: number; custom: string }): string {
  const [h, m] = f.time.split(":").map((n) => Number(n));
  switch (f.frequency) {
    case "weekdays": return `${m} ${h} * * 1-5`;
    case "daily": return `${m} ${h} * * *`;
    case "weekly": return `${m} ${h} * * ${f.weekday}`;
    case "hourly": return `0 * * * *`;
    default: return f.custom.trim();
  }
}

const pad = (n: string) => n.padStart(2, "0");

// The reverse, so an existing schedule opens in the right preset.
export function fromCron(cron: string): { frequency: Frequency; time: string; weekday: number; custom: string } {
  const base = { time: "07:00", weekday: 1, custom: cron };
  const f = cron.trim().split(/\s+/);
  if (f.length === 5 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[1]) && f[2] === "*" && f[3] === "*") {
    const time = `${pad(f[1])}:${pad(f[0])}`;
    if (f[4] === "1-5") return { ...base, frequency: "weekdays", time };
    if (f[4] === "*") return { ...base, frequency: "daily", time };
    if (/^[0-6]$/.test(f[4])) return { ...base, frequency: "weekly", time, weekday: Number(f[4]) };
  }
  if (cron.trim() === "0 * * * *") return { ...base, frequency: "hourly" };
  return { ...base, frequency: "custom" };
}

export function describeCron(cron: string): string {
  const p = fromCron(cron);
  switch (p.frequency) {
    case "weekdays": return `Weekdays at ${p.time}`;
    case "daily": return `Every day at ${p.time}`;
    case "weekly": return `Every ${DAYS[p.weekday]} at ${p.time}`;
    case "hourly": return "Every hour";
    default: return `Custom: ${cron}`;
  }
}
