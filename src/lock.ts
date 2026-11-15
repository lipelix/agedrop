import { stringify as stringifyToml } from "smol-toml";
import { FORMAT_VERSION } from "./config.js";
import { FormatError } from "./errors.js";
import {
  isValidRecipientName,
  LOCK_FILE,
  parseSecretPath,
  SECRET_EXTENSION,
  SECRETS_DIR,
} from "./names.js";
import { isAgeRecipient } from "./recipients.js";
import type { ResolvedScope } from "./scope.js";
import { compareBytes } from "./scope.js";
import { isTable, parseTomlFile } from "./toml.js";

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

/** A recipient set as `agedrop.lock` keeps it: recipient name → age recipient. */
export type RecipientSet = ReadonlyMap<string, string>;

/** `agedrop.lock`. */
export interface Lock {
  /** Secret id (`<scope>/<NAME>`) → recipient-set fingerprint. */
  readonly secrets: ReadonlyMap<string, string>;
  /** Fingerprint → the recipients it was computed from. */
  readonly sets: ReadonlyMap<string, RecipientSet>;
}

export const EMPTY_LOCK: Lock = { secrets: new Map(), sets: new Map() };

/**
 * The recipient-set fingerprint from SPEC.md: `sha256:` + hex SHA-256 of the age recipients,
 * deduplicated, sorted by byte value, each followed by a newline.
 */
export async function recipientSetFingerprint(recipients: Iterable<string>): Promise<string> {
  const sorted = [...new Set(recipients)].sort(compareBytes);
  if (sorted.length === 0) throw new Error("a recipient set needs at least one recipient");
  const input = new TextEncoder().encode(sorted.map((recipient) => `${recipient}\n`).join(""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Records that secret `id` is now encrypted to `scope`'s recipient set. Returns a new lock;
 * {@link formatLock} drops sets no secret uses any more.
 */
export async function lockSecret(lock: Lock, id: string, scope: ResolvedScope): Promise<Lock> {
  const fingerprint = await recipientSetFingerprint(scope.recipients);
  const secrets = new Map(lock.secrets).set(id, fingerprint);
  const sets = new Map(lock.sets).set(fingerprint, scope.members);
  return { secrets, sets };
}

/** Parses `agedrop.lock`. Throws {@link FormatError} listing every problem found. */
export function parseLock(text: string): Lock {
  const raw = parseTomlFile(LOCK_FILE, text);
  const issues: string[] = [];
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "secrets" && key !== "sets") {
      issues.push(`unknown key "${key}"`);
    }
  }
  if (raw.version !== FORMAT_VERSION) {
    issues.push(
      `unsupported version ${JSON.stringify(raw.version)} (expected ${String(FORMAT_VERSION)})`,
    );
  }

  const secrets = new Map<string, string>();
  const rawSecrets = raw.secrets ?? {};
  if (!isTable(rawSecrets)) {
    issues.push(`"secrets" must be a table`);
  } else {
    for (const [id, fingerprint] of Object.entries(rawSecrets)) {
      if (parseSecretPath(`${SECRETS_DIR}/${id}${SECRET_EXTENSION}`) === undefined) {
        issues.push(`invalid secret id "${id}"`);
      } else if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) {
        issues.push(`"${id}": fingerprint must look like sha256:<64 hex digits>`);
      } else {
        secrets.set(id, fingerprint);
      }
    }
  }

  const sets = new Map<string, RecipientSet>();
  const rawSets = raw.sets ?? {};
  if (!isTable(rawSets)) {
    issues.push(`"sets" must be a table`);
  } else {
    for (const [fingerprint, members] of Object.entries(rawSets)) {
      if (!FINGERPRINT.test(fingerprint)) {
        issues.push(`sets: "${fingerprint}" must look like sha256:<64 hex digits>`);
        continue;
      }
      if (!isTable(members) || Object.keys(members).length === 0) {
        issues.push(`sets."${fingerprint}" must be a non-empty table of name = "age1…"`);
        continue;
      }
      const set = new Map<string, string>();
      for (const [name, recipient] of Object.entries(members)) {
        if (!isValidRecipientName(name)) {
          issues.push(`sets."${fingerprint}": invalid recipient name "${name}"`);
        } else if (typeof recipient !== "string" || !isAgeRecipient(recipient)) {
          issues.push(`sets."${fingerprint}".${name}: not a valid age recipient`);
        } else {
          set.set(name, recipient);
        }
      }
      sets.set(fingerprint, set);
    }
  }

  if (issues.length > 0) throw new FormatError(LOCK_FILE, issues);
  return { secrets, sets };
}

/**
 * Checks what {@link parseLock} cannot without hashing: every fingerprint in `[secrets]` has a
 * `[sets]` entry, and every set hashes to its fingerprint. Returns one issue per problem.
 */
export async function lockIssues(lock: Lock): Promise<string[]> {
  const issues: string[] = [];
  for (const [id, fingerprint] of lock.secrets) {
    if (!lock.sets.has(fingerprint)) issues.push(`"${id}": its fingerprint has no [sets] entry`);
  }
  for (const [fingerprint, set] of lock.sets) {
    if ((await recipientSetFingerprint(set.values())) !== fingerprint) {
      issues.push(`sets."${fingerprint}": its recipients do not hash to this fingerprint`);
    }
  }
  return issues;
}

/** Renders `agedrop.lock` with sorted keys, so rewrites give small diffs. Unused sets are dropped. */
export function formatLock(lock: Lock): string {
  const secrets: Record<string, string> = {};
  for (const id of [...lock.secrets.keys()].sort(compareBytes)) {
    const fingerprint = lock.secrets.get(id);
    if (fingerprint !== undefined) secrets[id] = fingerprint;
  }
  const used = new Set(Object.values(secrets));
  const sets: Record<string, Record<string, string>> = {};
  for (const fingerprint of [...used].sort(compareBytes)) {
    const set = lock.sets.get(fingerprint);
    if (set === undefined) continue;
    const members: Record<string, string> = {};
    for (const name of [...set.keys()].sort(compareBytes)) members[name] = set.get(name) ?? "";
    sets[fingerprint] = members;
  }
  const doc: Record<string, unknown> = { version: FORMAT_VERSION, secrets };
  if (Object.keys(sets).length > 0) doc.sets = sets;
  return `${stringifyToml(doc).trimEnd()}\n`;
}
