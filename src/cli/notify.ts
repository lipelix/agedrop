import { createHmac } from "node:crypto";
import type { SecretRequest } from "../requests.js";
import { CliError } from "./context.js";
import {
  encryptPushPayload,
  parseSubscriptions,
  parseVapidKey,
  vapidAuthorization,
} from "./webpush.js";

/** The web UI that notifications link to. */
export const APP_URL = "https://app.agedrop.dev";

/** The longest `reason` a notification carries, in characters. */
const REASON_LIMIT = 500;
const TIMEOUT_MS = 15_000;

/** What a notification says about one request (SPEC.md § Notifications). It never holds a value. */
export interface Notification {
  readonly type: "agedrop.request";
  readonly repository?: string;
  readonly request: {
    readonly id: string;
    readonly scope: string;
    readonly name: string;
    readonly reason: string;
    readonly requested_by: string;
    readonly created: string;
  };
  readonly rotation: boolean;
  readonly url?: string;
  readonly title: string;
  readonly message: string;
}

export function buildNotification(
  request: SecretRequest,
  options: { rotation: boolean; repository?: string | undefined; appUrl: string },
): Notification {
  const chars = Array.from(request.reason); // code points: never cut a surrogate pair
  const reason =
    chars.length > REASON_LIMIT ? `${chars.slice(0, REASON_LIMIT - 1).join("")}…` : request.reason;
  const secret = `${request.scope}/${request.name}`;
  const { repository } = options;
  const url =
    repository === undefined
      ? undefined
      : `${options.appUrl.replace(/\/+$/, "")}/#/requests/${request.id}?${new URLSearchParams({ repo: repository }).toString()}`;
  return {
    type: "agedrop.request",
    ...(repository === undefined ? {} : { repository }),
    request: {
      id: request.id,
      scope: request.scope,
      name: request.name,
      reason,
      requested_by: request.requestedBy,
      created: request.created,
    },
    rotation: options.rotation,
    ...(url === undefined ? {} : { url }),
    title: `${options.rotation ? "New value requested" : "Secret requested"}: ${secret}`,
    message: `${reason}\nby ${request.requestedBy}`,
  };
}

/** A place notifications go to. `label` names it in errors and never holds a URL or a token. */
export interface Target {
  readonly label: string;
  send(notification: Notification): Promise<void>;
}

/** The targets configured in `env` (SPEC.md § Targets). An empty variable counts as unset. */
export function configuredTargets(env: Readonly<Record<string, string | undefined>>): Target[] {
  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const targets: Target[] = [];

  const ntfyUrl = get("AGEDROP_NTFY_URL");
  if (ntfyUrl !== undefined) targets.push(ntfyTarget(ntfyUrl, get("AGEDROP_NTFY_TOKEN")));
  else if (get("AGEDROP_NTFY_TOKEN") !== undefined) {
    throw new CliError("AGEDROP_NTFY_TOKEN is set but AGEDROP_NTFY_URL is not");
  }

  const webhookUrl = get("AGEDROP_WEBHOOK_URL");
  if (webhookUrl !== undefined) {
    targets.push(webhookTarget(webhookUrl, get("AGEDROP_WEBHOOK_SECRET")));
  } else if (get("AGEDROP_WEBHOOK_SECRET") !== undefined) {
    throw new CliError("AGEDROP_WEBHOOK_SECRET is set but AGEDROP_WEBHOOK_URL is not");
  }

  const push = [
    "AGEDROP_WEBPUSH_SUBSCRIPTIONS",
    "AGEDROP_VAPID_PRIVATE_KEY",
    "AGEDROP_VAPID_SUBJECT",
  ];
  const missing = push.filter((name) => get(name) === undefined);
  if (missing.length < push.length) {
    if (missing.length > 0) {
      throw new CliError(`Web Push needs ${push.join(", ")}; missing: ${missing.join(", ")}`);
    }
    targets.push(
      ...webPushTargets(
        get("AGEDROP_WEBPUSH_SUBSCRIPTIONS") ?? "",
        get("AGEDROP_VAPID_PRIVATE_KEY") ?? "",
        get("AGEDROP_VAPID_SUBJECT") ?? "",
      ),
    );
  }
  return targets;
}

function httpUrl(variable: string, text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CliError(`${variable} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`${variable} must be an https or http URL`);
  }
  return url;
}

function ntfyTarget(text: string, token: string | undefined): Target {
  const url = httpUrl("AGEDROP_NTFY_URL", text);
  const segments = url.pathname.split("/");
  const topic = segments.pop() ?? "";
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
    throw new CliError("AGEDROP_NTFY_URL must end with a topic: https://ntfy.sh/<topic>");
  }
  url.pathname = `${segments.join("/")}/`;
  url.search = "";
  const server = url.toString();
  return {
    label: "ntfy",
    send: (n) =>
      post(server, JSON.stringify(ntfyMessage(topic, n)), {
        "Content-Type": "application/json",
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      }),
  };
}

/** ntfy's JSON publish body (https://docs.ntfy.sh/publish/#publish-as-json). */
export function ntfyMessage(topic: string, n: Notification): Record<string, unknown> {
  return {
    topic,
    title: n.title,
    message: n.message,
    tags: ["key"],
    ...(n.url === undefined ? {} : { click: n.url }),
  };
}

function webhookTarget(text: string, secret: string | undefined): Target {
  const url = httpUrl("AGEDROP_WEBHOOK_URL", text).toString();
  return {
    label: "webhook",
    send: (n) => {
      const body = JSON.stringify(n);
      return post(url, body, {
        "Content-Type": "application/json",
        ...(secret === undefined ? {} : { "X-Agedrop-Signature": webhookSignature(secret, body) }),
      });
    },
  };
}

/** `sha256=<hex HMAC-SHA256 of the body>`, keyed with `AGEDROP_WEBHOOK_SECRET`. */
export function webhookSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function webPushTargets(subscriptions: string, privateKey: string, subject: string): Target[] {
  let subs;
  try {
    subs = parseSubscriptions(subscriptions);
  } catch (error) {
    throw new CliError(`AGEDROP_WEBPUSH_SUBSCRIPTIONS: ${(error as Error).message}`);
  }
  let vapid;
  try {
    vapid = parseVapidKey(privateKey);
  } catch (error) {
    throw new CliError(`AGEDROP_VAPID_PRIVATE_KEY ${(error as Error).message}`);
  }
  if (!/^(mailto:|https:\/\/)\S+$/.test(subject)) {
    throw new CliError("AGEDROP_VAPID_SUBJECT must be a mailto: or https: URL");
  }
  return subs.map((sub, index) => ({
    label: `web push ${subs.length > 1 ? `${String(index + 1)} ` : ""}(${new URL(sub.endpoint).host})`,
    send: (n) =>
      post(sub.endpoint, encryptPushPayload(Buffer.from(JSON.stringify(n)), sub), {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        Authorization: vapidAuthorization(sub.endpoint, subject, vapid),
        TTL: "86400",
        Urgency: "high",
      }).catch((error: unknown) => {
        const status = (error as { status?: number }).status;
        throw status === 404 || status === 410
          ? new Error(`HTTP ${String(status)}: the push service dropped the subscription`)
          : error;
      }),
  }));
}

async function post(
  url: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // fetch's own message is a bare "fetch failed"; the cause has the reason. Neither holds the URL.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const reason =
      (error as Error).name === "TimeoutError"
        ? `no answer within ${String(TIMEOUT_MS / 1000)} s`
        : (cause?.code ?? (error as Error).message);
    throw new Error(reason, { cause: error });
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${String(response.status)}`), { status: response.status });
  }
}
