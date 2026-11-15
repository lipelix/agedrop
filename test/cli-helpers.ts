import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Context } from "../src/cli/context.js";
import { run } from "../src/cli/run.js";
import { formatRecipientFile } from "../src/index.js";
import { endStdin, throwawayKey } from "./helpers.js";

export const CLI = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in this process with captured output. */
export async function runCli(
  argv: string[],
  options: { cwd: string; home: string; env?: Record<string, string>; stdin?: string | Buffer },
): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const ctx: Context = {
    cwd: options.cwd,
    home: options.home,
    env: options.env ?? {},
    stdin: Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin)]),
    stdout: { write: (chunk) => (stdout += Buffer.from(chunk).toString("utf8")) },
    stderr: { write: (chunk) => (stderr += Buffer.from(chunk).toString("utf8")) },
  };
  const code = await run(argv, ctx);
  return { code, stdout, stderr };
}

/** A clean environment: no AGEDROP_IDENTITY from the developer's shell, HOME in the temp dir. */
export function envFor(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
}

/** Runs the built CLI as a child process, like a user would. */
export function spawnCli(
  argv: string[],
  options: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI, ...argv],
      { cwd: options.cwd, env: options.env, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
    endStdin(child.stdin, options.stdin ?? "", reject);
  });
}

/**
 * A repository with an owner and one machine, scope "host/app" encrypted to both.
 * Returns the identities (throwaway keys).
 */
export async function makeRepo(root: string): Promise<{ owner: string; host: string }> {
  const owner = await throwawayKey();
  const host = await throwawayKey();
  await writeFile(
    join(root, "agedrop.toml"),
    `version = 0

[recipients]
owners = ["owner"]
hosts = ["host"]

[scopes."host/app"]
recipients = ["owners", "hosts"]

[scopes.other]
recipients = ["owners"]
`,
  );
  await mkdir(join(root, "recipients"));
  await writeFile(
    join(root, "recipients", "owner.pub"),
    formatRecipientFile({ kind: "owner", recipient: owner.recipient }),
  );
  await writeFile(
    join(root, "recipients", "host.pub"),
    formatRecipientFile({ kind: "machine", recipient: host.recipient }),
  );
  return { owner: owner.identity, host: host.identity };
}
