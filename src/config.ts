import { FormatError } from "./errors.js";
import { CONFIG_FILE, isValidGroupName, isValidRecipientName, isValidScope } from "./names.js";
import { isTable, parseTomlFile } from "./toml.js";

export const FORMAT_VERSION = 0;
export const OWNERS_GROUP = "owners";

/** A validated `agedrop.toml`. */
export interface Config {
  readonly version: typeof FORMAT_VERSION;
  /** Group name → recipient names. Always contains `owners`. */
  readonly groups: ReadonlyMap<string, readonly string[]>;
  /** Scope → group names. Every list contains `owners`. */
  readonly scopes: ReadonlyMap<string, readonly string[]>;
  /** Scopes with `redact = true`: `exec` always masks their values in output. */
  readonly redacted: ReadonlySet<string>;
}

/** Parses and validates `agedrop.toml`. Throws {@link FormatError} listing every problem found. */
export function parseConfig(text: string): Config {
  const raw = parseTomlFile(CONFIG_FILE, text);

  const issues: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!["version", "recipients", "scopes"].includes(key)) issues.push(`unknown key "${key}"`);
  }

  if (raw.version !== FORMAT_VERSION) {
    issues.push(
      raw.version === undefined
        ? `missing "version" (expected ${String(FORMAT_VERSION)})`
        : `unsupported version ${JSON.stringify(raw.version)} (expected ${String(FORMAT_VERSION)})`,
    );
  }

  const groups = parseGroups(raw.recipients, issues);
  const redacted = new Set<string>();
  const scopes = parseScopes(raw.scopes, groups, redacted, issues);

  if (issues.length > 0) throw new FormatError(CONFIG_FILE, issues);
  return { version: FORMAT_VERSION, groups, scopes, redacted };
}

function parseGroups(value: unknown, issues: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  if (value === undefined) {
    issues.push(`missing [recipients] table`);
    return groups;
  }
  if (!isTable(value)) {
    issues.push(`"recipients" must be a table of groups`);
    return groups;
  }
  for (const [group, members] of Object.entries(value)) {
    if (!isValidGroupName(group)) {
      issues.push(`invalid group name "${group}"`);
      continue;
    }
    const list = stringList(members, `recipients.${group}`, issues);
    if (list === undefined) continue;
    for (const name of list) {
      if (!isValidRecipientName(name))
        issues.push(`recipients.${group}: invalid recipient name "${name}"`);
    }
    groups.set(group, list);
  }
  if (!Object.hasOwn(value, OWNERS_GROUP))
    issues.push(`missing the "${OWNERS_GROUP}" group in [recipients]`);
  return groups;
}

function parseScopes(
  value: unknown,
  groups: ReadonlyMap<string, readonly string[]>,
  redacted: Set<string>,
  issues: string[],
): Map<string, string[]> {
  const scopes = new Map<string, string[]>();
  if (value === undefined) return scopes;
  if (!isTable(value)) {
    issues.push(`"scopes" must be a table of scopes`);
    return scopes;
  }
  for (const [scope, body] of Object.entries(value)) {
    const where = `scopes."${scope}"`;
    if (!isValidScope(scope)) {
      issues.push(`invalid scope "${scope}"`);
      continue;
    }
    if (!isTable(body)) {
      issues.push(`${where} must be a table`);
      continue;
    }
    for (const key of Object.keys(body)) {
      if (key !== "recipients" && key !== "redact") issues.push(`${where}: unknown key "${key}"`);
    }
    if (body.redact !== undefined && typeof body.redact !== "boolean") {
      issues.push(`${where}.redact must be true or false`);
    }
    if (body.redact === true) redacted.add(scope);
    const list = stringList(body.recipients, `${where}.recipients`, issues);
    if (list === undefined) continue;
    for (const group of list) {
      if (!groups.has(group)) issues.push(`${where}.recipients: unknown group "${group}"`);
    }
    if (!list.includes(OWNERS_GROUP)) {
      issues.push(`${where}.recipients must include "${OWNERS_GROUP}"`);
    }
    scopes.set(scope, list);
  }
  return scopes;
}

/** A non-empty list of distinct strings, or `undefined` after recording why not. */
function stringList(value: unknown, where: string, issues: string[]): string[] | undefined {
  if (value === undefined) {
    issues.push(`missing ${where}`);
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    issues.push(`${where} must be a list of strings`);
    return undefined;
  }
  const list = value;
  if (list.length === 0) {
    issues.push(`${where} must not be empty`);
    return undefined;
  }
  const seen = new Set<string>();
  for (const item of list) {
    if (seen.has(item)) issues.push(`${where}: "${item}" is listed twice`);
    seen.add(item);
  }
  return list;
}
