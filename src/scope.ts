import type { Config } from "./config.js";
import { FormatError } from "./errors.js";
import { CONFIG_FILE } from "./names.js";
import type { RecipientInfo } from "./recipients.js";

/** The people and machines a scope's secrets are encrypted to. */
export interface ResolvedScope {
  readonly scope: string;
  /** Recipient names, sorted and distinct. */
  readonly names: readonly string[];
  /** Age recipients, sorted by byte value and distinct: the input to encryption and the fingerprint. */
  readonly recipients: readonly string[];
  /** Recipient name → age recipient, sorted by name: the set `agedrop.lock` records. */
  readonly members: ReadonlyMap<string, string>;
}

/**
 * Checks that every recipient named in `agedrop.toml` has a `recipients/<name>.pub` file.
 * Returns one issue per missing file; an empty list means the repository is consistent.
 */
export function missingRecipients(
  config: Config,
  recipients: ReadonlyMap<string, RecipientInfo>,
): string[] {
  const issues: string[] = [];
  for (const [group, members] of config.groups) {
    for (const name of members) {
      if (!recipients.has(name)) {
        issues.push(`recipients.${group}: "${name}" has no recipients/${name}.pub`);
      }
    }
  }
  return issues;
}

/** Resolves a scope into its recipient set (SPEC.md, `agedrop.toml`). */
export function resolveScope(
  config: Config,
  recipients: ReadonlyMap<string, RecipientInfo>,
  scope: string,
): ResolvedScope {
  const groups = config.scopes.get(scope);
  if (groups === undefined) {
    throw new FormatError(CONFIG_FILE, [`unknown scope "${scope}"`]);
  }
  const members = new Map<string, string>();
  const issues: string[] = [];
  for (const group of groups) {
    for (const name of config.groups.get(group) ?? []) {
      const info = recipients.get(name);
      if (info === undefined) {
        issues.push(`scope "${scope}": recipient "${name}" has no recipients/${name}.pub`);
        continue;
      }
      members.set(name, info.recipient);
    }
  }
  if (issues.length > 0) throw new FormatError(CONFIG_FILE, issues);
  const names = [...members.keys()].sort(compareBytes);
  return {
    scope,
    names,
    recipients: [...new Set(members.values())].sort(compareBytes),
    members: new Map(names.map((name) => [name, members.get(name) ?? ""])),
  };
}

/** Orders strings by UTF-8 byte value, independent of locale. */
export function compareBytes(a: string, b: string): number {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

const utf8 = new TextEncoder();
