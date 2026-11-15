import { describe, expect, it } from "vitest";
import { envLine, envValue } from "../src/cli/dotenv.js";

describe("envLine", () => {
  it("writes safe values bare", () => {
    expect(envLine("URL", "postgres://u@h:5432/db?x=1")).toBe("URL='postgres://u@h:5432/db?x=1'\n");
    expect(envLine("TOKEN", "abc-DEF_1.2/3+4=5,6:7@8")).toBe("TOKEN=abc-DEF_1.2/3+4=5,6:7@8\n");
  });

  it("single-quotes values without a single quote, newlines included", () => {
    expect(envLine("A", "has space")).toBe("A='has space'\n");
    expect(envLine("A", 'a"b$c\nd')).toBe(`A='a"b$c\nd'\n`);
    expect(envLine("A", "")).toBe("A=''\n");
  });

  it("double-quotes and escapes values with a single quote", () => {
    expect(envLine("A", `it's "$x" \\ \n`)).toBe(`A="it's \\"\\$x\\" \\\\ \\n"\n`);
  });
});

describe("envValue", () => {
  it("accepts UTF-8 text and rejects NUL bytes and invalid UTF-8", () => {
    expect(envValue(new TextEncoder().encode("žluťoučký"))).toBe("žluťoučký");
    expect(envValue(new Uint8Array([0x61, 0x00]))).toBeUndefined();
    expect(envValue(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
  });
});
