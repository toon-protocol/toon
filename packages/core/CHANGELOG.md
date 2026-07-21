# @toon-protocol/core

## 3.1.1

### Patch Changes

- 81ad016: Correct the stale devnet/testnet chain presets to the current public deployment
  (source of truth: toon-meta `docs/deployment.md`, post-2026-07-19 public-chain
  cutover). Consumers that fell back to these presets — when a live announce
  omitted `preferredTokens`/`tokenNetworks` — resolved retired tokens/contracts
  and would settle against dead addresses.
  - **Base Sepolia (`evm:84532`)** `CHAIN_PRESETS['base-sepolia']` carried the
    retired e2e deployment (18-decimal USDC `0xac806…`, old TokenNetwork
    `0x47616F4b…`, registry `0xb9516c…`) → wrong token at wrong decimals. Updated
    to USDC `0x49beE1…` (6-decimal), TokenNetwork `0x1E95493f…`, registry
    `0xcC9079ad…` (rpcUrl `https://sepolia.base.org` unchanged).
  - **Solana devnet** the deployed-devnet profile carried the pre-cutover
    self-hosted-validator mint `9FtYCX…` (mint authority is NOT the faucet
    treasury) and program `EdJxYPD…`. Updated to the live mint
    `xyc5J8Mg…` (authority = faucet treasury `AEPoA5xT…`) and program
    `2aEVJ8k…`.

## 3.1.0

### Minor Changes

- 04ff9fd: extract digest into shared settlement-digest leaf (no behavior change), refs #329

  Phase 1 of connector#329: the v2 EIP-712 balance-proof digest (EVM claim +
  cooperative-close, the Solana/Mina message digests, and the pure EVM signer
  recovery) now lives in a new dependency-light leaf package,
  **`@toon-protocol/settlement-digest`** (`@noble/hashes` + `@noble/curves` only —
  no `ethers`/ABI libs, no dependency on `@toon-protocol/core`). This lets the
  connector's off-chain inbound verifier share the EXACT same digest bytes without
  pulling in core's heavy transitive tree or its optional circular peer-dep.

  `@toon-protocol/core` (`settlement/hashes.ts`) and `@toon-protocol/sdk`
  (`settlement/evm.ts`) adopt-and-re-export the leaf: every existing export
  (`balanceProofHashEvm`, `coopCloseHashEvm`, `eip712DomainSeparatorEvm`,
  `balanceProofHashSolana`, `minaHashToField`, `balanceProofFieldsMina`, the byte
  helpers, and `recoverEvmSignerAddress`) resolves identically. This is a **pure
  refactor** — the golden vectors from `docs/rolling-swap-v2-digest-spec.md` §4
  reproduce byte-for-byte, so no consumer sees a behavior change (minor, additive).

  Note: `@toon-protocol/settlement-digest@1.0.0` is a brand-new package; the
  release flow publishes it via `changeset publish` (which publishes any public
  workspace package whose version is not yet on npm), so it ships at exactly
  1.0.0 without a version-bump entry here.

## 3.0.0

### Major Changes

