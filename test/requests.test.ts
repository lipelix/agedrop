import { describe, expect, it } from "vitest";
import {
  formatRequest,
  FormatError,
  isValidRequestId,
  newRequestId,
  parseRequest,
  requestPath,
} from "../src/index.js";

const VALID = `scope = "mini/hq"
name = "VAPID_PRIVATE_KEY"
reason = "Web Push signing key"
requested_by = "plan session #52"
created = "2026-11-09T10:00:00+01:00"
generate = "openssl ecparam -genkey -name prime256v1 -noout"
`;

describe("parseRequest", () => {
  it("parses a request and normalizes created to UTC", () => {
    expect(parseRequest("abc123", VALID)).toEqual({
      id: "abc123",
      scope: "mini/hq",
      name: "VAPID_PRIVATE_KEY",
      reason: "Web Push signing key",
      requestedBy: "plan session #52",
      created: "2026-11-09T09:00:00.000Z",
      generate: "openssl ecparam -genkey -name prime256v1 -noout",
    });
  });

  it("accepts a TOML offset date-time", () => {
    const text = VALID.replace(`"2026-11-09T10:00:00+01:00"`, "2026-11-09T10:00:00Z");
    expect(parseRequest("abc123", text).created).toBe("2026-11-09T10:00:00.000Z");
  });

  it("lists every problem", () => {
    const text = `scope = "Bad Scope"\nname = "mixedCase"\nreason = ""\ncreated = 2026-11-09T10:00:00\nextra = 1\n`;
    let error: unknown;
    try {
      parseRequest("abc", text);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).file).toBe("requests/abc.toml");
    expect((error as FormatError).issues).toEqual([
      `unknown key "extra"`,
      `invalid scope "Bad Scope"`,
      `invalid secret name "mixedCase"`,
      `"reason" must be a non-empty string`,
      `missing "requested_by"`,
      `"created" must be a date-time with a time zone`,
    ]);
  });

  it("rejects a created string without a time zone", () => {
    expect(() => parseRequest("abc", VALID.replace("+01:00", ""))).toThrow(/RFC 3339/);
  });

  it("validates the id", () => {
    expect(() => parseRequest("../x", VALID)).toThrow(/invalid request id/);
    expect(requestPath("abc-1")).toBe("requests/abc-1.toml");
    expect(() => requestPath("ABC")).toThrow();
  });
});

describe("newRequestId", () => {
  it("makes valid ids of 8 unambiguous characters", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[a-km-np-z2-9]{8}$/);
      expect(isValidRequestId(id)).toBe(true);
    }
  });
});

describe("formatRequest", () => {
  it("round-trips through parseRequest", () => {
    const request = parseRequest("abc123", VALID);
    const text = formatRequest(request);
    expect(text).toBe(
      `scope = "mini/hq"\nname = "VAPID_PRIVATE_KEY"\nreason = "Web Push signing key"\n` +
        `requested_by = "plan session #52"\ncreated = "2026-11-09T09:00:00Z"\n` +
        `generate = "openssl ecparam -genkey -name prime256v1 -noout"\n`,
    );
    expect(parseRequest("abc123", text)).toEqual(request);
  });

  it("escapes quotes and newlines and leaves out a missing hint", () => {
    const request = {
      id: "x1",
      scope: "ci",
      name: "TOKEN",
      reason: 'needs "quotes"\nand lines',
      requestedBy: "agent",
      created: "2026-11-14T05:00:00.123Z",
    };
    const text = formatRequest(request);
    expect(text).not.toContain("generate");
    expect(parseRequest("x1", text)).toEqual({ ...request, created: "2026-11-14T05:00:00.000Z" });
  });

  it("refuses an invalid request", () => {
    expect(() =>
      formatRequest({
        id: "x1",
        scope: "Bad",
        name: "TOKEN",
        reason: "r",
        requestedBy: "a",
        created: "2026-11-14T05:00:00Z",
      }),
    ).toThrow(FormatError);
  });
});
