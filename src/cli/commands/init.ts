import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE, isValidRecipientName, LOCK_FILE } from "../../names.js";
import { EMPTY_LOCK, formatLock } from "../../lock.js";
import { writeFileAtomic } from "../../node.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, note, UsageError } from "../context.js";
import { exists } from "../repo.js";
import { version } from "../version.js";
import { GITHUB_WORKFLOW_PATH, githubWorkflow } from "../workflow.js";

export const init: Command = {
  name: "init",
  summary: "create agedrop.toml and agedrop.lock",
  help: `usage: agedrop init --owner <name> [--ci github] [--repo <dir>]
       agedrop init --ci github [--repo <dir>]

Creates agedrop.toml (with the "owners" group holding <name>) and an empty
agedrop.lock in the current directory, or in --repo. Then create the owner's
key with: agedrop keygen <name> --kind owner
  --ci github  also write ${GITHUB_WORKFLOW_PATH}, which runs
               agedrop notify for new requests; in a repository that has
               agedrop.toml already, only the workflow is written`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      owner: { type: "string" },
      ci: { type: "string" },
      repo: { type: "string" },
    });
    if (positionals.length > 0)
      throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
    if (values.ci !== undefined && values.ci !== "github") {
      throw new UsageError(`unknown --ci "${values.ci}": the only one is github`);
    }
    const root = resolve(ctx.cwd, values.repo ?? ".");
    const owner = values.owner;
    const hasConfig = await exists(join(root, CONFIG_FILE));
    if (hasConfig && (owner !== undefined || values.ci === undefined)) {
      throw new CliError(`${join(root, CONFIG_FILE)} already exists`);
    }
    if (values.ci === "github" && (await exists(join(root, GITHUB_WORKFLOW_PATH)))) {
      throw new CliError(`${join(root, GITHUB_WORKFLOW_PATH)} already exists`);
    }
    if (!hasConfig) {
      if (owner === undefined) throw new UsageError("missing --owner <name>");
      if (!isValidRecipientName(owner)) {
        throw new UsageError(`invalid recipient name "${owner}": use [a-z0-9][a-z0-9_-]*`);
      }
      const config = `# agedrop repository, format: https://agedrop.dev (SPEC.md)
version = 0

[recipients]
owners = ["${owner}"]

# A scope is a deployment target; its secrets are encrypted to its groups.
# [scopes."host/app"]
# recipients = ["owners", "host"]
`;
      await writeFileAtomic(join(root, CONFIG_FILE), config, { mode: 0o644, exclusive: true });
      if (!(await exists(join(root, LOCK_FILE)))) {
        await writeFileAtomic(join(root, LOCK_FILE), formatLock(EMPTY_LOCK), { mode: 0o644 });
      }
      note(ctx, `created ${CONFIG_FILE} and ${LOCK_FILE} in ${root}`);
    }
    if (values.ci === "github") {
      const path = join(root, GITHUB_WORKFLOW_PATH);
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, githubWorkflow(version()), { mode: 0o644, exclusive: true });
      note(
        ctx,
        `created ${GITHUB_WORKFLOW_PATH}: set AGEDROP_NTFY_URL (or another target) as a repository secret`,
      );
    }
    if (owner !== undefined) note(ctx, `next: agedrop keygen ${owner} --kind owner`);
    return 0;
  },
};
