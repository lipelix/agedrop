const BARE = /^[A-Za-z0-9_.,/:@+=-]*$/;

/**
 * Renders one `NAME=value` line as SPEC.md `pull --env` describes: bare when the value only holds
 * safe characters, single-quoted when it holds no `'`, double-quoted with escapes otherwise.
 */
export function envLine(name: string, value: string): string {
  return `${name}=${quote(value)}\n`;
}

function quote(value: string): string {
  if (value !== "" && BARE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("\n", "\\n");
  return `"${escaped}"`;
}

/** Decodes an env-style value, which must be UTF-8 without NUL bytes. Returns `undefined` otherwise. */
export function envValue(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}
