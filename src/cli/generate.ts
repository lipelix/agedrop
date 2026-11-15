import { spawn } from "node:child_process";
import { CliError, type Context } from "./context.js";

/**
 * Runs a request's `generate` hint with `sh -c` and returns its stdout as exact bytes.
 * Its stderr goes to ours. The value is never printed.
 */
export async function runGenerate(ctx: Context, command: string): Promise<Uint8Array> {
  const child = spawn("sh", ["-c", command], {
    cwd: ctx.cwd,
    env: ctx.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => ctx.stderr.write(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new CliError(`the generate command failed (exit ${String(code)}); nothing was written`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