- d864195: v2 EIP-712 domain-separated balance-proof digest (refs connector#324 finding #1).

  `balanceProofHashEvm` (core) and the sdk settlement builder now emit the EIP-712 v2
  claim digest, folding `chainId` **and** `verifyingContract` into the signed preimage
  via a standard `EIP712Domain(name="RollingSwapChannel", version="2", chainId,
verifyingContract)`. This closes the cross-chain/cross-deployment replay hole where a
  swap-signed claim redeemed on one `(chainId, contract)` pair could be replayed verbatim
  on another sharing the same `channelId`.

  **Breaking (ABI/wire):**
  - `balanceProofHashEvm(...)` gains two REQUIRED inputs — `chainId` + `verifyingContract` —
    and returns the EIP-712 claim digest instead of the v1 raw-keccak digest. `version="2"`
    makes the cutover fail-closed (v1 signatures can never validate as v2 and vice-versa).
  - New `coopCloseHashEvm(...)` (cooperative-close ack digest, distinct `CooperativeClose`
    type hash) and `eip712DomainSeparatorEvm(...)` helper, both exported.
  - sdk `recoverEvmSignerAddress` / `verifyEvmClaimSignature` / `buildSettlementTx` /
    `verifyAccumulatedClaim` thread `chainId` + `verifyingContract` from the validated EVM
    `SwapSignerConfig.chainId` + `.contractAddress`; `coopCloseHashEvm` +
    `eip712DomainSeparatorEvm` re-exported.

  Must ship in lockstep with the swap signer and toon-client legs of the coordinated
  migration.

## 2.1.0

### Minor Changes

- af3e3ef: Plumb per-packet `expiresAt` end-to-end (issue #81, rolling-swap prereq).

  `buildIlpPrepare()` no longer silently drops a caller-supplied `expiresAt`: it is
  now propagated onto the produced PREPARE as an ISO 8601 `expiresAt` string (the
  field the connector's `POST /admin/ilp/send` already accepts). All `IlpClient`
  transports forward it — the HTTP clients include it in the request body and the
  direct client parses it into the `Date` handed to `ConnectorNode.sendPacket()`.
  When omitted, behavior is unchanged (transport-derived / now+30s default).

  `streamSwap()` gains `packetExpiryMs`: when set, each packet is sent with
  `expiresAt = now + packetExpiryMs` (computed at send time) through
  `wrapSwapPacketToToon()` and `StreamSwapClient.sendSwapPacket()`, so a stalled
  packet expires deterministically and releases its in-flight slot. Omitted =
  previous timeout-derived behavior.

### Patch Changes

- fd5c7d4: Add `TOON_GENESIS_PEERS` environment variable override for the bundled genesis peer seed. When set, its JSON array replaces `genesis-peers.json` entirely (set to `[]` to disable bundled peers — e.g. private networks or hermetic tests). `additionalPeersJson` still merges on top.

## 2.0.1

### Patch Changes

- 9ff9751: Refresh the committed genesis peer seed to the live devnet apex identity (pubkey `2813187e…`, `g.proxy`, `wss://proxy.devnet.toonprotocol.dev:443`). The 2.0.0 seed pointed at a rotated/dead box identity (`522e9309…`), so clients bootstrapping from the shipped seed found zero peers. Adds tests that the shipped seed is non-empty, fully schema-valid, and pins the live apex, so a dead or empty seed can no longer ship silently.

## 2.0.0

### Major Changes

- af4cd24: Rename all `mill` vocabulary to `swap` across public API and internals.
  - `MillSignerConfig` → `SwapSignerConfig`
  - `millSignerAddress` → `swapSignerAddress` (on `SettlementClaim`, `SettlementBundle`)
  - `millEphemeralPubkey` → `swapEphemeralPubkey`
  - `millPubkey` / `millIlpAddress` → `swapPubkey` / `swapIlpAddress` (on `StreamSwapParams`)
  - Error codes `MILL_SIGNER_MISMATCH` / `MILL_RECIPIENT_MISMATCH` → `SWAP_SIGNER_MISMATCH` / `SWAP_RECIPIENT_MISMATCH`
  - Scripts renamed: `mill-swap.mjs` → `swap.mjs`, `mill-swap-mina.mjs` → `swap-mina.mjs`

### Minor Changes

- 2a5c243: Seed genesis-peers.json with the devnet apex bootstrap peer.

### Patch Changes

- 35fa7d3: Remove legacy `townhouse` term from code, comments, config, and docs.

## 1.6.0

### Minor Changes

- 816fc80: Add pure ui→kind:31036 coordinate and latest-addressable helpers. New exports: `parseUiCoordinate`, `buildUiCoordinate`, `getUiCoordinate`, `selectLatestAddressable`, the `UI_RENDERER_KIND` and `UI_TAG` constants, and the `UiCoordinate` type. All additive and side-effect free; no existing API changes.

  (Changeset retroactively added for #37, which merged without one.)

## 1.5.0

### Minor Changes

- 97af35e: Advertise ILP-over-HTTP in kind:10032 peer info. `IlpPeerInfo` gains optional `httpEndpoint` (RFC-0035 `POST /ilp` URL) and `supportsUpgrade` (whether the host accepts an HTTP `Upgrade` to BTP); `createNode` config gains matching `httpEndpoint` / `supportsUpgrade` options that are advertised in the node's announcement. Backward compatible — both fields are optional and omitted when unset.

  (Changeset retroactively added for #29, which merged without one.)
