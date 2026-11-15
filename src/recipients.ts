import { Encrypter } from "age-encryption";
import { FormatError } from "./errors.js";
import { isValidRecipientName, recipientPath } from "./names.js";

export const RECIPIENT_KINDS = ["machine", "ci", "owner"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

/** A parsed `recipients/<name>.pub` file. */
export interface RecipientInfo {
  readonly name: string;
  readonly kind: RecipientKind;
  /** `YYYY-MM-DD`, when the file has an `added` line. */
  readonly added?: string;
  /** The age recipient, `age1…` or `age1pq1…`. */
  readonly recipient: string;
  /** Every `# key: value` metadata line, including `kind` and `added`. */
  readonly metadata: ReadonlyMap<string, string>;
}

const METADATA = /^#\s*([a-z][a-z0-9_-]*)\s*:\s*(.*?)\s*$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses `recipients/<name>.pub`. Throws {@link FormatError} listing every problem found. */
export function parseRecipientFile(name: string, text: string): RecipientInfo {
  if (!isValidRecipientName(name)) {
    throw new FormatError(`recipients/${name}.pub`, [`invalid recipient name "${name}"`]);
  }
  const file = recipientPath(name);
  const issues: string[] = [];
  const metadata = new Map<string, string>();
  const keys: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const match = METADATA.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      const key = match[1].toLowerCase();
      if (metadata.has(key)) issues.push(`"${key}" is set twice`);
      metadata.set(key, match[2]);
      continue;
    }
    keys.push(line);
  }

  const kind = metadata.get("kind");
  if (kind === undefined) issues.push(`missing "# kind: ${RECIPIENT_KINDS.join(" | ")}"`);
  else if (!isRecipientKind(kind)) {
    issues.push(`unknown kind "${kind}" (expected ${RECIPIENT_KINDS.join(", ")})`);
  }

  const added = metadata.get("added");
  if (added !== undefined && !isDate(added)) issues.push(`"added" must be a date YYYY-MM-DD`);

  // Never echo a private key back: error messages end up in CI logs.
  if (keys.some((line) => line.toUpperCase().startsWith("AGE-SECRET-KEY-"))) {
    issues.push(
      `holds a private key (AGE-SECRET-KEY-…) instead of a public one: remove it and rotate that key`,
    );
    throw new FormatError(file, issues);
  }
  if (keys.length === 0) issues.push(`missing the age recipient line (age1…)`);
  if (keys.length > 1) issues.push(`expected one age recipient, found ${String(keys.length)}`);
  const recipient = keys[0];
  if (keys.length === 1 && recipient !== undefined && !isAgeRecipient(recipient)) {
    issues.push(`not a valid age recipient: "${recipient}"`);
  }

  if (
    issues.length > 0 ||
    recipient === undefined ||
    kind === undefined ||
    !isRecipientKind(kind)
  ) {
    throw new FormatError(file, issues);
  }
  return added === undefined
    ? { name, kind, recipient, metadata }
    : { name, kind, added, recipient, metadata };
}

/** Renders a recipient file in the canonical layout from SPEC.md. */
export function formatRecipientFile(info: {
  kind: RecipientKind;
  added?: string;
  recipient: string;
}): string {
  const lines = [`# kind: ${info.kind}`];
  if (info.added !== undefined) lines.push(`# added: ${info.added}`);
  lines.push(info.recipient);
  return `${lines.join("\n")}\n`;
}

/**
 * Bech32 human-readable parts of the allowed recipient types: X25519 (`age1…`) and hybrid
 * post-quantum (`age1pq1…`). Tag (`age1tag1…`, `age1tagpq1…`) and plugin (`age1<name>1…`)
 * recipients have other parts.
 */
const RECIPIENT_HRPS: readonly string[] = ["age", "age1pq"];

/**
 * True for X25519 (`age1…`) and hybrid post-quantum (`age1pq1…`) recipients that the
 * stock `age` CLI understands. Plugin and tag recipients are not allowed.
 *
 * The type is the bech32 human-readable part, everything before the last `1`. The bech32
 * data charset has no `1`, so X25519 data that happens to start with `tag` (`age1tag…`)
 * is still X25519.
 */
export function isAgeRecipient(value: string): boolean {
  const separator = value.lastIndexOf("1");
  if (separator < 0 || !RECIPIENT_HRPS.includes(value.slice(0, separator))) return false;
  try {
    new Encrypter().addRecipient(value);
    return true;
  } catch {
    return false;
  }
}

function isRecipientKind(value: string): value is RecipientKind {
  return (RECIPIENT_KINDS as readonly string[]).includes(value);
}

function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
