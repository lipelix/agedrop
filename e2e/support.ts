/** Shared pieces of the web UI's end-to-end tests: the GitHub double on the wire, sign-in, and leak checks. */
import { expect, type Page } from "@playwright/test";
import { FAKE_TOKEN, type FakeGitHub } from "../test/fake-github.js";
import { REPOSITORY } from "../test/web-fixture.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept, x-github-api-version",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Serves GitHub from `github`, one double per repository, and records every request the page sends,
 * to any host. A request for a repository none of them holds goes to the first, which answers 404.
 */
export async function connect(page: Page, github: FakeGitHub | FakeGitHub[]): Promise<Sent[]> {
  const doubles = Array.isArray(github) ? github : [github];
  const [first] = doubles;
  if (first === undefined) throw new Error("connect needs a GitHub double");
  const pick = (url: string, body: string): FakeGitHub =>
    doubles.find((double) => {
      const path = decodeURIComponent(new URL(url).pathname);
      return (
        path === `/repos/${double.repository}` ||
        path.startsWith(`/repos/${double.repository}/`) ||
        body.includes(`"repositoryNameWithOwner":"${double.repository}"`)
      );
    }) ?? first;
  const sent: Sent[] = [];
  page.on("request", (request) => {
    sent.push({ url: request.url(), headers: request.headers(), body: request.postData() ?? "" });
  });
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const result = pick(request.url(), request.postData() ?? "").handle(
      request.method(),
      request.url(),
      await request.allHeaders(),
      request.postData() ?? "",
    );
    await route.fulfill({
      status: result.status,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify(result.body),
    });
  });
  return sent;
}

export async function signIn(page: Page, options: { token?: string; remember?: boolean } = {}) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in to your secrets repository" }),
  ).toBeVisible();
  await page.getByLabel("Repository").fill(REPOSITORY);
  await page.getByLabel("Fine-grained token").fill(options.token ?? FAKE_TOKEN);
  if (options.remember === true) await page.getByLabel("Remember on this device").check();
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Everything that left the page, with base64 commit contents decoded, as one searchable string. */
export function everything(sent: readonly Sent[]): string {
  return sent
    .flatMap((request) => {
      const decoded = [...request.body.matchAll(/"contents":"([^"]+)"/g)].map((match) =>
        Buffer.from(match[1] ?? "", "base64").toString("utf8"),
      );
      return [request.url, JSON.stringify(request.headers), request.body, ...decoded];
    })
    .join("\n");
}

export async function storage(page: Page): Promise<string> {
  return page.evaluate(() =>
    [localStorage, sessionStorage]
      .flatMap((store) => Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ""}`))
      .join("\n"),
  );
}
