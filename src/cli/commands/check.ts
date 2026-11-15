import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, parseConfig } from "../../config.js";
import { FormatError } from "../../errors.js";
import { type Lock, lockIssues, parseLock, recipientSetFingerprint } from "../../lock.js";
import {
  CONFIG_FILE,
  LOCK_FILE,
  RECIPIENT_EXTENSION,
  RECIPIENTS_DIR,
  REQUESTS_DIR,
  SECRETS_DIR,
} from "../../names.js";
import { listRequestIds, listSecretFiles, readOptional } from "../../node.js";
import { OWNER_IDENTITY_EXTENSION, ownerIdentityIssues } from "../../owner.js";
import { parseRecipientFile, type RecipientInfo } from "../../recipients.js";
import { parseRequest } from "../../requests.js";
import { isAgeArmor } from "../../secret.js";
import { missingRecipients, resolveScope } from "../../scope.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { UsageError } from "../context.js";
import { requireRoot } from "../repo.js";

interface Problem {
  readonly file: string;
  readonly issue: string;
}

export const check: Command = {
  name: "check",
  summary: "validate layout, names and lock fingerprints (for CI)",
  help: `usage: agedrop check [--repo <dir>]

Validates agedrop.toml, recipients/*.pub and *.identity.age, requests/*.toml,
the paths and armor of every file under secrets/, and that agedrop.lock
matches each scope's current recipients. Exits 1 and lists every problem when there are
any. Never decrypts, so CI can run it without an identity.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, { repo: { type: "string" } });
    if (positionals.length > 0)
      throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
    const root = await requireRoot(ctx, values.repo);
    const result = await checkRepository(root);
    for (const { file, issue } of result.problems) ctx.stderr.write(`agedrop: ${file}: ${issue}\n`);
    if (result.problems.length > 0) {
      ctx.stderr.write(
        `${String(result.problems.length)} problem${result.problems.length === 1 ? "" : "s"}\n`,
      );
      return 1;
    }
    ctx.stdout.write(
      `ok: ${plural(result.secrets, "secret")} in ${plural(result.scopes, "scope")}, ${plural(result.recipients, "recipient")}, ${plural(result.requests, "open request")}\n`,
    );
    return 0;
  },
};

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

export interface CheckResult {
  readonly problems: readonly Problem[];
  readonly secrets: number;
  readonly scopes: number;
  readonly recipients: number;
  readonly requests: number;
}

/** Runs every check from SPEC.md `check` against a repository checkout. */
export async function checkRepository(root: string): Promise<CheckResult> {
  const problems: Problem[] = [];
  const collect = (fallbackFile: string, error: unknown): void => {
    if (!(error instanceof FormatError)) throw error;
    for (const issue of error.issues) problems.push({ file: error.file || fallbackFile, issue });
  };

  // agedrop.toml
  let config: Config | undefined;
  try {
    config = parseConfig(await readFile(join(root, CONFIG_FILE), "utf8"));
  } catch (error) {
    collect(CONFIG_FILE, error);
  }

  // recipients/
  const recipients = new Map<string, RecipientInfo>();
  const pubFiles = new Set<string>();
  const ownerIdentities: string[] = [];
  for (const entry of await entries(root, RECIPIENTS_DIR)) {
    const file = `${RECIPIENTS_DIR}/${entry}`;
    if (entry.endsWith(OWNER_IDENTITY_EXTENSION)) {
      ownerIdentities.push(entry.slice(0, -OWNER_IDENTITY_EXTENSION.length));
      continue;
    }
    if (!entry.endsWith(RECIPIENT_EXTENSION)) {
      problems.push({
        file,
        issue: `unexpected file (expected <name>.pub or <name>.identity.age)`,
      });
      continue;
    }
    const name = entry.slice(0, -RECIPIENT_EXTENSION.length);
    pubFiles.add(name);
    try {
      recipients.set(name, parseRecipientFile(name, await readFile(join(root, file), "utf8")));
    } catch (error) {
      collect(file, error);
    }
  }
  for (const name of ownerIdentities) {
    const file = `${RECIPIENTS_DIR}/${name}${OWNER_IDENTITY_EXTENSION}`;
    const pub = recipients.get(name) ?? (pubFiles.has(name) ? "invalid" : undefined);
    const text = await readFile(join(root, file), "utf8");
    for (const issue of ownerIdentityIssues(name, text, pub)) problems.push({ file, issue });
  }
  if (config !== undefined) {
    for (const issue of missingRecipients(config, recipients)) {
      problems.push({ file: CONFIG_FILE, issue });
    }
  }

  // Each scope's fingerprint, when all its recipients are known.
  const fingerprints = new Map<string, string>();
  if (config !== undefined) {
    for (const scope of config.scopes.keys()) {
      try {
        const resolved = resolveScope(config, recipients, scope);
        fingerprints.set(scope, await recipientSetFingerprint(resolved.recipients));
      } catch (error) {
        if (!(error instanceof FormatError)) throw error;
        // Already reported as a missing recipient.
      }
    }
  }

  // agedrop.lock
  let lock: Lock | undefined;
  const lockText = await readOptional(join(root, LOCK_FILE));
  if (lockText !== undefined) {
    try {
      lock = parseLock(lockText);
      for (const issue of await lockIssues(lock)) problems.push({ file: LOCK_FILE, issue });
    } catch (error) {
      collect(LOCK_FILE, error);
    }
  }

  // secrets/
  const secretIds = new Set<string>();
  const files = await listSecretFiles(root);
  if (files.length > 0 && lockText === undefined) {
    problems.push({ file: LOCK_FILE, issue: "missing: secrets exist but there is no lock file" });
  }
  for (const secret of files) {
    if (secret.scope === undefined || secret.name === undefined) {
      problems.push({
        file: secret.path,
        issue: `not a valid ${SECRETS_DIR}/<scope>/<NAME>.age path (scope segments [a-z0-9][a-z0-9._-]*, NAME [A-Z][A-Z0-9_]* or [a-z][a-z0-9._-]*)`,
      });
      continue;
    }
    const id = `${secret.scope}/${secret.name}`;
    secretIds.add(id);
    if (!isAgeArmor(await readFile(join(root, secret.path), "utf8"))) {
      problems.push({ file: secret.path, issue: "not an ASCII-armored age file" });
    }
    if (config !== undefined && !config.scopes.has(secret.scope)) {
      problems.push({
        file: secret.path,
        issue: `scope "${secret.scope}" is not defined in ${CONFIG_FILE}`,
      });
      continue;
    }
    const expected = fingerprints.get(secret.scope);
    if (lock === undefined || expected === undefined) continue;
    const recorded = lock.secrets.get(id);
    if (recorded === undefined) {
      problems.push({
        file: secret.path,
        issue: `no ${LOCK_FILE} entry: its recipients are unknown (add it again or rekey)`,
      });
    } else if (recorded !== expected) {
      problems.push({
        file: secret.path,
        issue: `stale: encrypted to another recipient set than scope "${secret.scope}" has now (rekey it)`,
      });
    }
  }
  for (const id of lock?.secrets.keys() ?? []) {
    if (!secretIds.has(id)) {
      problems.push({ file: LOCK_FILE, issue: `"${id}" has no ${SECRETS_DIR}/${id}.age` });
    }
  }

  // requests/
  const ids = await listRequestIds(root);
  for (const entry of await entries(root, REQUESTS_DIR)) {
    if (!entry.endsWith(".toml")) {
      problems.push({
        file: `${REQUESTS_DIR}/${entry}`,
        issue: "unexpected file (expected <id>.toml)",
      });
    }
  }
  for (const id of ids) {
    const file = `${REQUESTS_DIR}/${id}.toml`;
    try {
      const request = parseRequest(id, await readFile(join(root, file), "utf8"));
      if (config !== undefined && !config.scopes.has(request.scope)) {
        problems.push({ file, issue: `scope "${request.scope}" is not defined in ${CONFIG_FILE}` });
      }
    } catch (error) {
      collect(file, error);
    }
  }

  return {
    problems,
    secrets: secretIds.size,
    scopes: config?.scopes.size ?? 0,
    recipients: recipients.size,
    requests: ids.length,
  };
}

/** Non-hidden entries of a directory under the root; none when it does not exist. */
async function entries(root: string, dir: string): Promise<string[]> {
  try {
    return (await readdir(join(root, dir))).filter((entry) => !entry.startsWith(".")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
