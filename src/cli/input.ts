import { CliError, type Context, type Input } from "./context.js";

/** Reads stdin to the end as exact bytes. */
export async function readAll(stdin: Input): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Reads one line from a terminal without echoing it (or with `echo`, showing what is typed).
 * Enter ends the line, Backspace deletes, Ctrl-C cancels. The line ending is not part of the value.
 */
export async function readHiddenLine(ctx: Context, prompt: string, echo = false): Promise<string> {
  const { stdin } = ctx;
  if (stdin.setRawMode === undefined) throw new CliError("stdin is a terminal without raw mode");
  ctx.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding?.("utf8");
  stdin.resume?.();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause?.();
      ctx.stderr.write("\n");
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new CliError("cancelled", 130));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (echo && value !== "") ctx.stderr.write("\b \b");
          value = Array.from(value).slice(0, -1).join("");
        } else {
          if (echo) ctx.stderr.write(char);
          value += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}
