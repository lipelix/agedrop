/** A small agedrop repository with throwaway keys, for the web UI's tests. */
import {
  encryptSecret,
  formatLock,
  formatRecipientFile,
  formatRequest,
  lockSecret,
  parseConfig,
  parseRecipientFile,
  resolveScope,
  type Lock,
} from "../src/index.js";
import { FakeGitHub } from "./fake-github.js";
import { throwawayKey } from "./helpers.js";

export const REPOSITORY = "someone/home-secrets";

export interface Fixture {
  readonly github: FakeGitHub;
  /** Identity of the mini host, the target of `mini/hq`. */
  readonly miniIdentity: string;
  readonly ownerIdentity: string;
}

export async function webFixture(): Promise<Fixture> {
  const owner = await throwawayKey();
  const mini = await throwawayKey();
  const config = `version = 0

[recipients]
owners = ["owner"]
mini = ["mini"]

[scopes."mini/hq"]
recipients = ["owners", "mini"]

[scopes."ci/deploy"]
recipients = ["owners"]
`;
  const recipientFiles = {
    "recipients/owner.pub": formatRecipientFile({
      kind: "owner",
      added: "2026-11-01",
      recipient: owner.recipient,
    }),
    "recipients/mini.pub": formatRecipientFile({
      kind: "machine",
      added: "2026-11-01",
      recipient: mini.recipient,
    }),
  };
  const parsed = parseConfig(config);
  const recipients = new Map(
    Object.entries(recipientFiles).map(([path, text]) => {
      const name = path.slice("recipients/".length, -".pub".length);
      return [name, parseRecipientFile(name, text)];
    }),
  );
  const hq = resolveScope(parsed, recipients, "mini/hq");
  const deploy = resolveScope(parsed, recipients, "ci/deploy");

  let lock: Lock = { secrets: new Map(), sets: new Map() };
  lock = await lockSecret(lock, "mini/hq/DATABASE_URL", hq);
  // Encrypted to ci/deploy's recipients but recorded under an older set: stale.
  lock = await lockSecret(lock, "ci/deploy/NPM_TOKEN", hq);

  const github = new FakeGitHub(REPOSITORY, {
    "README.md": "# home secrets\n",
    "agedrop.toml": config,
    ...recipientFiles,
    "agedrop.lock": formatLock(lock),
    "secrets/mini/hq/DATABASE_URL.age": await encryptSecret(
      "postgres://throwaway@localhost/db",
      hq.recipients,
    ),
    "secrets/ci/deploy/NPM_TOKEN.age": await encryptSecret("npm_throwaway", deploy.recipients),
    "requests/k7mq2xpa.toml": formatRequest({
      id: "k7mq2xpa",
      scope: "mini/hq",
      name: "VAPID_PRIVATE_KEY",
      reason: "Web Push signing key for plan #50",
      requestedBy: "hq plan session #52",
      created: "2026-11-09T10:00:00Z",
      generate: "openssl ecparam -genkey -name prime256v1 -noout",
    }),
  });
  return { github, miniIdentity: mini.identity, ownerIdentity: owner.identity };
}
