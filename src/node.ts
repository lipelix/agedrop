import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Config, parseConfig } from "./config.js";
import { FormatError } from "./errors.js";
import { EMPTY_LOCK, type Lock, parseLock } from "./lock.js";
import {
  CONFIG_FILE,
  LOCK_FILE,
  parseSecretPath,
  RECIPIENT_EXTENSION,
  RECIPIENTS_DIR,
  REQUESTS_DIR,
  SECRETS_DIR,
} from "./names.js";
import { parseRecipientFile, type RecipientInfo } from "./recipients.js";
import { parseRequest, type SecretRequest } from "./requests.js";
import { compareBytes, missingRecipients } from "./scope.js";

/** The configuration and public keys of an agedrop repository: everything needed to write. */
export interface Repository {
  readonly root: string;
  readonly config: Config;
  readonly recipients: ReadonlyMap<string, RecipientInfo>;
}

/**
 * Reads `agedrop.toml` and `recipients/*.pub` from a repository checkout and checks that every
 * recipient the configuration names has a public key.
 */
export async function loadRepository(root: string): Promise<Repository> {
  const config = parseConfig(await readFile(join(root, CONFIG_FILE), "utf8"));
  const recipients = await loadRecipients(root);
  const missing = missingRecipients(config, recipients);
  if (missing.length > 0) throw new FormatError(CONFIG_FILE, missing);
  return { root, config, recipients };
}

/** Reads every `recipients/*.pub` file. A missing `recipients/` directory means no recipients. */
export async function loadRecipients(root: string): Promise<Map<string, RecipientInfo>> {
  const dir = join(root, RECIPIENTS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const recipients = new Map<string, RecipientInfo>();
  for (const entry of entries.sort()) {
    if (!entry.endsWith(RECIPIENT_EXTENSION)) continue;
    const name = entry.slice(0, -RECIPIENT_EXTENSION.length);
    recipients.set(name, parseRecipientFile(name, await readFile(join(dir, entry), "utf8")));
  }
  return recipients;
}

/** A file under `secrets/`, with its scope and name when the path is valid. */
export interface SecretFile {
  /** Repository-relative path with `/` separators, e.g. `secrets/mini/hq/TOKEN.age`. */
  readonly path: string;
  readonly scope?: string;
  readonly name?: string;
}

/**
 * Lists every file under `secrets/`, sorted by path, including files whose path is not a valid
 * secret path (those have no `scope` and `name`). Dotfiles such as `.gitkeep` are skipped.
 */
export async function listSecretFiles(root: string): Promise<SecretFile[]> {
  const files: SecretFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && relative === SECRETS_DIR) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else {
        const parsed = parseSecretPath(path);
        files.push(parsed === undefined ? { path } : { path, ...parsed });
      }
    }
  };
  await walk(SECRETS_DIR);
  return files.sort((a, b) => compareBytes(a.path, b.path));
}

/** Reads `agedrop.lock`. A missing file is an empty lock. */
export async function readLock(root: string): Promise<Lock> {
  const text = await readOptional(join(root, LOCK_FILE));
  return text === undefined ? EMPTY_LOCK : parseLock(text);
}

/** The ids of `requests/*.toml` files, sorted. A missing `requests/` directory means none. */
export async function listRequestIds(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(join(root, REQUESTS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".toml") && !entry.startsWith("."))
    .map((entry) => entry.slice(0, -".toml".length))
    .sort(compareBytes);
}

/** Reads and parses every open request. */
export async function loadRequests(root: string): Promise<SecretRequest[]> {
  const requests: SecretRequest[] = [];
  for (const id of await listRequestIds(root)) {
    requests.push(parseRequest(id, await readFile(join(root, REQUESTS_DIR, `${id}.toml`), "utf8")));
  }
  return requests;
}

/** Reads a UTF-8 file, or returns `undefined` when it does not exist. */
export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Writes a file through a temporary file in the same directory and a rename, so readers see either
 * the old or the new contents. The file gets `mode` even when it replaces one with other permissions.
 * With `exclusive`, an existing file is never replaced and the call fails with `EEXIST`.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: { mode: number; exclusive?: boolean },
): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", options.mode);
  try {
    await handle.writeFile(data);
    await handle.chmod(options.mode);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (options.exclusive === true) {
      await link(temp, path);
      await rm(temp);
    } else {
      await rename(temp, path);
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
