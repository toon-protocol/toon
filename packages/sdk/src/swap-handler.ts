/**
 * Swap Handler (Story 12.3)
 *
 * `createSwapHandler()` factory produces a kind:1059 `Handler` that:
 *   1. Unwraps an incoming NIP-59 gift-wrapped ILP swap packet (via Story 12.2).
 *   2. Identifies the requested `SwapPair` from inner-rumor `swap-from` / `swap-to` tags.
 *   3. Applies a per-packet exchange rate (pair.rate or live rateProvider hook).
 *   4. Delegates signed claim issuance to a pluggable `ClaimIssuer` (Story 12.4).
 *   5. NIP-44 encrypts the claim with an ephemeral key (Story 12.2) for return.
 *
 * The handler is a pure application-layer composition — no connector, routing,
 * or wallet code lives here. See `_bmad-output/epics/epic-12-token-swap-primitive.md`
 * for D12-001/D12-008/D12-009/D12-010 and the scope fence.
 *
 * Transport encoding: the `accept()` metadata emits `claim` as a base64-encoded
 * NIP-44 ciphertext, `ephemeralPubkey` as 64-char lowercase hex, and optional
 * `claimId`. The sender-side `streamSwap()` (Story 12.5) base64-decodes `claim`
 * before calling `decryptFulfillClaim`.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import type { UnsignedEvent } from 'nostr-tools/pure';
import type { SwapPair } from '@toon-protocol/core';

import { GiftWrapError, SwapHandlerError } from './errors.js';
import { unwrapSwapPacketFromToon, encryptFulfillClaim } from './gift-wrap.js';
import type { HandlePacketRejectResponse } from './handler-context.js';
import type { Handler } from './handler-registry.js';
import { base58Decode } from './identity.js';
import {
  BoundedReceiptSessions,
  isValidStreamNonce,
  issueSessionReceipt,
  type ReceiptSessionStoreLike,
  type StreamReceipt,
} from './stream-receipts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters passed to a {@link ClaimIssuer.issueClaim} call. */
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
 * Result returned from {@link ClaimIssuer.issueClaim}.
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

/**
 * Pluggable signed-claim issuer. Story 12.3 defines only the contract — the
 * concrete multi-chain implementation ships in Story 12.4.
 *
 * The issuer owns inventory accounting and signing-key material. The handler
 * relies on `issueClaim()` being atomic with inventory debit: if the call
 * resolves, the target-asset amount MUST be considered committed from the
 * Swap's reserves. If the call throws, no inventory change SHOULD have occurred.
 */
export interface ClaimIssuer {
  /**
   * Produce a signed off-chain payment-channel claim in the target asset.
   *
   * @throws Error (or subclass) on insufficient reserves, unsupported pair,
   * or signing failure. Errors with `code === 'INSUFFICIENT_INVENTORY'` or
   * messages matching `/insufficient/i` are surfaced as ILP T04; all other
   * errors default to T00 — but the thrown value is handed verbatim to
   * {@link CreateSwapHandlerConfig.onFailure} first, so an issuer's own
   * error taxonomy can pick the code and message instead.
   */
  issueClaim(params: IssueClaimParams): Promise<IssueClaimResult>;
}

/** Parameters for {@link applyRate}. */
export interface ApplyRateParams {
  /** Source amount in source micro-units. */
  sourceAmount: bigint;
  /** `SwapPair.from.assetScale` (number of decimals on source side). */
  fromScale: number;
  /** `SwapPair.to.assetScale` (number of decimals on target side). */
  toScale: number;
  /** Decimal-string rate (target whole-units per source whole-unit). */
  rate: string;
}

/**
 * A fresh quote returned by a {@link CreateSwapHandlerConfig.rateProvider}
 * hook (issue #82, rolling-swap quote tape).
 *
 * `rateTimestamp` is the unix-ms time at which the maker's rate SOURCE
 * produced this quote (its feed tick), not the time the handler resolved it.
 * Both fields are echoed verbatim into the FULFILL accept-metadata so the
 * sender can read the quote tape `(R_1, t_1), (R_2, t_2), …` off the fills.
 */
export interface RateQuote {
  /** Decimal-string rate matching `SwapPair.rate` format: /^(0|[1-9]\d*)(\.\d+)?$/. */
  rate: string;
  /** Unix ms timestamp when the rate source produced this quote. Positive integer. */
  rateTimestamp: number;
}

/** Minimal pino-compatible logger interface. */
export interface SwapHandlerLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// toon#204 — the refusal seam
// ---------------------------------------------------------------------------

/**
 * Which stage of the handler pipeline produced a refusal.
 *
 * Only the stages that can fail with a *thrown* error are represented — the
 * handler's other rejects (bad kind, invalid amount, unwrap failure,
 * unsupported pair, malformed `chain-recipient`, duplicate packet) are
 * decided by inspection, already carry a specific code and a
 * self-diagnosable message, and never reach {@link SwapHandlerFailureMapper}.
 */
export type SwapHandlerFailureStage =
  /** `rateProvider` threw, or returned a shape the handler cannot use. */
  | 'rate_provider'
  /** `applyRate` rejected the resolved rate or the source amount. */
  | 'rate_conversion'
  /** `claimIssuer.issueClaim()` threw. No claim was issued. */
  | 'issuer'
  /** `encryptFulfillClaim()` threw. A claim WAS issued and is now stranded. */
  | 'encrypt';

/** Packet-scoped context handed to a {@link SwapHandlerFailureMapper}. */
export interface SwapHandlerFailureContext {
  /** ILP destination address of the PREPARE being refused. */
  destination: string;
  /** Source-asset amount on the PREPARE (source micro-units). */
  sourceAmount: bigint;
  /** The matched `SwapPair`. */
  pair: SwapPair;
  /** The sender's real Nostr pubkey (from the seal, not the outer wrap). */
  senderPubkey: string;
  /** The sender's validated chain-recipient address for `pair.to.chain`. */
  chainRecipient: string;
  /** Resolved rate, once rate resolution succeeded. */
  rate?: string;
  /** Converted target amount, once rate conversion succeeded. */
  targetAmount?: bigint;
  /**
   * `true` only on the `encrypt` stage: `issueClaim()` already resolved, so
   * the maker has committed inventory for a claim the sender will never see.
   */
  claimIssued: boolean;
  /** `IssueClaimResult.claimId`, when the issuer supplied one. */
  claimId?: string;
}

