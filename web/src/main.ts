/**
 * agedrop web UI (SPEC.md § Web UI): inventory, add or replace, fulfil requests, and read values after an
 * owner passkey unlock, with no backend.
 * Routes live in the URL hash so any static host can serve the page.
 */
import { isValidSecretName, secretKind, type SecretRequest } from "../../src/index.js";
import { day, h } from "./dom.js";
import { GitHubClient, GitHubError } from "./github.js";
import {
  activeSession,
  clearSessions,
  findSession,
  loadSessions,
  removeSession,
  saveSession,
  type Session,
  setActive,
  tokenUrl,
} from "./session.js";
import { lock, onLockChange, unlockedOwner } from "./owner.js";
import {
  lockBar,
  type OwnerContext,
  ownerView,
  resetSetup,
  resetShow,
  setupView,
  showButton,
  valuePanel,
  valueShown,
} from "./owner-views.js";
import { loadSnapshot, type Snapshot } from "./snapshot.js";
import { valueField } from "./value-field.js";
import { commitWrite, valueProblem, WriteError } from "./write.js";
import "./styles.css";

interface State {
  session?: Session | undefined;
  client?: GitHubClient | undefined;
  snapshot?: Snapshot | undefined;
  loading?: Promise<Snapshot> | undefined;
  error?: string | undefined;
  /** The last commit this page made, shown once on the page it returns to. */
  flash?: { message: string; url: string } | undefined;
  /** What just happened to the list of repositories, shown once. */
  notice?: string | undefined;
}

const state: State = {};
const root = document.getElementById("app") ?? document.body;

type Route =
  | { page: "inventory" }
  | { page: "add"; scope?: string; name?: string }
  | { page: "requests" }
  | { page: "fulfil"; id: string; repo?: string }
  | { page: "owner" }
  | { page: "owner-setup" }
  | { page: "repositories"; add?: string; next?: string };

function route(): Route {
  const [path = "", query = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "add") {
    const scope = params.get("scope") ?? undefined;
    const name = params.get("name") ?? undefined;
    return {
      page: "add",
      ...(scope === undefined ? {} : { scope }),
      ...(name === undefined ? {} : { name }),
    };
  }
  if (parts[0] === "requests" && parts[1] !== undefined) {
    // A notification links to #/requests/<id>?repo=<owner/name> (SPEC.md § Notifications).
    const repo = params.get("repo") ?? undefined;
    return { page: "fulfil", id: parts[1], ...(repo === undefined ? {} : { repo }) };
  }
  if (parts[0] === "requests") return { page: "requests" };
  if (parts[0] === "owner" && parts[1] === "setup") return { page: "owner-setup" };
  if (parts[0] === "owner") return { page: "owner" };
  if (parts[0] === "repositories") {
    const add = params.get("add") ?? undefined;
    const next = params.get("next") ?? undefined;
    return {
      page: "repositories",
      ...(add === undefined ? {} : { add }),
      // Only a page of this app may follow: the link is untrusted input.
      ...(next?.startsWith("/requests/") ? { next } : {}),
    };
  }
  return { page: "inventory" };
}

function go(hash: string): void {
  if (location.hash === hash) void render();
  else location.hash = hash;
}

async function refresh(): Promise<Snapshot> {
  const client = state.client;
  if (client === undefined) throw new Error("not signed in");
  state.loading = loadSnapshot(client, state.session?.branch);
  try {
    state.snapshot = await state.loading;
    state.error = undefined;
    return state.snapshot;
  } finally {
    state.loading = undefined;
  }
}

/** Bumped on every render, so a render that waited for the repository cannot draw over a newer one. */
let renders = 0;

