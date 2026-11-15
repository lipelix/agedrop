import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";

/** A browser's `PushSubscription.toJSON()`: where to send, and the keys to encrypt to. */
export interface PushSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** The record size written in the aes128gcm header; one record holds the whole payload. */
const RECORD_SIZE = 4096;
/** A record's overhead: the padding delimiter (1 byte) and the AES-GCM tag (16 bytes). */
const RECORD_OVERHEAD = 17;

/** Parses `AGEDROP_WEBPUSH_SUBSCRIPTIONS`: one subscription as JSON, or an array of them. */
export function parseSubscriptions(text: string): PushSubscription[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  const list = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  if (list.length === 0) throw new Error("no subscription");
  return list.map((item, index) => {
    const where = list.length > 1 ? `subscription ${String(index + 1)}: ` : "";
    const sub = item as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof item !== "object" || item === null) throw new Error(`${where}not an object`);
    if (typeof sub.endpoint !== "string" || !isHttpsUrl(sub.endpoint)) {
      throw new Error(`${where}"endpoint" must be an https URL`);
    }
    const p256dh = sub.keys?.p256dh;
    const auth = sub.keys?.auth;
    if (typeof p256dh !== "string" || !isPublicKey(decode(p256dh))) {
      throw new Error(`${where}"keys.p256dh" must be a base64url P-256 public key`);
    }
    if (typeof auth !== "string" || decode(auth).length !== 16) {
      throw new Error(`${where}"keys.auth" must be 16 bytes of base64url`);
    }
    return { endpoint: sub.endpoint, keys: { p256dh, auth } };
  });
}

/** A VAPID (RFC 8292) signing key: the private key, and its public key as the `k` parameter. */
export interface VapidKey {
  readonly key: KeyObject;
  /** base64url of the uncompressed P-256 public key. */
  readonly publicKey: string;
}

/** Reads a VAPID private key given as base64url of its 32 bytes, as `web-push generate-vapid-keys` prints. */
export function parseVapidKey(text: string): VapidKey {
  const d = decode(text.trim());
  if (d.length !== 32) throw new Error("must be base64url of a 32-byte P-256 private key");
  const ecdh = createECDH("prime256v1");
  try {
    ecdh.setPrivateKey(d);
  } catch {
    throw new Error("is not a valid P-256 private key");
  }
  const pub = ecdh.getPublicKey();
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: d.toString("base64url"),
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  return { key, publicKey: pub.toString("base64url") };
}

/** The `Authorization` header value for a push to `endpoint`: a VAPID JWT valid for 12 hours. */
export function vapidAuthorization(
  endpoint: string,
  subject: string,
  vapid: VapidKey,
  now = Date.now(),
): string {
  const header = json64({ typ: "JWT", alg: "ES256" });
  const claims = json64({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: vapid.key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${signature.toString("base64url")}, k=${vapid.publicKey}`;
}

/**
 * Encrypts a push message to a subscription (RFC 8291, `Content-Encoding: aes128gcm`, one record).
 * `salt` and `senderKey` (a P-256 private key) are for tests; both are random otherwise.
 */
export function encryptPushPayload(
  payload: Uint8Array,
  subscription: PushSubscription,
  options: { salt?: Uint8Array; senderKey?: Uint8Array } = {},
): Uint8Array<ArrayBuffer> {
  if (payload.length + RECORD_OVERHEAD > RECORD_SIZE) {
    throw new Error(
      `the message is ${String(payload.length)} bytes, more than a push message holds (${String(RECORD_SIZE - RECORD_OVERHEAD)})`,
    );
  }
  const receiverKey = decode(subscription.keys.p256dh);
  const authSecret = decode(subscription.keys.auth);
  const ecdh = createECDH("prime256v1");
  if (options.senderKey === undefined) ecdh.generateKeys();
  else ecdh.setPrivateKey(Buffer.from(options.senderKey));
  const senderPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(receiverKey);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverKey, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = Buffer.from(options.salt ?? randomBytes(16));
  const cek = hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12);

  const cipher = createCipheriv("aes-128-gcm", Buffer.from(cek), Buffer.from(nonce));
  // The last (and only) record ends with the delimiter 0x02 and no padding.
  const record = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return new Uint8Array(Buffer.concat([header, senderPublic, record]));
}

function decode(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

function json64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isPublicKey(key: Buffer): boolean {
  if (key.length !== 65 || key[0] !== 4) return false;
  const probe = createECDH("prime256v1");
  probe.generateKeys();
  try {
    probe.computeSecret(key); // throws for a point that is not on the curve
    return true;
  } catch {
    return false;
  }
}

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}
