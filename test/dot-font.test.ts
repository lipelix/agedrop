/** The masking font (web/dot-font.ts): the committed file is the one the generator builds. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dotFont } from "../web/dot-font.js";

describe("dot font", () => {
  it("matches web/src/dots.ttf; run `node web/dot-font.ts` after changing the generator", () => {
    const committed = readFileSync(new URL("../web/src/dots.ttf", import.meta.url));
    expect(Buffer.from(dotFont()).equals(committed)).toBe(true);
  });

  it("has a valid whole-font checksum", () => {
    const font = dotFont();
    const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
    let sum = 0;
    for (let i = 0; i < font.length; i += 4) sum = (sum + view.getUint32(i)) % 0x100000000;
    expect(sum).toBe(0xb1b0afba);
  });
});
