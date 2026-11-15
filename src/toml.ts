import { parse as parseToml } from "smol-toml";
import { FormatError } from "./errors.js";

/** Parses a TOML file, turning syntax errors into a {@link FormatError} for `file`. */
export function parseTomlFile(file: string, text: string): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FormatError(file, [`invalid TOML: ${message.split("\n")[0] ?? message}`]);
  }
}

/** True for a TOML table (not an array, date or scalar). */
export function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}
