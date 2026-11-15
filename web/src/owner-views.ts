/**
 * The Owner page, the passkey setup steps, and Show on a secret (SPEC.md § Web UI, Owner passkey).
 * Values and identities live in this module's memory only; nothing here touches storage.
 */
import { h } from "./dom.js";
import type { GitHubClient } from "./github.js";
import {
  commitOwnerSetup,
  createPasskey,
  describePasskeyError,
  lock,
  type OwnerSetup,
  passkeyOwners,
  revealSecret,
  setupCase,
  setupIdentity,
  unlockedOwner,
  unlockWithBackup,
  unlockWithPasskey,
  wrapWithPasskey,
} from "./owner.js";
import type { SecretView, Snapshot } from "./snapshot.js";
import type { OwnerIdentity } from "../../src/index.js";

/** How long a shown value stays on screen. */
export const SHOW_MS = 30 * 1000;

export interface OwnerContext {
  readonly snapshot: Snapshot;
  readonly client: GitHubClient;
  readonly repository: string;
  /** Re-renders the current page. */
  rerender(): void;
  /** Navigates to `hash`. */
  go(hash: string): void;
  /** Shows `result` on the next page and reads the repository again. */
  committed(result: { message: string; url: string }, hash: string): void;
}

// -------------------------------------------------------------------------------------- show a value

interface Shown {
  readonly path: string;
  readonly name: string;
  readonly kind: "env" | "file";
  bytes: Uint8Array;
  readonly text?: string;
  readonly until: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

let shown: Shown | undefined;
let showError: { path: string; message: string } | undefined;
let busy: string | undefined;
let rerenderHook: (() => void) | undefined;

/** Hides the shown value and wipes its bytes. Returns whether one was shown. */
export function hideValue(): boolean {
  if (shown === undefined) return false;
  clearTimeout(shown.timer);
  shown.bytes.fill(0);
  shown = undefined;
  return true;
}

/** Whether a value is on screen, so the page can keep focus on it instead of the heading. */
export function valueShown(): boolean {
  return shown !== undefined;
}

/** Forgets every message and value, e.g. on navigation. */
export function resetShow(): void {
  hideValue();
  showError = undefined;
}

export function canShow(snapshot: Snapshot): boolean {
  return snapshot.ownerIdentities.size > 0 || unlockedOwner() !== undefined;
}

async function show(ctx: OwnerContext, secret: SecretView): Promise<void> {
  rerenderHook = () => {
    ctx.rerender();
  };
  hideValue();
  showError = undefined;
  busy = secret.path;
  ctx.rerender();
  try {
    if (unlockedOwner() === undefined) {
      const owners = passkeyOwners(ctx.snapshot);
      if (owners.length !== 1) {
        busy = undefined;
        ctx.go("#/owner");
        return;
      }
      await unlockWithPasskey(ctx.snapshot, owners[0] ?? "");
    }
    const bytes = await revealSecret(ctx.client, secret);
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) text = undefined;
    } catch {
      text = undefined;
    }
    shown = {
      path: secret.path,
      name: secret.name,
      kind: secret.kind,
      bytes,
      ...(text === undefined ? {} : { text }),
      until: Date.now() + SHOW_MS,
      timer: setTimeout(() => {
        if (hideValue()) rerenderHook?.();
      }, SHOW_MS),
    };
  } catch (error) {
    showError = { path: secret.path, message: describePasskeyError(error) };
  } finally {
    busy = undefined;
  }
  ctx.rerender();
}

/** The Show button for one secret in the inventory. */
export function showButton(ctx: OwnerContext, secret: SecretView): HTMLElement | null {
  if (!canShow(ctx.snapshot) || secret.sha === undefined) return null;
  const open = shown?.path === secret.path;
  return h(
    "button",
    {
      class: "link-button show",
      type: "button",
      disabled: busy !== undefined,
      "aria-expanded": open ? "true" : "false",
      "aria-label": `${open ? "Hide" : "Show"} ${secret.scope}/${secret.name}`,
      onclick: () => {
        if (open) {
          hideValue();
          ctx.rerender();
        } else void show(ctx, secret);
      },
    },
    busy === secret.path ? "Unlocking…" : open ? "Hide" : "Show",
  );
}

