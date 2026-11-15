import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** The end-to-end tests run the real CLI from dist/, so build it once before any test. */
export default async function setup(): Promise<void> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "-p",
      "tsconfig.build.json",
    ],
    { cwd: root },
  );
}
