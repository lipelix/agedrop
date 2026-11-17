import { FormatError } from "../errors.js";
import type { Command } from "./command.js";
import { add } from "./commands/add.js";
import { check } from "./commands/check.js";
import { exec } from "./commands/exec.js";
import { fulfil } from "./commands/fulfil.js";
import { init } from "./commands/init.js";
import { keygen } from "./commands/keygen.js";
import { ls } from "./commands/ls.js";
import { notify } from "./commands/notify.js";
import { protect } from "./commands/protect.js";
import { pull } from "./commands/pull.js";
import { rekey } from "./commands/rekey.js";
import { request } from "./commands/request.js";
import { requests } from "./commands/requests.js";
import { CliError, type Context, UsageError } from "./context.js";
import { version } from "./version.js";

export const COMMANDS: readonly Command[] = [
  init,
  keygen,
  add,
  request,
  requests,
  fulfil,
  notify,
  ls,
  check,
  protect,
  pull,
  exec,
  rekey,
];

function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return `usage: agedrop <command> [options]

Secrets as age files in git: write with public keys only, read with a private key,
agents request and never see values.

commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join("\n")}

Run agedrop <command> --help for details. Spec: https://agedrop.dev
`;
}

/** Runs the CLI with `argv` (without `node` and the script) and returns the exit code. */
export async function run(argv: readonly string[], ctx: Context): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    (name === undefined ? ctx.stderr : ctx.stdout).write(usage());
    return name === undefined ? 2 : 0;
  }
  if (name === "--version" || name === "-V") {
    ctx.stdout.write(`${version()}\n`);
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) {
    ctx.stderr.write(`agedrop: unknown command "${name}"\n\n${usage()}`);
    return 2;
  }
  const beforeSeparator = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (beforeSeparator.includes("--help") || beforeSeparator.includes("-h")) {
    ctx.stdout.write(`${command.help}\n`);
    return 0;
  }
  try {
    return await command.run(ctx, [...args]);
  } catch (error) {
    return report(ctx, command, error);
  }
}

function report(ctx: Context, command: Command, error: unknown): number {
  if (error instanceof FormatError) {
    for (const issue of error.issues) ctx.stderr.write(`agedrop: ${error.file}: ${issue}\n`);
    return 1;
  }
  if (error instanceof UsageError) {
    ctx.stderr.write(
      `agedrop ${command.name}: ${error.message}\n${command.help.split("\n")[0] ?? ""}\n`,
    );
    return error.exitCode;
  }
  if (error instanceof CliError) {
    ctx.stderr.write(`agedrop: ${error.message}\n`);
    return error.exitCode;
  }
  ctx.stderr.write(`agedrop: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}