async function render(): Promise<void> {
  const generation = ++renders;
  if (state.session === undefined) {
    root.replaceChildren(signInView());
    focusHeading();
    return;
  }
  const wanted = route();
  if (wanted.page === "fulfil" && wanted.repo !== undefined && !isOpen(wanted.repo)) {
    // A notification's link names its repository: one this device is signed in to opens by itself.
    const other = findSession(wanted.repo);
    if (other !== undefined) {
      open(other);
      state.notice = `Switched to ${other.repository}.`;
    }
  }
  if (wanted.page === "repositories") {
    resetShow();
    resetSetup();
    root.replaceChildren(shell(wanted, repositoriesView(wanted.add, wanted.next), false));
    focusHeading();
    return;
  }
  if (state.snapshot === undefined && state.error === undefined) {
    root.replaceChildren(
      shell(
        route(),
        h("p", { class: "loading", role: "status" }, "Reading the repository…"),
        false,
      ),
    );
    try {
      await (state.loading ?? refresh());
    } catch (error) {
      state.error = message(error);
      if (error instanceof GitHubError && error.status === 401) {
        rejected(state.session, state.error);
        return;
      }
    }
    if (generation !== renders) return;
  }
  const current = route();
  if (current.page !== "inventory") resetShow();
  if (current.page !== "owner-setup") resetSetup();
  const snapshot = state.snapshot;
  let page: Node;
  if (snapshot === undefined) {
    page = h(
      "section",
      { class: "panel" },
      h("h1", { tabindex: "-1" }, "Cannot read the repository"),
      h("p", { class: "error", role: "alert" }, state.error ?? "Unknown error"),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "button", onclick: () => void reload() }, "Try again"),
        h("a", { class: "button button-quiet", href: "#/repositories" }, "Repositories"),
      ),
    );
  } else if (current.page === "add") page = addView(snapshot, current.scope, current.name);
  else if (current.page === "requests") page = requestsView(snapshot);
  else if (current.page === "fulfil") page = fulfilView(snapshot, current.id, current.repo);
  else if (current.page === "owner") page = ownerView(ownerContext(snapshot));
  else if (current.page === "owner-setup") page = setupView(ownerContext(snapshot));
  else page = inventoryView(snapshot);
  const hadFocus = document.activeElement?.closest(".secret") ? document.activeElement : null;
  root.replaceChildren(shell(current, page));
  if (current.page === "inventory" && (valueShown() || hadFocus !== null)) {
    // Showing or hiding a value re-renders the page: keep focus on that secret, not the heading.
    root
      .querySelector<HTMLElement>(".secret-value, .secret-error, .show[aria-expanded=true]")
      ?.focus({ preventScroll: true });
  } else focusHeading();
}

function ownerContext(snapshot: Snapshot): OwnerContext {
  const client = state.client;
  if (client === undefined) throw new Error("not signed in");
  return {
    snapshot,
    client,
    repository: state.session?.repository ?? "",
    rerender: () => void render(),
    go,
    committed: (result, hash) => {
      state.flash = { message: result.message, url: result.url };
      state.snapshot = undefined;
      go(hash);
    },
  };
}

async function reload(): Promise<void> {
  state.snapshot = undefined;
  state.error = undefined;
  await render();
}

