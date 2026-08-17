# @toon-protocol/core

## 3.5.0

### Minor Changes

- bf74fac: Make the Solana settlement bundle EXECUTABLE, and refuse the claims that are not
  (toon#214).

  `buildSettlementTx`'s Solana branch emitted a transaction no validator could ever
  run. Every field of it was wrong against the deployed native payment-channel
  program (connector `packages/solana-program`), and nothing caught it because the
  SDK verified its own signature scheme in a closed loop and asserted only
  `unsignedTxBytes.length > 0`:

  |                    | emitted before                                                                                              | what the program requires                                                     |
  | ------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
  | discriminator      | `sha256("global:update_balance")[0..8]` (Anchor)                                                            | `[6,0,0,0,0,0,0,0]` (`instruction.rs:12`)                                     |
  | payload            | `cumulative(8 LE) \|\| nonce(8 LE)`                                                                         | `nonce(8 LE) \|\| transferred_amount(8 LE)`                                   |
  | signature          | inlined into the program's instruction data                                                                 | out of band, in an Ed25519 precompile instruction at index 0                  |
  | signed message     | `sha256(utf8(channelId) \|\| cumulative(32BE) \|\| nonce(32BE) \|\| utf8(recipient))`                       | the RAW 48 bytes `channel_pda \|\| nonce(8 LE) \|\| transferred_amount(8 LE)` |
  | accounts           | `[recipient(signer), swapSigner, channelId, program]`, program also passed as an account of the instruction | `[fee_payer(signer), claimer, channel_pda(w), instructions sysvar]`           |
  | instructions       | 1                                                                                                           | 2 (precompile first)                                                          |
  | data length prefix | threw above 127 bytes                                                                                       | `short_vec`, and the precompile instruction alone is 160 bytes                |

  Changes:
  - **`@toon-protocol/settlement-digest` / `@toon-protocol/core` / `@toon-protocol/sdk`**:
    new `balanceProofMessageSolana(channelPda, nonce, transferredAmount)` — the
    48-byte message the program's Ed25519 precompile check reconstructs, and the
    only Solana balance proof that can be redeemed. `bigintToBytes8LE` and
    `SOLANA_BALANCE_PROOF_MESSAGE_SIZE` are exported alongside it.
  - **`balanceProofHashSolana` is now deprecated** and used by the settlement path
    nowhere. It remains exported (it shipped in core/sdk 3.0.0) with its golden
    vectors intact, documented as not verifiable on chain.
  - **`verifyEd25519Signature`** verifies the program's message. A claim signed
    over the legacy digest is now `SIGNER_MISMATCH` — so `buildSettlementTx`
    refuses to hand back a Solana bundle the chain would reject instead of
    reporting success.
  - **`buildSolanaSettlementTx`** compiles a real two-instruction legacy Message
    (Ed25519 precompile, then `ClaimFromChannel`) with the program's account order
    and privileges, proper `short_vec` lengths, and a duplicate-account guard.
  - **New `patchSolanaRecentBlockhash(messageBytes, blockhash)`** (exported from the
    sdk root): the bundle carries an all-zero blockhash placeholder, and patching it
    is the submitter's one remaining step before signing with the recipient key.

  Proven, not asserted: `packages/sdk/tests/integration/solana-claim-redeem.integration.test.ts`
  boots a `solana-test-validator` with the real program (vendored, hash-asserted)
  and a real channel PDA, redeems a claim through `buildSettlementTx`, and asserts
  the on-chain `nonce_a` / `transferred_amount_a` moved — plus the mirror image: a
  legacy-digest claim is refused by the builder and, if forced, by the chain.

  **Signers must move in lockstep.** Any Solana balance-proof signer — today
  `@toon-protocol/swap`'s `SolanaPaymentChannelSigner` — must sign
  `balanceProofMessageSolana` for its claims to verify here and redeem on chain.

### Patch Changes

- Updated dependencies [bf74fac]
  - @toon-protocol/settlement-digest@1.1.0

## 3.4.0

### Minor Changes

- adb1240: feat(core): add an optional `notice` field to `IlpPeerInfo` (kind:10032)

  `IlpPeerInfo` gains an optional
  `notice?: { id, severity: 'info' | 'action-required', summary, url }` field
  (toon#183), giving operators a delivery channel for status/breaking-change
  notices through the one event every client already fetches at bootstrap.
  `buildIlpPeerInfoEvent` emits it when present and omits it otherwise; the
  parser drops a malformed or partial notice while still parsing the rest of
  `IlpPeerInfo`, and degrades an unrecognized `severity` to `'info'` rather
  than rejecting it.

  This is additive and optional — no behaviour change for a consumer that does
  not use the field.

- 53196fc: fix(core): seal `BootstrapService.announceViaIlp`'s packet and carry a real execution condition

  `BootstrapService.announceViaIlp` sent its announce PREPARE with no
  `executionCondition` and a plaintext base64 TOON payload, which a Rust
  connector refuses outright (`F01 prepare carries no execution condition`;
  toon#143).
  - `@toon-protocol/core` gains a new `./wire` subpath export carrying the
    sealed-wire primitives (`sealExchange`, `readExchangeOutcome`,
    `deriveFulfillment`, `deriveCondition`, the gift-wrap seal/open pair, and
    the OER envelope codec), ported from `@toon-protocol/client`'s
    `src/wire/` together with its committed cross-repo vectors. `core` gains
    `@noble/curves` and `@noble/ciphers` as direct dependencies; it does not
    depend on `@toon-protocol/client`.
  - `IlpClient.sendIlpPacket`/`sendIlpPacketWithClaim` accept an optional
    base64-encoded `executionCondition`, forwarded verbatim by every in-repo
    transport (`direct-ilp-client`, `http-ilp-client`, `ilp-client`,
    `direct-bls-client`).
  - A new `ConnectorEdgeLookup` port (`getIdentity`/`getRoutePrice`) lets a
    caller supply the terminating connector's identity and route price;
    `announceViaIlp` seals its packet to that identity via one `sealExchange`
    call on both the claim and no-claim branches, and asks for the amount
    (ADR 0020) instead of computing it as bytes × rate. Without a
    `connectorEdgeLookup`, the announce phase is skipped rather than sending
    an unsealed packet.
  - `BootstrapServiceConfig.basePricePerByte` is deprecated: it no longer
    prices the announce path by multiplying against the payload's byte
    length; if set, it is used verbatim as an explicit amount override
    instead of asking for the route price.

### Patch Changes

- a898240: fix(core): stop shipping a stale local-validator programId as the `solana-devnet` preset's default

  `SOLANA_CHAIN_PRESETS['solana-devnet']` (and thus `resolveSolanaChainConfig('solana-devnet')`)
  defaulted `programId` to `EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG` — a pre-cutover
  self-hosted-validator id that `network-profile.ts` already documents as retired. Worse, this
  preset's `rpcUrl` is `http://localhost:19899` (a local `solana-test-validator`, per the dev/e2e
  stack), where a deployed program's id is a fresh keypair generated per `cargo build-sbf` build —
  no fixed default can be correct there, and it is a different program than the one deployed on the
  public Solana devnet cluster (see `network-profile.ts`'s `SOLANA_TIER`).

  `programId` now defaults to `''` for `solana-devnet`; callers targeting a local validator must
  supply the id of whatever they deployed via the existing `SOLANA_PROGRAM_ID` env override.

- 7bf8383: fix(core): promote the deployed Solana mainnet program id into the `solana-mainnet` preset

  `SOLANA_CHAIN_PRESETS['solana-mainnet']` (and thus `resolveSolanaChainConfig('solana-mainnet')`)
  shipped `programId: ''`, pending a mainnet deploy of the TOON payment-channel program
  (connector#834). That program is now live on Solana mainnet-beta at
  `8e7BhzydH1EqL486tw6Lp99BXviH3i5JN8qNpMSNmHj3` (deployed slot 439316400, verified against a
  local `cargo build-sbf` build of `connector@main` — see toon#198 / connector#971), so the preset
  now carries it. `tokenMint` (Circle's native USDC) is unchanged.

## 3.3.0

### Minor Changes

- f706e3a: fix(discovery): reseed the genesis peers with both surviving devnet boxes

  toon-meta#310 retires the devnet apex, leaving two independent boxes: the relay
  and the store. The bundled seed had one entry, and all four of its fields
  described the apex — a fresh install would bootstrap against a box that no
  longer exists.

  The seed now carries one entry per surviving node. All values were checked
  against the live kind:10032 announces on
  `wss://relay-ws.devnet.toonprotocol.dev`, but note the relay entry describes
  the fleet as it will be after the cutover, not as it is today:
  - **relay** — pubkey `30fdd01d…`, the apex's announce identity, which the
    relay box adopts (toon-meta#310/#311) so already-deployed clients repair
    themselves against the same author; ILP address `g.toon.relay`; its own BTP
    endpoint `wss://proxy.relay.devnet.toonprotocol.dev/ilp/btp`. **No single
    live announce carries this pairing yet**: pre-cutover `30fdd01d…` still
    announces the apex's `g.toon` / `proxy.devnet…`, while `g.toon.relay` /
    `proxy.relay.devnet…` is announced by the relay box under its own pubkey
    `915d2990…`. The two halves converge into one announce when the relay box
    adopts the identity. The entry is nonetheless correct today, because
    `pubkey` and `relayUrl` are the only load-bearing fields — `ilpAddress`
    and `btpEndpoint` are starting hints, superseded by whatever the live
    announcement carries (proven in `BootstrapService.test.ts`, toon#175).
  - **store** — its own announce pubkey `499cdd71…` (unaffected by the
    cutover); ILP address `g.toon.ario`; its own BTP endpoint
    `wss://proxy.ario.devnet.toonprotocol.dev/ilp/btp`. This entry does match
    the store's live self-announce field for field, before and after.

  `relayUrl` is a required field on every entry and the store fronts no relay,
  so both entries name the relay box's `relay-ws` URL — unchanged through the
  cutover, so this seed is valid both before and after it lands.

  `GenesisPeerLoader.test.ts` gains a shape guard (`peers.length === 2`) plus
  literal pins for both entries, so a future edit that empties the array or
  drops a node fails loudly instead of shipping a dead or partial seed (the
  failure mode toon#56 already had once). `TOON_GENESIS_PEERS` still overrides
  the bundled seed wholesale, unchanged.

## 3.2.1

### Patch Changes

- c8d6dd3: fix: use the bare `evm:<chainId>` settlement identifier on the wire (toon#165)

  Settlement negotiation intersects the two sides' `supportedChains` sets, and the
  live fleet's kind:10032 announce plus the connector's x402 greeting both use the
  bare `evm:<numeric chainId>` form (e.g. `evm:84532`). Two places still emitted an
  extra family segment (`evm:base:84532`), which intersected with nothing and made
  EVM silently drop out of negotiation, falling through to Solana:
  - **core** — `resolveClientNetwork` now emits `evm:<chainId>` for the preset
    client's `supportedChains` / `chainRpcUrls` / `preferredTokens` /
    `tokenNetworks` keys. `BootstrapService` and the discovery tracker log the
    negotiated intersection so an empty one is diagnosable instead of silent.
  - **sdk** — `createNode`'s auto-populated `settlementInfo` (which flows into
    `BootstrapService` and the kind:10032 announce) now uses the same bare form.
    It previously announced `evm:base:<chainId>` while the connector's own
    `chainProviders` entry in the same function already used `evm:<chainId>`.
    The derivation is extracted as `buildDefaultSettlementInfo` and pinned by
    tests across every chain preset.

  No config or wire format change is required of callers that already passed an
  explicit `settlementInfo`; only the auto-populated default changed.

## 3.2.0

### Minor Changes

- dcb55ad: fix(discovery): point the genesis peer seed at the live apex announce

  The committed seed still described the retired TypeScript connector: it pinned that
  connector's nostr key `3f12da6d…`, the old `g.proxy` ILP address, and the root-path
  BTP endpoint `wss://proxy.devnet.toonprotocol.dev:443` that only the TypeScript edge
  ever served. `ToonClient`'s bootstrap queries kind:10032 with
  `authors: [<seed pubkey>]`, so a client got `EOSE, found 0 events` and could not open
  a channel at all — measured live on devnet, 2026-08-05.

  All three facts are refreshed against the live announce on
  `wss://relay-ws.devnet.toonprotocol.dev`, read raw over NIP-01 and validated with
  `parseIlpPeerInfo`:
  - `pubkey` → `30fdd01d…`, the apex announcer's durable identity. Its
    `edgeIdentity.publicKey` matches what `GET /ilp/identity` reports on the apex box,
    so this announce really does describe that connector.
  - `ilpAddress` → `g.toon`
  - `btpEndpoint` → `wss://proxy.devnet.toonprotocol.dev/ilp/btp`, the Rust edge's path.

  The endpoint change matters on its own: a seed that names the root path sends a client
  to an address where the Rust connector answers 400, which reads exactly like the box
  being down.

## 3.1.4

### Patch Changes

- f3ae203: Point the bundled devnet genesis peer at the apex's rotated announce identity.

  The devnet apex node's Nostr identity was rotated, so the pubkey baked into
  `genesis-peers.json` no longer matched the live kind:10032 self-announce.
  Clients bootstrapping from the bundled seed would trust a pubkey the apex no
  longer signs with. Updated to `3f12da6d…`.

## 3.1.3

### Patch Changes

- 8f5fe09: Add missing `engines.node` field to packages/core/package.json to match packages/sdk, and remove the stale `packages/rig` entry from tsconfig.json's exclude array.

## 3.1.2

### Patch Changes

- 02c0a27: Correct the devnet Mina settlement preset and the Base Sepolia RPC.
  - `CHAIN_PRESETS['base-sepolia'].rpcUrl`: `https://sepolia.base.org` →
    `https://base-sepolia-rpc.publicnode.com`. The old load balancer serves stale
    reads, so `openChannel`→`setTotalDeposit` fails with `InvalidChannelState`
    (0xf806e9d9); publicnode is the working devnet/testnet default.
  - `MINA_DEPLOYED_DEVNET`: update the zkApp to the current deployed
    PaymentChannel (`B62qmgPhv2Xo…`, retiring `B62qrH1As4…`) and add the
    settlement `tokenId` (`9497…`). The channels are denominated in a custom USDC
    token, so the tokenId is required to read the token balance and open channels
    against the right token. It now flows through `MinaTierCfg`,
    `resolveClientNetwork().minaChannel.tokenId`, and the node's Mina
    `chainProviders` entry.

  Source of truth: toon-meta `docs/deployment.md`. This makes the baked preset the
  drift-proof fallback a fresh client resolves before any connector redeploy; the
  kind:10032 announce still overrides these fields when present.

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
