# @toon-protocol/sdk

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

### Patch Changes

- Updated dependencies [04ff9fd]
  - @toon-protocol/core@3.1.0

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

### Patch Changes

- Updated dependencies [d864195]
  - @toon-protocol/core@3.0.0

## 2.2.0

### Minor Changes

- 5bc0e48: rfc-0039 stream receipts (issue #84, rolling-swap spec §7.2): per-fulfill signed proof of delivered-B.

  Maker side (`createSwapHandler`): when the sender advertises a session via the rumor's new `stream-nonce` tag, every ACCEPT's metadata gains an additive `receipt` object — `{v, streamNonce, seq, cumulativeDelivered, rate, rateTimestamp, sig}` — BIP-340-signed over a canonical length-prefixed encoding with the maker identity key by default (new `receiptSecretKey` config to provision a dedicated signer; new `receiptSessions` store seam for persistence alongside claims). Rejected packets never advance the session. Legacy senders (no tag) get the pre-existing metadata shape verbatim.

  Sender side (`streamSwap`): a per-stream 16-byte `streamNonce` is generated and sent on every rumor; each fulfilled packet's receipt is verified (signature vs `receiptPubkey` ?? `swapPubkey`, session match, monotone cumulative totals, duplicate-seq/fork detection, tape-consistency) BEFORE its claim accumulates. Verified receipts surface on `AccumulatedClaim.receipt`, `PacketProgress.receipt`, and the always-present `StreamSwapResult.receipts` chain (`{streamNonce, receipts, latest, totalDelivered, holes}` — present on abort too, covering what filled). A present-but-invalid receipt is a loud `RECEIPT_INVALID` rejection that halts the stream (`abortReason: 'receipt-invalid'`); receipt-less legacy makers degrade gracefully unless the new `requireReceipts` param is set (`RECEIPT_MISSING` + halt). `serializeReceiptChain()` exports the chain as a versioned, third-party re-verifiable audit/dispute artifact.

  New module `stream-receipts.ts` exported from the root and `/swap` entry points: `signStreamReceipt`, `verifyStreamReceipt`, `parseStreamReceipt`, `encodeReceiptSigningPayload`, `serializeReceiptChain`, `isValidStreamNonce`, `issueSessionReceipt`, `ReceiptChainTracker`, `BoundedReceiptSessions`, plus types.

## 2.1.0

### Minor Changes

- 34d7d16: Adaptive δ/W controller for rolling swaps (issue #83, rolling-swap spec §6),
  persisted per (chain, maker, pair).

  New module `adaptive-controller`:
  - `AdaptiveDeltaController` (built via async `AdaptiveDeltaController.create`)
    manages the two rolling-swap knobs from measured, untrusted inputs: δ
    (packet size, bounds per-packet pick-off risk) and W (in-flight window,
    bounds timing risk and the worst-case exposure δ·W).
  - The cap: `delta_cap = ε/(v·τ)` recomputed per packet — `v` is an EWMA of
    `abs(ΔR)/R` per second read off the issue-#82 quote tape, `τ` an EWMA of
    observed RTTs, and ε is denominated as a fraction of the maker's advertised
    half-spread (default `0.5 × halfSpread`), never an absolute rate. An
    absolute `maxPacketAmount` (maker maxAmount) cap binds independently.
  - Asymmetric, one-knob-per-step ramp: multiplicative shrink on stale-rate
    rejects / other rejects / realized slip > ε (`δ ← max(δ_min, δ/2)`) and on
    timeouts (`W ← max(1, ⌈W/2⌉)`); additive widen after K = 16 consecutive
    clean fulfills (`δ ← δ + δ_0` or `W ← W + 1`, alternating). Cold start is
    small on both knobs (`δ_0 = min(delta_cap, notional/256, maxAmount)`,
    `W_0 = 1`) with a multiplicative slow-start until the first-ever loss.
  - State (`{delta, W, vEwma, tauEwma, cleanStreak, everShrunk, lastWidened,
updatedAt}`) persists per `${chain}:${makerPubkey}:${from}:${to}` through a
    pluggable `SwapControllerStateStore` (SDK stays isomorphic):
    `InMemorySwapControllerStateStore` (default) or the Node-only
    `JsonFileSwapControllerStateStore` (atomic JSON-file map, the
    `ChannelStore` pattern), so ramp/trust survives across swaps.

  `streamSwap` / `streamSwapControlled` wiring: new `controller` param
  (exactly one of `packetCount`, `packetAmounts`, or `controller`). In
  controller mode the static even split is replaced by per-packet
  `controller.nextDelta(remaining)` sizing, up to `controller.window` packets
  are kept in flight concurrently, and every packet resolution feeds back a
  `PacketObservation` (resolution class, RTT, tape entry, realized amounts).
  The `minExchangeRate` floor is enforced in shared code BEFORE the controller
  observes anything — controller state can only tighten/loosen δ and W and can
  never relax the floor. Legacy paths (no `controller`) are unchanged.

- 7fd7fe3: Quote-tape plumbing + `minExchangeRate` hard floor in `streamSwap` (issue #82, rolling-swap spec §5/§7.1).

  Maker side (`createSwapHandler`): every FULFILL accept-metadata now carries the
  resolved per-packet rate `R_i` (`rate`, decimal string) and its quote timestamp
  (`rateTimestamp`, unix ms) — the quote tape. `rateProvider` may now return
  either the legacy decimal string (timestamp stamped at resolution) or a
  `RateQuote` `{ rate, rateTimestamp }` so the rate source's own tick time
  travels on the tape. Additive and backward compatible.

  Sender side (`streamSwap` / `streamSwapControlled`):
  - `decodeFulfillMetadata` parses the tape; a present-but-malformed or partial
    tape entry is a loud per-packet `FULFILL_DECODE_FAILED`, never a silent drop.
  - New `minExchangeRate` param (rfc-0029 semantics): a hard, per-packet,
    pre-accept floor. When set, the tape becomes required, and a packet whose
    tape rate is below the floor OR whose delivered `targetAmount` is below
    `applyRate(sourceAmount, minExchangeRate)` is recorded as a `BELOW_FLOOR`
    rejection (never accumulated into `claims[]`) and the stream halts with
    `abortReason: 'below-floor'`. The floor is independent of — and never
    relaxed by — the soft `rateDeviationThreshold` monitor or any
    callback/controller signal.
  - `PacketProgress` and `AccumulatedClaim` gain optional `rate`/`rateTimestamp`
    fields so `onPacket` consumers (the adaptive controller) can read the tape
    per fulfilled packet, in order.

  When the new params are omitted and the maker emits no tape, behavior is
  unchanged.

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

- Updated dependencies [fd5c7d4]
- Updated dependencies [af3e3ef]
  - @toon-protocol/core@2.1.0

## 2.0.1

### Patch Changes

- Updated dependencies [9ff9751]
  - @toon-protocol/core@2.0.1

## 2.0.0

### Major Changes

- af4cd24: Rename all `mill` vocabulary to `swap` across public API and internals.
  - `MillSignerConfig` → `SwapSignerConfig`
  - `millSignerAddress` → `swapSignerAddress` (on `SettlementClaim`, `SettlementBundle`)
  - `millEphemeralPubkey` → `swapEphemeralPubkey`
  - `millPubkey` / `millIlpAddress` → `swapPubkey` / `swapIlpAddress` (on `StreamSwapParams`)
  - Error codes `MILL_SIGNER_MISMATCH` / `MILL_RECIPIENT_MISMATCH` → `SWAP_SIGNER_MISMATCH` / `SWAP_RECIPIENT_MISMATCH`
  - Scripts renamed: `mill-swap.mjs` → `swap.mjs`, `mill-swap-mina.mjs` → `swap-mina.mjs`

- cccae07: Rename DvmHealthResponse → StoreHealthResponse (and related types) to align with the dvm→store vocabulary cleanup (#45).

### Patch Changes

- 35fa7d3: Remove legacy `townhouse` term from code, comments, config, and docs.
- Updated dependencies [35fa7d3]
- Updated dependencies [af4cd24]
- Updated dependencies [2a5c243]
  - @toon-protocol/core@2.0.0

## 1.0.1

### Patch Changes

- Updated dependencies [816fc80]
  - @toon-protocol/core@1.6.0

## 1.0.0

### Major Changes

- 1b993f6: Drop Node 20 support: bump `engines.node` from `>=20` to `>=22` to match the CI test matrix (both `ci.yml` and `release.yml` now only run on Node 22). Consumers pinned to Node 20 are no longer covered by CI and should upgrade.

## 0.6.0

### Minor Changes

- 97af35e: Advertise ILP-over-HTTP in kind:10032 peer info. `IlpPeerInfo` gains optional `httpEndpoint` (RFC-0035 `POST /ilp` URL) and `supportsUpgrade` (whether the host accepts an HTTP `Upgrade` to BTP); `createNode` config gains matching `httpEndpoint` / `supportsUpgrade` options that are advertised in the node's announcement. Backward compatible — both fields are optional and omitted when unset.

  (Changeset retroactively added for #29, which merged without one.)

### Patch Changes

- 68a4e86: Re-publish `@toon-protocol/sdk` from the standalone `toon` repository. This repairs the unresolved `workspace:*` dependency on `@toon-protocol/core` that made `@toon-protocol/sdk@0.5.0` uninstallable for external consumers — changesets/pnpm rewrite the workspace protocol to the real version (`@toon-protocol/core@1.4.1`) at publish time.
- Updated dependencies [97af35e]
  - @toon-protocol/core@1.5.0
