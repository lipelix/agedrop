import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { secretKind } from "../names.js";
import type { SecretFile } from "../node.js";
import { plaintextLength } from "../secret.js";

/** Values shorter than this many bytes are not redacted: they would mask ordinary output. */
export const MIN_REDACT_LENGTH = 6;

/** One byte sequence to mask, and the secret it comes from. */
export interface Pattern {
  readonly bytes: Buffer;
  readonly name: string;
}

/**
 * The forms of a value that `exec --redact` masks (SPEC.md § `exec`): its exact bytes, without trailing
 * newlines, URL-encoded, JSON-escaped, and base64 (standard and URL-safe, padded and unpadded, plus the
 * characters that only depend on the value at each of the three offsets inside a longer base64 text).
 * Returns none for a value under {@link MIN_REDACT_LENGTH} bytes.
 */
export function redactionPatterns(name: string, value: Uint8Array): Pattern[] {
  if (value.length < MIN_REDACT_LENGTH) return [];
  const bytes = Buffer.from(value);
  const forms = new Map<string, Buffer>();
  const add = (form: Buffer): void => {
    if (form.length >= MIN_REDACT_LENGTH) forms.set(form.toString("latin1"), form);
  };
  const addText = (form: string): void => {
    add(Buffer.from(form, "utf8"));
  };

  add(bytes);
  const trimmed = bytes.toString("latin1").replace(/(\r?\n)+$/, "");
  add(Buffer.from(trimmed, "latin1"));

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const encoded = encodeURIComponent(text);
  addText(encoded);
  addText(encoded.replaceAll("%20", "+"));
  addText(JSON.stringify(text).slice(1, -1));

  for (const offset of [0, 1, 2]) {
    const base64 = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    // Characters whose 6 bits all fall inside the value, so they do not depend on what surrounds it.
    const core = base64.slice(
      Math.ceil((8 * offset) / 6),
      Math.floor((8 * (offset + bytes.length)) / 6),
    );
    const variants = offset === 0 ? [base64, base64.replace(/=+$/, ""), core] : [core];
    for (const variant of variants) {
      addText(variant);
      addText(variant.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return [...forms.values()].map((form) => ({ bytes: form, name }));
}

/**
 * Masks patterns in a byte stream. Feed it with {@link write} and finish with {@link end}; both return the
 * bytes that are safe to pass on. Every byte inside any match is masked: a run of overlapping matches
 * becomes one `[REDACTED:<NAME>]` marker, named after the run's first match. A tail that could still be the
 * start of a match is held back until more bytes arrive or the stream ends.
 */
export class Redactor {
  private readonly byFirstByte = new Map<number, Pattern[]>();
  private pending: Buffer = Buffer.alloc(0);
  /** Bytes of `pending` before this index are inside a run whose marker was already returned. */
  private covered = 0;

  constructor(patterns: readonly Pattern[]) {
    for (const pattern of patterns) {
      const first = pattern.bytes[0];
      if (first === undefined) continue;
      const list = this.byFirstByte.get(first) ?? [];
      list.push(pattern);
      this.byFirstByte.set(first, list);
    }
  }

  write(chunk: Uint8Array): Buffer {
    if (chunk.length === 0) return Buffer.alloc(0);
    this.pending =
      this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    return this.drain(false);
  }

  end(): Buffer {
    const out = this.drain(true);
    this.pending = Buffer.alloc(0);
    this.covered = 0;
    return out;
  }

  private drain(final: boolean): Buffer {
    const buffer = this.pending;
    const out: Buffer[] = [];
    let emitted = this.covered; // bytes before this index are passed on or masked
    let position = 0;
    for (; position < buffer.length; position++) {
      const match = this.matchAt(buffer, position, final);
      if (match === "undecided") break;
      if (match === undefined) continue;
      if (position >= this.covered) {
        out.push(buffer.subarray(emitted, position), Buffer.from(`[REDACTED:${match.name}]`));
      }
      this.covered = Math.max(this.covered, match.end);
      emitted = this.covered;
    }
    if (emitted < position) out.push(buffer.subarray(emitted, position));
    this.pending = Buffer.from(buffer.subarray(position));
    this.covered = Math.max(0, this.covered - position);
    return Buffer.concat(out);
  }

  /**
   * The longest pattern that matches at `position`; `undefined` when none can; `"undecided"` when one
   * might once more bytes arrive.
   */
  private matchAt(
    buffer: Buffer,
    position: number,
    final: boolean,
  ): { end: number; name: string } | undefined | "undecided" {
    const candidates = this.byFirstByte.get(buffer[position] ?? -1);
    if (candidates === undefined) return undefined;
    const available = buffer.length - position;
    let best: { end: number; name: string } | undefined;
    for (const { bytes, name } of candidates) {
      if (bytes.length <= available) {
        const end = position + bytes.length;
        if (
          buffer.compare(bytes, 0, bytes.length, position, end) === 0 &&
          end > (best?.end ?? -1)
        ) {
          best = { end, name };
        }
      } else if (!final && buffer.compare(bytes, 0, available, position, buffer.length) === 0) {
        return "undecided";
      }
    }
    return best;
  }
}

/**
 * The env-style secrets in scopes with `redact = true` that are too short to redact, as their paths.
 * Reads each value's length from its age file (see {@link plaintextLength}); decrypts nothing.
 */
export async function tooShortToRedact(
  root: string,
  redacted: ReadonlySet<string>,
  files: readonly SecretFile[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    if (file.scope === undefined || file.name === undefined || !redacted.has(file.scope)) continue;
    if (secretKind(file.name) !== "env") continue;
    const length = plaintextLength(await readFile(join(root, file.path), "utf8"));
    if (length !== undefined && length < MIN_REDACT_LENGTH) paths.push(file.path);
  }
  return paths;
}

/** The warning `ls` and `check` print for a secret {@link tooShortToRedact}. */
export function tooShortWarning(path: string): string {
  return `agedrop: ${path}: warning: shorter than ${String(MIN_REDACT_LENGTH)} bytes, so exec --redact cannot mask it`;
}
