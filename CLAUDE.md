# toon

The shared **library layer** of the TOON Protocol: `@toon-protocol/core` (protocol primitives — TOON codec, Nostr peer discovery, ILP address derivation, settlement config, the structural `EmbeddableConnectorLike` interface) and `@toon-protocol/sdk` (the `createNode` framework, handler registry, Arweave DVM handler, swap + multi-chain settlement engines). **Libraries only — no Docker image, no end-user CLI.**

TOON Protocol = pay-to-write Nostr over Interledger (ILP), split into per-team repos. Reads are free; a write is an ILP packet carrying a TOON-encoded Nostr event + a signed payment-channel claim, validated by the connector.

## Build & test
```
pnpm install
pnpm -r build
pnpm -r test
```

## Shared skills, docs & project context → toon-protocol/toon-meta
Cross-cutting agent skills, docs, and the canonical project context live in **[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**, not here. Load the shared skills:
```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```
Canonical rules/decisions: `toon-meta` → `_bmad-output/project-context.md`.

## Cross-repo dependencies
- This repo **publishes** `@toon-protocol/{core,sdk}` to npm; every other TOON repo consumes them at pinned semver.
- `@toon-protocol/connector` is an **optional peer dependency** — `sdk` dynamically imports it at runtime; `core` never imports it (talks to it via a structural interface). `toon` builds and runs without it present.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. **All payment-claim validation lives ONLY in the connector — never re-implement it here.**

## Publishing
CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`** — it ships unresolved `workspace:*` and breaks external installs (this is exactly how the old `sdk@0.5.0`/`town@0.4.0` got published broken).
