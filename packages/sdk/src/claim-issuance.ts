/**
 * Maker-side claim-issuance parameter and result shapes.
 *
 * **Path-agnostic.** These two types were introduced with the legacy
 * claim-in-FULFILL handler (Story 12.3) and physically lived in
 * `swap-handler.ts`, but they describe *leg-B claim issuance*, which is
 * common to both swap protocols. `@toon-protocol/swap`'s
 * `MultiChainClaimIssuer` — the leg-B claim signer that ADR 0003 keeps —
 * builds its **rolling** surface directly on top of them:
 *
 * ```ts
 * // swap/packages/swap/src/claim-issuer.ts
 * export interface IssueRollingClaimParams extends IssueClaimParams { … }
 * export interface RollingIssueClaimResult extends IssueClaimResult { … }
 * ```
 *
 * and `rolling-engine.ts` calls `issueRollingClaim()` with them on every
 * coupled fill.
 *
 * They were relocated here by toon#210 (ADR 0003 stage 3) so that withdrawing
 * the legacy handler in stage 7 is a mechanical deletion of `swap-handler.ts`.
 * The move is source-only: both types are still exported from
 * `@toon-protocol/sdk` under exactly the same names.
 *
 * The `ClaimIssuer` interface itself is deliberately **not** here — its whole
 * contract is the legacy `issueClaim()` call, and it goes with the handler.
 *
 * @module
 */

import type { UnsignedEvent } from 'nostr-tools/pure';
import type { SwapPair } from '@toon-protocol/core';

/** Parameters passed to a `ClaimIssuer.issueClaim` call. */
export interface IssueClaimParams {
  /** Source-asset amount received by the Swap (ILP packet amount, source micro-units). */
  sourceAmount: bigint;
  /** Target-asset amount owed to the sender (post-rate-conversion, target micro-units). */
  targetAmount: bigint;
  /** The `SwapPair` this packet is being priced against. */
  pair: SwapPair;
  /**
   * The sender's real Nostr pubkey (extracted from the unwrapped seal).
   *
   * Identity-layer key only: used by the Swap for inventory ledger keying and
   * the sender→channel sticky binding (`channelState.reserve()` /
   * `channelState.release()`). The Swap MUST NOT pass this to chain-layer
   * signers as the balance-proof `recipient` — use {@link chainRecipient}
   * for that (Story 12.9 D12-011).
   */
  senderPubkey: string;
  /**
   * The sender's chain-specific payout address for `pair.to.chain`
   * (Story 12.9 AC-10). Extracted and format-validated from the rumor's
   * `chain-recipient` tag by the swap handler. REQUIRED. This is the
   * address the Swap's `PaymentChannelSigner` MUST use as the balance-proof
   * `recipient` (e.g., 20-byte EVM address, 32-byte Solana Ed25519 pubkey).
   */
  chainRecipient: string;
  /** The inner rumor (for optional Swap-side context; may be ignored by the issuer). */
  rumor: UnsignedEvent;
}

/**
 * Result returned from `ClaimIssuer.issueClaim`.
 *
 * Story 12.6 extension: additive settlement-context fields let the sender
 * reconstruct the balance-proof message hash for signature verification and
 * on-chain settlement (see `buildSettlementTx()`).
 */
export interface IssueClaimResult {
  /** Signed claim bytes ready for NIP-44 encryption (chain-specific format). */
  claim: Uint8Array;
  /** Optional Swap-side claim ID for logging/tracing. */
  claimId?: string;
  // --- Story 12.6 settlement-context fields (additive, all optional for
  // one-story-cycle backward compat; the Swap SHOULD emit all of them) ---
  /** Channel identifier on the target chain. */
  channelId?: string;
  /** Balance-proof nonce (monotonically increasing per channel). */
  nonce?: bigint;
  /** Cumulative transferred amount on the channel (target micro-units). */
  cumulativeAmount?: bigint;
  /** Recipient address (the sender's target-asset address). */
  recipient?: string;
  /** Swap's on-chain signer address. */
  swapSignerAddress?: string;
}
