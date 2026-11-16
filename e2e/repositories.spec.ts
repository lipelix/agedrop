/**
 * Several repositories in the web UI (SPEC.md § Web UI, Sign-in): add a second one with the token of
 * the first, switch, follow a notification's link across them, and remove one.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { formatRequest } from "../src/index.js";
import { FAKE_TOKEN, FakeGitHub } from "../test/fake-github.js";
import { REPOSITORY, webFixture } from "../test/web-fixture.js";
import { connect, signIn } from "./support.js";

const OTHER = "someone/work-secrets";

/** The fixture's repository and a second one with its own open request. */
async function twoRepositories(): Promise<FakeGitHub[]> {
  const { github } = await webFixture();
  const files = Object.fromEntries(github.files);
  delete files["requests/k7mq2xpa.toml"];
  files["requests/w3rk9zzb.toml"] = formatRequest({
    id: "w3rk9zzb",
    scope: "ci/deploy",
    name: "REGISTRY_TOKEN",
    reason: "Push images from the release job",
    requestedBy: "release agent",
    created: "2026-11-12T08:00:00Z",
  });
  return [github, new FakeGitHub(OTHER, files)];
}

function signedIn(page: Page): Locator {
  return page.getByRole("list", { name: "Signed-in repositories" });
}

async function addOther(page: Page): Promise<void> {
  await page.getByRole("link", { name: /^Repository someone\/home-secrets/ }).click();
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  await page.getByLabel("Repository", { exact: true }).fill(OTHER);
  // Same owner, so the saved token is offered and no token is typed.
  await expect(page.getByLabel("Token", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("New fine-grained token")).toBeHidden();
  await page.getByRole("button", { name: "Add repository" }).click();
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
}

test("adds a second repository with the saved token, switches and removes", async ({ page }) => {
  await connect(page, await twoRepositories());
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  await addOther(page);

  await expect(page.getByRole("status").filter({ hasText: `Added ${OTHER}.` })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText(`${OTHER} @ main`);
  await page.getByRole("link", { name: /^Requests/ }).click();
  await expect(page.getByRole("link", { name: /REGISTRY_TOKEN/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /VAPID_PRIVATE_KEY/ })).toHaveCount(0);

  // Both are listed; the open one is marked, the other opens with one tap.
  await page.getByRole("link", { name: /^Repository someone\/work-secrets/ }).click();
  const rows = signedIn(page).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: OTHER })).toContainText("shared token");
  await expect(signedIn(page).locator("[aria-current=true]")).toContainText(OTHER);
  await page.getByRole("button", { name: new RegExp(`^${REPOSITORY}`) }).click();
  await expect(page.getByRole("banner")).toContainText(`${REPOSITORY} @ main`);
  await page.getByRole("link", { name: /^Requests/ }).click();
  await expect(page.getByRole("link", { name: /VAPID_PRIVATE_KEY/ })).toBeVisible();

  // A reload keeps both and the one this tab had open.
  await page.reload();
  await expect(page.getByRole("banner")).toContainText(`${REPOSITORY} @ main`);

  // Removing the open one hands over to the other; removing the last one signs out.
  await page.getByRole("link", { name: /^Repository someone\/home-secrets/ }).click();
  await page.getByRole("button", { name: `Remove ${REPOSITORY}` }).click();
  await expect(page.getByRole("status")).toContainText(`Removed ${REPOSITORY} from this device.`);
  await expect(signedIn(page).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("banner")).toContainText(OTHER);
  await page.getByRole("button", { name: `Remove ${OTHER}` }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to your secrets repository" }),
  ).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
});

test("a notification's link opens its repository when the device is signed in to it", async ({
  page,
}) => {
  await connect(page, await twoRepositories());
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  await addOther(page);

  await page.goto(`/#/requests/k7mq2xpa?${new URLSearchParams({ repo: REPOSITORY }).toString()}`);
  await expect(page.getByRole("heading", { name: "mini/hq/VAPID_PRIVATE_KEY" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(`Switched to ${REPOSITORY}.`);
  await expect(page.getByRole("banner")).toContainText(`${REPOSITORY} @ main`);
});

test("a notification's link for a new repository adds it and opens the fulfil form", async ({
  page,
}) => {
  await connect(page, await twoRepositories());
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();

  await page.goto(`/#/requests/w3rk9zzb?${new URLSearchParams({ repo: OTHER }).toString()}`);
  await page.getByRole("link", { name: `Add ${OTHER}` }).click();
  await expect(page.getByLabel("Repository", { exact: true })).toHaveValue(OTHER);
  await page.getByRole("button", { name: "Add repository" }).click();
  await expect(page.getByRole("heading", { name: "ci/deploy/REGISTRY_TOKEN" })).toBeVisible();
  await expect(page.getByText("Push images from the release job")).toBeVisible();
});

test("a repository the token does not cover is not added, and the open one stays", async ({
  page,
}) => {
  const { github } = await webFixture();
  await connect(page, github);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  await page.getByRole("link", { name: /^Repository someone\/home-secrets/ }).click();
  await page.getByLabel("Repository", { exact: true }).fill("someone/not-covered");
  await page.getByRole("button", { name: "Add repository" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "someone/not-covered was not found, or the token has no access to it. Add it to the token on GitHub, or use a new token.",
  );
  await expect(signedIn(page).getByRole("listitem")).toHaveCount(1);

  // Another owner needs its own token: the field comes back.
  await page.getByLabel("Repository", { exact: true }).fill("elsewhere/secrets");
  await expect(page.getByLabel("Token", { exact: true })).toHaveValue("new");
  await expect(page.getByLabel("New fine-grained token")).toBeVisible();
  await page.getByLabel("New fine-grained token").fill("github_pat_wrong");
  await page.getByRole("button", { name: "Add repository" }).click();
  await expect(page.getByRole("alert")).toContainText("GitHub rejected the token");
  await expect(page.getByRole("banner")).toContainText(REPOSITORY);
});

test("a session saved before several repositories still signs in", async ({ page }) => {
  const { github } = await webFixture();
  await connect(page, github);
  await page.goto("/");
  await page.evaluate(
    ([repository, token]) => {
      localStorage.setItem("agedrop.session", JSON.stringify({ repository, branch: "", token }));
    },
    [REPOSITORY, FAKE_TOKEN],
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  await page.getByRole("link", { name: /^Repository someone\/home-secrets/ }).click();
  await expect(signedIn(page).getByRole("listitem")).toContainText("remembered");
});

test("a token GitHub rejects removes its repositories and keeps the others", async ({ page }) => {
  await connect(page, await twoRepositories());
  await page.goto("/");
  await page.evaluate(
    ([repository, other, token]) => {
      localStorage.setItem(
        "agedrop.session",
        JSON.stringify([
          { repository, branch: "", token },
          { repository: other, branch: "", token: "github_pat_expired" },
        ]),
      );
      localStorage.setItem("agedrop.active", other ?? "");
    },
    [REPOSITORY, OTHER, FAKE_TOKEN],
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    `${OTHER}: GitHub rejected the token: it is wrong, expired or revoked. Add it again with a new token.`,
  );
  await expect(signedIn(page).getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: new RegExp(`^${REPOSITORY}`) }).click();
  await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();
});