function focusHeading(): void {
  const heading = root.querySelector<HTMLElement>("h1");
  heading?.focus({ preventScroll: true });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpen(repository: string): boolean {
  return state.session?.repository.toLowerCase() === repository.toLowerCase();
}

/** Leaves the open repository: nothing read or unlocked there may show in the next one. */
function close(): void {
  resetShow();
  resetSetup();
  lock();
  state.session = undefined;
  state.client = undefined;
  state.snapshot = undefined;
  state.loading = undefined;
  state.error = undefined;
  state.flash = undefined;
}

/** Makes `session` the repository every page works in. */
function open(session: Session): void {
  close();
  state.client = new GitHubClient(session.repository, session.token);
  state.session = session;
  setActive(session.repository);
}

function signOut(reason?: string): void {
  close();
  clearSessions();
  state.notice = undefined;
  state.error = reason;
  void render();
}

/** Forgets one repository. The open one hands over to the next, or to the sign-in form. */
function forget(repository: string): void {
  const wasOpen = isOpen(repository);
  removeSession(repository);
  if (wasOpen) {
    close();
    const next = activeSession();
    if (next !== undefined) open(next);
  }
}

/** GitHub refused the token of `session`: every repository signed in with it goes, with the reason. */
function rejected(session: Session, reason: string): void {
  const gone = loadSessions().filter((other) => other.token === session.token);
  for (const other of gone) forget(other.repository);
  if (state.session === undefined) {
    signOut(reason);
    return;
  }
  const names = gone.map((other) => other.repository).join(", ");
  state.notice = `${names}: ${reason}. Add ${gone.length === 1 ? "it" : "them"} again with a new token.`;
  go("#/repositories");
}

// ---------------------------------------------------------------------------------------------- shell

function shell(current: Route, page: Node, showFlash = true): HTMLElement {
  const snapshot = state.snapshot;
  const open = snapshot?.requests.length ?? 0;
  const tab = (
    hash: string,
    label: string,
    active: boolean,
    badge?: number,
    unlocked = false,
  ): HTMLElement =>
    h(
      "a",
      { href: hash, class: "tab", "aria-current": active ? "page" : undefined },
      label,
      unlocked
        ? [
            h("span", { class: "unlocked-dot", "aria-hidden": "true" }),
            h("span", { class: "visually-hidden" }, " (unlocked)"),
          ]
        : null,
      badge !== undefined && badge > 0
        ? h("span", { class: "badge", "aria-label": `${String(badge)} open` }, String(badge))
        : null,
    );
  return h(
    "div",
    { class: "shell" },
    h(
      "header",
      { class: "topbar" },
      h(
        "div",
        { class: "topbar-row" },
        h("a", { href: "#/", class: "wordmark", "aria-label": "agedrop, inventory" }, "agedrop"),
        h(
          "a",
          {
            class: "repo",
            href: "#/repositories",
            title: state.session?.repository,
            "aria-current": current.page === "repositories" ? "page" : undefined,
          },
          h("span", { class: "visually-hidden" }, "Repository "),
          h(
            "span",
            { class: "repo-name" },
            state.session?.repository ?? "",
            snapshot !== undefined ? h("span", { class: "branch" }, ` @ ${snapshot.branch}`) : null,
          ),
          h("span", { class: "visually-hidden" }, ": switch or add"),
        ),
        h(
          "button",
          {
            class: "link-button sign-out",
            onclick: () => {
              signOut();
            },
          },
          "Sign out",
        ),
      ),
      h(
        "nav",
        { class: "tabs", "aria-label": "Pages" },
        tab("#/", "Inventory", current.page === "inventory"),
        tab("#/add", "Add", current.page === "add"),
        tab(
          "#/requests",
          "Requests",
          current.page === "requests" || current.page === "fulfil",
          open,
        ),
        tab(
          "#/owner",
          "Owner",
          current.page === "owner" || current.page === "owner-setup",
          undefined,
          unlockedOwner() !== undefined,
        ),
      ),
    ),
    h(
      "main",
      { class: "page" },
      // The shell drawn while the repository loads is replaced at once: it must not use these up.
      showFlash || current.page === "repositories" ? notice() : null,
      showFlash ? flash() : null,
      page,
    ),
  );
}

function flash(): HTMLElement | null {
  const done = state.flash;
  if (done === undefined) return null;
  state.flash = undefined;
  const safeUrl = done.url.startsWith("https://github.com/") ? done.url : undefined;
  return h(
    "div",
    { class: "flash", role: "status" },
    h("strong", {}, "Committed. "),
    h("code", {}, done.message),
    safeUrl === undefined
      ? null
      : h(
          "a",
          { class: "flash-link", href: safeUrl, target: "_blank", rel: "noopener noreferrer" },
          "View on GitHub",
        ),
  );
}

function notice(): HTMLElement | null {
  const text = state.notice;
  if (text === undefined) return null;
  state.notice = undefined;
  return h("p", { class: "notice", role: "status" }, text);
}

// ------------------------------------------------------------------------------------------- sign-in

function signInView(): HTMLElement {
  const current = route();
  const linked =
    current.page === "fulfil" ? current.repo : current.page === "repositories" ? current.add : "";
  return h(
    "div",
    { class: "signin-wrap" },
    repositoryForm({
      first: true,
      repository: linked ?? "",
      error: state.error,
      done: () => {
        // A notification's link stays in the hash, so its fulfil form opens after sign-in.
        if (current.page === "repositories") go(`#${current.next ?? "/"}`);
        else void render();
      },
    }),
  );
}

/** Where a token comes from: typed in, or the one a signed-in repository already uses. */
function tokenChoices(sessions: readonly Session[]): Session[] {
  const seen = new Set<string>();
  return sessions.filter((session) => !seen.has(session.token) && seen.add(session.token));
}

function ownerOf(repository: string): string {
  return (repository.split("/")[0] ?? "").toLowerCase();
}

/**
 * The form that signs in to a repository: the whole sign-in page for the first one, a section of the
 * Repositories page for the next. The token is checked against GitHub before anything is stored.
 */
function repositoryForm(options: {
  first: boolean;
  repository: string;
  error?: string | undefined;
  done: () => void;
}): HTMLElement {
  const choices = tokenChoices(loadSessions());
  const repository = h("input", {
    id: "repository",
    name: "repository",
    required: true,
    placeholder: "owner/name",
    pattern: "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
    // The repository is the password manager's username: a saved token is named after it.
    autocomplete: "username",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    value: options.repository,
    oninput: () => {
      link.href = tokenUrl(repository.value.trim());
      if (!picked) suggest();
    },
  });
  const branch = h("input", {
    id: "branch",
    name: "branch",
    placeholder: "default branch",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  const token = h("input", {
    id: "token",
    name: "token",
    type: "password",
    required: true,
    autocomplete: "current-password",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "github_pat_…",
    "aria-describedby": "token-hint",
  });
  const remember = h("input", { id: "remember", type: "checkbox", name: "remember" });
  const link = h(
    "a",
    { href: tokenUrl(options.repository), target: "_blank", rel: "noopener noreferrer" },
    "Create a token on GitHub",
  );
  const error = h("p", { class: "error", role: "alert" }, options.error ?? "");
  const idle = options.first ? "Sign in" : "Add repository";
  const submit = h("button", { class: "button", type: "submit" }, idle);

  // With a repository signed in, its token can serve the next one: GitHub lets one fine-grained token
  // cover several repositories of an owner.
  let picked = false;
  const source = h(
    "select",
    {
      id: "token-source",
      name: "token-source",
      "aria-describedby": "token-source-hint",
      onchange: () => {
        picked = true;
        sync();
      },
    },
    choices.map((session, index) =>
      h("option", { value: String(index) }, `The token of ${session.repository}`),
    ),
    h("option", { value: "new" }, "A new token"),
  );
  const tokenField = field(
    "token",
    choices.length === 0 ? "Fine-grained token" : "New fine-grained token",
    token,
    h(
      "span",
      {},
      "Only your secrets repositories, with Contents: read and write, and an expiry. One token can cover several repositories of the same owner. ",
      link,
      ". If GitHub says the name is taken, you already have a token for this owner: ",
      h(
        "a",
        {
          href: "https://github.com/settings/personal-access-tokens",
          target: "_blank",
          rel: "noopener noreferrer",
        },
        "edit it",
      ),
      ", add this repository under Repository access, and paste it here.",
    ),
  );
  const sourceField = field(
    "token-source",
    "Token",
    source,
    h(
      "span",
      {},
      "A saved token works here once it covers this repository: ",
      h(
        "a",
        {
          href: "https://github.com/settings/personal-access-tokens",
          target: "_blank",
          rel: "noopener noreferrer",
        },
        "edit it on GitHub",
      ),
      " and add the repository under Repository access.",
    ),
  );
  const reused = (): Session | undefined =>
    source.value === "new" ? undefined : choices[Number(source.value)];
  function sync(): void {
    const saved = reused();
    tokenField.hidden = saved !== undefined;
    token.required = saved === undefined;
    if (saved !== undefined) remember.checked = saved.remember;
  }
  /** Until the user picks: a saved token of the same owner, a new one for another owner. */
  function suggest(): void {
    const owner = ownerOf(repository.value.trim());
    const match = choices.findIndex((session) => ownerOf(session.repository) === owner);
    source.value = owner === "" && choices.length > 0 ? "0" : match === -1 ? "new" : String(match);
    sync();
  }
  suggest();

  return h(
    "form",
    {
      class: options.first ? "panel signin" : "panel add-repository",
      "aria-labelledby": options.first ? undefined : "repository-form-title",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const session: Session = {
          repository: repository.value.trim(),
          branch: branch.value.trim(),
          token: reused()?.token ?? token.value.trim(),
          remember: remember.checked,
        };
        let client: GitHubClient;
        try {
          client = new GitHubClient(session.repository, session.token);
        } catch (failure) {
          error.textContent = message(failure);
          return;
        }
        error.textContent = "";
        submit.disabled = true;
        submit.textContent = "Checking with GitHub…";
        void client.repo().then(
          () => {
            saveSession(session);
            open(session);
            if (!options.first) state.notice = `Added ${session.repository}.`;
            options.done();
          },
          (failure: unknown) => {
            error.textContent =
              reused() !== undefined && failure instanceof GitHubError && failure.status === 404
                ? `${message(failure)}. Add it to the token on GitHub, or use a new token.`
                : message(failure);
            submit.disabled = false;
            submit.textContent = idle;
          },
        );
      },
    },
    options.first ? h("p", { class: "eyebrow" }, "agedrop") : null,
    options.first
      ? h("h1", { tabindex: "-1" }, "Sign in to your secrets repository")
      : h("h2", { id: "repository-form-title" }, "Add a repository"),
    options.first
      ? h(
          "p",
          { class: "lede" },
          "This page encrypts on your device and commits through the GitHub API. There is no agedrop server, and only ciphertext leaves the page.",
        )
      : null,
    field("repository", "Repository", repository),
    field("branch", "Branch", branch, "Leave empty for the repository's default branch."),
    choices.length === 0 ? null : sourceField,
    tokenField,
    h(
      "label",
      { class: "check" },
      remember,
      h(
        "span",
        {},
        "Remember on this device",
        h("small", {}, "Otherwise the token is forgotten when the tab closes."),
      ),
    ),
    error,
    submit,
  );
}

// -------------------------------------------------------------------------------------- repositories

function repositoriesView(add?: string, next?: string): HTMLElement {
  const sessions = loadSessions();
  const shared = (session: Session): number =>
    sessions.filter((other) => other.token === session.token).length;
  return h(
    "section",
    { class: "repositories" },
    h("h1", { tabindex: "-1" }, "Repositories"),
    h(
      "p",
      { class: "lede" },
      "Every repository this device is signed in to. Pages show one at a time.",
    ),
    h(
      "ul",
      { class: "repo-list", "aria-label": "Signed-in repositories" },
      sessions.map((session) => {
        const current = isOpen(session.repository);
        return h(
          "li",
          { class: "repo-row" },
          h(
            "button",
            {
              class: "repo-open",
              type: "button",
              "aria-current": current ? "true" : undefined,
              onclick: () => {
                if (!current) open(session);
                go("#/");
              },
            },
            h("strong", {}, session.repository),
            h(
              "span",
              { class: "repo-meta" },
              [
                ...(session.branch === "" ? [] : [session.branch]),
                session.remember ? "remembered" : "this tab only",
                ...(shared(session) > 1 ? ["shared token"] : []),
              ].join(" · "),
            ),
            current ? h("span", { class: "repo-current" }, "Open") : null,
          ),
          h(
            "button",
            {
              class: "link-button repo-remove",
              type: "button",
              "aria-label": `Remove ${session.repository}`,
              onclick: () => {
                forget(session.repository);
                if (state.session === undefined) {
                  signOut();
                  return;
                }
                state.notice = `Removed ${session.repository} from this device. Its token still exists on GitHub.`;
                void render();
              },
            },
            "Remove",
          ),
        );
      }),
    ),
    repositoryForm({
      first: false,
      repository: add ?? "",
      done: () => {
        go(`#${next ?? "/"}`);
      },
    }),
  );
}

function field(id: string, label: string, control: HTMLElement, hint?: string | Node): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("label", { for: id, class: "label" }, label),
    control,
    hint === undefined ? null : h("p", { class: "hint", id: `${id}-hint` }, hint),
  );
}

