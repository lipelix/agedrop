import { homedir } from "node:os";

/** A stream the CLI writes to. */
export interface Output {
  write(chunk: string | Uint8Array): unknown;
}

/** Standard input, with the terminal methods present when it is a TTY. */
export interface Input extends AsyncIterable<Buffer | string> {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

/** Everything a command touches outside the repository, so tests can supply their own. */
export interface Context {
  readonly cwd: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: Input;
  readonly stdout: Output;
  readonly stderr: Output;
}

export function processContext(): Context {
  return {
    cwd: process.cwd(),
    home: homedir(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

/** A failure the CLI reports as `agedrop: <message>` and exits with `exitCode`. */
export class CliError extends Error {
  override readonly name = "CliError";

  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** Wrong arguments: exit code 2, with a pointer to `--help`. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
  }
}

export function note(ctx: Context, message: string): void {
  ctx.stderr.write(`${message}\n`);
}
