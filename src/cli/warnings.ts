/**
 * Node 22 marks X25519 in Web Crypto as experimental and prints a warning on every run. agedrop relies on
 * it, and its tests check it against the stock `age` CLI, so for a CLI user the warning is only noise.
 * Every other warning still goes through. Imported first by `main.ts`, before any crypto runs.
 */
const emitWarning = process.emitWarning.bind(process);

process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const option = rest[0];
  const type =
    typeof option === "string"
      ? option
      : typeof option === "object" && option !== null && "type" in option
        ? String(option.type)
        : warning instanceof Error
          ? warning.name
          : undefined;
  if (type === "ExperimentalWarning" && message.includes("X25519")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
};
