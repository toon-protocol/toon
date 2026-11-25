# toon

The shared **library layer** of the TOON Protocol — an ILP-gated Nostr relay network (pay to write, free to read). This repo publishes `@toon-protocol/core` to npm:

- **`@toon-protocol/core`**: the TOON binary codec (`./toon`), NIP-34 (`./nip34`), `base58Encode` / `base58Decode`, and the kind 5094 blob storage request builder and parser.

These are **libraries only** — no Docker image, no end-user CLI. Today rig and infra consume core from npm; the parked store and swap pin older published versions of `@toon-protocol/core`, `@toon-protocol/sdk` and `@toon-protocol/settlement-digest`, which are no longer published from here.

## How it relates to the connector

`toon` does **not** vendor the [`@toon-protocol/connector`](https://github.com/toon-protocol/connector) (the ILP payment engine that validates claims, takes fees, and routes packets). Nothing here depends on it. All payment-claim validation lives in the connector, never here.

## Develop

```bash
pnpm install
pnpm -r build
pnpm -r test
```

### Getting started with Devbox

[Devbox](https://github.com/jetify-com/devbox) pins the local toolchain to the exact
versions CI uses — Node `22` and pnpm `8.15.9` — so `pnpm build`,
`pnpm test`, and `pnpm lint` run in a reproducible shell without touching your system
packages.

**Prerequisites:** [Install devbox](https://www.jetify.com/devbox/docs/installing_devbox/) (one-liner).

```bash
# Enter the pinned shell (downloads packages on first run via Nix)
devbox shell

# Inside the devbox shell, all tools are on PATH:
node --version    # v22.x
pnpm --version    # 8.15.x

# Run the standard targets (defined as devbox scripts)
devbox run build  # pnpm install --no-frozen-lockfile && pnpm build
devbox run lint
devbox run test
```

`.devbox/` (the Nix symlink/cache dir) is gitignored; `devbox.json` and `devbox.lock`
are committed.

## Release

Publishing is done by CI ([`.github/workflows/release.yml`](.github/workflows/release.yml)) via [changesets](https://github.com/changesets/changesets) + `pnpm` (which rewrites `workspace:*` to real versions at publish time). Add a changeset with `pnpm changeset`; merging the generated "Version Packages" PR publishes to npm using the org `NPM_TOKEN` secret.

> Extracted from the original TOON monorepo with full history preserved.
