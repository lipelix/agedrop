/** A file in an agedrop repository does not follow SPEC.md. */
export class FormatError extends Error {
  override readonly name = "FormatError";

  constructor(
    /** Repository-relative path of the offending file, e.g. `agedrop.toml`. */
    readonly file: string,
    /** One human-readable line per problem found. */
    readonly issues: readonly string[],
  ) {
    super(`${file}: ${issues.join("; ")}`);
  }
}