/**
 * A failure the handler is about to turn into an ILP REJECT, handed to the
 * caller-supplied {@link SwapHandlerFailureMapper} *before* the reject is
 * built — with the thrown value intact.
 */
export interface SwapHandlerFailure {
  /** Which stage failed. */
  stage: SwapHandlerFailureStage;
  /**
   * The thrown value, VERBATIM — not a string. `code`, `details`, `cause`
   * and the stack are all still attached, which is the whole point of this
   * seam: the SDK cannot classify a maker's domain errors, but the maker can.
   */
  error: unknown;
  /** `error.message` (or `String(error)`), extracted for convenience. */
  message: string;
  /** `error.code`, when the thrown value carries a string one. */
  code?: string;
  /** Packet-scoped context. */
  context: SwapHandlerFailureContext;
  /**
   * Exactly what the handler will reject with if the mapper returns nothing.
   *
   * This is also how a mapper tells an *already-classified* failure from an
   * opaque one: the handler recognises insufficient inventory on its own and
   * defaults to `T04 / Insufficient liquidity`, so a mapper that only wants
   * to enrich the opaque cases can return early when
   * `defaultRejection.code !== 'T00'`.
   */
  defaultRejection: SwapHandlerRejection;
}

/** An ILP REJECT a {@link SwapHandlerFailureMapper} wants emitted. */
export interface SwapHandlerRejection {
  /** ILP wire code, e.g. `'T04'`, `'F99'`. Required. */
  code: string;
  /** Human-readable message returned to the sender. Required. */
  message: string;
  /**
   * Optional opaque payload attached as `data` on the reject response —
   * base64 by convention, matching how the connector's reject `data` is
   * carried on the wire.
   */
  data?: string;
  /**
   * Optional SEMANTIC reject reason for the connector's `REJECT_CODE_MAP`
   * (e.g. `{ code: 'insufficient_funds' }`).
   *
   * NOTE: this survives only when the maker wires its packet handler to the
   * connector directly. `createNode()`'s `setPacketHandler` adapter in
   * `@toon-protocol/core` derives `rejectReason` from the wire code and
   * overwrites whatever the handler set.
   */
  rejectReason?: { code: string; message: string };
  /** Optional metadata merged onto the reject response. */
  metadata?: Record<string, unknown>;
}

/**
 * Caller-supplied classifier: turn a {@link SwapHandlerFailure} into the
 * REJECT the sender should see.
 *
 * MUST be synchronous — it runs on the reject path of a live packet.
 * Returning `undefined` (or throwing, or returning a malformed rejection)
 * keeps `failure.defaultRejection`, so a mapper can classify the conditions
 * it knows and ignore the rest. A mapper that classifies nothing at all must
 * still `return undefined` explicitly: `void` is deliberately NOT in the
 * union (this repo's lint forbids `no-invalid-void-type`), and observing
 * without classifying is what `logger` is for.
 */
export type SwapHandlerFailureMapper = (
  failure: SwapHandlerFailure
) => SwapHandlerRejection | undefined;

/**
 * The handler's reject response. Widens `HandlePacketRejectResponse` with the
 * two extra fields a {@link SwapHandlerRejection} may carry.
 */
export interface SwapHandlerRejectResponse extends HandlePacketRejectResponse {
  data?: string;
  rejectReason?: { code: string; message: string };
}

/**
 * Minimal `Set`-like contract the handler requires from
 * `seenPacketIds`. Both the native `Set<string>` and
 * {@link BoundedSeenPacketIds} satisfy this; operators can swap in a
 * persistent/remote-backed replacement too.
 */
export interface SeenPacketIdsLike {
  has(value: string): boolean;
  add(value: string): unknown;
  delete(value: string): boolean;
}

