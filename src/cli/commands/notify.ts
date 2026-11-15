import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FormatError } from "../../errors.js";
import { REQUESTS_DIR, secretPath } from "../../names.js";
import { listRequestIds } from "../../node.js";
import { isValidRequestId, parseRequest, requestPath } from "../../requests.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, note, UsageError } from "../context.js";
import { addedSince } from "../git.js";
import { APP_URL, buildNotification, configuredTargets, type Notification } from "../notify.js";
import { exists, requireRoot } from "../repo.js";

const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const notify: Command = {
  name: "notify",
  summary: "tell a human about new requests: ntfy, a webhook or Web Push",
  help: `usage: agedrop notify [id…] [--since <rev>] [--dry-run] [--github <owner/name>]
                      [--app-url <url>] [--repo <dir>]

Sends one notification per request: the ids given, the request files added
since <rev> (all zeros means every open request), or every open request.
A notification holds the scope, name, reason, requester and a link to the
fulfil form in the web UI, never a value. Targets come from the environment:
  AGEDROP_NTFY_URL [AGEDROP_NTFY_TOKEN]          ntfy topic URL
  AGEDROP_WEBHOOK_URL [AGEDROP_WEBHOOK_SECRET]   JSON POST, HMAC-signed
  AGEDROP_WEBPUSH_SUBSCRIPTIONS AGEDROP_VAPID_PRIVATE_KEY AGEDROP_VAPID_SUBJECT
  --dry-run   print the notifications as JSON and send nothing
  --github    the GitHub repository for the link (default: GITHUB_REPOSITORY)
  --app-url   the web UI (default: ${APP_URL})`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      since: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      github: { type: "string" },
      "app-url": { type: "string" },
      repo: { type: "string" },
    });
    const since = values.since;
    if (since !== undefined && positionals.length > 0) {
      throw new UsageError("give request ids or --since <rev>, not both");
    }
    if (since?.startsWith("-") === true || since === "") {
      throw new UsageError(`invalid --since revision "${since}"`);
    }
    for (const id of positionals) {
      if (!isValidRequestId(id)) throw new UsageError(`invalid request id "${id}"`);
    }
    const fromEnv = ctx.env.GITHUB_REPOSITORY?.trim();
    const github = values.github ?? (fromEnv === "" ? undefined : fromEnv);
    if (github !== undefined && !GITHUB_REPOSITORY.test(github)) {
      throw new UsageError(`invalid GitHub repository "${github}": use owner/name`);
    }
    const appUrl = values["app-url"] ?? APP_URL;
    if (!/^https?:\/\/\S+$/.test(appUrl)) throw new UsageError(`invalid --app-url "${appUrl}"`);

    const dryRun = values["dry-run"];
    const targets = dryRun ? [] : configuredTargets(ctx.env);
    if (!dryRun && targets.length === 0) {
      throw new CliError(
        "no notification target: set AGEDROP_NTFY_URL, AGEDROP_WEBHOOK_URL or AGEDROP_WEBPUSH_SUBSCRIPTIONS (see agedrop notify --help)",
      );
    }

    const root = await requireRoot(ctx, values.repo);
    let ids: string[];
    if (positionals.length > 0) ids = positionals;
    else if (since === undefined || /^0+$/.test(since)) ids = await listRequestIds(root);
    else {
      let paths: string[];
      try {
        paths = await addedSince(root, since, REQUESTS_DIR);
      } catch (error) {
        const detail = (error as { stderr?: string }).stderr?.trim().split("\n")[0];
        throw new CliError(
          `cannot list the requests added since ${since}: ${detail ?? String(error)}`,
        );
      }
      ids = paths
        .map((path) => /^requests\/([^/]+)\.toml$/.exec(path)?.[1])
        .filter((id): id is string => id !== undefined && isValidRequestId(id));
    }

    let failed = false;
    const notifications: Notification[] = [];
    for (const id of ids) {
      const file = requestPath(id);
      let text: string;
      try {
        text = await readFile(join(root, file), "utf8");
      } catch {
        ctx.stderr.write(`agedrop: ${file}: no open request "${id}"\n`);
        failed = true;
        continue;
      }
      try {
        const request = parseRequest(id, text);
        const rotation = await exists(join(root, secretPath(request.scope, request.name)));
        notifications.push(buildNotification(request, { rotation, repository: github, appUrl }));
      } catch (error) {
        if (!(error instanceof FormatError)) throw error;
        for (const issue of error.issues) ctx.stderr.write(`agedrop: ${error.file}: ${issue}\n`);
        failed = true;
      }
    }

    if (dryRun) {
      for (const n of notifications) ctx.stdout.write(`${JSON.stringify(n)}\n`);
      return failed ? 1 : 0;
    }
    if (notifications.length === 0) {
      note(ctx, since === undefined ? "no open requests" : `no requests added since ${since}`);
      return failed ? 1 : 0;
    }
    let sent = 0;
    for (const n of notifications) {
      const results = await Promise.allSettled(targets.map((target) => target.send(n)));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        ctx.stderr.write(
          `agedrop: ${targets[index]?.label ?? "target"}: request ${n.request.id}: ${reason}\n`,
        );
        failed = true;
      });
      if (results.some((r) => r.status === "fulfilled")) sent++;
    }
    const labels = targets.map((t) => t.label).join(", ");
    note(
      ctx,
      `notified ${String(sent)} of ${String(notifications.length)} request${notifications.length === 1 ? "" : "s"} (${labels})`,
    );
    return failed ? 1 : 0;
  },
};
