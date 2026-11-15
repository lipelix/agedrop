/** Patterns for names and paths, as defined in SPEC.md "Repository layout". */

const SCOPE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const FILE_NAME = /^[a-z][a-z0-9._-]*$/;
const RECIPIENT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export const SECRETS_DIR = "secrets";
export const RECIPIENTS_DIR = "recipients";
export const REQUESTS_DIR = "requests";
export const CONFIG_FILE = "agedrop.toml";
export const LOCK_FILE = "agedrop.lock";
export const SECRET_EXTENSION = ".age";
export const RECIPIENT_EXTENSION = ".pub";

/** `env` for `[A-Z][A-Z0-9_]*` names, `file` for lowercase file-style names. */
export type SecretKind = "env" | "file";

export function isValidScope(scope: string): boolean {
  return scope.split("/").every((segment) => SCOPE_SEGMENT.test(segment));
}

export function isValidRecipientName(name: string): boolean {
  return RECIPIENT_NAME.test(name);
}

/** Group names follow the same rule as recipient names. */
export const isValidGroupName = isValidRecipientName;

/** Returns the kind of a valid secret name, or `undefined` when the name is invalid. */
export function secretKind(name: string): SecretKind | undefined {
  if (ENV_NAME.test(name)) return "env";
  if (FILE_NAME.test(name)) return "file";
  return undefined;
}

export function isValidSecretName(name: string): boolean {
  return secretKind(name) !== undefined;
}

/** `<scope>/<NAME>`: the secret's key in `agedrop.lock`. */
export function secretId(scope: string, name: string): string {
  assertSecret(scope, name);
  return `${scope}/${name}`;
}

/** Repository-relative path of a secret file: `secrets/<scope>/<NAME>.age`. */
export function secretPath(scope: string, name: string): string {
  return `${SECRETS_DIR}/${secretId(scope, name)}${SECRET_EXTENSION}`;
}

/** Repository-relative path of a recipient file: `recipients/<name>.pub`. */
export function recipientPath(name: string): string {
  if (!isValidRecipientName(name))
    throw new Error(`invalid recipient name: ${JSON.stringify(name)}`);
  return `${RECIPIENTS_DIR}/${name}${RECIPIENT_EXTENSION}`;
}

/**
 * Splits a repository-relative secret path into scope and name.
 * Returns `undefined` for anything that is not a valid `secrets/<scope>/<NAME>.age` path.
 */
export function parseSecretPath(path: string): { scope: string; name: string } | undefined {
  const prefix = `${SECRETS_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith(SECRET_EXTENSION)) return undefined;
  const id = path.slice(prefix.length, -SECRET_EXTENSION.length);
  const slash = id.lastIndexOf("/");
  if (slash <= 0) return undefined;
  const scope = id.slice(0, slash);
  const name = id.slice(slash + 1);
  if (!isValidScope(scope) || !isValidSecretName(name)) return undefined;
  return { scope, name };
}

function assertSecret(scope: string, name: string): void {
  if (!isValidScope(scope)) throw new Error(`invalid scope: ${JSON.stringify(scope)}`);
  if (!isValidSecretName(name)) throw new Error(`invalid secret name: ${JSON.stringify(name)}`);
}
