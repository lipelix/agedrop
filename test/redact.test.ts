import { describe, expect, it } from "vitest";
import { MIN_REDACT_LENGTH, redactionPatterns, Redactor } from "../src/cli/redact.js";

const enc = (text: string): Buffer => Buffer.from(text, "utf8");

function redactorFor(values: Record<string, string>): Redactor {
  return new Redactor(
    Object.entries(values).flatMap(([name, value]) => redactionPatterns(name, enc(value))),
  );
}

/** Feeds `text` in the given chunk sizes (cycled) and returns everything the redactor passed on. */
function feed(
  redactor: Redactor,
  text: string | Buffer,
  sizes: readonly number[] = [text.length],
): string {
  const bytes = typeof text === "string" ? enc(text) : text;
  const out: Buffer[] = [];
  for (let offset = 0, i = 0; offset < bytes.length; i++) {
    const size = Math.max(1, sizes[i % sizes.length] ?? 1);
    out.push(redactor.write(bytes.subarray(offset, offset + size)));
    offset += size;
  }
  out.push(redactor.end());
  return Buffer.concat(out).toString("utf8");
}

describe("Redactor", () => {
  it("masks every occurrence with the secret's name", () => {
    const r = redactorFor({ API_TOKEN: "s3cret-token" });
    expect(feed(r, "token=s3cret-token; again s3cret-token\n")).toBe(
      "token=[REDACTED:API_TOKEN]; again [REDACTED:API_TOKEN]\n",
    );
  });

  it("masks a value split across chunks, at every split point and byte by byte", () => {
    const value = "postgres://app:hunter2-hunter2@db:5432/app";
    const text = `connect failed: ${value} (retry)\n`;
    const expected = "connect failed: [REDACTED:DATABASE_URL] (retry)\n";
    for (let split = 1; split < text.length; split++) {
      const r = redactorFor({ DATABASE_URL: value });
      expect(feed(r, text, [split, text.length])).toBe(expected);
    }
    expect(feed(redactorFor({ DATABASE_URL: value }), text, [1])).toBe(expected);
    expect(feed(redactorFor({ DATABASE_URL: value }), text, [3, 1, 7])).toBe(expected);
  });

  it("passes output through at once unless it could start a value", () => {
    const r = redactorFor({ API_TOKEN: "s3cret-token" });
    expect(r.write(enc("Password: ")).toString()).toBe("Password: ");
    expect(r.write(enc("ok s3cr")).toString()).toBe("ok ");
    expect(r.write(enc("et-token!")).toString()).toBe("[REDACTED:API_TOKEN]!");
    expect(r.write(enc("s3c")).toString()).toBe("");
    expect(r.end().toString()).toBe("s3c");
  });

  it("merges overlapping values, of one secret or several, into one marker", () => {
    // B starts inside A: leftmost-longest alone would leave "456789" of B.
    const r = redactorFor({ A: "secret123", B: "123456789" });
    expect(feed(r, "x secret123456789 y")).toBe("x [REDACTED:A] y");
    expect(feed(redactorFor({ A: "secret123", B: "123456789" }), "x secret123456789 y", [1])).toBe(
      "x [REDACTED:A] y",
    );
    // A value that repeats into itself.
    expect(feed(redactorFor({ R: "aaaaaa" }), "<aaaaaaaaaaaaa>", [2])).toBe("<[REDACTED:R]>");
    // One value inside another: the longer one wins at the same position.
    expect(feed(redactorFor({ SHORT: "abcdef", LONG: "abcdefghij" }), "abcdefghij abcdef")).toBe(
      "[REDACTED:LONG] [REDACTED:SHORT]",
    );
  });

  it("keeps adjacent values as separate markers", () => {
    expect(feed(redactorFor({ A: "aaaaaa", B: "bbbbbb" }), "aaaaaabbbbbb")).toBe(
      "[REDACTED:A][REDACTED:B]",
    );
  });

  it("masks URL-encoded, JSON-escaped and newline-trimmed forms", () => {
    const value = 'p@ss w/rd&"x"';
    const r = (): Redactor => redactorFor({ PASSWORD: value });
    expect(feed(r(), `url=${encodeURIComponent(value)}`)).toBe("url=[REDACTED:PASSWORD]");
    expect(feed(r(), `form=${encodeURIComponent(value).replaceAll("%20", "+")}`)).toBe(
      "form=[REDACTED:PASSWORD]",
    );
    expect(feed(r(), JSON.stringify({ password: value }))).toBe(
      '{"password":"[REDACTED:PASSWORD]"}',
    );
    expect(feed(redactorFor({ KEY: "line-value\n" }), "echo: line-value.")).toBe(
      "echo: [REDACTED:KEY].",
    );
  });

  it("masks base64 forms, also inside a longer base64 text at any offset", () => {
    const value = "hunter2-hunter2?>";
    const r = (): Redactor => redactorFor({ PASSWORD: value });
    const plain = Buffer.from(value).toString("base64");
    expect(feed(r(), `b64 ${plain}`)).toBe("b64 [REDACTED:PASSWORD]");
    const url = Buffer.from(value).toString("base64url");
    expect(feed(r(), `b64url ${url}`)).toBe("b64url [REDACTED:PASSWORD]");
    for (const user of ["u", "us", "usr", "user:"]) {
      const header = `Authorization: Basic ${Buffer.from(`${user}:${value}`).toString("base64")}`;
      const [before, after] = feed(r(), header)
        .replace("Authorization: Basic ", "")
        .split("[REDACTED:PASSWORD]");
      // Only characters that also hold bits of "<user>:" or of the padding survive.
      expect(before?.length, user).toBeLessThanOrEqual(Math.ceil(((user.length + 1) * 8) / 6));
      expect(after, user).toMatch(/^[A-Za-z0-9+/]?=*$/);
    }
  });

  it("works on bytes, so a multi-byte character split across chunks is matched and kept", () => {
    const value = "pässwörd-ünïcode";
    const r = redactorFor({ PASSWORD: value });
    expect(feed(r, `ü ${value} ü`, [1])).toBe("ü [REDACTED:PASSWORD] ü");
  });

  it("does not match values shorter than the minimum", () => {
    expect(MIN_REDACT_LENGTH).toBe(6);
    expect(redactionPatterns("SHORT", enc("abcde"))).toEqual([]);
    expect(feed(redactorFor({ SHORT: "abcde", OK: "abcdef" }), "abcde abcdef")).toBe(
      "abcde [REDACTED:OK]",
    );
  });

  it("leaves output alone when there is nothing to mask", () => {
    expect(feed(new Redactor([]), "anything\n", [1])).toBe("anything\n");
    const binary = Buffer.from([0, 255, 1, 254, 10]);
    const r = new Redactor([]);
    expect(Buffer.concat([r.write(binary), r.end()])).toEqual(binary);
  });
});
