/**
 * Sign-in details (SPEC.md § Web UI, Sign-in): one entry per repository with its branch and token, kept
 * in `sessionStorage`, or in `localStorage` for the entries the user asked to be remembered. Never a
 * secret value.
 */

const KEY = "agedrop.session";
const ACTIVE = "agedrop.active";

export interface Session {
  readonly repository: string;
  readonly branch: string;
  readonly token: string;
  readonly remember: boolean;
}

type Stored = Pick<Session, "repository" | "branch" | "token">;

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The entries of one storage. A single object is the format from before several repositories. */
function read(storage: Storage): Stored[] {
  const raw = storage.getItem(KEY);
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    const entries: unknown[] = Array.isArray(value) ? value : [value];
    return entries.flatMap((entry) => {
      const { repository, branch, token } = (entry ?? {}) as Partial<Stored>;
      if (typeof repository !== "string" || typeof token !== "string") return [];
      return [{ repository, branch: typeof branch === "string" ? branch : "", token }];
    });
  } catch {
    storage.removeItem(KEY);
    return [];
  }
}

function write(storage: Storage, entries: readonly Stored[]): void {
  if (entries.length === 0) storage.removeItem(KEY);
  else storage.setItem(KEY, JSON.stringify(entries));
}

/** Every signed-in repository, sorted by name. An entry of this tab wins over a remembered one. */
export function loadSessions(): Session[] {
  const sessions: Session[] = [];
  for (const storage of [sessionStorage, localStorage]) {
    for (const entry of read(storage)) {
      if (sessions.some((known) => same(known.repository, entry.repository))) continue;
      sessions.push({ ...entry, remember: storage === localStorage });
    }
  }
  return sessions.sort((a, b) =>
    a.repository.toLowerCase().localeCompare(b.repository.toLowerCase()),
  );
}

export function findSession(repository: string): Session | undefined {
  return loadSessions().find((session) => same(session.repository, repository));
}

/** The repository this tab works in: the one it opened last, else the one opened last on this device. */
export function activeSession(): Session | undefined {
  const sessions = loadSessions();
  for (const storage of [sessionStorage, localStorage]) {
    const name = storage.getItem(ACTIVE);
    const session = name === null ? undefined : sessions.find((s) => same(s.repository, name));
    if (session !== undefined) return session;
  }
  return sessions[0];
}

export function setActive(repository: string): void {
  sessionStorage.setItem(ACTIVE, repository);
  // Only a remembered repository may leave a trace after the tab closes.
  if (findSession(repository)?.remember === true) localStorage.setItem(ACTIVE, repository);
}

/** Adds the repository, or replaces its entry, and makes it the active one. */
export function saveSession(session: Session): void {
  removeSession(session.repository);
  const { repository, branch, token } = session;
  const storage = session.remember ? localStorage : sessionStorage;
  write(storage, [...read(storage), { repository, branch, token }]);
  setActive(repository);
}

export function removeSession(repository: string): void {
  for (const storage of [sessionStorage, localStorage]) {
    write(
      storage,
      read(storage).filter((entry) => !same(entry.repository, repository)),
    );
    const active = storage.getItem(ACTIVE);
    if (active !== null && same(active, repository)) storage.removeItem(ACTIVE);
  }
}

export function clearSessions(): void {
  for (const storage of [sessionStorage, localStorage]) {
    storage.removeItem(KEY);
    storage.removeItem(ACTIVE);
  }
}

/** GitHub's new fine-grained token page, filled in as far as GitHub's URL parameters allow. */
export function tokenUrl(repository: string): string {
  const owner = repository.split("/")[0] ?? "";
  const params = new URLSearchParams({
    name: "agedrop web",
    description: `agedrop web UI for ${repository || "my secrets repositories"}`,
    expires_in: "90",
    contents: "write",
  });
  if (owner !== "") params.set("target_name", owner);
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}
