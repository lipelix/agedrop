import { rm } from "node:fs/promises";
import { join } from "node:path";
import { LOCK_FILE, secretKind, secretPath } from "../../names.js";
import { readOptional } from "../../node.js";
import { isValidRequestId, parseRequest, requestPath, type SecretRequest } from "../../requests.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, type Context, note, UsageError } from "../context.js";
import { runGenerate } from "../generate.js";
import { commitPaths, inWorkTree, isTracked } from "../git.js";
import { readHiddenLine } from "../input.js";
import { openRepository, scopeOf } from "../repo.js";
import { prepareValue, readValue, storeSecret } from "../store.js";

export const fulfil: Command = {
  name: "fulfil",
  summary: "answer a request: encrypt the value and close the request in one commit",
  help: `usage: agedrop fulfil <id> [--generate] [--no-commit] [--repo <dir>] [< value]

Shows request <id>, reads the value like agedrop add (stdin, or one hidden
line from a terminal), writes secrets/<scope>/<NAME>.age and agedrop.lock,
deletes requests/<id>.toml and commits exactly those files. It never prints
the value and does not push.
  --generate   run the request's generate hint (sh -c) and use its stdout;
               from a terminal you are asked before it runs
  --no-commit  leave the changes uncommitted`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      generate: { type: "boolean", default: false },
      "no-commit": { type: "boolean", default: false },
      repo: { type: "string" },
    });
    const [id, ...rest] = positionals;
    if (id === undefined) throw new UsageError("missing <id> (see agedrop requests)");
    if (rest.length > 0) {
      throw new UsageError(`unexpected argument: values are read from stdin, never from arguments`);
    }
    if (!isValidRequestId(id)) throw new UsageError(`invalid request id "${id}"`);
    const repo = await openRepository(ctx, values.repo);
    const file = requestPath(id);
    const text = await readOptional(join(repo.root, file));
    if (text === undefined) {
      throw new CliError(`no open request ${id}: ${file} does not exist (see agedrop requests)`);
    }
    const request = parseRequest(id, text);
    const resolved = scopeOf(repo, request.scope);
    const kind = secretKind(request.name) ?? "file";
    describe(ctx, request, resolved.names);

    const value = prepareValue(
      ctx,
      request.name,
      kind,
      await obtainValue(ctx, request, values.generate),
    );

    const secret = secretPath(request.scope, request.name);
    const tracked = await isTracked(repo.root, file);
    const replaced = await storeSecret(repo, resolved, request.name, value);
    await rm(join(repo.root, file));
    note(ctx, `${replaced ? "replaced" : "added"} ${secret} and closed ${file}`);

    if (values["no-commit"]) {
      note(ctx, "not committed (--no-commit)");
      return 0;
    }
    if (!(await inWorkTree(repo.root))) {
      note(ctx, "not in a git work tree: nothing committed");
      return 0;
    }
    const paths = [secret, LOCK_FILE, ...(tracked ? [file] : [])];
    const message = `chore(secrets): fulfil ${request.scope}/${request.name} (request ${id})`;
    try {
      const commit = await commitPaths(repo.root, paths, message);
      note(ctx, `committed ${commit}: ${message}\nnext: git push`);
    } catch (error) {
      throw new CliError(
        `wrote the secret, but git commit failed: ${gitError(error)}; commit ${paths.join(", ")} by hand`,
      );
    }
    return 0;
  },
};

function describe(ctx: Context, request: SecretRequest, names: readonly string[]): void {
  note(
    ctx,
    [
      `request ${request.id}: ${request.scope}/${request.name}`,
      `  reason:       ${request.reason.replace(/\n/g, "\n                ")}`,
      `  requested by: ${request.requestedBy} on ${request.created}`,
      `  readable by:  ${names.join(", ")}`,
      ...(request.generate === undefined ? [] : [`  generate:     ${request.generate}`]),
    ].join("\n"),
  );
}

async function obtainValue(
  ctx: Context,
  request: SecretRequest,
  generate: boolean,
): Promise<Uint8Array> {
  const run = (command: string): Promise<Uint8Array> => runGenerate(ctx, command);
  const label = `${request.scope}/${request.name}`;
  if (generate) {
    if (request.generate === undefined)
      throw new CliError(`request ${request.id} has no generate hint`);
    note(ctx, `running: ${request.generate}`);
    return run(request.generate);
  }
  if (request.generate !== undefined && ctx.stdin.isTTY) {
    const answer = await readHiddenLine(ctx, `run the generate command above? [y/N] `, true);
    if (/^y(es)?$/i.test(answer.trim())) return run(request.generate);
  }
  return readValue(ctx, `value for ${label}: `);
}

function gitError(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : String(error);
  return text.trim().split("\n").at(-1) ?? text;
}