// ----------------------------------------------------------------------------------------- inventory

/** Says that the branch has no agedrop.toml, and how to set it up. */
function notSetUpBox(snapshot: Snapshot): HTMLElement {
  return h(
    "section",
    { class: "not-set-up", "aria-labelledby": "not-set-up-title" },
    h("h2", { id: "not-set-up-title" }, "This repository is not set up for agedrop"),
    h(
      "p",
      {},
      h("strong", {}, snapshot.repository),
      " has no ",
      h("code", {}, "agedrop.toml"),
      " on branch ",
      h("strong", {}, snapshot.branch),
      ".",
    ),
    h(
      "p",
      {},
      "Run ",
      h("code", {}, "agedrop init --owner <name>"),
      " in a clone of it and push, or check the repository and branch you signed in with.",
    ),
  );
}

/** Owners named in `agedrop.toml` with no `recipients/<name>.pub` yet: a store fresh from `init`. */
function keylessOwners(snapshot: Snapshot): string[] {
  const owners = snapshot.config?.groups.get("owners") ?? [];
  return owners.filter((name) => !snapshot.recipientFiles.has(name));
}

/** Says that an owner has no key yet, and leads to the Owner page, which makes one. */
function firstOwnerBox(names: readonly string[]): HTMLElement {
  const first = names[0] ?? "";
  return h(
    "section",
    { class: "not-set-up", "aria-labelledby": "first-owner-title" },
    h("h2", { id: "first-owner-title" }, `Set up the key of ${first}`),
    h(
      "p",
      {},
      h("code", {}, "agedrop.toml"),
      ` names ${names.join(", ")} as owner${names.length === 1 ? "" : "s"}, with no key yet. `,
      "The Owner page makes the key, locks it with a passkey and shows its backup once. ",
      "Adding secrets works once it is committed.",
    ),
    h("p", {}, h("a", { class: "button", href: "#/owner/setup" }, `Set up ${first}`)),
  );
}

