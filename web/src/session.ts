/**
 * Sign-in details (SPEC.md § Web UI, Sign-in): repository, branch and token, kept in `sessionStorage`,
 * or in `localStorage` when the user asks to be remembered. Never a secret value.
 */

const KEY = "agedrop.session";

export interface Session {
  readonly repository: string;
  readonly branch: string;
  readonly token: string;
  readonly remember: boolean;
}

export function loadSession(): Session | undefined {
  for (const storage of [sessionStorage, localStorage]) {
    const raw = storage.getItem(KEY);
    if (raw === null) continue;
    try {
      const value = JSON.parse(raw) as Partial<Session>;
      if (typeof value.repository === "string" && typeof value.token === "string") {
        return {
          repository: value.repository,
          branch: typeof value.branch === "string" ? value.branch : "",
          token: value.token,
          remember: storage === localStorage,
        };
      }
    } catch {
      storage.removeItem(KEY);
    }
  }
  return undefined;
}

export function saveSession(session: Session): void {
  clearSession();
  const { repository, branch, token } = session;
  (session.remember ? localStorage : sessionStorage).setItem(
    KEY,
    JSON.stringify({ repository, branch, token }),
  );
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY);
  localStorage.removeItem(KEY);
}

/** GitHub's new fine-grained token page, filled in as far as GitHub's URL parameters allow. */
export function tokenUrl(repository: string): string {
  const owner = repository.split("/")[0] ?? "";
  const params = new URLSearchParams({
    name: "agedrop web",
    description: `agedrop web UI for ${repository || "one repository"}`,
    expires_in: "90",
    contents: "write",
  });
  if (owner !== "") params.set("target_name", owner);
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}