/** Configuration for {@link createSwapHandler}. */
export interface CreateSwapHandlerConfig {
  /** Swap's secp256k1 secret key for unwrapping gift-wrapped packets (32 bytes). */
  recipientSecretKey: Uint8Array;
  /** Swap pairs this Swap currently supports. */
  swapPairs: SwapPair[];
  /** Claim issuer delegate (Story 12.4 plugs in the multi-chain implementation). */
  claimIssuer: ClaimIssuer;
  /**
   * Optional live-rate override hook. When provided, the handler calls this per
   * packet instead of reading `pair.rate`. This is the rolling-swap fresh-quote
   * seam (issue #82): the resolved rate `R_i` and its quote timestamp are
   * emitted on every FULFILL's accept-metadata as the quote tape.
   *
   * MAY return either:
   * - a decimal string matching `SwapPair.rate` format
   *   /^(0|[1-9]\d*)(\.\d+)?$/ (legacy shape; the handler stamps
   *   `rateTimestamp` with its own resolution time), or
   * - a {@link RateQuote} `{ rate, rateTimestamp }` so the rate source's own
   *   tick time travels on the tape.
   */
  rateProvider?: (
    pair: SwapPair
  ) => string | RateQuote | Promise<string | RateQuote>;
  /**
   * Optional replay-protection set. When provided, the handler uses it
   * VERBATIM (operator-owned — bounding/persistence is the operator's
   * responsibility). When OMITTED (Story 12.8 AC-14), the handler
   * defaults to a {@link BoundedSeenPacketIds} with cap
   * {@link DEFAULT_SEEN_PACKET_IDS_CAP}. Any `Set`-shaped object with
   * `has`/`add`/`delete` (and a `size` getter for test introspection)
   * satisfies the contract.
   */
  seenPacketIds?: SeenPacketIdsLike;
  /**
   * Optional dedicated receipt signing key (issue #84, rfc-0039 stream
   * receipts; rolling-swap spec §7.2). 32-byte secp256k1 secret key used to
   * BIP-340-sign the per-fulfill {@link StreamReceipt}. When OMITTED,
   * receipts are signed with `recipientSecretKey` — the maker's Nostr
   * identity key — so senders verify against the `swapPubkey` they already
   * discovered via kind:10032. Provide a separate key when the receipt
   * signer should be provisioned independently of the identity key (e.g.
   * the swap#47 coupled engine binding receipts to the chain-B claim
   * signer); senders then verify via `StreamSwapParams.receiptPubkey`.
   */
  receiptSecretKey?: Uint8Array;
  /**
   * Optional receipt session store (issue #84). Tracks per-`streamNonce`
   * `{seq, cumulativeDelivered}` so receipt totals are monotone within a
   * session. Defaults to a {@link BoundedReceiptSessions} in-memory LRU.
   * Operators that persist claims should back this with the same storage so
   * receipt state survives restarts alongside the claim stream (a lost
   * session restarts at seq 1, which senders reject as a forked chain).
   */
  receiptSessions?: ReceiptSessionStoreLike;
  /** Optional pino-compatible logger. Defaults to a no-op logger. */
  logger?: SwapHandlerLogger;
  /**
   * Optional refusal classifier (toon#204).
   *
   * Before the handler rejects a packet because something *threw* — the rate
   * provider, rate conversion, the claim issuer, or claim encryption — it
   * calls this hook with the thrown value intact plus the reject it would
   * otherwise emit. Return a {@link SwapHandlerRejection} to replace that
   * reject; return nothing to keep it.
   *
   * This exists because the SDK cannot classify a maker's domain errors: it
   * recognises only insufficient inventory and collapsed everything else to
   * `T00 Internal error`, discarding the actionable message at the throw
   * site (e.g. `0x0124a370…: 1000 unredeemed`, which cost a multi-hour live
   * diagnosis on devnet — swap#136/#137). The maker already knows how to
   * classify its own failures; this is where it says so.
   *
   * Defaults are unchanged when this is omitted, and the hook cannot break
   * the handler: a throw or a malformed return falls back to
   * `failure.defaultRejection`.
   */
  onFailure?: SwapHandlerFailureMapper;
}

// ---------------------------------------------------------------------------
// Story 12.8 AC-14 — bounded seenPacketIds default
// ---------------------------------------------------------------------------

/**
 * Default ceiling for the `seenPacketIds` replay-protection set when the
 * operator does not supply a custom `Set`. Rationale: 10_000 packet-ids at
 * ~64 bytes each yields a ~640KB memory ceiling — high enough to absorb
 * legitimate bursts, low enough to bound DoS via distinct-id flooding.
 *
 * When the default bounded set is in use, eviction is LAST-ACCESS order
 * (LRU), NOT insertion order: a replay attacker who retries the same
 * packet-id forever would, under insertion-order LRU, have their entry
 * evicted after 10_000 new ids pass through — re-opening the replay
 * window. Access-order keeps frequently-replayed ids pinned, so the
 * window stays closed.
 *
 * Operators may override by supplying a custom `Set<string>` (e.g. a
 * persistent backing store). `createSwapHandler` uses the supplied set
 * verbatim without size-capping.
 */
export const DEFAULT_SEEN_PACKET_IDS_CAP = 10_000;

/**
 * ILP REJECT codes emitted by `createSwapHandler()`.
 *
 * Exported as named constants so tests (Story 12.8 AC-3 forbids hardcoded
 * error-code strings) and downstream integrators can assert against the
 * same symbolic source the handler uses. Values follow RFC 27 / ILPv4
 * reject-code conventions (F01 = malformed, F02 = unreachable, F04 =
 * duplicate, F06 = unsupported pair, T00 = transient internal, T04 =
 * insufficient liquidity).
 *
 * These are DEFAULTS for the throwing stages: a
 * {@link CreateSwapHandlerConfig.onFailure} mapper may replace the code and
 * message of any refusal it can classify (toon#204).
 */
export const SWAP_HANDLER_REJECT_CODES = {
  /** Malformed / invalid PREPARE content — gift-wrap shape or amount invalid. */
  INVALID_GIFT_WRAP: 'F01',
  /**
   * Missing or malformed `chain-recipient` tag on the rumor (toon#200). A
   * permanent sender-side error — F01, not the T00 previously emitted here,
   * so the sender can self-diagnose instead of treating it as transient.
   */
  INVALID_CHAIN_RECIPIENT: 'F01',
  /** No route — the handler did not match a registered destination. */
  UNREACHABLE: 'F02',
  /** Duplicate packet — `seenPacketIds` replay hit. */
  DUPLICATE_PACKET: 'F04',
  /** Requested swap pair is not advertised by this Swap. */
  UNSUPPORTED_PAIR: 'F06',
  /** Transient internal failure — signing, rate provider, or unexpected. */
  INTERNAL: 'T00',
  /** Insufficient Swap inventory for the requested amount. */
  INSUFFICIENT_LIQUIDITY: 'T04',
} as const;

/**
 * Human-readable reject messages emitted by `createSwapHandler()`.
 *
 * Tests may assert against these verbatim rather than matching regexes
 * (Story 12.8 AC-3 guidance).
 */
export const SWAP_HANDLER_REJECT_MESSAGES = {
  INVALID_GIFT_WRAP: 'Invalid gift wrap',
  INVALID_AMOUNT: 'Invalid amount',
  UNREACHABLE: 'Unreachable',
  DUPLICATE_PACKET: 'Duplicate packet',
  UNSUPPORTED_PAIR: 'Unsupported swap pair',
  INTERNAL: 'Internal error',
  INSUFFICIENT_LIQUIDITY: 'Insufficient liquidity',
  RATE_PROVIDER: 'Rate provider error',
  RATE_CONVERSION: 'Rate conversion error',
} as const;

/**
 * LRU-ish `Set<string>`: re-adding an existing element promotes it to
 * "most recently accessed"; `has()` also promotes. Eviction occurs on
 * `add()` when size exceeds the cap — the least-recently-accessed entry
 * (Map insertion-order head) is removed.
 *
 * Exported as `@internal` for Story 12.8 AC-10 test introspection.
 *
 * @internal
 */