/** The value panel under a secret, when it is shown or failed to show. */
export function valuePanel(ctx: OwnerContext, secret: SecretView): HTMLElement | null {
  if (showError?.path === secret.path) {
    return h(
      "p",
      { class: "error secret-error", role: "alert" },
      `Not shown: ${showError.message}.`,
    );
  }
  const value = shown;
  if (value?.path !== secret.path) return null;
  const countdown = h("span", { class: "hint countdown", "aria-live": "off" });
  const tick = (): void => {
    const left = Math.max(0, Math.ceil((value.until - Date.now()) / 1000));
    countdown.textContent = `Hides in ${String(left)} s`;
  };
  tick();
  const interval = setInterval(() => {
    if (!countdown.isConnected) clearInterval(interval);
    else tick();
  }, 1000);
  const status = h("span", { class: "hint", role: "status" });
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value.text ?? "");
      status.textContent = "Copied.";
    } catch {
      status.textContent = "The browser refused the clipboard.";
    }
  };
  return h(
    "div",
    {
      class: "secret-value",
      role: "region",
      tabindex: "-1",
      "aria-label": `Value of ${secret.scope}/${secret.name}`,
    },
    value.text === undefined
      ? h("p", { class: "binary" }, `Binary value, ${formatSize(value.bytes.length)}.`)
      : h("pre", { class: "value-text" }, h("code", {}, value.text)),
    h(
      "div",
      { class: "value-actions" },
      value.text === undefined
        ? null
        : h(
            "button",
            { class: "button button-quiet", type: "button", onclick: () => void copy() },
            "Copy",
          ),
      value.kind === "file" || value.text === undefined
        ? h(
            "button",
            {
              class: "button button-quiet",
              type: "button",
              onclick: () => {
                download(value.name, value.bytes);
              },
            },
            "Download",
          )
        : null,
      h(
        "button",
        {
          class: "button button-quiet",
          type: "button",
          onclick: () => {
            hideValue();
            ctx.rerender();
          },
        },
        "Hide",
      ),
      countdown,
      status,
    ),
  );
}

