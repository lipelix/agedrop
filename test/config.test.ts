import { describe, expect, it } from "vitest";
import { FormatError, parseConfig } from "../src/index.js";

const SPEC_EXAMPLE = `
version = 0

[recipients]
owners = ["libor"]
mini   = ["server"]
ci     = ["github-actions"]

[scopes."mini/hq"]
recipients = ["owners", "mini"]

[scopes."ci/deploy"]
recipients = ["owners", "ci"]
`;

function issuesOf(text: string): readonly string[] {
  try {
    parseConfig(text);
  } catch (error) {
    if (error instanceof FormatError) return error.issues;
    throw error;
  }
  throw new Error("expected a FormatError");
}

describe("parseConfig", () => {
  it("parses the SPEC.md example", () => {
    const config = parseConfig(SPEC_EXAMPLE);
    expect(config.version).toBe(0);
    expect(config.groups.get("owners")).toEqual(["libor"]);
    expect(config.groups.get("mini")).toEqual(["server"]);
    expect(config.scopes.get("mini/hq")).toEqual(["owners", "mini"]);
    expect([...config.scopes.keys()]).toEqual(["mini/hq", "ci/deploy"]);
  });

  it("accepts a config with no scopes yet", () => {
    expect(parseConfig(`version = 0\n[recipients]\nowners = ["me"]\n`).scopes.size).toBe(0);
  });

  it("requires owners in every scope", () => {
    expect(
      issuesOf(`version = 0
[recipients]
owners = ["libor"]
mini = ["server"]
[scopes.mini]
recipients = ["mini"]
`),
    ).toEqual([`scopes."mini".recipients must include "owners"`]);
  });

  it("requires the owners group", () => {
    expect(issuesOf(`version = 0\n[recipients]\nmini = ["server"]\n`)).toContain(
      `missing the "owners" group in [recipients]`,
    );
  });

  it("rejects unknown and misspelled keys", () => {
    const issues = issuesOf(`version = 0
extra = 1
[recipients]
owners = ["libor"]
[scopes.mini]
recipient = ["owners"]
`);
    expect(issues).toContain(`unknown key "extra"`);
    expect(issues).toContain(`scopes."mini": unknown key "recipient"`);
    expect(issues).toContain(`missing scopes."mini".recipients`);
  });

  it("rejects unknown groups, duplicates, bad names and empty lists", () => {
    const issues = issuesOf(`version = 0
[recipients]
owners = ["libor", "libor"]
empty = []
Bad = ["x"]
odd = ["Not.Valid"]
[scopes."mini/hq"]
recipients = ["owners", "nope"]
[scopes."../escape"]
recipients = ["owners"]
`);
    expect(issues).toEqual(
      expect.arrayContaining([
        `recipients.owners: "libor" is listed twice`,
        `recipients.empty must not be empty`,
        `invalid group name "Bad"`,
        `recipients.odd: invalid recipient name "Not.Valid"`,
        `scopes."mini/hq".recipients: unknown group "nope"`,
        `invalid scope "../escape"`,
      ]),
    );
  });

  it("checks the version", () => {
    expect(issuesOf(`[recipients]\nowners = ["a"]\n`)).toContain(`missing "version" (expected 0)`);
    expect(issuesOf(`version = 1\n[recipients]\nowners = ["a"]\n`)).toContain(
      `unsupported version 1 (expected 0)`,
    );
  });

  it("reports invalid TOML and wrong types", () => {
    expect(issuesOf(`version = `)[0]).toMatch(/^invalid TOML/);
    expect(issuesOf(`version = 0\nrecipients = ["a"]\n`)).toContain(
      `"recipients" must be a table of groups`,
    );
    expect(issuesOf(`version = 0\n[recipients]\nowners = "a"\n`)).toContain(
      `recipients.owners must be a list of strings`,
    );
  });

  it("names the file in the error", () => {
    expect(() => parseConfig(`version = 2`)).toThrow(/^agedrop\.toml: /);
  });
});