function problemsBox(snapshot: Snapshot): HTMLElement | HTMLElement[] | null {
  // Without agedrop.toml, "agedrop.toml: missing" is said once, by the not-set-up box; an owner without
  // a key is said once, by the first-owner box.
  const keyless = keylessOwners(snapshot);
  const said = new Set([
    ...(snapshot.configMissing ? ["agedrop.toml: missing"] : []),
    ...keyless.map(
      (name) => `agedrop.toml: recipients.owners: "${name}" has no recipients/${name}.pub`,
    ),
  ]);
  const problems = snapshot.problems.filter((problem) => !said.has(problem));
  const notSetUp = snapshot.configMissing
    ? notSetUpBox(snapshot)
    : keyless.length > 0
      ? firstOwnerBox(keyless)
      : null;
  if (problems.length === 0) return notSetUp;
  const box = h(
    "section",
    { class: "problems", "aria-labelledby": "problems-title" },
    h(
      "h2",
      { id: "problems-title" },
      `${String(problems.length)} problem${problems.length === 1 ? "" : "s"} found`,
    ),
    h(
      "p",
      {},
      "Fix these in the repository (agedrop check lists the same). Writes stay off while agedrop.toml, recipients or agedrop.lock do not validate.",
    ),
    h(
      "ul",
      {},
      problems.map((problem) => h("li", {}, h("code", {}, problem))),
    ),
  );
  return notSetUp === null ? box : [notSetUp, box];
}

