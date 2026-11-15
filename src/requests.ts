import { stringify as stringifyToml, TomlDate } from "smol-toml";
import { FormatError } from "./errors.js";
import { isValidScope, isValidSecretName, REQUESTS_DIR } from "./names.js";
import { parseTomlFile } from "./toml.js";

const REQUEST_ID = /^[a-z0-9][a-z0-9_-]*$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const KEYS = ["scope", "name", "reason", "requested_by", "created", "generate"];

/** A parsed `requests/<id>.toml`: an open request for a secret. It never holds a value. */
export interface SecretRequest {
  readonly id: string;
  readonly scope: string;
  readonly name: string;
  readonly reason: string;
  readonly requestedBy: string;
  /** RFC 3339 date-time, normalized to UTC (`…Z`). */
  readonly created: string;
  /** Optional hint for the UI: a command that generates a suitable value. */
  readonly generate?: string;
}

export function isValidRequestId(id: string): boolean {
  return REQUEST_ID.test(id);
}

/** Repository-relative path of a request file: `requests/<id>.toml`. */
export function requestPath(id: string): string {
  if (!isValidRequestId(id)) throw new Error(`invalid request id: ${JSON.stringify(id)}`);
  return `${REQUESTS_DIR}/${id}.toml`;
}

/** Parses `requests/<id>.toml`. Throws {@link FormatError} listing every problem found. */
export function parseRequest(id: string, text: string): SecretRequest {
  const file = `${REQUESTS_DIR}/${id}.toml`;
  if (!isValidRequestId(id)) throw new FormatError(file, [`invalid request id "${id}"`]);
  const raw = parseTomlFile(file, text);
  const issues: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) issues.push(`unknown key "${key}"`);
  }

  const field = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) {
      issues.push(`missing "${key}"`);
      return undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
      issues.push(`"${key}" must be a non-empty string`);
      return undefined;
    }
    return value;
  };

  const scope = field("scope");
  if (scope !== undefined && !isValidScope(scope)) issues.push(`invalid scope "${scope}"`);
  const name = field("name");
  if (name !== undefined && !isValidSecretName(name)) issues.push(`invalid secret name "${name}"`);
  const reason = field("reason");
  const requestedBy = field("requested_by");
  const created = parseCreated(raw.created, issues);
  const generate = raw.generate;
  if (generate !== undefined && typeof generate !== "string") {
    issues.push(`"generate" must be a string`);
  }

  if (
    issues.length > 0 ||
    scope === undefined ||
    name === undefined ||
    reason === undefined ||
    requestedBy === undefined ||
    created === undefined
  ) {
    throw new FormatError(file, issues);
  }
  const request = { id, scope, name, reason, requestedBy, created };
  return typeof generate === "string" ? { ...request, generate } : request;
}

function parseCreated(value: unknown, issues: string[]): string | undefined {
  if (value === undefined) {
    issues.push(`missing "created"`);
    return undefined;
  }
  if (value instanceof TomlDate) {
    if (!value.isDateTime() || value.isLocal() || !value.isValid()) {
      issues.push(`"created" must be a date-time with a time zone`);
      return undefined;
    }
    return new Date(value.getTime()).toISOString();
  }
  if (typeof value === "string" && RFC3339.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  issues.push(`"created" must be an RFC 3339 date-time with a time zone`);
  return undefined;
}

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** A new random request id: 8 characters from `a-z` and `2-9`, without look-alikes (SPEC.md § Requests). */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  // 256 is a multiple of the alphabet's 32 characters, so every character is equally likely.
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length] ?? "").join("");
}

/**
 * Renders `requests/<id>.toml`. Throws when the request would not pass {@link parseRequest}.
 * `created` is written as a TOML string, UTC, without fractional seconds.
 */
export function formatRequest(request: SecretRequest): string {
  const doc: Record<string, string> = {
    scope: request.scope,
    name: request.name,
    reason: request.reason,
    requested_by: request.requestedBy,
    created: new Date(request.created).toISOString().replace(/\.\d+Z$/, "Z"),
  };
  if (request.generate !== undefined) doc.generate = request.generate;
  const text = `${stringifyToml(doc).trimEnd()}\n`;
  parseRequest(request.id, text);
  return text;
}
