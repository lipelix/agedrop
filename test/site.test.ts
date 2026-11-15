/** The landing page's response headers (site/_headers) against what site/index.html loads. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(`../site/${path}`, import.meta.url), "utf8");

const html = read("index.html");
const headers = read("_headers");

function csp(): Map<string, string[]> {
  const line = headers.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  if (!line) throw new Error("site/_headers has no Content-Security-Policy");
  const value = line.slice(line.indexOf(":") + 1);
  const directives = new Map<string, string[]>();
  for (const part of value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

describe("site/_headers", () => {
  it("allows every inline script by its hash, and nothing inline otherwise", () => {
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) =>
        `'sha256-${createHash("sha256")
          .update(m[1] ?? "", "utf8")
          .digest("base64")}'`,
    );
    expect(inline.length).toBeGreaterThan(0);
    const scriptSrc = csp().get("script-src") ?? [];
    for (const hash of inline) expect(scriptSrc).toContain(hash);
    expect(scriptSrc.filter((s) => s.startsWith("'sha256-"))).toHaveLength(inline.length);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it("allows the hosts the page loads from", () => {
    const directives = csp();
    for (const m of html.matchAll(/<link[^>]+href="(https:\/\/[^"]+)"[^>]*rel="stylesheet"/g)) {
      expect(directives.get("style-src")).toContain(new URL(m[1] ?? "").origin);
    }
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      expect(m[1]).not.toMatch(/^https?:/);
    }
    expect(directives.get("font-src")).toContain("https://fonts.gstatic.com");
    expect(directives.get("default-src")).toEqual(["'none'"]);
  });
});