function inventoryView(snapshot: Snapshot): HTMLElement {
  const known = new Set(snapshot.scopes.map((scope) => scope.scope));
  const orphans = snapshot.secrets.filter((secret) => !known.has(secret.scope));
  const stale = snapshot.secrets.filter((secret) => secret.status === "stale").length;
  const open = snapshot.requests.length;

  const summary = h(
    "dl",
    { class: "summary" },
    h("div", {}, h("dt", {}, "Secrets"), h("dd", {}, String(snapshot.secrets.length))),
    h("div", {}, h("dt", {}, "Scopes"), h("dd", {}, String(snapshot.scopes.length))),
    h(
      "div",
      { class: stale > 0 ? "warn" : undefined },
      h("dt", {}, "Stale"),
      h("dd", {}, String(stale)),
    ),
    h(
      "div",
      { class: open > 0 ? "attention" : undefined },
      h("dt", {}, "Requests"),
      h("dd", {}, open > 0 ? h("a", { href: "#/requests" }, String(open)) : "0"),
    ),
  );

  const scopeCard = (scope: string, names: readonly string[] | undefined): HTMLElement => {
    const secrets = snapshot.secrets.filter((secret) => secret.scope === scope);
    return h(
      "section",
      { class: "scope", "aria-labelledby": `scope-${scope}` },
      h(
        "header",
        { class: "scope-head" },
        h("h2", { id: `scope-${scope}` }, scope),
        names === undefined
          ? h(
              "p",
              { class: "recipients warn" },
              known.has(scope) ? "recipients unresolved" : "not in agedrop.toml",
            )
          : h(
              "p",
              { class: "recipients" },
              h("span", { class: "visually-hidden" }, "Encrypted to "),
              names.join(" · "),
            ),
      ),
      secrets.length === 0
        ? h("p", { class: "empty" }, "No secrets yet.")
        : h(
            "ul",
            { class: "secrets" },
            secrets.map((secret) =>
              h(
                "li",
                { class: "secret" },
                h(
                  "div",
                  { class: "secret-main" },
                  h("span", { class: "secret-name" }, secret.name),
                  h(
                    "span",
                    { class: `pill pill-${secret.status.replace(" ", "-")}` },
                    secret.status,
                  ),
                ),
                h(
                  "div",
                  { class: "secret-meta" },
                  h("span", { class: "kind" }, secret.kind === "env" ? "env" : "file"),
                  secret.lastChange === undefined
                    ? h("span", {}, "no commit")
                    : h(
                        "span",
                        {},
                        h(
                          "time",
                          { datetime: secret.lastChange.date },
                          day(secret.lastChange.date),
                        ),
                        ` by ${secret.lastChange.author}`,
                      ),
                  showButton(ownerContext(snapshot), secret),
                  known.has(secret.scope)
                    ? h(
                        "a",
                        {
                          class: "replace",
                          href: `#/add?${new URLSearchParams({ scope: secret.scope, name: secret.name }).toString()}`,
                          "aria-label": `Replace ${secret.scope}/${secret.name}`,
                        },
                        "Replace",
                      )
                    : null,
                ),
                valuePanel(ownerContext(snapshot), secret),
              ),
            ),
          ),
    );
  };

  return h(
    "div",
    { class: "inventory" },
    h(
      "div",
      { class: "page-head" },
      h("h1", { tabindex: "-1" }, "Inventory"),
      h("button", { class: "link-button", onclick: () => void reload() }, "Reload"),
    ),
    summary,
    open > 0
      ? h(
          "a",
          { class: "callout", href: "#/requests" },
          h("strong", {}, `${String(open)} open request${open === 1 ? "" : "s"}`),
          h("span", {}, " waiting for a value →"),
        )
      : null,
    lockBar(ownerContext(snapshot)),
    problemsBox(snapshot),
    snapshot.configMissing
      ? null
      : snapshot.scopes.length === 0
        ? h("p", { class: "empty" }, "agedrop.toml defines no scopes yet.")
        : snapshot.scopes.map((scope) => scopeCard(scope.scope, scope.resolved?.names)),
    [...new Set(orphans.map((secret) => secret.scope))].map((scope) => scopeCard(scope, undefined)),
  );
}

// ------------------------------------------------------------------------------------- add / fulfil

