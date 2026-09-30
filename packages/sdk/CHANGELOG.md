# @toon-protocol/sdk

## 4.0.0

### Major Changes

- bccc7ca: Withdraw `createSwapHandler` and `streamSwap` / `streamSwapControlled` — the maker- and
  sender-side implementations of the legacy claim-in-FULFILL swap protocol (toon#211, ADR 0003
  stage 7).

  TOON supports the **rolling** swap protocol only, per
  [ADR 0003](https://github.com/toon-protocol/toon-meta/blob/main/docs/adr/0003-the-rolling-swap-is-the-only-swap.md).
  Legacy — the all-zero-condition, kind:20032 gift-wrap protocol where the maker returns a signed
  balance proof inside the FULFILL `data` — is now removed from every repo in the fleet. Nothing in
  the organization imports these symbols any more: the rolling maker stopped wiring
  `createSwapHandler` (toon-protocol/swap#154), `@toon-protocol/swap` stopped re-exporting it
  (toon-protocol/swap#155), and the client stopped sending legacy packets
  (toon-protocol/toon-client#598).

  **Removed** (no deprecation shim — see ADR 0003's rejected options):
  - `createSwapHandler`, `findSwapPair`, `SWAP_HANDLER_REJECT_CODES`, `SWAP_HANDLER_REJECT_MESSAGES`
    and their types (`CreateSwapHandlerConfig`, `ClaimIssuer`, `SwapHandlerLogger`, `RateQuote`,
    `SwapHandlerFailure`, `SwapHandlerFailureContext`, `SwapHandlerFailureMapper`,
    `SwapHandlerFailureStage`, `SwapHandlerRejection`, `SwapHandlerRejectResponse`).
  - `streamSwap`, `streamSwapControlled`, `StreamSwapError` and their types (`StreamSwapParams`,
    `StreamSwapResult`, `StreamSwapClient`, `StreamSwapController`, `PacketProgress`,
    `RateMonitorCallback`).
  - The internal `__streamSwapTesting` testing surface.
  - The `packages/sdk/scripts/` legacy one-shot demo scripts (`swap.mjs`, `swap-mina.mjs`).
    These were repo-local exercise scripts and were never part of the published package.

  **Unchanged** — still exported from `@toon-protocol/sdk` (and `@toon-protocol/sdk/swap` where
  applicable), because settlement and the rolling swap engine depend on them regardless of protocol:
  `applyRate` / `ApplyRateParams`, `SwapHandlerError`, `AccumulatedClaim`, `IssueClaimParams` /
  `IssueClaimResult`, `wrapSwapPacketToToon`, `unwrapSwapPacket`, `buildSettlementTx`,
  `verifyAccumulatedClaim`, the adaptive δ/W controller, and the rfc-0039 stream-receipt primitives.

  **Migration:** a maker is now run with `startSwapNode` from `@toon-protocol/swap`. There is no
  drop-in replacement for `streamSwap()` inside `@toon-protocol/sdk` — sending a rolling swap goes
  through `@toon-protocol/swap`'s / `@toon-protocol/client`'s rolling RFQ client. `@toon-protocol/sdk`
  is public and a legacy maker or sender built on these symbols may exist outside the fleet; this
  note is the entire mitigation, since third-party integrations cannot be observed or migrated
  directly.

## 3.3.0

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

- 313cf8c: Relocate the swap symbols the **rolling** path shares out of the **legacy** swap
  files (toon#210, ADR 0003 stage 3).

  **Nothing is withdrawn, added, renamed or re-typed.** This is a source-only move
  so that ADR 0003's stage 7 — deleting `swap-handler.ts` and `stream-swap.ts`
  with `createSwapHandler` — is a mechanical deletion instead of one that silently
  breaks the rolling engine.

  Moved (same exported names, same barrels, same types):
  - `applyRate` / `ApplyRateParams` → `apply-rate.ts` (was `swap-handler.ts`).
    Rolling importers: the SDK's own `adaptive-controller.ts` and
    `@toon-protocol/swap`'s `rolling-engine.ts`.
  - `IssueClaimParams` / `IssueClaimResult` → `claim-issuance.ts` (was
    `swap-handler.ts`). `@toon-protocol/swap`'s rolling `IssueRollingClaimParams`
    / `RollingIssueClaimResult` extend them.
  - `AccumulatedClaim` → `settlement/accumulated-claim.ts` (was `stream-swap.ts`).
    It is a settlement type — `buildSettlementTx` / `verifyAccumulatedClaim` and
    `@toon-protocol/client`'s rolling reveal/settle paths all consume it.

  The published surface is unchanged: the runtime export sets of both
  `@toon-protocol/sdk` and `@toon-protocol/sdk/swap` are byte-identical to the
  previous release (79 and 14 names), the emitted `.d.ts` declarations are
  structurally identical, and the frozen public-API guard at
  `packages/sdk/src/index.test.ts` is untouched. `@toon-protocol/swap` and
  `@toon-protocol/client` build, typecheck and pass their suites against this
  version with zero source changes.

  Shipped as a **minor** rather than a patch because it is the versioned,
  revertible checkpoint stage 7's major depends on — not because any consumer can
  observe a difference.

### Patch Changes

- Updated dependencies [bf74fac]
  - @toon-protocol/settlement-digest@1.1.0
  - @toon-protocol/core@3.5.0

## 3.2.0

### Minor Changes

- 0c5b6b4: fix(sdk): stop swallowing swap-handler failures — surface the error and let the caller classify the reject

  `createSwapHandler` recognised exactly one failure condition
  (`INSUFFICIENT_INVENTORY` → `T04 Insufficient liquidity`) and collapsed
  everything else into `logger.error({ event: 'swap_handler.issuer_failed' })` +
  `ctx.reject('T00', 'Internal error')`. The thrown value never left the
  handler: only its `message` reached the (by default no-op) logger, and nothing
  at all reached the caller. Live on devnet the maker refused every swap with a
  bare `T00 Internal error` while the throw site had a perfectly actionable
  `0x0124a370…: 1000 unredeemed` — a multi-hour diagnosis for a mundane cause.
  `swap_handler.encrypt_failed` was worse: a second, indistinguishable
  `T00 Internal error`, which the downstream consumer (swap#137) could only
  _infer_ by observing that a blanket T00 had arrived after a claim was
  successfully issued.
  - New optional `CreateSwapHandlerConfig.onFailure` hook. Before rejecting
    because something threw — `rateProvider`, `applyRate`, `claimIssuer.issueClaim`,
    or `encryptFulfillClaim` — the handler calls it with a `SwapHandlerFailure`
    carrying the thrown value VERBATIM (`code`, `details`, `cause`, stack all
    intact), the extracted `message`, packet context (`pair`, `senderPubkey`,
    `chainRecipient`, `sourceAmount`, `rate`, `targetAmount`, `claimIssued`,
    `claimId`), and the `defaultRejection` it would otherwise emit. Returning a
    `SwapHandlerRejection` replaces the reject's `code`/`message` and may attach
    `data`, `rejectReason`, and `metadata`; returning `undefined` keeps the
    default. The hook cannot break the handler — a throw or a malformed return
    logs (`swap_handler.on_failure_threw` /
    `swap_handler.on_failure_invalid_rejection`) and falls back to the default.
  - The `encrypt` stage no longer ends the error's life. It reports
    `claimIssued: true` (value committed, claim stranded), so a consumer can
    classify it outright instead of inferring it.
  - Every refusal log line now also carries `err` (the thrown value itself, for
    a pino-style serializer), `code` when present, `stage`, and the
    `rejectCode`/`rejectMessage` actually going on the wire. The pre-existing
    `event` names and the `error` (message) field are unchanged.
  - New exported types: `SwapHandlerFailure`, `SwapHandlerFailureContext`,
    `SwapHandlerFailureMapper`, `SwapHandlerFailureStage`,
    `SwapHandlerRejection`, `SwapHandlerRejectResponse`.

  Backward compatible: with no `onFailure`, every code and message on every path
  is byte-identical to before, `INSUFFICIENT_INVENTORY` included.

## 3.1.8

### Patch Changes

- 1c051a6: fix(sdk): accept EIP-55 checksummed EVM `chain-recipient` addresses in `createSwapHandler`

  `validateChainRecipient`'s local `SWAP_HANDLER_EVM_ADDRESS_REGEX` duplicate (in `swap-handler.ts`)
  tested EVM addresses against a lowercase-only regex, where released clients send EIP-55
  checksummed (mixed-case) addresses. Every stock-client swap packet was rejected as a malformed
  rumor (`T00 Internal error`), even though the sender-side validator (`validateChainAddress` in
  `stream-swap.ts`, fixed under #153) already accepts the same checksummed input.

  `validateChainRecipient` now lowercase-normalizes an EVM value before testing it, matching
  `validateChainAddress`'s existing behavior. `findChainRecipient` returns the lowercased value for
  `evm:*` chains, so downstream consumers (e.g. `IssueClaimParams.chainRecipient`) get a single
  normalized casing regardless of which casing the sender used.

  `createSwapHandler` also now rejects a missing or malformed `chain-recipient` with `F01` and a
  message naming the field and the expected shape per chain (e.g. `missing or malformed
chain-recipient for evm:base:8453 — expected 0x + 40 hex chars`), instead of the opaque
  `T00 Internal error` it emitted before. This is a permanent sender-side error, not a transient
  one, so a specific reject reason lets the sender self-diagnose and correct the address instead of
  retrying blind — per #200's second ask and the PR #201 review resolution. **Supersedes Story
  12.9 AC-14a/AC-14b's original T00 pin** (`packages/sdk/src/swap-handler.test.ts` tests
  T-5 (AC-14a) and T-6a/T-6b/T-6c (AC-14b) now assert F01).

- Updated dependencies [a898240]
- Updated dependencies [7bf8383]
- Updated dependencies [adb1240]
- Updated dependencies [53196fc]
  - @toon-protocol/core@3.4.0

## 3.1.7

### Patch Changes

- Updated dependencies [f706e3a]
  - @toon-protocol/core@3.3.0

## 3.1.6

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

- Updated dependencies [c8d6dd3]
  - @toon-protocol/core@3.2.1

## 3.1.5

### Patch Changes

- Updated dependencies [dcb55ad]
  - @toon-protocol/core@3.2.0

## 3.1.4

### Patch Changes

- Updated dependencies [f3ae203]
  - @toon-protocol/core@3.1.4

## 3.1.3

### Patch Changes

- Updated dependencies [8f5fe09]
  - @toon-protocol/core@3.1.3

## 3.1.2

### Patch Changes

- Updated dependencies [02c0a27]
  - @toon-protocol/core@3.1.2

## 3.1.1

### Patch Changes

- Updated dependencies [81ad016]
  - @toon-protocol/core@3.1.1

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
