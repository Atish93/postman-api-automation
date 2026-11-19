// Test-data files: a CSV or JSON table attached to a collection. A plain run with a data file runs
// the collection once per row (Newman's iteration data); each row's columns are variables, e.g. {{email}}.
import { HttpError } from "./errors.ts";

export const MAX_BYTES = 1_000_000;
export const MAX_ROWS = 1000;

export type ParsedData = { format: "csv" | "json"; columns: string[]; rows: Record<string, string>[] };

// RFC 4180 CSV: commas, quoted fields with "" for a quote, newlines inside quotes, CRLF or LF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0;
  text = text.replace(/^﻿/, ""); // Excel's byte-order mark
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new HttpError(400, "The CSV has a quote that is never closed.");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === "")); // blank lines
}

export function parseDataFile(name: string, content: string): ParsedData {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new HttpError(400, `The file is larger than ${MAX_BYTES / 1_000_000} MB.`);
  const format = /\.json$/i.test(name) || /^\s*[[{]/.test(content) ? "json" : "csv";
  let columns: string[], rows: Record<string, string>[];
  if (format === "csv") {
    const table = parseCsv(content);
    if (table.length < 2) throw new HttpError(400, "The CSV needs a header row (the variable names) and at least one row of values.");
    columns = table[0].map((h) => h.trim());
    if (columns.some((c) => !c)) throw new HttpError(400, "Every column in the header row needs a name.");
    if (new Set(columns).size !== columns.length) throw new HttpError(400, "Two columns in the header row have the same name.");
    table.slice(1).forEach((r, n) => {
      if (r.length !== columns.length) throw new HttpError(400, `Row ${n + 1} has ${r.length} values but the header has ${columns.length} columns.`);
    });
    rows = table.slice(1).map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j]])));
  } else {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (e: any) {
      throw new HttpError(400, `The JSON can't be read: ${e.message}`);
    }
    if (!Array.isArray(data) || !data.length || !data.every((r) => r && typeof r === "object" && !Array.isArray(r)))
      throw new HttpError(400, 'The JSON must be a list of objects, one per run, e.g. [{"email": "a@example.com"}, {"email": "b@example.com"}].');
    columns = [...new Set(data.flatMap((r) => Object.keys(r as object)))];
    // Variables are text; nested values are passed as JSON.
    rows = (data as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])));
  }
  if (rows.length > MAX_ROWS) throw new HttpError(400, `The file has ${rows.length} rows; the most is ${MAX_ROWS}.`);
  return { format, columns, rows };
}

// Which of the file's columns the collection uses as {{variables}} (in URLs, headers, bodies or scripts).
export function columnUse(collectionJson: string, columns: string[]) {
  const used = new Set([...collectionJson.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((m) => m[1]));
  for (const m of collectionJson.matchAll(/(?:iterationData|data)\.get\(\\?["']([^"'\\]+)\\?["']\)/g)) used.add(m[1]);
  return { used: columns.filter((c) => used.has(c)), unused: columns.filter((c) => !used.has(c)) };
}
