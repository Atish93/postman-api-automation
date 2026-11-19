// A small Markdown renderer for the agents' reports: headings, paragraphs, lists, tables,
// **bold**, `code` and [links](…). Builds React elements; never injects HTML.
import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={i++} className="font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={i++} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em] ring-1 ring-line">{t.slice(1, -1)}</code>);
    else {
      const [, label, href] = t.match(/\[([^\]]+)\]\(([^)]+)\)/)!;
      out.push(/^https?:\/\//.test(href) ? <a key={i++} href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">{label}</a> : label);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { blocks.push(<h3 key={k++} className="mt-4 font-semibold first:mt-0">{inline(h[2])}</h3>); i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={k++} className="relative my-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr>{head.map((c, j) => <th key={j} className="border-b border-line px-2 py-1 font-medium">{inline(c)}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className="border-b border-line px-2 py-1 align-top">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const mm = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)/)!;
        items.push({ depth: mm[1].length >= 2 ? 1 : 0, text: mm[3] });
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={k++} className={`my-2 space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, j) => <li key={j} className={it.depth ? "ml-4 list-[circle]" : ""}>{inline(it.text)}</li>)}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++} className="my-2">{inline(para.join(" "))}</p>);
  }
  return <div className="text-sm leading-relaxed">{blocks}</div>;
}