interface WriteFormOptions {
  readonly snapshot: Snapshot;
  readonly scope?: string;
  readonly name?: string;
  readonly request?: SecretRequest;
}

function writeForm(options: WriteFormOptions): HTMLElement {
  const { snapshot, request } = options;
  const scopes = snapshot.scopes;
  const scopeSelect = h(
    "select",
    { id: "scope", name: "scope", required: true, disabled: request !== undefined },
    h("option", { value: "" }, "Choose a scope"),
    scopes.map((scope) =>
      h(
        "option",
        { value: scope.scope, selected: scope.scope === (request?.scope ?? options.scope) },
        scope.scope,
      ),
    ),
  );
  const nameInput = h("input", {
    id: "name",
    name: "name",
    required: true,
    readonly: request !== undefined,
    value: request?.name ?? options.name ?? "",
    placeholder: "DATABASE_URL or tls.key",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    "aria-describedby": "name-hint",
  });
  const nameHint = h("p", { class: "hint", id: "name-hint" });
  const recipients = h("p", { class: "to" });
  const value = valueField("value");
  const error = h("p", { class: "error", role: "alert" });
  const submit = h(
    "button",
    { class: "button", type: "submit" },
    request === undefined ? "Encrypt and commit" : "Encrypt, commit and close request",
  );

  const update = (): void => {
    const name = nameInput.value.trim();
    const kind = secretKind(name);
    value.setName(name);
    nameHint.textContent =
      name === ""
        ? "UPPER_CASE for env values, lowercase.with.dots for files."
        : kind === undefined
          ? "Not a valid name: UPPER_CASE (env) or lowercase (file), no mixed case."
          : `${kind === "env" ? "Env-style" : "File-style"} secret · secrets/${scopeSelect.value || "<scope>"}/${name}.age${
              snapshot.secrets.some(
                (secret) => secret.scope === scopeSelect.value && secret.name === name,
              )
                ? " · replaces the current value"
                : ""
            }`;
    const resolved = scopes.find((scope) => scope.scope === scopeSelect.value)?.resolved;
    recipients.replaceChildren(
      resolved === undefined
        ? ""
        : h(
            "span",
            {},
            "Encrypted to ",
            h("strong", {}, resolved.names.join(", ")),
            ` (${String(resolved.recipients.length)} key${resolved.recipients.length === 1 ? "" : "s"})`,
          ),
    );
  };
  scopeSelect.addEventListener("change", update);
  nameInput.addEventListener("input", update);
  update();

  const form = h(
    "form",
    {
      class: "write-form",
      novalidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        void (async () => {
          error.textContent = "";
          const scope = request?.scope ?? scopeSelect.value;
          const name = request?.name ?? nameInput.value.trim();
          if (scope === "") return void (error.textContent = "Choose a scope.");
          if (!isValidSecretName(name))
            return void (error.textContent = "Enter a valid secret name.");
          const bytes = await value.read();
          const problem = valueProblem(name, bytes);
          if (problem !== undefined) return void (error.textContent = `Not written: ${problem}.`);
          const client = state.client;
          const current = state.snapshot;
          if (client === undefined || current === undefined) return;
          submit.disabled = true;
          submit.textContent = "Encrypting and committing…";
          form.setAttribute("aria-busy", "true");
          try {
            const result = await commitWrite(client, current, {
              scope,
              name,
              value: bytes,
              ...(request === undefined ? {} : { requestId: request.id }),
            });
            bytes.fill(0);
            value.clear();
            state.flash = { message: result.message, url: result.url };
            state.snapshot = undefined;
            go(request === undefined ? "#/" : "#/requests");
          } catch (failure) {
            bytes.fill(0);
            error.textContent =
              failure instanceof WriteError || failure instanceof GitHubError
                ? `Not written: ${failure.message}.`
                : `Not written: ${message(failure)}`;
            submit.disabled = false;
            submit.textContent = "Try again";
            form.removeAttribute("aria-busy");
          }
        })();
      },
    },
    request === undefined ? field("scope", "Scope", scopeSelect) : null,
    request === undefined ? field("name", "Secret name", h("div", {}, nameInput, nameHint)) : null,
    recipients,
    value.element,
    error,
    submit,
  );
  return form;
}

function addView(snapshot: Snapshot, scope?: string, name?: string): HTMLElement {
  const replacing =
    scope !== undefined &&
    name !== undefined &&
    snapshot.secrets.some((s) => s.scope === scope && s.name === name);
  return h(
    "section",
    { class: "panel" },
    h("h1", { tabindex: "-1" }, replacing ? "Replace a secret" : "Add a secret"),
    h(
      "p",
      { class: "lede" },
      "The value is encrypted in this browser to the scope's public keys, then committed. Nobody can read it back here, you included.",
    ),
    problemsBox(snapshot),
    writeForm({
      snapshot,
      ...(scope === undefined ? {} : { scope }),
      ...(name === undefined ? {} : { name }),
    }),
  );
}

