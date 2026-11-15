import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { identityToRecipient } from "age-encryption";
import { readOptional } from "../node.js";
import { parseIdentityFile } from "../secret.js";
import { CliError, type Context, note } from "./context.js";

export const IDENTITY_ENV = "AGEDROP_IDENTITY";

/** `~/.config/agedrop/identity`: where a host keeps its identity. */
export function defaultIdentityPath(ctx: Context): string {
  return join(ctx.home, ".config", "agedrop", "identity");
}

export interface LoadedIdentity {
  readonly identities: readonly string[];
  /** Where the identity came from, for messages: a path or `AGEDROP_IDENTITY`. */
  readonly source: string;
}

/** Loads the identity from `--identity`, then `AGEDROP_IDENTITY`, then `~/.config/agedrop/identity`. */
export async function loadIdentity(
  ctx: Context,
  file: string | undefined,
): Promise<LoadedIdentity> {
  if (file !== undefined) return fromFile(ctx, resolve(ctx.cwd, file), true);

  const value = ctx.env[IDENTITY_ENV];
  if (value !== undefined) {
    if (value.trim() === "") {
      throw new CliError(`${IDENTITY_ENV} is set but empty (is the CI secret missing?)`);
    }
    return { identities: parse(value, IDENTITY_ENV), source: IDENTITY_ENV };
  }

  const path = defaultIdentityPath(ctx);
  return fromFile(ctx, path, false);
}

async function fromFile(ctx: Context, path: string, explicit: boolean): Promise<LoadedIdentity> {
  const text = await readOptional(path);
  if (text === undefined) {
    throw new CliError(
      explicit
        ? `identity file ${path} does not exist`
        : `no identity: pass --identity <file>, set ${IDENTITY_ENV}, or create ${path} with "agedrop keygen <name>"`,
    );
  }
  const { mode } = await stat(path);
  if ((mode & 0o077) !== 0) {
    note(ctx, `agedrop: warning: ${path} is readable by other users; run chmod 600 ${path}`);
  }
  return { identities: parse(text, path), source: path };
}

function parse(text: string, source: string): string[] {
  try {
    return parseIdentityFile(text);
  } catch (error) {
    throw new CliError(`${source}: ${(error as Error).message}`);
  }
}

/** The public keys of the loaded identities, for "cannot decrypt" messages. */
export async function publicKeys(identity: LoadedIdentity): Promise<string[]> {
  const keys: string[] = [];
  for (const id of identity.identities) {
    try {
      keys.push(await identityToRecipient(id));
    } catch {
      // A malformed key fails decryption with its own error; nothing to show here.
    }
  }
  return keys;
}
