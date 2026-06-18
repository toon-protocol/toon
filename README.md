# toon

The shared **library layer** of the TOON Protocol — an ILP-gated Nostr relay network (pay to write, free to read). This repo publishes two npm packages that every TOON node and client builds on:

- **`@toon-protocol/core`** — protocol primitives: the TOON binary codec, Nostr peer discovery (kind:10032), bootstrap, ILP address derivation, settlement chain config, and the structural `ConnectorNode` interface (`EmbeddableConnectorLike`).
- **`@toon-protocol/sdk`** — the framework for building an ILP-gated Nostr service: `createNode()` (verify → price → dispatch), the handler registry, the Arweave DVM handler, swap modules, and the multi-chain settlement engines.

These are **libraries only** — no Docker image, no end-user CLI. The node products (`relay`, `swap`, `store`), the operator product (`hub`), and the `client` consume them from npm.

## How it relates to the connector

`toon` does **not** vendor the [`@toon-protocol/connector`](https://github.com/ALLiDoizCode/connector) (the ILP payment engine that validates claims, takes fees, and routes packets). `core` talks to it only through a structural interface; `sdk` loads it via an optional, dynamic import. The connector is an **optional peer dependency** — `toon` builds and runs without it present, and all payment-claim validation lives in the connector, never here.

## Develop

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## Getting started with Devbox

[Devbox](https://www.jetify.com/devbox) pins the exact Node.js and pnpm versions used by this repo and CI, giving every contributor an identical toolchain without installing anything globally.

1. [Install Devbox](https://www.jetify.com/devbox/docs/installing_devbox/)
2. Start a shell with the pinned toolchain:
   ```bash
   devbox shell
   ```
3. Inside the shell the normal dev commands work as-is:
   ```bash
   pnpm install
   pnpm -r build
   pnpm -r test
   ```

Devbox reads `devbox.json` and installs Node.js 22 via Nix; pnpm is activated automatically through Corepack using the `packageManager` field in `package.json`.

## Release

Publishing is done by CI ([`.github/workflows/release.yml`](.github/workflows/release.yml)) via [changesets](https://github.com/changesets/changesets) + `pnpm` (which rewrites `workspace:*` to real versions at publish time). Add a changeset with `pnpm changeset`; merging the generated "Version Packages" PR publishes to npm using the org `NPM_TOKEN` secret.

> Extracted from the original TOON monorepo with full history preserved.
