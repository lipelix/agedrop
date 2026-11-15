import { parseArgs, type ParseArgsConfig } from "node:util";
import { type Context, UsageError } from "./context.js";

export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Full help text: usage line first. */
  readonly help: string;
  run(ctx: Context, args: string[]): Promise<number>;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** `node:util` parseArgs in strict mode, turning its errors into usage errors. */
export function parse<const O extends Options>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message.split("\n")[0] ?? String(error));
  }
}

/** Shared options: every command takes `--repo` and `--help`. */
export const REPO_OPTION = { repo: { type: "string" } } as const;