/** "Unlocked as …" with a Lock button, for the inventory. */
export function lockBar(ctx: OwnerContext): HTMLElement | null {
  const owner = unlockedOwner();
  if (owner === undefined) return null;
  return h(
    "div",
    { class: "lock-bar", role: "status" },
    h("span", {}, "Unlocked as ", h("strong", {}, owner.name), ` until ${clock(owner.until)}`),
    h(
      "button",
      {
        class: "link-button",
        type: "button",
        onclick: () => {
          resetShow();
          lock();
          ctx.rerender();
        },
      },
      "Lock",
    ),
  );
}

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/octet-stream" }));
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function clock(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --------------------------------------------------------------------------------------- Owner page

export function ownerView(ctx: OwnerContext): HTMLElement {
  const owner = unlockedOwner();
  const owners = passkeyOwners(ctx.snapshot);
  const error = h("p", { class: "error", role: "alert" });

  const unlockButtons = owners.map((name) =>
    h(
      "button",
      {
        class: "button",
        type: "button",
        onclick: (event: Event) => {
          const button = event.currentTarget as HTMLButtonElement;
          button.disabled = true;
          button.textContent = "Waiting for the passkey…";
          error.textContent = "";
          void unlockWithPasskey(ctx.snapshot, name).then(
            () => {
              ctx.rerender();
            },
            (failure: unknown) => {
              error.textContent = `Not unlocked: ${describePasskeyError(failure)}.`;
              button.disabled = false;
              button.textContent = `Unlock as ${name}`;
            },
          );
        },
      },
      `Unlock as ${name}`,
    ),
  );

  const backup = h("textarea", {
    id: "backup",
    class: "masked",
    rows: "3",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    "data-1p-ignore": true,
    "data-lpignore": "true",
    placeholder: "AGE-SECRET-KEY-1…",
    "aria-describedby": "backup-hint",
  });
  const backupError = h("p", { class: "error", role: "alert" });
  const backupForm = h(
    "form",
    {
      class: "backup-form",
      novalidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        backupError.textContent = "";
        const text = backup.value;
        backup.value = "";
        void unlockWithBackup(ctx.snapshot, text).then(
          () => {
            ctx.rerender();
          },
          (failure: unknown) => {
            backupError.textContent = `Not unlocked: ${describePasskeyError(failure)}.`;
          },
        );
      },
    },
    h(
      "div",
      { class: "field" },
      h("label", { for: "backup", class: "label" }, "Backup identity"),
      backup,
    ),
    h(
      "p",
      { class: "hint", id: "backup-hint" },
      "The identity shown once at setup. It stays in this tab's memory and is never stored or sent.",
    ),
    backupError,
    h("button", { class: "button button-quiet", type: "submit" }, "Unlock with the backup"),
  );

  return h(
    "div",
    { class: "owner" },
    h("div", { class: "page-head" }, h("h1", { tabindex: "-1" }, "Owner")),
    h(
      "p",
      { class: "lede" },
      "Unlock an owner's key with a passkey to read values on this device. It stays in this tab's memory for 5 minutes, and values show only when you ask.",
    ),
    owner !== undefined
      ? h(
          "section",
          { class: "panel unlocked", "aria-labelledby": "unlocked-title" },
          h("h2", { id: "unlocked-title" }, `Unlocked as ${owner.name}`),
          h("p", {}, `Locks at ${clock(owner.until)}. Show any secret from the inventory.`),
          h(
            "div",
            { class: "value-actions" },
            h("a", { class: "button", href: "#/" }, "Go to the inventory"),
            h(
              "button",
              {
                class: "button button-quiet",
                type: "button",
                onclick: () => {
                  resetShow();
                  lock();
                  ctx.rerender();
                },
              },
              "Lock",
            ),
          ),
        )
      : h(
          "section",
          { class: "panel", "aria-labelledby": "unlock-title" },
          h("h2", { id: "unlock-title" }, "Unlock with a passkey"),
          owners.length === 0
            ? h(
                "p",
                { class: "empty-note" },
                "No owner has a passkey in this repository yet. Set one up below.",
              )
            : h("div", { class: "value-actions" }, unlockButtons),
          error,
          h(
            "details",
            { class: "backup" },
            h("summary", {}, "Lost the passkey? Unlock with the backup"),
            backupForm,
          ),
        ),
    h(
      "section",
      { class: "panel", "aria-labelledby": "setup-title" },
      h("h2", { id: "setup-title" }, "Set up a passkey"),
      h(
        "p",
        {},
        "Wraps an owner's key with a passkey (Face ID, Touch ID or the device PIN) and commits it as recipients/<name>.identity.age. For a new owner it also makes the key, and shows its backup once.",
      ),
      h(
        "a",
        { class: "button button-quiet", href: "#/owner/setup" },
        owner === undefined ? "Set up a passkey" : `Set up a new passkey for ${owner.name}`,
      ),
    ),
  );
}

// --------------------------------------------------------------------------------------------- setup

type Step = "name" | "passkey" | "wrap" | "confirm";

interface Wizard {
  step: Step;
  name: string;
  isNew: boolean;
  owner?: OwnerIdentity;
  wrapped?: string;
}

let wizard: Wizard | undefined;

/** Drops the setup in progress and the identity it holds. */
export function resetSetup(): void {
  wizard = undefined;
}

function defaultName(snapshot: Snapshot): string {
  const owner = unlockedOwner();
  if (owner !== undefined) return owner.name;
  const members = snapshot.config?.groups.get("owners") ?? [];
  return members.find((name) => !snapshot.ownerIdentities.has(name)) ?? members[0] ?? "";
}

