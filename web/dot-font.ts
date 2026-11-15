/**
 * Builds `web/src/dots.ttf`, the font that masks values (SPEC.md § Web UI, Values): every character
 * from U+0020 up, outside the surrogates, is the same dot. A masked field is then an ordinary text
 * field, which browsers' AutoFill does not take for a password field, as it does one with
 * `-webkit-text-security`. Run `node web/dot-font.ts` to write the file; a test checks it matches.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNITS_PER_EM = 1000;
const ADVANCE = 600;
const ASCENT = 800;
const DESCENT = 200;
/** The dot: a circle on the x-height's middle, like a password bullet. */
const DOT = { x: 300, y: 270, radius: 150 };
const NAME = "agedrop dots";
const POSTSCRIPT_NAME = "agedrop-dots";
/** 2026-11-15, in seconds since 1904: fixed, so the file builds the same every time. */
const CREATED = 3_877_545_600;

class Writer {
  private readonly bytes: number[] = [];
  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }
  u16(value: number): this {
    return this.u8(value >> 8).u8(value);
  }
  i16(value: number): this {
    return this.u16(value < 0 ? value + 0x10000 : value);
  }
  u32(value: number): this {
    return this.u16(Math.floor(value / 0x10000)).u16(value % 0x10000);
  }
  raw(data: Uint8Array): this {
    for (const byte of data) this.u8(byte);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Glyph 0 is an empty `.notdef`; glyph 1 is the dot, eight off-curve points around a circle. */
function dotGlyph(): { glyph: Uint8Array; box: [number, number, number, number] } {
  const reach = DOT.radius / Math.cos(Math.PI / 8);
  // Clockwise from the top: TrueType's outer contours run clockwise.
  const points = Array.from({ length: 8 }, (_, i) => {
    const angle = Math.PI / 2 - (i * Math.PI) / 4;
    return [
      Math.round(DOT.x + reach * Math.cos(angle)),
      Math.round(DOT.y + reach * Math.sin(angle)),
    ] as const;
  });
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const box: [number, number, number, number] = [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];
  const w = new Writer().i16(1);
  for (const value of box) w.i16(value);
  w.u16(points.length - 1).u16(0);
  // Flag 0: off-curve, x and y as 16-bit deltas.
  w.raw(new Uint8Array(points.length));
  let previous = 0;
  for (const x of xs) {
    w.i16(x - previous);
    previous = x;
  }
  previous = 0;
  for (const y of ys) {
    w.i16(y - previous);
    previous = y;
  }
  while (w.done().length % 4 !== 0) w.u8(0);
  return { glyph: w.done(), box };
}

/**
 * A format 13 subtable (many-to-one) maps everything to the dot. Format 4, for engines that read only
 * that, covers Latin up to U+017F.
 */
function cmap(): Uint8Array {
  const latinEnd = 0x17f;
  const latinCount = latinEnd - 0x20 + 1;
  const segCount = 2;
  const format4 = new Writer()
    .u16(4)
    .u16(16 + segCount * 8 + latinCount * 2)
    .u16(0)
    .u16(segCount * 2)
    .u16(4)
    .u16(1)
    .u16(0)
    .u16(latinEnd)
    .u16(0xffff)
    .u16(0)
    .u16(0x20)
    .u16(0xffff)
    .i16(0)
    .i16(1)
    .u16(segCount * 2)
    .u16(0);
  for (let i = 0; i < latinCount; i++) format4.u16(1);
  const groups = [
    [0x20, 0xd7ff],
    [0xe000, 0x10ffff],
  ] as const;
  const format13 = new Writer()
    .u16(13)
    .u16(0)
    .u32(16 + groups.length * 12)
    .u32(0)
    .u32(groups.length);
  for (const [start, end] of groups) format13.u32(start).u32(end).u32(1);
  const f4 = format4.done();
  const f13 = format13.done();
  const header = 4 + 2 * 8;
  return new Writer()
    .u16(0)
    .u16(2)
    .u16(3)
    .u16(1)
    .u32(header)
    .u16(3)
    .u16(10)
    .u32(header + f4.length)
    .raw(f4)
    .raw(f13)
    .done();
}

function name(): Uint8Array {
  const records: [number, string][] = [
    [1, NAME],
    [2, "Regular"],
    [3, `${POSTSCRIPT_NAME}-1.0`],
    [4, NAME],
    [5, "Version 1.0"],
    [6, POSTSCRIPT_NAME],
  ];
  const strings = records.map(([, text]) => {
    const w = new Writer();
    for (const char of text) w.u16(char.charCodeAt(0));
    return w.done();
  });
  const w = new Writer()
    .u16(0)
    .u16(records.length)
    .u16(6 + records.length * 12);
  let offset = 0;
  records.forEach(([id], i) => {
    const length = strings[i]?.length ?? 0;
    w.u16(3).u16(1).u16(0x409).u16(id).u16(length).u16(offset);
    offset += length;
  });
  for (const string of strings) w.raw(string);
  return w.done();
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const word =
      ((data[i] ?? 0) << 24) |
      ((data[i + 1] ?? 0) << 16) |
      ((data[i + 2] ?? 0) << 8) |
      (data[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) % 0x100000000;
  }
  return sum;
}

export function dotFont(): Uint8Array {
  const { glyph, box } = dotGlyph();
  const [xMin, yMin, xMax, yMax] = box;
  const numGlyphs = 2;

  const head = new Writer()
    .u32(0x00010000)
    .u32(0x00010000)
    .u32(0) // checkSumAdjustment, set below
    .u32(0x5f0f3cf5)
    .u16(0b1011)
    .u16(UNITS_PER_EM)
    .u32(0)
    .u32(CREATED)
    .u32(0)
    .u32(CREATED)
    .i16(xMin)
    .i16(yMin)
    .i16(xMax)
    .i16(yMax)
    .u16(0)
    .u16(8)
    .i16(2)
    .i16(0)
    .i16(0)
    .done();
  const hhea = new Writer()
    .u32(0x00010000)
    .i16(ASCENT)
    .i16(-DESCENT)
    .i16(0)
    .u16(ADVANCE)
    .i16(xMin)
    .i16(ADVANCE - xMax)
    .i16(xMax)
    .i16(1)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .u16(numGlyphs)
    .done();
  const maxp = new Writer()
    .u32(0x00010000)
    .u16(numGlyphs)
    .u16(8)
    .u16(1)
    .u16(0)
    .u16(0)
    .u16(2)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .done();
  const os2 = new Writer()
    .u16(4)
    .i16(ADVANCE)
    .u16(400)
    .u16(5)
    .u16(0)
    .i16(650)
    .i16(600)
    .i16(0)
    .i16(75)
    .i16(650)
    .i16(600)
    .i16(0)
    .i16(350)
    .i16(50)
    .i16(260)
    .i16(0)
    .raw(new Uint8Array(10))
    .u32(1)
    .u32(0)
    .u32(0)
    .u32(0)
    .raw(new TextEncoder().encode("NONE"))
    .u16(0xc0) // REGULAR, USE_TYPO_METRICS
    .u16(0x20)
    .u16(0xffff)
    .i16(ASCENT)
    .i16(-DESCENT)
    .i16(0)
    .u16(ASCENT)
    .u16(DESCENT)
    .u32(1)
    .u32(0)
    .i16(500)
    .i16(700)
    .u16(0)
    .u16(0x20)
    .u16(1)
    .done();
  const hmtx = new Writer().u16(ADVANCE).i16(0).u16(ADVANCE).i16(xMin).done();
  const loca = new Writer()
    .u16(0)
    .u16(0)
    .u16(glyph.length / 2)
    .done();
  const post = new Writer()
    .u32(0x00030000)
    .u32(0)
    .i16(-100)
    .i16(50)
    .u32(1)
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(0)
    .done();

  const tables: [string, Uint8Array][] = [
    ["OS/2", os2],
    ["cmap", cmap()],
    ["glyf", glyph],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["name", name()],
    ["post", post],
  ];
  const w = new Writer()
    .u32(0x00010000)
    .u16(tables.length)
    .u16(128)
    .u16(3)
    .u16(tables.length * 16 - 128);
  let offset = 12 + tables.length * 16;
  const padded = tables.map(([, data]) => {
    const copy = new Uint8Array(Math.ceil(data.length / 4) * 4);
    copy.set(data);
    return copy;
  });
  tables.forEach(([tag, data], i) => {
    w.raw(new TextEncoder().encode(tag)).u32(checksum(data)).u32(offset).u32(data.length);
    offset += padded[i]?.length ?? 0;
  });
  for (const data of padded) w.raw(data);
  const font = w.done();

  const headOffset =
    12 + tables.length * 16 + padded.slice(0, 3).reduce((sum, t) => sum + t.length, 0);
  const adjustment = (0xb1b0afba - checksum(font) + 0x100000000) % 0x100000000;
  new DataView(font.buffer).setUint32(headOffset + 8, adjustment);
  return font;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("src/dots.ttf", import.meta.url), dotFont());
}
