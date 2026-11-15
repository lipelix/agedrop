import type { SecretRequest } from "../requests.js";

/** Plain text columns, two spaces apart; the last column is not padded. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `${cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd()}\n`;
  return [header, ...rows].map(line).join("");
}

/** Open requests as a table, as `ls` and `requests` print them. */
export function requestTable(requests: readonly SecretRequest[]): string {
  return table(
    ["REQUEST", "SECRET", "CREATED", "BY", "REASON"],
    requests.map((r) => [
      r.id,
      `${r.scope}/${r.name}`,
      r.created.slice(0, 10),
      r.requestedBy,
      oneLine(r.reason),
    ]),
  );
}

/** Keeps a multi-line reason on one row. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}
