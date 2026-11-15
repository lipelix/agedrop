import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRecipientFile, resolveScope } from "../src/index.js";
import { loadRepository } from "../src/node.js";
import { throwawayKey, withTempDir } from "./helpers.js";

describe("loadRepository", () => {
  it("reads agedrop.toml and recipients/*.pub", async () => {
    await withTempDir(async (root) => {
      const owner = await throwawayKey();
      await writeFile(
        join(root, "agedrop.toml"),
        `version = 0\n[recipients]\nowners = ["libor"]\n[scopes.home]\nrecipients = ["owners"]\n`,
      );
      await mkdir(join(root, "recipients"));
      await writeFile(
        join(root, "recipients", "libor.pub"),
        formatRecipientFile({ kind: "owner", recipient: owner.recipient }),
      );
      await writeFile(join(root, "recipients", "libor.identity.age"), "ignored");
      const repo = await loadRepository(root);
      expect([...repo.recipients.keys()]).toEqual(["libor"]);
      expect(resolveScope(repo.config, repo.recipients, "home").recipients).toEqual([
        owner.recipient,
      ]);
    });
  });

  it("fails when a configured recipient has no .pub file", async () => {
    await withTempDir(async (root) => {
      await writeFile(
        join(root, "agedrop.toml"),
        `version = 0\n[recipients]\nowners = ["libor"]\n`,
      );
      await expect(loadRepository(root)).rejects.toThrow(/"libor" has no recipients\/libor\.pub/);
    });
  });
});
