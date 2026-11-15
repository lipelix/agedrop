import { describe, expect, it } from "vitest";
import {
  compareBytes,
  formatRecipientFile,
  missingRecipients,
  parseConfig,
  parseRecipientFile,
  type RecipientInfo,
  resolveScope,
} from "../src/index.js";
import { throwawayKey } from "./helpers.js";

async function recipientsFor(names: string[]): Promise<Map<string, RecipientInfo>> {
  const map = new Map<string, RecipientInfo>();
  for (const name of names) {
    const { recipient } = await throwawayKey();
    map.set(name, parseRecipientFile(name, formatRecipientFile({ kind: "machine", recipient })));
  }
  return map;
}

const config = parseConfig(`version = 0
[recipients]
owners = ["libor", "laptop"]
mini = ["server", "libor"]
ci = ["github-actions"]
[scopes."mini/hq"]
recipients = ["owners", "mini"]
[scopes."ci/deploy"]
recipients = ["owners", "ci"]
`);

describe("resolveScope", () => {
  it("returns the union of the scope's groups, sorted and distinct", async () => {
    const recipients = await recipientsFor(["libor", "laptop", "server", "github-actions"]);
    const resolved = resolveScope(config, recipients, "mini/hq");
    expect(resolved.names).toEqual(["laptop", "libor", "server"]);
    const expected = ["libor", "laptop", "server"]
      .map((n) => recipients.get(n)?.recipient ?? "")
      .sort(compareBytes);
    expect(resolved.recipients).toEqual(expected);
  });

  it("counts a shared key once", async () => {
    const recipients = await recipientsFor(["libor", "laptop", "server", "github-actions"]);
    const libor = recipients.get("libor");
    if (libor === undefined) throw new Error("unreachable");
    recipients.set("laptop", { ...libor, name: "laptop" });
    expect(resolveScope(config, recipients, "ci/deploy").recipients).toHaveLength(2);
  });

  it("fails on an unknown scope or a missing .pub file", async () => {
    const recipients = await recipientsFor(["libor", "laptop", "server"]);
    expect(() => resolveScope(config, recipients, "nope")).toThrow(/unknown scope "nope"/);
    expect(() => resolveScope(config, recipients, "ci/deploy")).toThrow(
      /recipient "github-actions" has no recipients\/github-actions\.pub/,
    );
    expect(missingRecipients(config, recipients)).toEqual([
      `recipients.ci: "github-actions" has no recipients/github-actions.pub`,
    ]);
  });
});

describe("compareBytes", () => {
  it("orders by byte value, not locale", () => {
    expect(["b", "B", "a", "_", "ä"].sort(compareBytes)).toEqual(["B", "_", "a", "b", "ä"]);
  });
});
