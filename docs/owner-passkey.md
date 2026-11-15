# Owner passkey: read secrets in the browser

The web UI (`https://app.agedrop.dev`) can show a secret's value to an owner after Face ID, Touch ID or the
device PIN. No private key sits on a server: the owner's key is in the repository as
`recipients/<name>.identity.age`, encrypted to a passkey. The format is in [SPEC.md](../SPEC.md)
§ Recipients, Owner identity files, and § Web UI, Owner passkey.

## What you need

- A browser and passkey with the WebAuthn **PRF** extension:
  - Safari on iOS 18.4 or later, or on macOS 15 or later, with the passkey in iCloud Keychain.
    iOS 18.0 to 18.3 had a PRF bug, so update first.
  - Chrome 132 or later, with the passkey in Google Password Manager or iCloud Keychain.
  - Third-party password managers may save the passkey but not support PRF. The page then says it
    "cannot derive keys". Use the system keychain, or unlock with the backup.
- A place for the **backup**: paper in a drawer, or a password manager entry. Not the repository, not a
  chat, not a cloud note.

## Set up

1. Sign in to the web UI and open **Owner**, then **Set up a passkey**.
2. Enter the owner name.
   - **New owner** (no `recipients/<name>.pub` yet): the page makes a new key.
   - **Existing owner** (the `.pub` exists with `kind: owner`): paste the owner's identity, e.g. from
     `~/.config/agedrop/identity` on the laptop where you ran `agedrop keygen <name> --kind owner`. The page
     checks that it matches the `.pub`.
3. **Create the passkey.** Save it in the system keychain. It is named `agedrop <name> (<owner/repo>)`.
4. **Lock the key with the passkey.** Confirm with the passkey again and pick the one you just made.
5. A new owner sees the **backup** once. Copy, download or print it, store it, and tick the box.
6. **Commit.** One commit adds `recipients/<name>.identity.age`, and for a new owner `recipients/<name>.pub`.

A new owner can read nothing yet: add the name to `owners` in `agedrop.toml`, then run `agedrop rekey`
with an existing owner identity, and commit.

## Read a value

In the inventory, tap **Show** on a secret. With one owner passkey in the repository, the page asks for it
right away; with several, it opens **Owner** to choose. The value shows in the page and hides again after
30 seconds, when you switch away from the tab, or when you leave the inventory. The unlocked key stays in
the tab's memory for 5 minutes, then the page locks itself. **Lock** ends it sooner.

## Lost the passkey

A deleted passkey, a new phone without the old keychain, or a browser without PRF all end the same way:
the identity file cannot be unwrapped. The backup brings everything back.

- **Read secrets now**, with the stock age CLI and no agedrop:

  ```sh
  age -d -i backup.txt secrets/mini/hq/DATABASE_URL.age
  ```

  or with agedrop: `agedrop pull mini/hq DATABASE_URL --identity backup.txt --to -`.

- **Unlock the web UI**: **Owner** → *Lost the passkey? Unlock with the backup*, then paste it.
- **Set up a new passkey**: unlock with the backup, then **Set up a new passkey for <name>**. It reuses the
  unlocked key, so no paste is needed, and replaces `recipients/<name>.identity.age`. The old passkey stops
  working. Delete it from the keychain.

## Lost the backup too, or it leaked

- **Passkey still works, backup lost**: unlock, then copy the key from a machine that has it, or make a new
  owner key (below). A key without a backup is one lost phone away from gone.
- **Both lost**: that owner key is gone. Another owner (or a host identity that can still read the secrets)
  has to re-encrypt: make a new owner key in the web UI under a new name or after removing the old `.pub`,
  put it in `owners`, and run `agedrop rekey` with an identity that can still decrypt.
- **Backup leaked**: treat the key as compromised. Make a new owner key, put it in `owners` instead of the
  old name, delete the old `<name>.pub` and `<name>.identity.age`, run `agedrop rekey`, and rotate every
  secret it lists: old commits stay readable with the leaked key.

## What the page does with your key

- The unwrapped key and every shown value stay in the tab's memory. They are never put in
  `localStorage`, `sessionStorage`, a URL or a log, and never sent anywhere. The page's Content Security
  Policy lets it talk to `api.github.com` only, and only ciphertext and public keys go there.
- The passkey's relying party is the page's host name, `app.agedrop.dev`, so no other site, the landing page
  at `agedrop.dev` included, can ask for it.
