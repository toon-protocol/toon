# toon

The shared **library layer** of the TOON Protocol: `@toon-protocol/core` (protocol primitives — TOON codec, Nostr peer discovery, ILP address derivation, settlement config, the structural `EmbeddableConnectorLike` interface) and `@toon-protocol/sdk` (the `createNode` framework, handler registry, Arweave DVM handler, swap + multi-chain settlement engines). **Libraries only — no Docker image, no end-user CLI.**

TOON Protocol = pay-to-write Nostr over Interledger (ILP), split into per-team repos. Reads are free; a write is an ILP packet carrying a TOON-encoded Nostr event + a signed payment-channel claim, validated by the connector.

## Build & test

```
pnpm install
pnpm -r build
pnpm -r test
```

## Shared skills & project context

Cross-repo context (where each TOON repo lives, the cross-repo glossary, the decisions that bind several repos and the shared skills) lives in `toon-protocol/toon-meta`, the org's private home repo; nothing in this repo needs it to build, test or publish. Repo rules are in this file and `docs/agents/`.

## Cross-repo dependencies

- This repo **publishes** `@toon-protocol/{core,sdk}` to npm. Only a few repos consume them, at pinned semver:
  - **swap** (`packages/swap`) — core and sdk: base58, receipts, `applyRate`, the settlement digests and signers, `buildSettlementTx`.
  - **store** — sdk: `createArweaveDvmHandler`, `ChunkManager`, the `NodeConfig` type.
  - **rig** (`packages/rig`, `packages/rig-web`) — core: `core/nip34`.
  - **infra** (`sandbox/`).

  toon-client no longer depends on `@toon-protocol/core`, and the connector is a Rust workspace that never used it. A public export is not load-bearing across the fleet; check the consumers above before treating a change or removal as breaking.

- `@toon-protocol/connector` is an **optional peer dependency** — `sdk` dynamically imports it at runtime; `core` never imports it (talks to it via a structural interface). `toon` builds and runs without it present.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. **All payment-claim validation lives ONLY in the connector — never re-implement it here.**

## Publishing

CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`** — it ships unresolved `workspace:*` and breaks external installs (this is exactly how the old `sdk@0.5.0`/`town@0.4.0` got published broken).

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`toon-protocol/toon`, via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, names unchanged. They also drive the AFK factory: `ready-for-agent` is its queue. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. A root `CONTEXT.md` holds this repo's own terms; it has no ADRs. See `docs/agents/domain.md`.