export function setupView(ctx: OwnerContext): HTMLElement {
  const current = wizard;
  const steps: [Step, string][] = [
    ["name", "Owner"],
    ["passkey", "Create the passkey"],
    ["wrap", "Lock the key"],
    ["confirm", current?.isNew === false ? "Commit" : "Backup and commit"],
  ];
  const at = steps.findIndex(([step]) => step === (current?.step ?? "name"));
  const progress = h(
    "ol",
    { class: "steps" },
    steps.map(([, label], index) =>
      h(
        "li",
        {
          class: index < at ? "done" : index === at ? "current" : undefined,
          "aria-current": index === at ? "step" : undefined,
        },
        label,
      ),
    ),
  );
  let body: HTMLElement;
  if (current === undefined || current.step === "name") body = nameStep(ctx);
  else if (current.step === "passkey") body = passkeyStep(ctx, current);
  else if (current.step === "wrap") body = wrapStep(ctx, current);
  else body = confirmStep(ctx, current);
  return h(
    "section",
    { class: "panel setup" },
    h("p", { class: "eyebrow" }, "Owner passkey"),
    h(
      "h1",
      { tabindex: "-1" },
      current === undefined ? "Set up a passkey" : `Passkey for ${current.name}`,
    ),
    progress,
    body,
    h(
      "button",
      {
        class: "link-button cancel",
        type: "button",
        onclick: () => {
          resetSetup();
          ctx.go("#/owner");
        },
      },
      "Cancel",
    ),
  );
}

function nameStep(ctx: OwnerContext): HTMLElement {
  const name = h("input", {
    id: "owner-name",
    required: true,
    value: defaultName(ctx.snapshot),
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    "aria-describedby": "owner-name-hint",
  });
  const hint = h("p", { class: "hint", id: "owner-name-hint" });
  const pasted = h("textarea", {
    id: "owner-identity",
    class: "masked",
    rows: "3",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    "data-1p-ignore": true,
    "data-lpignore": "true",
    placeholder: "AGE-SECRET-KEY-1…",
  });
  const pastedField = h(
    "div",
    { class: "field" },
    h("label", { for: "owner-identity", class: "label" }, "The owner's identity"),
    pasted,
    h(
      "p",
      { class: "hint" },
      "From the backup or ~/.config/agedrop/identity. It is checked against recipients/<name>.pub, then wrapped; it is never stored or sent in plaintext.",
    ),
  );
  const error = h("p", { class: "error", role: "alert" });
  const update = (): void => {
    const value = name.value.trim();
    const found = setupCase(ctx.snapshot, value);
    const unlockedHere = unlockedOwner()?.name === value;
    pastedField.hidden = found.kind !== "existing" || unlockedHere;
    hint.textContent =
      value === ""
        ? "A name from the owners group in agedrop.toml."
        : found.kind === "invalid"
          ? `Cannot use this name: ${found.reason}.`
          : found.kind === "new"
            ? `New owner: a new key is made, with recipients/${value}.pub. Add ${value} to the owners group in agedrop.toml to give it access.`
            : unlockedHere
              ? `Uses the unlocked key of ${value}.${ctx.snapshot.ownerIdentities.has(value) ? " Replaces its current passkey." : ""}`
              : `recipients/${value}.pub exists: paste its identity to wrap it.${ctx.snapshot.ownerIdentities.has(value) ? " Replaces its current passkey." : ""}`;
  };
  name.addEventListener("input", update);
  update();
  const submit = h("button", { class: "button", type: "submit" }, "Continue");
  return h(
    "form",
    {
      novalidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        error.textContent = "";
        const value = name.value.trim();
        const text = pasted.value;
        submit.disabled = true;
        void setupIdentity(ctx.snapshot, value, text).then(
          (owner) => {
            pasted.value = "";
            wizard = {
              step: "passkey",
              name: value,
              isNew: setupCase(ctx.snapshot, value).kind === "new",
              owner,
            };
            ctx.rerender();
          },
          (failure: unknown) => {
            error.textContent = `${describePasskeyError(failure)}.`;
            submit.disabled = false;
          },
        );
      },
    },
    h(
      "div",
      { class: "field" },
      h("label", { for: "owner-name", class: "label" }, "Owner name"),
      name,
      hint,
    ),
    pastedField,
    error,
    submit,
  );
}

/** One step that runs a passkey ceremony on a tap: Safari allows one per user gesture. */
function ceremony(
  label: string,
  waiting: string,
  explain: string,
  action: () => Promise<void>,
): HTMLElement {
  const error = h("p", { class: "error", role: "alert" });
  const button = h(
    "button",
    {
      class: "button",
      type: "button",
      onclick: () => {
        error.textContent = "";
        button.disabled = true;
        button.textContent = waiting;
        void action().catch((failure: unknown) => {
          error.textContent = `${describePasskeyError(failure)}.`;
          button.disabled = false;
          button.textContent = label;
        });
      },
    },
    label,
  );
  return h("div", { class: "ceremony" }, h("p", {}, explain), error, button);
}

