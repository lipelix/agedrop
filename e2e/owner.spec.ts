/**
 * The owner passkey end to end (SPEC.md § Web UI, Owner passkey): setup, unlock, Show, and the backup.
 * WebKit has no virtual authenticator in Playwright, so both browsers get the fake PRF authenticator
 * from test/fake-passkey.ts; one more test uses Chromium's own virtual authenticator over CDP.
 */
import { expect, type Page, test } from "@playwright/test";
import { installFakePasskeys } from "../test/fake-passkey.js";
import { ageDecrypt, throwawayKey } from "../test/helpers.js";
import { webFixture } from "../test/web-fixture.js";
import { connect, everything, signIn, storage } from "./support.js";

const DATABASE_URL = "postgres://throwaway@localhost/db";

async function passkeyPrompts(page: Page): Promise<number> {
  return page.evaluate(() => globalThis.fakePasskeys?.gets ?? -1);
}

/** Walks the setup for the fixture's existing owner, pasting its identity. */
async function setUpExistingOwner(page: Page, ownerIdentity: string): Promise<void> {
  await page.getByRole("link", { name: /^Owner/ }).click();
  await expect(page.getByRole("heading", { name: "Owner", exact: true })).toBeVisible();
  await expect(page.getByText("No owner has a passkey in this repository yet.")).toBeVisible();
  await page.getByRole("link", { name: "Set up a passkey" }).click();
  await expect(page.getByLabel("Owner name")).toHaveValue("owner");
  await expect(page.getByText("recipients/owner.pub exists: paste its identity")).toBeVisible();
  await page.getByLabel("The owner's identity").fill(ownerIdentity);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create the passkey" }).click();
  await page.getByRole("button", { name: "Lock the key with the passkey" }).click();
  await expect(page.getByText("Commits recipients/owner.identity.age.")).toBeVisible();
  await page.getByRole("button", { name: "Commit" }).click();
}

