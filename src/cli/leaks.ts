import { posix } from "node:path";
import { RECIPIENTS_DIR, SECRETS_DIR } from "../names.js";
import { OWNER_IDENTITY_EXTENSION } from "../owner.js";
import { isAgeArmor } from "../secret.js";
import { type FileVersion, ignoredPaths, readBlobs } from "./git.js";
import type { Pattern } from "./redact.js";

/** One reason a file must not be committed. Never holds a value or a key. */
export interface Leak {
  readonly file: string;
  readonly issue: string;
}

/** An age private key: X25519 (`AGE-SECRET-KEY-1…`) or ML-KEM hybrid (`AGE-SECRET-KEY-PQ-1…`). */
const PRIVATE_KEY = /AGE-SECRET-KEY-(?:PQ-)?1[02-9AC-HJ-NP-Z]{50,}/i;

/** `.env.<suffix>` files that hold placeholders by convention and are meant to be committed. */
const ENV_TEMPLATES = new Set(["example", "sample", "template", "dist"]);

/** True for `.env` and `.env.<anything>` other than the templates in {@link ENV_TEMPLATES}. */
export function isEnvFile(path: string): boolean {
  const base = posix.basename(path);
  if (base === ".env") return true;
  return base.startsWith(".env.") && !ENV_TEMPLATES.has(base.slice(".env.".length));
}

/**
 * Checks file versions about to enter git history (SPEC.md § `check --staged`).
 * `prefix` is the path from the work tree's top to the agedrop directory (`""` or ending in `/`);
 * `values` are the forms of the decryptable values to look for (`--values`), or none.
 */
export async function findLeaks(
  top: string,
  prefix: string,
  files: readonly FileVersion[],
  values: readonly Pattern[],
): Promise<Leak[]> {
  const leaks: Leak[] = [];
  const secretsDir = `${prefix}${SECRETS_DIR}/`;
  const isOwnerIdentity = (path: string): boolean =>
    path.startsWith(`${prefix}${RECIPIENTS_DIR}/`) &&
    !path.slice(prefix.length + RECIPIENTS_DIR.length + 1).includes("/") &&
    path.endsWith(OWNER_IDENTITY_EXTENSION);

  const byBlob = new Map<string, string[]>();
  for (const { path, blob } of files) byBlob.set(blob, [...(byBlob.get(blob) ?? []), path]);
  await readBlobs(top, [...byBlob.keys()], (blob, content) => {
    for (const path of byBlob.get(blob) ?? []) {
      const armored = isAgeArmor(content.toString("utf8"));
      if (path.startsWith(secretsDir) && content.length > 0 && !armored) {
        leaks.push({
          file: path,
          issue: `not an ASCII-armored age file: plaintext under ${SECRETS_DIR}/ (add values with agedrop add)`,
        });
      }
      if (!isOwnerIdentity(path) && PRIVATE_KEY.test(content.toString("latin1"))) {
        leaks.push({ file: path, issue: "holds an age private key (AGE-SECRET-KEY-…)" });
      }
      if (armored) continue;
      const found = new Set<string>();
      for (const pattern of values) {
        if (!found.has(pattern.name) && content.includes(pattern.bytes)) found.add(pattern.name);
      }
      for (const name of [...found].sort()) {
        leaks.push({ file: path, issue: `holds the value of ${name}` });
      }
    }
  });

  const envFiles = [...new Set(files.map((file) => file.path).filter(isEnvFile))];
  const ignored = await ignoredPaths(top, envFiles);
  for (const path of envFiles) {
    if (ignored.has(path)) continue;
    leaks.push({
      file: path,
      issue:
        "an env file, which may hold decrypted values, and no ignore rule covers it: unstage it (git rm --cached) and add it to .gitignore",
    });
  }
  return leaks.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