function passkeyStep(ctx: OwnerContext, current: Wizard): HTMLElement {
  return ceremony(
    "Create the passkey",
    "Waiting for the passkey…",
    `Your device asks to save a passkey named "agedrop ${current.name} (${ctx.repository})". Keep it in the system keychain (iCloud Keychain or Google Password Manager): other password managers may not support the key derivation agedrop needs.`,
    async () => {
      await createPasskey(ctx.repository, current.name);
      current.step = "wrap";
      ctx.rerender();
    },
  );
}

function wrapStep(ctx: OwnerContext, current: Wizard): HTMLElement {
  return ceremony(
    "Lock the key with the passkey",
    "Waiting for the passkey…",
    "Confirm with the passkey once more: it derives the key that encrypts the owner's identity. Choose the passkey you just made.",
    async () => {
      if (current.owner === undefined) throw new Error("the setup lost its key: start again");
      current.wrapped = await wrapWithPasskey(current.owner);
      current.step = "confirm";
      ctx.rerender();
    },
  );
}

function confirmStep(ctx: OwnerContext, current: Wizard): HTMLElement {
  const owner = current.owner;
  const wrapped = current.wrapped;
  if (owner === undefined || wrapped === undefined) {
    resetSetup();
    return h("p", { class: "error" }, "The setup lost its state. Start again.");
  }
  const error = h("p", { class: "error", role: "alert" });
  const stored = h("input", { id: "stored", type: "checkbox" });
  const submit = h(
    "button",
    { class: "button", type: "submit", disabled: current.isNew },
    "Commit",
  );
  stored.addEventListener("change", () => {
    submit.disabled = !stored.checked;
  });
  const status = h("span", { class: "hint", role: "status" });
  const backup = current.isNew
    ? h(
        "div",
        { class: "backup-sheet" },
        h("h2", {}, "Store this backup now"),
        h(
          "p",
          {},
          "This is the owner's private key. It is shown only now. With it you can read every secret using the age CLI and set up a new passkey if this one is lost. Without it, a lost passkey means a lost key. Keep it on paper or in a password manager, never in the repository.",
        ),
        h("pre", { class: "identity-file" }, h("code", {}, owner.file)),
        h(
          "div",
          { class: "value-actions" },
          h(
            "button",
            {
              class: "button button-quiet",
              type: "button",
              onclick: () => {
                void navigator.clipboard.writeText(owner.file).then(
                  () => (status.textContent = "Copied."),
                  () => (status.textContent = "The browser refused the clipboard."),
                );
              },
            },
            "Copy",
          ),
          h(
            "button",
            {
              class: "button button-quiet",
              type: "button",
              onclick: () => {
                download(
                  `agedrop-${current.name}-identity.txt`,
                  new TextEncoder().encode(owner.file),
                );
              },
            },
            "Download",
          ),
          status,
        ),
        h(
          "label",
          { class: "check" },
          stored,
          h("span", {}, "I stored this backup somewhere safe, off this repository"),
        ),
      )
    : null;
  const files = current.isNew
    ? [`recipients/${current.name}.pub`, `recipients/${current.name}.identity.age`]
    : [`recipients/${current.name}.identity.age`];
  return h(
    "form",
    {
      novalidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (current.isNew && !stored.checked) return;
        error.textContent = "";
        submit.disabled = true;
        submit.textContent = "Committing…";
        const setup: OwnerSetup = { name: current.name, owner, wrapped };
        void commitOwnerSetup(ctx.client, ctx.snapshot, setup).then(
          (result) => {
            resetSetup();
            ctx.committed(result, "#/owner");
          },
          (failure: unknown) => {
            error.textContent = `Not written: ${describePasskeyError(failure)}.`;
            submit.disabled = false;
            submit.textContent = "Try again";
          },
        );
      },
    },
    backup,
    h(
      "p",
      { class: "to" },
      "Commits ",
      files.flatMap((file, i) => [i > 0 ? " and " : "", h("code", {}, file)]),
      ".",
    ),
    error,
    submit,
  );
}
