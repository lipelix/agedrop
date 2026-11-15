import { describe, expect, it } from "vitest";
import {
  isValidRecipientName,
  isValidScope,
  parseSecretPath,
  recipientPath,
  secretKind,
  secretPath,
} from "../src/index.js";

describe("names", () => {
  it.each(["mini", "mini/hq", "ci/deploy", "a/b/c", "web-1/app.v2", "x_y"])(
    "accepts scope %s",
    (s) => {
      expect(isValidScope(s)).toBe(true);
    },
  );

  it.each([
    "",
    "/mini",
    "mini/",
    "mini//hq",
    "../x",
    "mini/..",
    ".hidden",
    "Mini",
    "mini hq",
    "-x",
  ])("rejects scope %j", (s) => {
    expect(isValidScope(s)).toBe(false);
  });

  it("tells env-style from file-style names", () => {
    expect(secretKind("VAPID_PRIVATE_KEY")).toBe("env");
    expect(secretKind("A")).toBe("env");
    expect(secretKind("github_app_key")).toBe("file");
    expect(secretKind("tls.crt")).toBe("file");
    for (const bad of ["Mixed", "1ABC", "_X", "a/b", "", "ABC-DEF", ".env"]) {
      expect(secretKind(bad), bad).toBeUndefined();
    }
  });

  it("builds and parses secret paths", () => {
    expect(secretPath("mini/hq", "TOKEN")).toBe("secrets/mini/hq/TOKEN.age");
    expect(parseSecretPath("secrets/mini/hq/TOKEN.age")).toEqual({
      scope: "mini/hq",
      name: "TOKEN",
    });
    expect(parseSecretPath("secrets/TOKEN.age")).toBeUndefined();
    expect(parseSecretPath("secrets/mini/Bad.age")).toBeUndefined();
    expect(parseSecretPath("other/mini/TOKEN.age")).toBeUndefined();
    expect(() => secretPath("../etc", "X")).toThrow(/invalid scope/);
    expect(() => secretPath("mini", "Bad")).toThrow(/invalid secret name/);
  });

  it("validates recipient names", () => {
    expect(isValidRecipientName("server")).toBe(true);
    expect(isValidRecipientName("github_actions")).toBe(true);
    expect(isValidRecipientName("Mac")).toBe(false);
    expect(isValidRecipientName("a.b")).toBe(false);
    expect(recipientPath("libor")).toBe("recipients/libor.pub");
    expect(() => recipientPath("../x")).toThrow();
  });
});
