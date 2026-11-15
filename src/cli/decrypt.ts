import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type SecretKind, secretKind, secretPath } from "../names.js";
import { listSecretFiles, type Repository } from "../node.js";
import { decryptSecret } from "../secret.js";
import { CliError } from "./context.js";
import { type LoadedIdentity, publicKeys } from "./identity.js";
import { scopeOf } from "./repo.js";

export interface Plaintext {
  readonly name: string;
  readonly kind: SecretKind;
  readonly value: Uint8Array;
}

/**
 * Decrypts the secrets directly in `secrets/<scope>/` (not nested scopes), or only `names`.
 * Fails on an unknown scope or name, and when the identity is not a recipient of a file.
 */
export async function decryptScope(
  repo: Repository,
  scope: string,
  names: readonly string[],
  identity: LoadedIdentity,
): Promise<Plaintext[]> {
  scopeOf(repo, scope);
  const available = (await listSecretFiles(repo.root))
    .filter((file) => file.scope === scope && file.name !== undefined)
    .map((file) => file.name ?? "");
  for (const name of names) {
    if (!available.includes(name)) throw new CliError(`no secret ${secretPath(scope, name)}`);
  }
  const selected = names.length > 0 ? [...new Set(names)] : available;

  const plaintexts: Plaintext[] = [];
  for (const name of selected) {
    const path = secretPath(scope, name);
    let value: Uint8Array;
    try {
      value = await decryptSecret(
        await readFile(join(repo.root, path), "utf8"),
        identity.identities,
      );
    } catch (error) {
      const keys = await publicKeys(identity);
      throw new CliError(
        `${path}: cannot decrypt with the identity from ${identity.source} (${keys.join(", ") || "no valid key"}): ${(error as Error).message}. Is this host in a group of scope "${scope}", and was the secret added or rekeyed since?`,
      );
    }
    plaintexts.push({ name, kind: secretKind(name) ?? "file", value });
  }
  return plaintexts;
}
