import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EMPTY_LOCK,
  formatLock,
  FormatError,
  type Lock,
  lockIssues,
  lockSecret,
  parseLock,
  recipientSetFingerprint,
} from "../src/index.js";
import { throwawayKey } from "./helpers.js";

describe("recipientSetFingerprint", () => {
  it("hashes sorted, distinct recipients, one per line", async () => {
    const expected = createHash("sha256").update("age1aaa\nage1bbb\n").digest("hex");
    expect(await recipientSetFingerprint(["age1bbb", "age1aaa", "age1bbb"])).toBe(
      `sha256:${expected}`,
    );
  });

  it("does not depend on order and changes with the set", async () => {
    const a = await recipientSetFingerprint(["age1x", "age1y"]);
    expect(await recipientSetFingerprint(["age1y", "age1x"])).toBe(a);
    expect(await recipientSetFingerprint(["age1x"])).not.toBe(a);
  });

  it("refuses an empty set", async () => {
    await expect(recipientSetFingerprint([])).rejects.toThrow(/at least one/);
  });
});

describe("agedrop.lock", () => {
  const fp = `sha256:${"ab".repeat(32)}`;

  it("round-trips with sorted keys and drops sets no secret uses", async () => {
    const a = await throwawayKey();
    const b = await throwawayKey();
    const used = await recipientSetFingerprint([a.recipient, b.recipient]);
    const unused = await recipientSetFingerprint([a.recipient]);
    const lock: Lock = {
      secrets: new Map([
        ["mini/hq/b_file", used],
        ["ci/deploy/TOKEN", used],
      ]),
      sets: new Map([
        [unused, new Map([["alice", a.recipient]])],
        [
          used,
          new Map([
            ["bob", b.recipient],
            ["alice", a.recipient],
          ]),
        ],
      ]),
    };
    const text = formatLock(lock);
    expect(text).toBe(
      `version = 0\n\n[secrets]\n"ci/deploy/TOKEN" = "${used}"\n"mini/hq/b_file" = "${used}"\n\n` +
        `[sets."${used}"]\nalice = "${a.recipient}"\nbob = "${b.recipient}"\n`,
    );
    const parsed = parseLock(text);
    expect([...parsed.secrets]).toEqual([
      ["ci/deploy/TOKEN", used],
      ["mini/hq/b_file", used],
    ]);
    expect([...parsed.sets.keys()]).toEqual([used]);
    expect(await lockIssues(parsed)).toEqual([]);
  });

  it("accepts an empty lock", () => {
    expect(parseLock(formatLock(EMPTY_LOCK)).secrets.size).toBe(0);
    expect(parseLock(`version = 0\n`).sets.size).toBe(0);
    expect(formatLock(EMPTY_LOCK)).toBe("version = 0\n\n[secrets]\n");
  });

  it("records a scope's members with lockSecret", async () => {
    const a = await throwawayKey();
    const scope = {
      scope: "mini/hq",
      names: ["alice"],
      recipients: [a.recipient],
      members: new Map([["alice", a.recipient]]),
    };
    const lock = await lockSecret(EMPTY_LOCK, "mini/hq/TOKEN", scope);
    const fingerprint = await recipientSetFingerprint([a.recipient]);
    expect(lock.secrets.get("mini/hq/TOKEN")).toBe(fingerprint);
    expect(lock.sets.get(fingerprint)).toEqual(scope.members);
    expect(EMPTY_LOCK.secrets.size).toBe(0);
  });

  it("reports missing and mismatched sets", async () => {
    const a = await throwawayKey();
    const lock: Lock = {
      secrets: new Map([["mini/X", fp]]),
      sets: new Map([[fp, new Map([["alice", a.recipient]])]]),
    };
    expect(await lockIssues(lock)).toEqual([
      `sets."${fp}": its recipients do not hash to this fingerprint`,
    ]);
    expect(await lockIssues({ secrets: lock.secrets, sets: new Map() })).toEqual([
      `"mini/X": its fingerprint has no [sets] entry`,
    ]);
  });

  it("rejects bad ids, fingerprints, sets and versions", () => {
    const text =
      `version = 1\n[secrets]\n"TOKEN" = "${fp}"\n"mini/X" = "md5:00"\n` +
      `[sets."md5:00"]\na = "age1x"\n[sets."${fp}"]\n"Bad Name" = "age1x"\nok = "nope"\n`;
    expect(() => parseLock(text)).toThrow(FormatError);
    try {
      parseLock(text);
    } catch (error) {
      expect((error as FormatError).issues).toEqual([
        `unsupported version 1 (expected 0)`,
        `invalid secret id "TOKEN"`,
        `"mini/X": fingerprint must look like sha256:<64 hex digits>`,
        `sets: "md5:00" must look like sha256:<64 hex digits>`,
        `sets."${fp}": invalid recipient name "Bad Name"`,
        `sets."${fp}".ok: not a valid age recipient`,
      ]);
    }
  });
});