export class BoundedSeenPacketIds {
  readonly #map = new Map<string, true>();
  readonly #cap: number;
  readonly [Symbol.toStringTag] = 'Set';

  constructor(cap: number = DEFAULT_SEEN_PACKET_IDS_CAP) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error(
        `BoundedSeenPacketIds cap must be a positive integer, got ${cap}`
      );
    }
    this.#cap = cap;
  }

  get size(): number {
    return this.#map.size;
  }

  /** Exposed for AC-10 test introspection. */
  get cap(): number {
    return this.#cap;
  }

  has(value: string): boolean {
    if (!this.#map.has(value)) return false;
    // Access-order promotion: re-insert so iteration order puts this at tail.
    this.#map.delete(value);
    this.#map.set(value, true);
    return true;
  }

  add(value: string): this {
    if (this.#map.has(value)) {
      // Promote to most-recently-accessed.
      this.#map.delete(value);
      this.#map.set(value, true);
      return this;
    }
    this.#map.set(value, true);
    while (this.#map.size > this.#cap) {
      // Evict least-recently-accessed (Map iteration is insertion order;
      // first key is the oldest that hasn't been re-added).
      const first = this.#map.keys().next();
      if (first.done) break;
      this.#map.delete(first.value);
    }
    return this;
  }

  delete(value: string): boolean {
    return this.#map.delete(value);
  }

  clear(): void {
    this.#map.clear();
  }

  forEach(
    callback: (value: string, value2: string, set: Set<string>) => void,
    thisArg?: unknown
  ): void {
    for (const k of this.#map.keys()) {
      callback.call(thisArg, k, k, this);
    }
  }

  *[Symbol.iterator](): IterableIterator<string> {
    yield* this.#map.keys();
  }

  *keys(): IterableIterator<string> {
    yield* this.#map.keys();
  }

  *values(): IterableIterator<string> {
    yield* this.#map.keys();
  }

  *entries(): IterableIterator<[string, string]> {
    for (const k of this.#map.keys()) yield [k, k];
  }
}

// ---------------------------------------------------------------------------
// applyRate helper (AC-8)
// ---------------------------------------------------------------------------

const RATE_REGEX = /^(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Apply a decimal-string exchange rate to a source amount across asset scales.
 * Uses BigInt arithmetic throughout — never coerces to `Number` — to preserve
 * 18-decimal EVM precision (Epic 11 retro MAX_SAFE_INTEGER guard).
 *
 * Rounds toward zero (integer division), which economically favors the Swap
 * (standard market-maker convention).
 *
 * @throws {SwapHandlerError} If rate format is invalid, rate is zero, or
 *   sourceAmount is not positive.
 */
export function applyRate(params: ApplyRateParams): bigint {
  const { sourceAmount, fromScale, toScale, rate } = params;

  if (!RATE_REGEX.test(rate)) {
    throw new SwapHandlerError(`Invalid rate format: ${rate}`);
  }
  // Reject any zero-valued rate regardless of decimal presentation.
  // RATE_REGEX matches `'0'`, `'0.0'`, `'0.00'`, etc. — all semantically
  // "not quoting". Previous check only caught the bare `'0'` form, letting
  // `'0.0'` slip through and produce a zero-valued targetAmount that the
  // sender's rate-deviation guard could not catch (expectedTargetAmount=0n
  // skips the deviation math). (Story 12.5 code-review pass #3.)
  if (/^0(\.0+)?$/.test(rate)) {
    throw new SwapHandlerError('Rate is zero (pair not quoting)');
  }
  if (sourceAmount <= 0n) {
    throw new SwapHandlerError(
      `sourceAmount must be positive, got ${sourceAmount}`
    );
  }

  const dotIdx = rate.indexOf('.');
  const integerPart = dotIdx === -1 ? rate : rate.slice(0, dotIdx);
  const fractionalPart = dotIdx === -1 ? '' : rate.slice(dotIdx + 1);

  const rateNumerator = BigInt(integerPart + fractionalPart);
  const rateDenominator = 10n ** BigInt(fractionalPart.length);

  const scaleUp = 10n ** BigInt(toScale);
  const scaleDown = 10n ** BigInt(fromScale);

  return (
    (sourceAmount * rateNumerator * scaleUp) / (rateDenominator * scaleDown)
  );
}

// ---------------------------------------------------------------------------
// findSwapPair helper (AC-7)
// ---------------------------------------------------------------------------

/**
 * Find the `SwapPair` identified by the rumor's `swap-from` / `swap-to` tags.
 *
 * Each tag value is parsed as `<assetCode>:<chain>`, split on the FIRST `:`
 * so multi-segment chain IDs like `evm:base:8453` remain intact as the chain
 * portion. Returns `null` for any malformed/missing tag — the handler
 * interprets `null` as "unsupported pair" and rejects via ILP F06.
 */
export function findSwapPair(
  rumor: UnsignedEvent,
  pairs: SwapPair[]
): SwapPair | null {
  const fromTag = findTagValue(rumor, 'swap-from');
  const toTag = findTagValue(rumor, 'swap-to');

  if (!fromTag || !toTag) return null;

  const fromParts = splitAssetChain(fromTag);
  const toParts = splitAssetChain(toTag);
  if (!fromParts || !toParts) return null;

  for (const pair of pairs) {
    if (
      pair.from.assetCode === fromParts.assetCode &&
      pair.from.chain === fromParts.chain &&
      pair.to.assetCode === toParts.assetCode &&
      pair.to.chain === toParts.chain
    ) {
      return pair;
    }
  }
  return null;
}

function findTagValue(
  rumor: UnsignedEvent,
  tagName: string
): string | undefined {
  if (!Array.isArray(rumor.tags)) return undefined;
  for (const t of rumor.tags) {
    if (Array.isArray(t) && t[0] === tagName && typeof t[1] === 'string') {
      return t[1];
    }
  }
  return undefined;
}

function splitAssetChain(
  raw: string
): { assetCode: string; chain: string } | null {
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) return null;
  const assetCode = raw.slice(0, idx);
  const chain = raw.slice(idx + 1);
  if (!assetCode || !chain) return null;
  return { assetCode, chain };
}

// ---------------------------------------------------------------------------
// Story 12.9 AC-2 / AC-8 — chain-recipient format validation
// ---------------------------------------------------------------------------
//
// Duplicated (intentionally small) from `stream-swap.ts` to avoid a circular
// module cycle (`stream-swap` imports `applyRate` from this file). Guardrail
// 8.5 sanctions local duplication rather than introducing a shared helper
// package. Rules MUST match the sender-side validator byte-for-byte.

const SWAP_HANDLER_EVM_ADDRESS_REGEX = /^0x[0-9a-f]{40}$/;
const SWAP_HANDLER_BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Validate a chain-recipient address against `chain`. MUST remain in sync
 * with `validateChainAddress(value, chain, 'address')` in `stream-swap.ts`.
 */
export function validateChainRecipient(value: string, chain: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (chain.startsWith('evm:')) {
    // toon#153 (stream-swap.ts) / toon#200 (here): viem / EIP-55 emits
    // checksummed (mixed-case) addresses, and released clients send them
    // in the `chain-recipient` tag. Lowercase-normalize before the
    // strict-lowercase-hex regex so a valid checksummed address is
    // accepted instead of every stock-client swap packet being rejected.
    return SWAP_HANDLER_EVM_ADDRESS_REGEX.test(value.toLowerCase());
  }
  if (chain.startsWith('solana:')) {
    if (!SWAP_HANDLER_BASE58_REGEX.test(value)) return false;
    if (value.length < 32 || value.length > 44) return false;
    try {
      return base58Decode(value).length === 32;
    } catch {
      return false;
    }
  }
  if (chain.startsWith('mina:')) {
    return SWAP_HANDLER_BASE58_REGEX.test(value) && value.length >= 32;
  }
  return value.length > 0;
}

/**
 * Describe the expected `chain-recipient` shape for `chain`, for use in a
 * self-diagnosable reject message (toon#200). MUST stay in sync with
 * `validateChainRecipient`'s per-chain rules above.
 */
function describeChainRecipientShape(chain: string): string {
  if (chain.startsWith('evm:')) return '0x + 40 hex chars';
  if (chain.startsWith('solana:')) return 'a base58-encoded 32-byte public key';
  if (chain.startsWith('mina:')) return 'a base58 string of at least 32 chars';
  return 'a non-empty string';
}

/**
 * Extract the sender-supplied chain-recipient address from the rumor's
 * `chain-recipient` tag (Story 12.9 AC-8). Returns `null` if the tag is
 * missing or malformed for `chain`.
 *
 * toon#200: an EVM value is returned lowercased — `validateChainRecipient`
 * accepts EIP-55 checksummed (mixed-case) input, so downstream consumers
 * (e.g. `IssueClaimParams.chainRecipient`) get a single normalized casing
 * regardless of which casing the sender used.
 */
export function findChainRecipient(
  rumor: UnsignedEvent,
  chain: string
): string | null {
  const raw = findTagValue(rumor, 'chain-recipient');
  if (!raw) return null;
  if (!validateChainRecipient(raw, chain)) return null;
  return chain.startsWith('evm:') ? raw.toLowerCase() : raw;
}

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noop = (): void => undefined;
const NOOP_LOGGER: SwapHandlerLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

// ---------------------------------------------------------------------------
// createSwapHandler factory (AC-3..AC-12)
// ---------------------------------------------------------------------------

/**
 * Construct a kind:1059 Swap inbound-swap handler.
 *
 * The returned `Handler` is a pure closure over `config`; two calls with the
 * same config yield two independent-but-equivalent handlers. Register via
 * `node.handlers.on(1059, handler)` (Story 12.7).
 *
 * @throws {SwapHandlerError} At construction time if config is malformed.
 */
export function createSwapHandler(config: CreateSwapHandlerConfig): Handler {
  // Construction-time validation (pre-empt Story 12.2 retro finding #1).
  if (
    !(config.recipientSecretKey instanceof Uint8Array) ||
    config.recipientSecretKey.length !== 32
  ) {
    throw new SwapHandlerError(
      'recipientSecretKey must be a 32-byte Uint8Array'
    );
  }
  if (!Array.isArray(config.swapPairs)) {
    throw new SwapHandlerError('swapPairs must be an array');
  }
  if (
    !config.claimIssuer ||
    typeof config.claimIssuer.issueClaim !== 'function'
  ) {
    throw new SwapHandlerError(
      'claimIssuer must implement issueClaim(params): Promise<IssueClaimResult>'
    );
  }

  if (
    config.receiptSecretKey !== undefined &&
    (!(config.receiptSecretKey instanceof Uint8Array) ||
      config.receiptSecretKey.length !== 32)
  ) {
    throw new SwapHandlerError('receiptSecretKey must be a 32-byte Uint8Array');
  }

  if (
    config.onFailure !== undefined &&
    typeof config.onFailure !== 'function'
  ) {
    throw new SwapHandlerError(
      'onFailure must be a function (failure) => SwapHandlerRejection | undefined'
    );
  }

  const logger = config.logger ?? NOOP_LOGGER;
  const onFailure = config.onFailure;

  // Issue #84: receipt signing key + per-streamNonce session state. Default
  // signer is the maker identity key (verifiable against `swapPubkey`).
  const receiptSecretKey = config.receiptSecretKey ?? config.recipientSecretKey;
  const receiptSessions: ReceiptSessionStoreLike =
    config.receiptSessions ?? new BoundedReceiptSessions();

  // Story 12.8 AC-14: when the operator does not supply a custom set,
  // default to a bounded access-order-LRU set. Operator-supplied sets are
  // used verbatim (we do not second-guess the operator's choice of
  // persistence / bounding).
  const seenPacketIds: SeenPacketIdsLike =
    config.seenPacketIds ?? new BoundedSeenPacketIds();

  return async (ctx) => {
    // AC-4: defensive kind guard. HandlerRegistry.dispatch already routes by
    // kind, but a mis-registered handler should fail loudly rather than
    // silently mutate unrelated traffic.
    if (ctx.kind !== 1059) {
      // Generic reject message -- do not leak handler role to the caller.
      // A swap handler registered for non-1059 traffic is a mis-configuration;
      // the caller doesn't need to know which handler fielded the packet.
      return ctx.reject('F02', 'Unreachable');
    }

    // Defense-in-depth: reject non-positive amounts eagerly with a dedicated
    // code so the sender gets an unambiguous error (otherwise applyRate would
    // throw and surface as the generic T00 "Rate conversion error"). ILP
    // connectors already enforce amount > 0, but we double-check at the
    // protocol boundary.
    if (typeof ctx.amount !== 'bigint' || ctx.amount <= 0n) {
      logger.warn({
        event: 'swap_handler.invalid_amount',
        destination: ctx.destination,
      });
      return ctx.reject('F01', 'Invalid amount');
    }

    // AC-4 / AC-5 / AC-6: decode and unwrap. `ctx.toon` is the base64 string
    // lifted verbatim from `ilpPrepare.data` (which `buildIlpPrepare` produces
    // by base64-encoding the raw TOON binary). Single decode -> TOON bytes.
    //
    // NOTE: `ctx.pubkey` is the OUTER ephemeral gift-wrap pubkey, NOT the real
    // sender. The real sender comes from the seal inside
    // unwrapSwapPacketFromToon. Do not use `ctx.pubkey` for sender identity.
    if (typeof ctx.toon !== 'string' || ctx.toon.length === 0) {
      logger.warn({
        event: 'swap_handler.invalid_toon',
        destination: ctx.destination,
      });
      return ctx.reject('F01', 'Invalid gift wrap');
    }
    let rumor: UnsignedEvent;
    let senderPubkey: string;
    try {
      const toonData = new Uint8Array(Buffer.from(ctx.toon, 'base64'));
      ({ rumor, senderPubkey } = unwrapSwapPacketFromToon({
        toonData,
        recipientSecretKey: config.recipientSecretKey,
      }));
    } catch (err) {
      if (err instanceof GiftWrapError) {
        logger.warn({
          event: 'swap_handler.unwrap_failed',
          destination: ctx.destination,
          error: err.message,
        });
        return ctx.reject('F01', 'Invalid gift wrap');
      }
      logger.error({
        event: 'swap_handler.unwrap_unexpected_error',
        destination: ctx.destination,
        error: err instanceof Error ? err.message : String(err),
      });
      return ctx.reject('F01', 'Invalid gift wrap');
    }

    // AC-7: pair lookup
    const pair = findSwapPair(rumor, config.swapPairs);
    if (!pair) {
      logger.debug({
        event: 'swap_handler.unsupported_pair',
        destination: ctx.destination,
      });
      return ctx.reject('F06', 'Unsupported swap pair');
    }

    // Story 12.9 AC-1 / AC-8: extract and validate the `chain-recipient`
    // tag from the inner rumor. Missing or malformed values are a permanent
    // sender-side error, not a transient/internal one (toon#200 owner
    // decision, superseding AC-14a/AC-14b's original T00 pin) — reject F01
    // with a message naming the field and the expected shape so the sender
    // can self-diagnose and retry with a corrected address.
    const chainRecipient = findChainRecipient(rumor, pair.to.chain);
    if (!chainRecipient) {
      logger.debug({
        event: 'swap_handler.malformed_rumor',
        destination: ctx.destination,
        reason: 'missing_or_malformed_chain_recipient',
        chain: pair.to.chain,
      });
      return ctx.reject(
        'F01',
        `missing or malformed chain-recipient for ${pair.to.chain} — expected ${describeChainRecipientShape(pair.to.chain)}`
      );
    }

    // AC-11: replay protection check. We RESERVE the packetId synchronously
    // here (before the first `await`) so that two concurrent invocations with
    // an identical packet ID cannot both pass the `has()` gate. Because the
    // JS event loop is cooperative, the check-and-add pair is atomic relative
    // to other microtasks as long as it straddles no `await`. If issuance or
    // encryption later fails, we release the reservation so the sender can
    // legitimately retry (AC-11 requires retries of rejected packets).
    // Story 12.8 AC-14: replay check always runs (against the bounded default
    // when the operator did not supply a custom set).
    const packetId: string = computePacketId(senderPubkey, ctx.amount, rumor);
    if (seenPacketIds.has(packetId)) {
      logger.debug({
        event: 'swap_handler.duplicate_packet',
        packetId,
      });
      return ctx.reject('F04', 'Duplicate packet');
    }
    // Reserve eagerly to close the concurrent check-then-add race.
    seenPacketIds.add(packetId);

    // Helper: release the replay reservation on failure so the sender can retry.
    const releaseReservation = (): void => {
      seenPacketIds.delete(packetId);
    };

    /**
     * toon#204 — the single exit for every "something threw" refusal.
     *
     * Releases the replay reservation (all four throwing stages are
     * retryable), offers the failure to `onFailure` with the thrown value
     * INTACT, logs the outcome — including the code actually going on the
     * wire — and builds the reject.
     */
    const refuse = (params: {
      stage: SwapHandlerFailureStage;
      error: unknown;
      /** Log event name, kept byte-identical to the pre-#204 lines. */
      logEvent: string;
      level: 'warn' | 'error';
      defaultRejection: SwapHandlerRejection;
      context: Omit<
        SwapHandlerFailureContext,
        | 'destination'
        | 'sourceAmount'
        | 'pair'
        | 'senderPubkey'
        | 'chainRecipient'
      >;
    }): SwapHandlerRejectResponse => {
      releaseReservation();

      const { stage, error, defaultRejection } = params;
      const message = error instanceof Error ? error.message : String(error);
      const rawCode = (error as { code?: unknown } | undefined)?.code;
      const failure: SwapHandlerFailure = {
        stage,
        error,
        message,
        ...(typeof rawCode === 'string' && { code: rawCode }),
        context: {
          destination: ctx.destination,
          sourceAmount: ctx.amount,
          pair,
          senderPubkey,
          chainRecipient,
          ...params.context,
        },
        defaultRejection,
      };

      let rejection = defaultRejection;
      if (onFailure) {
        try {
          const mapped = onFailure(failure);
          if (
            mapped !== undefined &&
            mapped !== null &&
            typeof mapped.code === 'string' &&
            mapped.code.length > 0 &&
            typeof mapped.message === 'string'
          ) {
            rejection = mapped;
          } else if (mapped !== undefined && mapped !== null) {
            // A mapper that returns garbage must not take the packet down
            // with it — say so loudly and keep the default.
            logger.warn({
              event: 'swap_handler.on_failure_invalid_rejection',
              stage,
            });
          }
        } catch (mapErr) {
          logger.error({
            event: 'swap_handler.on_failure_threw',
            stage,
            error: mapErr instanceof Error ? mapErr.message : String(mapErr),
            err: mapErr,
          });
        }
      }

      logger[params.level]({
        event: params.logEvent,
        // `error` (the message) is the pre-#204 field and stays put; `err`
        // carries the thrown value itself so a pino-style serializer can
        // record its code/cause/stack instead of just the sentence.
        error: message,
        err: error,
        ...(typeof rawCode === 'string' && { code: rawCode }),
        stage,
        rejectCode: rejection.code,
        rejectMessage: rejection.message,
      });

      return {
        ...ctx.reject(rejection.code, rejection.message),
        ...(rejection.data !== undefined && { data: rejection.data }),
        ...(rejection.rejectReason !== undefined && {
          rejectReason: rejection.rejectReason,
        }),
        ...(rejection.metadata !== undefined && {
          metadata: rejection.metadata,
        }),
      };
    };

    // AC-9 rate resolution (optional live hook per D12-006).
    //
    // Issue #82 (rolling-swap quote tape): the resolved rate `R_i` and its
    // quote timestamp are captured here and emitted on the accept-metadata.
    // A provider may return the legacy string shape (timestamp = resolution
    // time) or a `RateQuote` carrying its rate source's own tick time.
    let rate: string;
    let rateTimestamp: number;
    try {
      const provided = config.rateProvider
        ? await config.rateProvider(pair)
        : pair.rate;
      if (typeof provided === 'string') {
        rate = provided;
        rateTimestamp = Date.now();
      } else if (
        provided !== null &&
        typeof provided === 'object' &&
        typeof provided.rate === 'string' &&
        typeof provided.rateTimestamp === 'number' &&
        Number.isInteger(provided.rateTimestamp) &&
        provided.rateTimestamp > 0
      ) {
        rate = provided.rate;
        rateTimestamp = provided.rateTimestamp;
      } else {
        throw new SwapHandlerError(
          'rateProvider must return a decimal-string rate or { rate, rateTimestamp }'
        );
      }
    } catch (err) {
      return refuse({
        stage: 'rate_provider',
        error: err,
        logEvent: 'swap_handler.rate_provider_failed',
        level: 'error',
        defaultRejection: {
          code: SWAP_HANDLER_REJECT_CODES.INTERNAL,
          message: SWAP_HANDLER_REJECT_MESSAGES.RATE_PROVIDER,
        },
        context: { claimIssued: false },
      });
    }

    // AC-8: apply rate (BigInt throughout).
    let targetAmount: bigint;
    try {
      targetAmount = applyRate({
        sourceAmount: ctx.amount,
        fromScale: pair.from.assetScale,
        toScale: pair.to.assetScale,
        rate,
      });
      logger.debug({
        event: 'swap_handler.rate_applied',
        sourceAmount: ctx.amount.toString(),
        targetAmount: targetAmount.toString(),
        rate,
      });
    } catch (err) {
      // Do NOT surface the internal rate string / validation detail to the
      // sender -- the DEFAULT message stays generic and privacy-preserving.
      // A maker that wants to say more can do so via `onFailure`; it is the
      // one that knows what its own rate source is allowed to leak.
      return refuse({
        stage: 'rate_conversion',
        error: err,
        logEvent: 'swap_handler.rate_conversion_failed',
        level: 'warn',
        defaultRejection: {
          code: SWAP_HANDLER_REJECT_CODES.INTERNAL,
          message: SWAP_HANDLER_REJECT_MESSAGES.RATE_CONVERSION,
        },
        context: { rate, claimIssued: false },
      });
    }

    // AC-9: delegate to claim issuer
    let claim: Uint8Array;
    let claimId: string | undefined;
    let settlementChannelId: string | undefined;
    let settlementNonce: bigint | undefined;
    let settlementCumulative: bigint | undefined;
    let settlementRecipient: string | undefined;
    let settlementSwapSigner: string | undefined;
    try {
      const result = await config.claimIssuer.issueClaim({
        sourceAmount: ctx.amount,
        targetAmount,
        pair,
        senderPubkey,
        chainRecipient,
        rumor,
      });
      claim = result.claim;
      claimId = result.claimId;
      settlementChannelId = result.channelId;
      settlementNonce = result.nonce;
      settlementCumulative = result.cumulativeAmount;
      settlementRecipient = result.recipient;
      settlementSwapSigner = result.swapSignerAddress;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = err instanceof Error ? err.message : String(err);
      // The ONE condition the SDK can classify by itself. Its default is
      // unchanged (T04 / 'Insufficient liquidity', logged at warn under the
      // same event) — but it goes through `refuse` too, so `onFailure` sees
      // every issuer failure uniformly and can tell this one apart by
      // `defaultRejection.code`.
      const insufficient =
        code === 'INSUFFICIENT_INVENTORY' || /insufficient/i.test(message);
      return refuse({
        stage: 'issuer',
        error: err,
        logEvent: insufficient
          ? 'swap_handler.insufficient_inventory'
          : 'swap_handler.issuer_failed',
        level: insufficient ? 'warn' : 'error',
        defaultRejection: insufficient
          ? {
              code: SWAP_HANDLER_REJECT_CODES.INSUFFICIENT_LIQUIDITY,
              message: SWAP_HANDLER_REJECT_MESSAGES.INSUFFICIENT_LIQUIDITY,
            }
          : {
              code: SWAP_HANDLER_REJECT_CODES.INTERNAL,
              message: SWAP_HANDLER_REJECT_MESSAGES.INTERNAL,
            },
        context: { rate, targetAmount, claimIssued: false },
      });
    }

    // AC-10: NIP-44 encrypt the claim (Story 12.2 handles ephemeral-key zeroing).
    let ciphertext: Uint8Array;
    let ephemeralPubkey: string;
    try {
      const enc = encryptFulfillClaim({ claimData: claim, senderPubkey });
      ciphertext = enc.ciphertext;
      ephemeralPubkey = enc.ephemeralPubkey;
    } catch (err) {
      // toon#204: this branch used to end the error's life — the message was
      // flattened into one log line the default no-op logger threw away, and
      // the sender got a bare `T00 Internal error` indistinguishable from
      // the issuer branch above. swap#137 could only *infer* it downstream
      // ("a blanket T00 after a claim was issued can only be this"). Now the
      // thrown value reaches `onFailure`, and `claimIssued: true` says
      // plainly that value is committed but stranded.
      return refuse({
        stage: 'encrypt',
        error: err,
        logEvent: 'swap_handler.encrypt_failed',
        level: 'error',
        defaultRejection: {
          code: SWAP_HANDLER_REJECT_CODES.INTERNAL,
          message: SWAP_HANDLER_REJECT_MESSAGES.INTERNAL,
        },
        context: {
          rate,
          targetAmount,
          claimIssued: true,
          ...(claimId !== undefined && { claimId }),
        },
      });
    }

    // AC-11: packetId was reserved pre-issuance to close the concurrent
    // check-then-add race; it remains committed on this success path.

    // Issue #84 (rfc-0039 stream receipts, spec §7.2): when the sender
    // advertised a session via the rumor's `stream-nonce` tag, issue the
    // per-fulfill signed receipt. This runs strictly on the ACCEPT path —
    // every reject above returns before this point, so a rejected packet
    // never advances the session (no receipt, no seq, no cumulative).
    // The read-increment-write inside issueSessionReceipt is synchronous,
    // so concurrent packets in one session get gapless distinct seqs.
    // Legacy senders (no tag) get the pre-#84 metadata shape verbatim.
    let receipt: StreamReceipt | undefined;
    const streamNonceTag = findTagValue(rumor, 'stream-nonce');
    if (streamNonceTag !== undefined) {
      if (!isValidStreamNonce(streamNonceTag)) {
        logger.warn({
          event: 'swap_handler.invalid_stream_nonce',
          destination: ctx.destination,
        });
      } else {
        try {
          receipt = issueSessionReceipt({
            sessions: receiptSessions,
            streamNonce: streamNonceTag,
            deliveredAmount: targetAmount,
            rate,
            rateTimestamp,
            secretKey: receiptSecretKey,
          });
        } catch (err) {
          // Value is already committed (claim issued + encrypted): accept
          // WITHOUT a receipt rather than failing the packet. A sender that
          // requires receipts will surface this loudly on its side.
          logger.error({
            event: 'swap_handler.receipt_issue_failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const claimBase64 = Buffer.from(ciphertext).toString('base64');
    logger.info({
      event: 'swap_handler.claim_issued',
      claimId,
      ephemeralPubkey,
    });

    // Story 12.5: emit the Swap-computed `targetAmount` (decimal string) so
    // the sender can run an end-to-end rate-deviation check without having to
    // parse the opaque chain-specific `claimBytes`. This is additive and
    // backward compatible — legacy senders that ignore the field get the
    // same {claim, ephemeralPubkey, claimId?} shape they always did.
    // Issue #82 (rolling-swap quote tape, spec §7.1): every FULFILL carries
    // the rate `R_i` actually applied to this packet plus its quote
    // timestamp. Additive and backward compatible — legacy senders ignore
    // the extra fields; rolling senders read the sequence
    // `(R_1, t_1), (R_2, t_2), …` as the price tape.
    const metadata: Record<string, unknown> = {
      claim: claimBase64,
      ephemeralPubkey,
      targetAmount: targetAmount.toString(),
      rate,
      rateTimestamp,
    };
    if (claimId !== undefined) metadata['claimId'] = claimId;
    // Issue #84: per-fulfill signed receipt (additive; only present when the
    // sender advertised a `stream-nonce` and signing succeeded).
    if (receipt !== undefined) metadata['receipt'] = receipt;
    // Story 12.6: thread settlement-context fields through when the claim
    // issuer emits them. All-or-nothing: a Swap that supplies settlement
    // fields MUST supply all five, since the sender's FULFILL decoder
    // enforces all-present-or-all-absent.
    if (
      settlementChannelId !== undefined &&
      settlementNonce !== undefined &&
      settlementCumulative !== undefined &&
      settlementRecipient !== undefined &&
      settlementSwapSigner !== undefined
    ) {
      metadata['channelId'] = settlementChannelId;
      metadata['nonce'] = settlementNonce.toString();
      metadata['cumulativeAmount'] = settlementCumulative.toString();
      metadata['recipient'] = settlementRecipient;
      metadata['swapSignerAddress'] = settlementSwapSigner;
    }

    return ctx.accept(metadata);
  };
}

// ---------------------------------------------------------------------------
// Replay packet ID hash
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic packet ID for replay protection.
 *
 * Uses explicit length-prefix delimiters between the three inputs so that
 * `('ab','c12','3')` and `('abc','12','3')` produce distinct digests. Without
 * delimiters, variable-width string concatenation is ambiguous under hashing.
 */
function computePacketId(
  senderPubkey: string,
  sourceAmount: bigint,
  rumor: UnsignedEvent
): string {
  const rumorId = (rumor as UnsignedEvent & { id?: string }).id ?? '';
  const hash = createHash('sha256');
  const parts = [senderPubkey, sourceAmount.toString(), rumorId];
  for (const p of parts) {
    // 4-byte big-endian length prefix followed by UTF-8 bytes.
    const buf = Buffer.from(p, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(buf.length, 0);
    hash.update(lenBuf);
    hash.update(buf);
  }
  return hash.digest('hex');
}
