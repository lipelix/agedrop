/**
 * A fake platform authenticator with the WebAuthn PRF extension, for Node (vitest) and for browsers
 * without a virtual authenticator (WebKit in Playwright). `installFakePasskeys` is self-contained so
 * Playwright can pass it to `page.addInitScript`.
 *
 * Each credential holds a random HMAC key; the PRF of an input is HMAC-SHA-256(key, input). Real
 * authenticators hash the inputs first, which makes no difference to typage.
 */

export interface FakePasskeyControl {
  /** Number of `navigator.credentials.get` calls: one per Face ID prompt on a real device. */
  gets: number;
  /** Number of credentials created. */
  readonly count: number;
  /** When true, created credentials report no PRF support, like an authenticator without it. */
  noPrf: boolean;
  /** When true, the next ceremony fails as if the user cancelled it. */
  cancel: boolean;
  /** Drops every credential, like a lost phone. */
  forget(): void;
}

declare global {
  var fakePasskeys: FakePasskeyControl | undefined;
}

export function installFakePasskeys(): void {
  interface Credential {
    readonly id: Uint8Array;
    readonly key: CryptoKey;
  }
  const credentials: Credential[] = [];
  const control = {
    gets: 0,
    noPrf: false,
    cancel: false,
    get count() {
      return credentials.length;
    },
    forget() {
      credentials.length = 0;
    },
  };
  globalThis.fakePasskeys = control;

  const bytes = (source: BufferSource): Uint8Array =>
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const same = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
  const notAllowed = (): Error => {
    const error = new Error("The operation either timed out or was not allowed.");
    error.name = "NotAllowedError";
    return error;
  };

  const fake = {
    async create(options: CredentialCreationOptions) {
      if (control.cancel) {
        control.cancel = false;
        throw notAllowed();
      }
      const id = crypto.getRandomValues(new Uint8Array(16));
      const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]);
      credentials.push({ id, key });
      const prf = options.publicKey?.extensions?.prf !== undefined && !control.noPrf;
      return {
        type: "public-key",
        rawId: id.slice().buffer,
        response: { getTransports: () => ["internal"] },
        getClientExtensionResults: () => (prf ? { prf: { enabled: true } } : {}),
      };
    },
    async get(options: CredentialRequestOptions) {
      control.gets++;
      if (control.cancel) {
        control.cancel = false;
        throw notAllowed();
      }
      const allowed = options.publicKey?.allowCredentials ?? [];
      const credential =
        allowed.length === 0
          ? credentials[credentials.length - 1]
          : credentials.find((c) => allowed.some((a) => same(bytes(a.id), c.id)));
      if (credential === undefined) throw notAllowed();
      const inputs = options.publicKey?.extensions?.prf?.eval;
      const sign = async (input: BufferSource): Promise<ArrayBuffer> =>
        crypto.subtle.sign("HMAC", credential.key, bytes(input).slice());
      const results =
        inputs === undefined || control.noPrf
          ? undefined
          : {
              first: await sign(inputs.first),
              ...(inputs.second === undefined ? {} : { second: await sign(inputs.second) }),
            };
      return {
        type: "public-key",
        rawId: credential.id.slice().buffer,
        getClientExtensionResults: () => (results === undefined ? {} : { prf: { results } }),
      };
    },
  };
  Object.defineProperty(globalThis.navigator, "credentials", {
    value: fake,
    configurable: true,
  });
}
