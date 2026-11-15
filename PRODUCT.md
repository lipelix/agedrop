# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS with a small vanilla JS file in `site/`, no build step. Hosting target is agedrop.dev on the owner's personal Cloudflare account (not deployed yet).

## Users

Solo developers and self-hosters who run their own servers and AI coding agents. Their secrets sit in scattered `.env` files with no backup, they hand-copy keys between laptop and server, and their agent sessions stall on "owner, add this secret". Small teams are a later audience, not the focus of the landing page.

## Product Purpose

agedrop keeps secrets as one age-encrypted file each in a git repository. Anyone with the public keys can add a secret; only holders of a private key can read one. Agents and scripts file requests for secrets they need and never receive the value. Success: a solo developer stops copying keys by hand and an agent can ask for a secret without the value ever entering its context.

## Positioning

No backend at all: git is the only storage. Writes need public keys only. An agent never receives the value. Every secret decrypts with the stock `age` CLI, so there is no lock-in.

## Operating Context

CLI on laptop, server and CI (`add`, `request`, `fulfil`, `ls`, `pull`, `exec`, `rekey`, `check`), a static web UI at app.agedrop.dev for adding secrets and answering requests from any device (built in `web/`, not deployed yet; reading values with a passkey-wrapped owner identity is planned), request files committed by agents, notifications via the user's own CI.

## Capabilities and Constraints

- Status: format spec is draft v0; nothing is implemented yet. The first release (v0.1) is in progress. The page must not imply it is usable today.
- Non-goals: protection from processes running as the same OS user, read audit, dynamic credentials.
- Anyone with push access can replace (not read) a secret; mitigated by branch protection and signed commits.
- No paid plans and no pricing (decided 2026-11-14). agedrop is a free, open-source core; the page must not show prices or planned paid tiers.
- The GitHub repo is private until release.

## Brand Commitments

Name "agedrop", domain agedrop.dev, unscoped npm `agedrop`. MIT license. Core maintained by Libor Váchal under lipelix. Copy in English.

## Evidence on Hand

SPEC.md (format, layout, CLI table, security notes) and docs/decisions.md (why it exists, competitor pricing read 2026-11-09: Infisical Free 5 identities, Pro $20/identity/month; Phase Free 5 users or service accounts, 3 apps, 24 h audit log). No users, testimonials, benchmarks or download counts exist; never invent them.

## Product Principles

1. The value never travels through anything but the owner's device and the machine that runs it.
2. No server to keep alive: anything that would need a server is out of scope, and would only ever see ciphertext.
3. Open format first: leaving agedrop must cost nothing.
4. Honest about limits and status.

## Primary Action

Follow the GitHub repository.