test.describe("with a fake PRF authenticator", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFakePasskeys);
  });

  test("passkey → a secret's value, and the same file decrypts with age and the backup", async ({
    page,
  }) => {
    const { github, ownerIdentity } = await webFixture();
    const sent = await connect(page, github);
    await signIn(page);
    await setUpExistingOwner(page, ownerIdentity);

    await expect(page.getByRole("status").filter({ hasText: "Committed." })).toContainText(
      "chore(recipients): set the passkey of owner owner",
    );
    await expect(page.getByRole("heading", { name: "Unlocked as owner" })).toBeVisible();
    const commit = github.commits.at(-1);
    expect(commit?.changed).toEqual(["recipients/owner.identity.age"]);
    const wrapped = github.files.get("recipients/owner.identity.age") ?? "";
    expect(wrapped.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\n")).toBe(true);

    // Lock, then Show unlocks with one passkey prompt and decrypts in the page.
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page.getByRole("heading", { name: "Unlock with a passkey" })).toBeVisible();
    await page.getByRole("link", { name: "Inventory", exact: true }).click();
    const prompts = await passkeyPrompts(page);
    await page.getByRole("button", { name: "Show mini/hq/DATABASE_URL" }).click();
    const value = page.getByRole("region", { name: "Value of mini/hq/DATABASE_URL" });
    await expect(value).toContainText(DATABASE_URL);
    await expect(value).toContainText(/Hides in \d+ s/);
    expect(await passkeyPrompts(page)).toBe(prompts + 1);
    await expect(page.getByText("Unlocked as owner")).toBeVisible();
    await expect(page.getByRole("link", { name: "Owner (unlocked)" })).toBeVisible();

    await value.getByRole("button", { name: "Hide" }).click();
    await expect(value).toBeHidden();
    await expect(page.getByText(DATABASE_URL)).toBeHidden();

    // The backup is the identity itself: the stock age CLI reads the same file with it.
    expect(
      await ageDecrypt(github.files.get("secrets/mini/hq/DATABASE_URL.age") ?? "", ownerIdentity),
    ).toBe(DATABASE_URL);

    // Neither the value nor the identity ever left the page or reached storage.
    const wire = everything(sent);
    expect(wire).not.toContain(DATABASE_URL);
    expect(wire).not.toContain(ownerIdentity);
    const stored = await storage(page);
    expect(stored).not.toContain(DATABASE_URL);
    expect(stored).not.toContain(ownerIdentity);
  });

  test("a new owner: makes a key, shows its backup once, then commits .pub and identity", async ({
    page,
  }) => {
    const { github } = await webFixture();
    const sent = await connect(page, github);
    await signIn(page);
    await page.goto("/#/owner/setup");
    await page.getByLabel("Owner name").fill("alex");
    await expect(
      page.getByText(/New owner: a new key is made, with recipients\/alex.pub/),
    ).toBeVisible();
    await expect(page.getByLabel("The owner's identity")).toBeHidden();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Create the passkey" }).click();
    await page.getByRole("button", { name: "Lock the key with the passkey" }).click();

    await expect(page.getByRole("heading", { name: "Store this backup now" })).toBeVisible();
    const backup = (await page.locator(".identity-file").textContent()) ?? "";
    expect(backup).toMatch(
      /^# created: \S+Z\n# public key: (age1[0-9a-z]+)\nAGE-SECRET-KEY-1[0-9A-Z]+\n$/,
    );
    const identity = /AGE-SECRET-KEY-1[0-9A-Z]+/.exec(backup)?.[0] ?? "";
    const recipient = /# public key: (age1[0-9a-z]+)/.exec(backup)?.[1] ?? "";
    const commitButton = page.getByRole("button", { name: "Commit" });
    await expect(commitButton).toBeDisabled();
    await page.getByLabel("I stored this backup somewhere safe, off this repository").check();
    await commitButton.click();

    await expect(page.getByRole("status").filter({ hasText: "Committed." })).toContainText(
      "chore(recipients): add owner alex with a passkey",
    );
    await expect(page.getByRole("heading", { name: "Unlocked as alex" })).toBeVisible();
    expect([...(github.commits.at(-1)?.changed ?? [])].sort()).toEqual([
      "recipients/alex.identity.age",
      "recipients/alex.pub",
    ]);
    const pub = github.files.get("recipients/alex.pub") ?? "";
    expect(pub).toMatch(/^# kind: owner\n# added: \d{4}-\d{2}-\d{2}\n/);
    expect(pub).toContain(recipient);

    // A secret encrypted to the new key decrypts with the backup and the stock age CLI.
    const { encryptSecret } = await import("../src/index.js");
    expect(await ageDecrypt(await encryptSecret("hello", [recipient]), backup)).toBe("hello");

    expect(everything(sent)).not.toContain(identity);
    expect(await storage(page)).not.toContain(identity);

    // The backup is not shown again.
    await page.goto("/#/owner/setup");
    await expect(page.locator(".identity-file")).toHaveCount(0);
  });

  test("a store fresh from init: the owner named in agedrop.toml gets its first key", async ({
    page,
  }) => {
    // `agedrop init --owner owner` lists the owner before recipients/owner.pub exists.
    const { github } = await webFixture();
    github.files.delete("recipients/owner.pub");
    await connect(page, github);
    await signIn(page);
    await page.goto("/#/owner/setup");
    await expect(page.getByLabel("Owner name")).toHaveValue("owner");
    await expect(
      page.getByText(/New owner: a new key is made, with recipients\/owner.pub/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Create the passkey" }).click();
    await page.getByRole("button", { name: "Lock the key with the passkey" }).click();
    await page.getByLabel("I stored this backup somewhere safe, off this repository").check();
    await page.getByRole("button", { name: "Commit" }).click();

    await expect(page.getByRole("status").filter({ hasText: "Committed." })).toContainText(
      "chore(recipients): add owner owner with a passkey",
    );
    await expect(page.getByRole("heading", { name: "Unlocked as owner" })).toBeVisible();
    expect([...(github.commits.at(-1)?.changed ?? [])].sort()).toEqual([
      "recipients/owner.identity.age",
      "recipients/owner.pub",
    ]);
  });

  test("unlocks with the backup, and hides a shown value after 30 seconds", async ({ page }) => {
    await page.clock.install();
    const { github, ownerIdentity } = await webFixture();
    await connect(page, github);
    await signIn(page);
    await page.getByRole("link", { name: /^Owner/ }).click();
    await page.getByText("Lost the passkey? Unlock with the backup").click();

    const stranger = await throwawayKey();
    await page.getByLabel("Backup identity").fill(stranger.identity);
    await page.getByRole("button", { name: "Unlock with the backup" }).click();
    await expect(page.getByText("this identity is not the key of any owner")).toBeVisible();
    await expect(page.getByLabel("Backup identity")).toHaveValue("");

    await page.getByLabel("Backup identity").fill(`# created: x\n${ownerIdentity}\n`);
    await page.getByRole("button", { name: "Unlock with the backup" }).click();
    await expect(page.getByRole("heading", { name: "Unlocked as owner" })).toBeVisible();

    await page.getByRole("link", { name: "Go to the inventory" }).click();
    await page.getByRole("button", { name: "Show ci/deploy/NPM_TOKEN" }).click();
    const value = page.getByRole("region", { name: "Value of ci/deploy/NPM_TOKEN" });
    await expect(value).toContainText("npm_throwaway");
    expect(await passkeyPrompts(page)).toBe(0);

    await page.clock.fastForward(31_000);
    await expect(value).toBeHidden();

    // Unlocking lasts 5 minutes, then the page locks itself.
    await page.clock.fastForward(5 * 60 * 1000);
    await expect(page.getByText("Unlocked as owner")).toBeHidden();
    await expect(page.getByRole("link", { name: "Owner", exact: true })).toBeVisible();
  });

  test("explains a passkey without PRF and a cancelled prompt", async ({ page }) => {
    const { github, ownerIdentity } = await webFixture();
    await connect(page, github);
    await signIn(page);
    await page.goto("/#/owner/setup");
    await page.getByLabel("The owner's identity").fill(ownerIdentity);
    await page.getByRole("button", { name: "Continue" }).click();

    await page.evaluate(() => {
      if (globalThis.fakePasskeys) globalThis.fakePasskeys.cancel = true;
    });
    await page.getByRole("button", { name: "Create the passkey" }).click();
    await expect(page.getByText("the passkey prompt was cancelled or timed out")).toBeVisible();

    await page.evaluate(() => {
      if (globalThis.fakePasskeys) globalThis.fakePasskeys.noPrf = true;
    });
    await page.getByRole("button", { name: "Create the passkey" }).click();
    await expect(page.getByText(/cannot derive keys \(WebAuthn PRF\)/)).toBeVisible();
    expect(github.commits).toHaveLength(1);
  });

  test("refuses a pasted identity that is not the owner's key", async ({ page }) => {
    const { github } = await webFixture();
    await connect(page, github);
    await signIn(page);
    await page.goto("/#/owner/setup");
    await page.getByLabel("The owner's identity").fill((await throwawayKey()).identity);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("this identity is not the key in recipients/owner.pub"),
    ).toBeVisible();
    await page.getByLabel("Owner name").fill("mini");
    await expect(
      page.getByText(/recipients\/mini.pub is a machine key, not an owner/),
    ).toBeVisible();
  });
});

test("Chromium's virtual authenticator: setup and Show with real WebAuthn PRF", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "only Chromium has a virtual authenticator");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  const { github, ownerIdentity } = await webFixture();
  await connect(page, github);
  await signIn(page);
  await setUpExistingOwner(page, ownerIdentity);
  await expect(page.getByRole("heading", { name: "Unlocked as owner" })).toBeVisible();
  await page.getByRole("button", { name: "Lock" }).click();
  await page.getByRole("link", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Show mini/hq/DATABASE_URL" }).click();
  await expect(page.getByRole("region", { name: "Value of mini/hq/DATABASE_URL" })).toContainText(
    DATABASE_URL,
  );
});