function requestsView(snapshot: Snapshot): HTMLElement {
  return h(
    "section",
    { class: "requests" },
    h(
      "div",
      { class: "page-head" },
      h("h1", { tabindex: "-1" }, "Open requests"),
      h("button", { class: "link-button", onclick: () => void reload() }, "Reload"),
    ),
    snapshot.requests.length === 0
      ? h(
          "div",
          { class: "empty-state" },
          h("p", {}, h("strong", {}, "Nothing is waiting.")),
          h("p", {}, "When an agent runs agedrop request and pushes, its request shows up here."),
        )
      : h(
          "ul",
          { class: "request-list" },
          snapshot.requests.map((request) =>
            h(
              "li",
              {},
              h(
                "a",
                { class: "request-card", href: `#/requests/${request.id}` },
                h(
                  "span",
                  { class: "request-secret" },
                  `${request.scope}/`,
                  h("strong", {}, request.name),
                ),
                h("span", { class: "request-reason" }, request.reason),
                h(
                  "span",
                  { class: "request-meta" },
                  `${request.requestedBy} · `,
                  h("time", { datetime: request.created }, day(request.created)),
                  ` · ${request.id}`,
                ),
              ),
            ),
          ),
        ),
  );
}

function fulfilView(snapshot: Snapshot, id: string, repo?: string): HTMLElement {
  const signedIn = state.session?.repository ?? "";
  if (repo !== undefined && !isOpen(repo)) {
    const add = new URLSearchParams({ add: repo, next: `/requests/${id}?repo=${repo}` });
    return h(
      "section",
      { class: "panel" },
      h("h1", { tabindex: "-1" }, "Request in another repository"),
      h(
        "p",
        {},
        `This link is for request ${id} in ${repo}, and this device is not signed in to it. Add it to fulfil the request; ${signedIn} stays signed in.`,
      ),
      h("a", { class: "button", href: `#/repositories?${add.toString()}` }, `Add ${repo}`),
    );
  }
  const request = snapshot.requests.find((open) => open.id === id);
  if (request === undefined) {
    return h(
      "section",
      { class: "panel" },
      h("h1", { tabindex: "-1" }, "Request not open"),
      h(
        "p",
        {},
        `Request ${id} is not in requests/ on this branch: it was fulfilled or withdrawn.`,
      ),
      h("a", { class: "button", href: "#/requests" }, "Back to requests"),
    );
  }
  const exists = snapshot.secrets.some(
    (secret) => secret.scope === request.scope && secret.name === request.name,
  );
  return h(
    "section",
    { class: "panel fulfil" },
    h("p", { class: "eyebrow" }, `Request ${request.id}`),
    h(
      "h1",
      { tabindex: "-1", "aria-label": `${request.scope}/${request.name}` },
      h("span", { class: "scope-prefix" }, `${request.scope}/`),
      request.name,
    ),
    h(
      "dl",
      { class: "request-details" },
      h("div", {}, h("dt", {}, "Reason"), h("dd", {}, request.reason)),
      h("div", {}, h("dt", {}, "Requested by"), h("dd", {}, request.requestedBy)),
      h(
        "div",
        {},
        h("dt", {}, "Filed"),
        h(
          "dd",
          {},
          h(
            "time",
            { datetime: request.created },
            request.created.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC"),
          ),
        ),
      ),
      exists
        ? h(
            "div",
            {},
            h("dt", {}, "Note"),
            h("dd", {}, "This secret exists: fulfilling replaces its value."),
          )
        : null,
    ),
    request.generate === undefined
      ? null
      : h(
          "div",
          { class: "generate-hint" },
          h("p", { class: "label" }, "Suggested command"),
          h("pre", {}, h("code", {}, request.generate)),
          h(
            "p",
            { class: "hint" },
            "Written by the requester, so read it first. This page never runs it: run it on a machine you trust and paste the output, or use Generate.",
          ),
        ),
    problemsBox(snapshot),
    writeForm({ snapshot, request }),
  );
}

// -------------------------------------------------------------------------------------------- start

const saved = activeSession();
if (saved !== undefined) {
  try {
    open(saved);
  } catch {
    clearSessions();
  }
}
window.addEventListener("hashchange", () => void render());
// A shown value never outlives the tab being in view; an unlocked key is dropped when it times out.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && valueShown()) {
    resetShow();
    void render();
  }
});
onLockChange(() => {
  if (unlockedOwner() === undefined) resetShow();
  void render();
});
void render();
