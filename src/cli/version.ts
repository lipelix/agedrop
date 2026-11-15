import { readFileSync } from "node:fs";

/** The version in package.json. */
export function version(): string {
  // dist/cli/version.js and src/cli/version.ts both sit two levels below package.json.
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}
