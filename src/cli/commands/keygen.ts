import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { isValidRecipientName, recipientPath } from "../../names.js";
import { writeFileAtomic } from "../../node.js";
import { formatRecipientFile, RECIPIENT_KINDS, type RecipientKind } from "../../recipients.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, note, UsageError } from "../context.js";
import { defaultIdentityPath } from "../identity.js";
import { exists, findRoot } from "../repo.js";

export const keygen: Command = {
  name: "keygen",
  summary: "create an identity on this host and its recipients/<name>.pub",
  help: `usage: agedrop keygen <name> [--kind machine|ci|owner] [--out <file>|-] [--repo <dir>]

Generates an age identity and writes it to --out, by default
~/.config/agedrop/identity (mode 600). It never overwrites an identity.
--out - prints the identity instead, e.g. to store it as the AGEDROP_IDENTITY
CI secret. Inside a repository it writes recipients/<name>.pub; outside, it
prints that file. Then add <name> to a group in agedrop.toml.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      kind: { type: "string", default: "machine" },
      out: { type: "string" },
      repo: { type: "string" },
    });
    const [name, ...rest] = positionals;
    if (name === undefined) throw new UsageError("missing <name>");
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0] ?? ""}"`);
    if (!isValidRecipientName(name)) {
      throw new UsageError(`invalid recipient name "${name}": use [a-z0-9][a-z0-9_-]*`);
    }
    const kind = values.kind;
    if (!isKind(kind)) {
      throw new UsageError(`unknown kind "${kind}": use ${RECIPIENT_KINDS.join(", ")}`);
    }

    const root = await findRoot(ctx, values.repo);
    const pubPath = root === undefined ? undefined : join(root, recipientPath(name));
    if (pubPath !== undefined && (await exists(pubPath))) {
      throw new CliError(`${recipientPath(name)} already exists`);
    }

    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const now = new Date();
    const identityFile = `# created: ${now.toISOString().replace(/\.\d+Z$/, "Z")}\n# public key: ${recipient}\n${identity}\n`;
    const pub = formatRecipientFile({ kind, added: now.toISOString().slice(0, 10), recipient });

    if (values.out === "-") {
      ctx.stdout.write(identityFile);
    } else {
      const out =
        values.out === undefined ? defaultIdentityPath(ctx) : resolve(ctx.cwd, values.out);
      if (await exists(out)) {
        throw new CliError(
          `${out} already exists; keygen never overwrites an identity (use --out <file>)`,
        );
      }
      await mkdir(dirname(out), { recursive: true, mode: 0o700 });
      await writeFileAtomic(out, identityFile, { mode: 0o600, exclusive: true });
      note(ctx, `wrote the identity to ${out}`);
    }

    if (pubPath === undefined) {
      note(ctx, `not in an agedrop repository; save this as recipients/${name}.pub:`);
      (values.out === "-" ? ctx.stderr : ctx.stdout).write(pub);
      return 0;
    }
    await mkdir(dirname(pubPath), { recursive: true });
    await writeFileAtomic(pubPath, pub, { mode: 0o644, exclusive: true });
    note(ctx, `wrote ${recipientPath(name)} (${kind}): ${recipient}`);
    note(ctx, `next: add "${name}" to a group in agedrop.toml`);
    if (values.out !== "-") ctx.stdout.write(`${recipient}\n`);
    return 0;
  },
};

function isKind(value: string): value is RecipientKind {
  return (RECIPIENT_KINDS as readonly string[]).includes(value);
}
