/**
 * `AccumulatedClaim` — one harvested, verified leg-B claim.
 *
 * **Path-agnostic.** This is a *settlement* type: it is the input shape of
 * `buildSettlementTx()` / `verifyAccumulatedClaim()`, both of which survive
 * ADR 0003's removal of the legacy swap path. It happened to be declared in
 * `stream-swap.ts` (the legacy `streamSwap` sender) only because that sender
 * was the first producer of one; `@toon-protocol/client`'s rolling reveal /
 * received-claim / settle paths all consume it too.
 *
 * Relocated here by toon#210 (ADR 0003 stage 3) so that deleting
 * `stream-swap.ts` in toon#211 (ADR 0003 stage 7) did not take the settlement
 * surface with it. The move is source-only: `AccumulatedClaim` is still
 * exported from both `@toon-protocol/sdk` and `@toon-protocol/sdk/swap` under
 * the same name.
 *
 * @module
 */

import type { SwapPair } from '@toon-protocol/core';

import type { StreamReceipt } from '../stream-receipts.js';

/**
 * An accumulated claim successfully harvested from a single packet.
 *
 * @stable — Story 12.6 (`buildSettlementTx()`) depends on this shape.
 * Breaking changes require a coordinated migration.
 *
 * Story 12.6 ADDITIVE extension: the settlement-context fields
 * `channelId`, `nonce`, `cumulativeAmount`, `recipient`, and
 * `swapSignerAddress` are marked optional (`?:`) for one story-cycle of
 * backward compat but are REQUIRED in practice: Story 12.6's
 * `buildSettlementTx()` throws `MISSING_SETTLEMENT_METADATA` when any of
 * these are absent.
 */
export interface AccumulatedClaim {
  /** 0-indexed position in the swap's packet stream. */
  packetIndex: number;
  /** Source-asset amount sent for this packet (micro-units). */
  sourceAmount: bigint;
  /**
   * Target-asset amount claimed (micro-units).
   *
   * **Source of truth caveat:** This is the expected target amount computed
   * by `applyRate(pair.rate)`. The actual signed-claim amount lives inside
   * `claimBytes`; Story 12.6 is responsible for parsing `claimBytes` per
   * chain and verifying the on-wire signed amount equals this expected amount.
   */
  targetAmount: bigint;
  /** Decrypted signed claim bytes. Chain-specific encoding per Story 12.4. */
  claimBytes: Uint8Array;
  /** Swap's ephemeral pubkey from the FULFILL (64-char lowercase hex). */
  swapEphemeralPubkey: string;
  /** Optional Swap-side claim ID (passed through from handler metadata). */
  claimId?: string;
  /** Swap pair this claim was priced against (copy of `pair` for settlement-time routing). */
  pair: SwapPair;
  /** Unix ms timestamp when this claim was accepted. */
  receivedAt: number;
  // --- Story 12.6 settlement-context fields (additive) ---
  /** Channel identifier on the target chain (lowercase hex with 0x prefix for EVM; base58 for Solana). */
  channelId?: string;
  /** Balance-proof nonce (decimal string). Monotonically increasing within a channel. */
  nonce?: string;
  /** Cumulative transferred amount on the channel (target micro-units, decimal string). */
  cumulativeAmount?: string;
  /** Recipient address (the sender's target-asset address). */
  recipient?: string;
  /** Swap's on-chain signer address. */
  swapSignerAddress?: string;
  // --- Issue #82 quote-tape fields (additive) ---
  /** Maker's fresh rate `R_i` applied to this packet (decimal string), from the FULFILL quote tape. */
  rate?: string;
  /** Unix ms timestamp when the maker's rate source produced `rate`. Present iff `rate` is. */
  rateTimestamp?: number;
  // --- Issue #84 stream-receipt field (additive) ---
  /**
   * The VERIFIED signed receipt that rode on this packet's FULFILL
   * (issue #84, rolling-swap spec §7.2) — receipts persist wherever the
   * claim does. Present iff the maker emitted receipts for this session.
   */
  receipt?: StreamReceipt;
}
