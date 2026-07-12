/**
 * Sender-side `streamSwap()` API (Story 12.5).
 *
 * Drives the sender side of the Token Swap Primitive: chunks a total source
 * amount into N sender-chosen packets, wraps each with `wrapSwapPacketToToon()`
 * using a fresh ephemeral gift-wrap key per packet (D12-003 / risk R-006),
 * sends each via `ToonClient.sendSwapPacket(...)`, decrypts each FULFILL's
 * NIP-44-encrypted claim with `decryptFulfillClaim()`, accumulates the
 * decrypted claims into an ordered array, invokes a per-packet rate monitoring
 * callback, and supports pause / resume / stop / AbortSignal so the sender
 * can abort when rate drifts past tolerance.
 *
 * Composition story: consumes Stories 12.1 (SwapPair type), 12.2 (gift wrap
 * primitives), 12.3 (handler wire contract). Produces `AccumulatedClaim[]`
 * consumed by Story 12.6 (`buildSettlementTx()`).
 *
 * Design decisions:
 * - `streamSwap()` does NOT throw on mid-stream failure. Caller gets
 *   `StreamSwapResult` with `state` and `abortReason`. Only construction-time
 *   validation throws synchronously.
 * - `streamSwap()` does NOT retry individual packets. BTP-level connection
 *   retries are handled inside `BtpRuntimeClient`; application-layer retry
 *   (e.g., T04 insufficient inventory) is a future-story concern.
 * - Rate deviation math stays BigInt throughout. The `effectiveRate` on
 *   `PacketProgress` is a display-only `number` (Epic 11 retro MAX_SAFE_INTEGER
 *   guard).
 *
 * @module
 */

import { getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent } from 'nostr-tools/pure';
import type { SwapPair } from '@toon-protocol/core';

import { StreamSwapError } from './errors.js';
import { wrapSwapPacketToToon, decryptFulfillClaim } from './gift-wrap.js';
import { base58Decode } from './identity.js';
import { applyRate } from './swap-handler.js';
import {
  parseStreamReceipt,
  ReceiptChainTracker,
  type StreamReceipt,
  type StreamReceiptChain,
} from './stream-receipts.js';
import type {
  PacketObservation,
  PacketResolution,
  StreamSwapAdaptiveController,
} from './adaptive-controller.js';

// ---------------------------------------------------------------------------
// Minimal structural shapes (avoid cross-package type imports)
// ---------------------------------------------------------------------------

/** Minimal `IlpSendResult` shape — mirrors `packages/client/src/types.ts`. */
interface IlpSendResultLike {
  accepted: boolean;
  data?: string;
  code?: string;
  message?: string;
}

/**
 * Minimal `SignedBalanceProof` structural type.
 *
 * We avoid importing from `@toon-protocol/client` so the SDK package does not
 * gain a runtime dep on the client package. The sender layer only forwards
 * this opaquely to `ToonClient.sendSwapPacket`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque forwarded type
type SignedBalanceProofLike = any;

/**
 * The subset of `ToonClient` that `streamSwap()` requires. This narrow shape
 * exists so that consumers can pass a real `ToonClient` OR a mock without
 * importing the whole class.
 */
export interface StreamSwapClient {
  sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    timeout?: number;
    claim?: SignedBalanceProofLike;
    /**
     * Explicit per-packet PREPARE expiry. When set, the transport MUST use
     * exactly this expiry on the wire instead of deriving one from the
     * request timeout. Optional so existing `ToonClient` implementations
     * remain structurally compatible (they ignore the extra field until
     * the client-transport work lands).
     */
    expiresAt?: Date;
  }): Promise<IlpSendResultLike>;
  getPublicKey(): string;
}

// ---------------------------------------------------------------------------
// Public interfaces (AC-2, AC-7, AC-8, AC-9, AC-10)
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link streamSwap} / {@link streamSwapControlled}.
 *
 * @stable — downstream Stories 12.6 and 12.8 depend on this shape.
 */
export interface StreamSwapParams {
  /** SDK client with BTP wiring (see {@link StreamSwapClient}). */
  client: StreamSwapClient;
  /** Swap's 64-char lowercase hex pubkey (recipient of gift wrap). */
  swapPubkey: string;
  /** Swap's ILP destination address (e.g., 'g.toon.swap1'). */
  swapIlpAddress: string;
  /** The `SwapPair` being executed (from kind:10032 discovery, Story 12.1). */
  pair: SwapPair;
  /** Sender's 32-byte secp256k1 secret key. Used for seal signing AND FULFILL decryption. */
  senderSecretKey: Uint8Array;
  /**
   * Sender's chain-specific payout address for `pair.to.chain` (Story 12.9 AC-4).
   *
   * REQUIRED. The Nostr `senderPubkey` (identity layer) cannot be used as the
   * on-chain `recipient` in a balance-proof because they are cryptographically
   * independent keys (D12-011). For `evm:*` chains this must be a 20-byte
   * lowercased `0x`-prefixed hex address; for `solana:*` a base58 pubkey that
   * decodes to 32 bytes; for `mina:*` a base58 public-key string. The value
   * is validated at `streamSwapControlled()` entry via `validateChainAddress`
   * and echoed on every rumor as the `chain-recipient` tag (AC-6).
   */
  chainRecipient: string;
  /** Total source-asset amount to swap (source micro-units). */
  totalAmount: bigint;
  /** Even-split packet count. EXACTLY ONE of this, `packetAmounts`, or `controller` is required. */
  packetCount?: number;
  /** Explicit per-packet amounts. EXACTLY ONE of this, `packetCount`, or `controller` is required. */
  packetAmounts?: readonly bigint[];
  /**
   * Adaptive δ/W controller (issue #83, rolling-swap spec §6). EXACTLY ONE
   * of this, `packetCount`, or `packetAmounts` is required.
   *
   * When set, packetization is DYNAMIC: the static even split is replaced by
   * per-packet sizing from `controller.nextDelta(remaining)` (δ, capped by
   * the measured `ε/(v·τ)` bound), and up to `controller.window` (W) packets
   * are kept in flight concurrently. After every packet resolves, the
   * controller receives a {@link PacketObservation} (realized rate, tape
   * entry, RTT, resolution class) so δ and W adapt across the stream —
   * multiplicative shrink on stale/slip/reject, additive widen on clean
   * streaks.
   *
   * Adaptive-mode contract differences (each N/A to the legacy paths):
   * - `PacketProgress.total` is the number of packets scheduled SO FAR (the
   *   final count is unknown upfront).
   * - With `W > 1`, `onPacket` fires in packet COMPLETION order, not strict
   *   index order.
   * - On a mid-stream halt (floor breach, stop, abort), already-sent
   *   in-flight packets are drained and their claims harvested before the
   *   result resolves.
   *
   * INVARIANT: the controller only tightens/loosens δ and W. It is consulted
   * strictly AFTER the `minExchangeRate` floor check and can never relax it.
   */
  controller?: StreamSwapAdaptiveController;
  /** Source-asset balance proof claim. Required unless ChannelManager is wired. */
  claim?: SignedBalanceProofLike;
  /** Rate monitoring callback (fires after each accepted FULFILL). */
  onPacket?: RateMonitorCallback;
  /** Rate deviation threshold (decimal, e.g., 0.02 = 2%). */
  rateDeviationThreshold?: number;
  /**
   * Hard floor on the per-packet exchange rate (issue #82, rfc-0029
   * `minExchangeRate` semantics; rolling-swap spec §5). Decimal string in
   * `SwapPair.rate` format (target whole-units per source whole-unit),
   * strictly positive.
   *
   * When set:
   * - The quote tape (`rate` + `rateTimestamp` on each FULFILL's metadata)
   *   becomes REQUIRED: a fulfilled packet whose metadata is missing the
   *   tape is a loud per-packet `FULFILL_DECODE_FAILED` error, never a
   *   silent drop.
   * - Each fulfilled packet is checked BEFORE its claim is decrypted or
   *   accumulated: if the maker's tape rate `R_i` is below the floor, OR
   *   the delivered `targetAmount` is below `applyRate(sourceAmount,
   *   minExchangeRate)`, the packet is recorded as a rejection with code
   *   `BELOW_FLOOR` and the stream halts with `abortReason: 'below-floor'`.
   *   A violating packet NEVER accumulates into `claims[]`.
   *
   * This is the safety mechanism, deliberately independent of (and never
   * relaxed by) the soft `rateDeviationThreshold` monitor, the `onPacket`
   * callback, or any future adaptive-controller signal: a calm tape must
   * not be able to talk the sender into a worse worst case.
   *
   * When omitted, behavior is unchanged (legacy back-compat): the tape is
   * optional and only the soft deviation monitor applies.
   */
  minExchangeRate?: string;
  /**
   * Maker receipt verification key (issue #84, rfc-0039 stream receipts;
   * rolling-swap spec §7.2): 64-char lowercase hex x-only pubkey each
   * per-fulfill receipt's BIP-340 signature is verified against. Defaults
   * to `swapPubkey` (the maker identity key — the swap handler's default
   * receipt signer). Set when the maker provisioned a dedicated receipt key
   * (`CreateSwapHandlerConfig.receiptSecretKey`, e.g. the swap#47 coupled
   * engine's chain-B claim signer key).
   */
  receiptPubkey?: string;
  /**
   * When true, every fulfilled packet MUST carry a verifiable receipt: a
   * receipt-less FULFILL is recorded as a `RECEIPT_MISSING` rejection and
   * the stream halts with `abortReason: 'receipt-invalid'` (a maker that
   * doesn't attest deliveries cannot be audited, so keep the exposure at
   * zero). When omitted/false, receipt-less fulfills from legacy makers
   * degrade gracefully: the claim still accumulates, `result.receipts`
   * is simply empty. A receipt that is PRESENT but fails verification
   * (tampered, wrong key, wrong session, non-monotone, duplicate seq) is
   * ALWAYS a loud `RECEIPT_INVALID` rejection + halt, regardless of this
   * flag — the packet's claim is never accumulated.
   */
  requireReceipts?: boolean;
  /** Per-packet timeout in ms. Default 30000. */
  packetTimeoutMs?: number;
  /**
   * Per-packet PREPARE expiry window in ms. When set, each packet is sent
   * with `expiresAt = now + packetExpiryMs` (computed at send time) so a
   * stalled packet expires deterministically and releases its in-flight
   * slot (rolling-swap R7). When omitted, behavior is unchanged: the
   * transport derives the expiry from its timeout (back-compat default).
   */
  packetExpiryMs?: number;
  /** Optional AbortSignal. */
  signal?: AbortSignal;
  /**
   * Optional pino-compatible logger. Defaults to a no-op.
   *
   * Note: `streamSwap` calls each method with a single structured-event object
   * (e.g., `logger.warn({ event: 'stream_swap.packet_rejected', code, ... })`).
   * Pino accepts this form (the object is logged as top-level fields and the
   * message is left empty); other loggers that expect `(msg, meta)` should
   * wrap accordingly.
   */
  logger?: {
    debug: (...a: unknown[]) => void;
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
}

/**
 * Rate monitoring callback. Fires after each successful FULFILL decryption,
 * before the next packet is sent. If the callback throws or rejects, the
 * stream is treated as stopped.
 */
export type RateMonitorCallback = (
  progress: PacketProgress
) => void | Promise<void>;

/**
 * Progress payload delivered to {@link RateMonitorCallback}. Frozen to
 * prevent callback mutation.
 */
export interface PacketProgress {
  /** 0-indexed packet number within this streamSwap invocation. */
  index: number;
  /**
   * Total number of packets scheduled. In adaptive mode (`controller` set)
   * packet sizing is dynamic, so this is the number scheduled SO FAR.
   */
  total: number;
  /** Source-asset amount sent for this packet (micro-units). */
  sourceAmount: bigint;
  /** Target-asset claim amount derived for this packet (micro-units). */
  targetAmount: bigint;
  /** Rate advertised on the `SwapPair` at swap start (decimal string). */
  advertisedRate: string;
  /** Effective rate for this packet as JS Number (target / source in whole units). Display-only. */
  effectiveRate: number;
  /** Absolute deviation from advertisedRate as a decimal (e.g., 0.0125 = 1.25%). */
  rateDeviation: number;
  /** Cumulative source sent across accepted packets so far (including this one). */
  cumulativeSource: bigint;
  /** Cumulative target received so far (including this one). */
  cumulativeTarget: bigint;
  /**
   * Quote-tape entry (issue #82, rolling-swap spec §7.1): the maker's fresh
   * rate `R_i` actually applied to THIS packet, as reported on the FULFILL
   * metadata. Present iff the maker emitted the tape. The sequence of these
   * values across packets, in `index` order, IS the price tape the adaptive
   * controller (toon#83) consumes.
   */
  rate?: string;
  /** Unix ms timestamp when the maker's rate source produced {@link rate}. Present iff `rate` is. */
  rateTimestamp?: number;
  /**
   * Verified per-fulfill stream receipt (issue #84, rolling-swap spec §7.2).
   * Present iff the maker emitted a receipt AND it verified (signature,
   * session nonce, monotonicity) — an invalid receipt halts the stream
   * before the callback ever fires for that packet.
   */
  receipt?: StreamReceipt;
  /** Controller state at callback time. */
  state: 'running' | 'paused' | 'stopped';
}

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

/**
 * Aggregate result of a `streamSwap()` invocation.
 *
 * @stable — Stories 12.6 and 12.8 depend on this shape.
 */
export interface StreamSwapResult {
  state: 'completed' | 'failed' | 'stopped';
  claims: AccumulatedClaim[];
  rejections: {
    packetIndex: number;
    sourceAmount: bigint;
    code: string;
    message: string;
  }[];
  errors: { packetIndex: number; cause: Error }[];
  abortReason:
    | 'complete'
    | 'aborted'
    | 'stopped'
    | 'callback-stop'
    | 'callback-throw'
    | 'rate-deviation'
    | 'below-floor'
    | 'receipt-invalid'
    | 'all-rejected';
  cumulativeSource: bigint;
  cumulativeTarget: bigint;
  packetsSent: number;
  packetsScheduled: number;
  /**
   * The verified receipt chain for this stream (issue #84, rolling-swap
   * spec §7.2): every receipt that verified against the maker receipt key,
   * sorted by `seq`, plus the superseding `latest`, the signed
   * `totalDelivered`, and any `seq` holes. ALWAYS present — on abort it
   * covers exactly what filled before the halt; against a legacy maker
   * (no receipt support) it is simply empty. Feed to
   * `serializeReceiptChain()` for the portable audit/dispute artifact.
   */
  receipts: StreamReceiptChain;
}

/** External controller returned by {@link streamSwapControlled}. */
export interface StreamSwapController {
  pause(): void;
  resume(): void;
  stop(): void;
  readonly state: 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const RATE_REGEX = /^(0|[1-9]\d*)(\.\d+)?$/;
const HEX64_REGEX = /^[0-9a-f]{64}$/;
// Strict base64: only `=` padding at the end, 0/1/2 pad chars. The character
// class is intentionally restrictive — previous form `/^[A-Za-z0-9+/=]+$/`
// accepted `=` anywhere and non-multiple-of-4 lengths, which could funnel
// malformed payloads into `Buffer.from`/`JSON.parse` and surface confusing
// errors. (Story 12.5 code-review pass #3.)
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

/** True iff `s` is a non-empty, base64-shaped string of length multiple of 4. */
function isBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  return BASE64_REGEX.test(s);
}

/** Length-split `total` into `count` bigints. Remainder absorbed on last element. */
function chunkAmount(total: bigint, count: number): bigint[] {
  if (
    !Number.isInteger(count) ||
    count <= 0 ||
    count > Number.MAX_SAFE_INTEGER
  ) {
    throw new StreamSwapError(
      'INVALID_CHUNKING',
      `packetCount must be a positive integer, got ${count}`
    );
  }
  if (total < BigInt(count)) {
    throw new StreamSwapError(
      'INVALID_CHUNKING',
      `totalAmount (${total}) must be >= packetCount (${count}) so per-packet amount >= 1`
    );
  }
  const base = total / BigInt(count);
  const remainder = total - base * BigInt(count);
  const out: bigint[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = base;
  const last = out[count - 1] ?? 0n;
  out[count - 1] = last + remainder;
  return out;
}

/** Build the kind:20032 unsigned "swap rumor" event per AC-4.
 *
 * Story 12.9 AC-1/AC-6: the returned rumor MUST include a `chain-recipient`
 * tag carrying the sender-supplied chain-format payout address for
 * `pair.to.chain`. The value is echoed verbatim per packet — no case-folding
 * or transformation beyond what the sender-side `validateChainAddress`
 * accepts.
 *
 * Issue #84 (rfc-0039 stream receipts): when `streamNonce` is provided, the
 * rumor also carries a `stream-nonce` tag — the sender-generated session
 * identifier a receipt-capable maker echoes on every per-fulfill receipt.
 * This is the TOON analogue of rfc-0039's Verifier→Receiver Receipt-Nonce
 * provisioning (in-band, per stream). Legacy makers ignore the unknown tag.
 */
function buildSwapRumor(input: {
  senderPubkey: string;
  pair: SwapPair;
  sourceAmount: bigint;
  packetIndex: number;
  totalPackets: number;
  nonce: Uint8Array;
  createdAt: number;
  chainRecipient: string;
  /** 32-char lowercase hex session nonce (issue #84 stream receipts). */
  streamNonce?: string;
}): UnsignedEvent {
  const {
    senderPubkey,
    pair,
    sourceAmount,
    packetIndex,
    totalPackets,
    nonce,
    createdAt,
    chainRecipient,
    streamNonce,
  } = input;
  const tags: string[][] = [
    ['swap-from', `${pair.from.assetCode}:${pair.from.chain}`],
    ['swap-to', `${pair.to.assetCode}:${pair.to.chain}`],
    ['amount', sourceAmount.toString()],
    ['seq', String(packetIndex), String(totalPackets)],
    ['nonce', Buffer.from(nonce).toString('hex')],
    ['chain-recipient', chainRecipient],
  ];
  if (streamNonce !== undefined) tags.push(['stream-nonce', streamNonce]);
  return {
    kind: 20032,
    pubkey: senderPubkey,
    content: '',
    created_at: createdAt,
    tags,
  };
}

const EVM_CHANNEL_ID_REGEX = /^0x[0-9a-f]{64}$/;
const EVM_ADDRESS_REGEX = /^0x[0-9a-f]{40}$/;
const DECIMAL_UINT_REGEX = /^(0|[1-9]\d*)$/;
// Permissive base58 charset (Bitcoin alphabet — no 0, O, I, l).
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Validate a chain-specific address or channelId string. `chain` is the
 * `pair.to.chain` string (e.g., `'evm:base:8453'`, `'solana:mainnet'`).
 *
 * Returns true for valid formats; false otherwise.
 */
export function validateChainAddress(
  value: string,
  chain: string,
  kind: 'channelId' | 'address'
): boolean {
  if (chain.startsWith('evm:')) {
    // #153: viem / EIP-55 emits checksummed (mixed-case) addresses, and
    // callers commonly pass a checksummed `chainRecipient`. Lowercase-normalize
    // before the strict-lowercase-hex regex so a valid checksummed address (or
    // channelId) is accepted instead of being spuriously rejected with
    // INVALID_CHAIN_RECIPIENT / FULFILL_DECODE_FAILED.
    const normalized = value.toLowerCase();
    if (kind === 'channelId') return EVM_CHANNEL_ID_REGEX.test(normalized);
    return EVM_ADDRESS_REGEX.test(normalized);
  }
  if (chain.startsWith('solana:')) {
    // AC-3: base58 decode MUST succeed AND length MUST be 32 bytes. A pure
    // regex + char-length sanity check is too loose — a malformed "32-char"
    // base58 string may decode to 22–24 bytes and slip through.
    if (!BASE58_REGEX.test(value)) return false;
    if (value.length < 32 || value.length > 44) return false;
    try {
      return base58Decode(value).length === 32;
    } catch {
      return false;
    }
  }
  if (chain.startsWith('mina:')) {
    return BASE58_REGEX.test(value) && value.length >= 32;
  }
  // Unknown chain — permit; settlement layer will surface UNSUPPORTED_CHAIN.
  return value.length > 0;
}

/**
 * Decode the FULFILL response `data` (base64-encoded JSON metadata) into
 * the `{ claim, ephemeralPubkey, claimId?, targetAmount?, ...settlement }`
 * shape.
 *
 * Story 12.6 extension: also parses the settlement-context fields
 * (`channelId`, `nonce`, `cumulativeAmount`, `recipient`, `swapSignerAddress`).
 * These are OPTIONAL and best-effort (#153): each is threaded through only
 * when it is a well-formed string for the target chain; an absent or malformed
 * settlement field is silently dropped rather than failing the whole decode,
 * so a fulfilled swap still surfaces its signed `claim` + `ephemeralPubkey`.
 * Only `claim` and `ephemeralPubkey` are strictly required.
 *
 * Issue #82 extension (quote tape, rolling-swap spec §7.1): parses the
 * per-packet quote-tape fields `rate` (decimal string, the maker's fresh
 * `R_i`) and `rateTimestamp` (unix ms). Unlike the best-effort settlement
 * fields, a MALFORMED tape is always a loud `FULFILL_DECODE_FAILED` — a
 * present-but-garbled `rate`/`rateTimestamp`, or one field without the
 * other, fails the decode rather than silently dropping, so a rolling
 * sender can never run blind on a corrupt tape. A wholly ABSENT tape is
 * permitted for legacy makers unless `opts.requireQuoteTape` is set (which
 * `runLoop` does whenever `minExchangeRate` is armed).
 *
 * Issue #84 extension (rfc-0039 stream receipts, spec §7.2): parses the
 * optional `receipt` object into a structurally-validated {@link StreamReceipt}.
 * Like the tape, a PRESENT-but-malformed receipt is a loud
 * `FULFILL_DECODE_FAILED` (a garbled proof must never be silently dropped —
 * the sender would keep streaming while its audit artifact rots); a wholly
 * absent receipt is legacy-maker territory and tolerated here (the
 * `requireReceipts` policy is enforced by the caller, which has the halt
 * machinery). Signature/monotonicity verification is NOT done here — that is
 * `processAcceptedPacket`'s ReceiptChainTracker.
 *
 * @param chain Optional `pair.to.chain` string for per-chain format validation
 *   of channelId / recipient / swapSignerAddress. When omitted, format checks
 *   fall back to a length-only sanity check.
 * @param opts.requireQuoteTape When true, a missing `rate`/`rateTimestamp`
 *   pair is a `FULFILL_DECODE_FAILED` error instead of being tolerated.
 */
function decodeFulfillMetadata(
  data: string | undefined,
  chain?: string,
  opts?: { requireQuoteTape?: boolean }
): {
  claim: string;
  ephemeralPubkey: string;
  claimId?: string;
  /** Optional Swap-reported actual target amount (decimal string). Used for rate deviation when present. */
  targetAmount?: string;
  /** Quote-tape rate `R_i` (decimal string). Present iff the maker emitted the tape. */
  rate?: string;
  /** Quote-tape timestamp (unix ms). Present iff `rate` is. */
  rateTimestamp?: number;
  /** Per-fulfill stream receipt (issue #84) — structurally validated, NOT yet signature-verified. */
  receipt?: StreamReceipt;
  channelId?: string;
  nonce?: string;
  cumulativeAmount?: string;
  recipient?: string;
  swapSignerAddress?: string;
} {
  if (data === undefined || data === null || data === '') {
    throw new StreamSwapError('FULFILL_DECODE_FAILED', 'FULFILL data missing');
  }
  // Quick-fail for obvious non-base64 input. Rejects '@' etc. and strings
  // that aren't a multiple-of-4 length.
  if (!isBase64(data)) {
    throw new StreamSwapError(
      'FULFILL_DECODE_FAILED',
      'FULFILL data is not valid base64'
    );
  }
  let jsonBytes: Buffer;
  try {
    jsonBytes = Buffer.from(data, 'base64');
  } catch (err) {
    throw new StreamSwapError(
      'FULFILL_DECODE_FAILED',
      `FULFILL data base64 decode failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBytes.toString('utf8'));
  } catch (err) {
    throw new StreamSwapError(
      'FULFILL_DECODE_FAILED',
      `FULFILL data JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new StreamSwapError(
      'FULFILL_DECODE_FAILED',
      'FULFILL metadata is not an object'
    );
  }
  const obj = parsed as Record<string, unknown>;
  const claim = obj['claim'];
  const ephemeralPubkey = obj['ephemeralPubkey'];
  if (typeof claim !== 'string' || !isBase64(claim)) {
    throw new StreamSwapError(
      'FULFILL_DECODE_FAILED',
      'FULFILL metadata.claim is missing or not base64 string'
    );
  }
  if (
    typeof ephemeralPubkey !== 'string' ||
    !HEX64_REGEX.test(ephemeralPubkey)
  ) {
    throw new StreamSwapError(
      'FULFILL_DECODE_FAILED',
      'FULFILL metadata.ephemeralPubkey is missing or not 64-char hex'
    );
  }
  const result: {
    claim: string;
    ephemeralPubkey: string;
    claimId?: string;
    targetAmount?: string;
    rate?: string;
    rateTimestamp?: number;
    receipt?: StreamReceipt;
    channelId?: string;
    nonce?: string;
    cumulativeAmount?: string;
    recipient?: string;
    swapSignerAddress?: string;
  } = {
    claim,
    ephemeralPubkey,
  };
  if (typeof obj['claimId'] === 'string') {
    result.claimId = obj['claimId'] as string;
  }
  // Swap-reported target amount (optional). MUST be a non-negative integer
  // decimal string — reject signed / fractional / non-numeric values so a
  // malicious or buggy Swap cannot poison `cumulativeTarget`, the deviation
  // calc, or the `AccumulatedClaim.targetAmount` surface that Story 12.6
  // settles against. Presence of the field with a malformed value is a
  // FULFILL_DECODE_FAILED — the sender cannot safely consume the metadata.
  if (obj['targetAmount'] !== undefined) {
    const ta = obj['targetAmount'];
    if (typeof ta !== 'string' || !/^(0|[1-9]\d*)$/.test(ta)) {
      throw new StreamSwapError(
        'FULFILL_DECODE_FAILED',
        'FULFILL metadata.targetAmount must be a non-negative integer decimal string'
      );
    }
    result.targetAmount = ta;
  }
  // Issue #82 quote tape — `rate` + `rateTimestamp` travel together.
  // Malformed-tape handling is deliberately LOUD (unlike the best-effort
  // settlement fields below): a rolling sender that silently dropped a
  // garbled tape entry would keep streaming blind, starving the floor and
  // the adaptive controller. Absence of BOTH fields is legacy-maker
  // territory and tolerated unless the caller requires the tape.
  const tapeRate = obj['rate'];
  const tapeTimestamp = obj['rateTimestamp'];
  const hasRate = tapeRate !== undefined;
  const hasTimestamp = tapeTimestamp !== undefined;
  if (hasRate !== hasTimestamp) {
    throw new StreamSwapError(
      'FULFILL_DECODE_FAILED',
      'FULFILL metadata quote tape is malformed: rate and rateTimestamp must travel together'
    );
  }
  if (hasRate) {
    if (
      typeof tapeRate !== 'string' ||
      !RATE_REGEX.test(tapeRate) ||
      /^0(\.0+)?$/.test(tapeRate)
    ) {
      throw new StreamSwapError(
        'FULFILL_DECODE_FAILED',
        'FULFILL metadata.rate must be a positive decimal string'
      );
    }
    if (
      typeof tapeTimestamp !== 'number' ||
      !Number.isInteger(tapeTimestamp) ||
      tapeTimestamp <= 0
    ) {
      throw new StreamSwapError(
        'FULFILL_DECODE_FAILED',
        'FULFILL metadata.rateTimestamp must be a positive integer (unix ms)'
      );
    }
    result.rate = tapeRate;
    result.rateTimestamp = tapeTimestamp;
  } else if (opts?.requireQuoteTape === true) {
    throw new StreamSwapError(
      'FULFILL_DECODE_FAILED',
      'FULFILL metadata is missing the quote tape (rate + rateTimestamp) required when minExchangeRate is set'
    );
  }
  // Issue #84 stream receipt — structural validation only (loud on garble,
  // tolerant on absence; see the function doc). Signature verification and
  // monotonicity are enforced downstream against the session tracker.
  if (obj['receipt'] !== undefined) {
    try {
      result.receipt = parseStreamReceipt(obj['receipt']);
    } catch (err) {
      throw new StreamSwapError(
        'FULFILL_DECODE_FAILED',
        `FULFILL metadata.receipt is malformed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }
  // Story 12.6 settlement-context fields — OPTIONAL, best-effort (#153).
  //
  // These five fields are only consumed downstream by `buildSettlementTx()`
  // (Story 12.6), which performs on-chain target redemption — a flow that is
  // itself #82-bounded (synthetic devnet channels) and independently validates
  // every field it consumes before signing. They are NOT required to surface
  // the swap's signed claim to the caller.
  //
  // The previous contract was all-or-nothing AND hard-failed the entire FULFILL
  // decode (`FULFILL_DECODE_FAILED`) on any partial/malformed settlement field.
  // That rejected otherwise-valid swap FULFILLs whenever the swap's real
  // envelope carried, e.g., a cross-chain channelId (an EVM-style hex channelId
  // echoed on a `solana:`/`mina:` target) or a checksummed address — so a
  // fulfilled swap reported `state: failed` with an empty `claims[]`.
  //
  // New contract: thread each settlement field through ONLY when it is a
  // well-formed string for the target chain; silently drop any field that is
  // absent or malformed. A swap whose swap omits/garbles settlement metadata
  // still completes with the signed claim; `buildSettlementTx()` will then
  // surface `MISSING_SETTLEMENT_METADATA` at settlement time if the caller
  // actually attempts on-chain redemption with an incomplete bundle.
  //
  // `recipient` is special-cased: it is the anti-substitution security check in
  // `runLoop` (the swap must echo the sender-supplied `chainRecipient`). We thread
  // it through whenever it is a non-empty string — even if it fails the chain
  // format check — so the runLoop equality check still fires. The equality
  // comparison there is the real boundary; a format-only mismatch must not be
  // silently dropped (which would skip the check entirely).
  const channelId = obj['channelId'];
  if (
    typeof channelId === 'string' &&
    (!chain || validateChainAddress(channelId, chain, 'channelId'))
  ) {
    result.channelId = channelId;
  }
  const nonce = obj['nonce'];
  if (typeof nonce === 'string' && DECIMAL_UINT_REGEX.test(nonce)) {
    result.nonce = nonce;
  }
  const cumulativeAmount = obj['cumulativeAmount'];
  if (
    typeof cumulativeAmount === 'string' &&
    DECIMAL_UINT_REGEX.test(cumulativeAmount)
  ) {
    result.cumulativeAmount = cumulativeAmount;
  }
  const recipient = obj['recipient'];
  if (typeof recipient === 'string' && recipient.length > 0) {
    // Always thread a present recipient so the runLoop anti-substitution
    // equality check (`metadata.recipient === params.chainRecipient`) runs.
    result.recipient = recipient;
  }
  const swapSignerAddress = obj['swapSignerAddress'];
  if (
    typeof swapSignerAddress === 'string' &&
    (!chain || validateChainAddress(swapSignerAddress, chain, 'address'))
  ) {
    result.swapSignerAddress = swapSignerAddress;
  }
  return result;
}

/**
 * Compare two decimal-string rates (RATE_REGEX format) exactly, in BigInt —
 * no float coercion. Returns -1 if `a < b`, 0 if equal, 1 if `a > b`.
 *
 * Used by the issue #82 `minExchangeRate` floor to compare the maker's tape
 * rate `R_i` against the floor without precision loss on long fractions.
 */
function compareDecimalRates(a: string, b: string): -1 | 0 | 1 {
  const split = (s: string): { int: string; frac: string } => {
    const dot = s.indexOf('.');
    return dot === -1
      ? { int: s, frac: '' }
      : { int: s.slice(0, dot), frac: s.slice(dot + 1) };
  };
  const pa = split(a);
  const pb = split(b);
  const scale = Math.max(pa.frac.length, pb.frac.length);
  const av = BigInt(pa.int + pa.frac.padEnd(scale, '0'));
  const bv = BigInt(pb.int + pb.frac.padEnd(scale, '0'));
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** Simple Deferred for pause/resume gating. */
class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (v: T) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror Promise constructor
  reject!: (e: any) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

const noop = (): void => undefined;
const NOOP_LOGGER: NonNullable<StreamSwapParams['logger']> = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

// ---------------------------------------------------------------------------
// Validation (AC-2) — synchronous, fires before any packet
// ---------------------------------------------------------------------------

function validateParams(params: StreamSwapParams): void {
  if (typeof params.totalAmount !== 'bigint' || params.totalAmount <= 0n) {
    throw new StreamSwapError(
      'INVALID_AMOUNT',
      `totalAmount must be a positive bigint, got ${String(params.totalAmount)}`
    );
  }

  const hasCount = params.packetCount !== undefined;
  const hasAmounts = params.packetAmounts !== undefined;
  const hasController = params.controller !== undefined;
  const chunkingModes = [hasCount, hasAmounts, hasController].filter(
    Boolean
  ).length;
  if (chunkingModes !== 1) {
    throw new StreamSwapError(
      'INVALID_CHUNKING',
      'Exactly one of packetCount, packetAmounts, or controller must be provided'
    );
  }

  if (hasController) {
    const c = params.controller as StreamSwapAdaptiveController;
    if (
      typeof c.nextDelta !== 'function' ||
      typeof c.observe !== 'function' ||
      typeof c.window !== 'number'
    ) {
      throw new StreamSwapError(
        'INVALID_STATE',
        'controller must implement nextDelta(remaining), observe(observation), and window'
      );
    }
  } else if (hasCount) {
    const c = params.packetCount as number;
    if (!Number.isInteger(c) || c <= 0) {
      throw new StreamSwapError(
        'INVALID_CHUNKING',
        `packetCount must be a positive integer, got ${c}`
      );
    }
    if (BigInt(c) > params.totalAmount) {
      throw new StreamSwapError(
        'INVALID_CHUNKING',
        `packetCount (${c}) exceeds totalAmount (${params.totalAmount}); per-packet amount would be < 1 micro-unit`
      );
    }
  } else {
    const arr = params.packetAmounts as readonly bigint[];
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new StreamSwapError(
        'INVALID_CHUNKING',
        'packetAmounts must be a non-empty array'
      );
    }
    let sum = 0n;
    for (const a of arr) {
      if (typeof a !== 'bigint' || a <= 0n) {
        throw new StreamSwapError(
          'INVALID_CHUNKING',
          `packetAmounts entries must be positive bigint, got ${String(a)}`
        );
      }
      sum += a;
    }
    if (sum !== params.totalAmount) {
      throw new StreamSwapError(
        'INVALID_CHUNKING',
        `sum(packetAmounts) (${sum}) !== totalAmount (${params.totalAmount})`
      );
    }
  }

  if (
    !(params.senderSecretKey instanceof Uint8Array) ||
    params.senderSecretKey.length !== 32
  ) {
    throw new StreamSwapError(
      'INVALID_STATE',
      'senderSecretKey must be a 32-byte Uint8Array'
    );
  }

  if (
    typeof params.swapPubkey !== 'string' ||
    !HEX64_REGEX.test(params.swapPubkey)
  ) {
    throw new StreamSwapError(
      'INVALID_STATE',
      'swapPubkey must be a 64-char lowercase hex string'
    );
  }

  if (!params.pair || typeof params.pair !== 'object') {
    throw new StreamSwapError('INVALID_PAIR', 'pair is required');
  }
  // Guard the nested `from` / `to` shape before deep-reading `.assetScale` etc.
  // Otherwise malformed input produces a bare TypeError at `applyRate()` or
  // `buildSwapRumor()` instead of a categorized StreamSwapError.
  if (
    !params.pair.from ||
    typeof params.pair.from !== 'object' ||
    typeof params.pair.from.assetCode !== 'string' ||
    typeof params.pair.from.assetScale !== 'number' ||
    typeof params.pair.from.chain !== 'string'
  ) {
    throw new StreamSwapError(
      'INVALID_PAIR',
      'pair.from must have { assetCode: string, assetScale: number, chain: string }'
    );
  }
  if (
    !params.pair.to ||
    typeof params.pair.to !== 'object' ||
    typeof params.pair.to.assetCode !== 'string' ||
    typeof params.pair.to.assetScale !== 'number' ||
    typeof params.pair.to.chain !== 'string'
  ) {
    throw new StreamSwapError(
      'INVALID_PAIR',
      'pair.to must have { assetCode: string, assetScale: number, chain: string }'
    );
  }
  if (
    typeof params.pair.rate !== 'string' ||
    !RATE_REGEX.test(params.pair.rate)
  ) {
    throw new StreamSwapError(
      'INVALID_PAIR',
      `pair.rate must match ${RATE_REGEX}, got ${params.pair.rate}`
    );
  }
  try {
    applyRate({
      sourceAmount: 1n,
      fromScale: params.pair.from.assetScale,
      toScale: params.pair.to.assetScale,
      rate: params.pair.rate,
    });
  } catch (err) {
    throw new StreamSwapError(
      'INVALID_PAIR',
      `pair failed applyRate sanity check: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  if (
    params.rateDeviationThreshold !== undefined &&
    (typeof params.rateDeviationThreshold !== 'number' ||
      !Number.isFinite(params.rateDeviationThreshold) ||
      params.rateDeviationThreshold < 0)
  ) {
    throw new StreamSwapError(
      'INVALID_STATE',
      `rateDeviationThreshold must be a non-negative finite number, got ${params.rateDeviationThreshold}`
    );
  }

  // Issue #82: minExchangeRate is a hard floor — decimal string, strictly
  // positive (a zero floor is "no floor"; omit the param instead). The
  // format + non-zero constraints here are exactly applyRate's throw
  // conditions, so the per-packet floor computation cannot throw mid-stream.
  if (params.minExchangeRate !== undefined) {
    if (
      typeof params.minExchangeRate !== 'string' ||
      !RATE_REGEX.test(params.minExchangeRate) ||
      /^0(\.0+)?$/.test(params.minExchangeRate)
    ) {
      throw new StreamSwapError(
        'INVALID_STATE',
        `minExchangeRate must be a positive decimal string matching ${RATE_REGEX}, got ${String(
          params.minExchangeRate
        )}`
      );
    }
  }

  // Issue #84: receipt verification key — same shape as swapPubkey.
  if (
    params.receiptPubkey !== undefined &&
    (typeof params.receiptPubkey !== 'string' ||
      !HEX64_REGEX.test(params.receiptPubkey))
  ) {
    throw new StreamSwapError(
      'INVALID_STATE',
      'receiptPubkey must be a 64-char lowercase hex string'
    );
  }
  if (
    params.requireReceipts !== undefined &&
    typeof params.requireReceipts !== 'boolean'
  ) {
    throw new StreamSwapError(
      'INVALID_STATE',
      `requireReceipts must be a boolean, got ${String(params.requireReceipts)}`
    );
  }

  if (
    params.packetExpiryMs !== undefined &&
    (typeof params.packetExpiryMs !== 'number' ||
      !Number.isInteger(params.packetExpiryMs) ||
      params.packetExpiryMs <= 0)
  ) {
    throw new StreamSwapError(
      'INVALID_STATE',
      `packetExpiryMs must be a positive integer (ms), got ${params.packetExpiryMs}`
    );
  }

  // Story 12.9 AC-4 / AC-5: `chainRecipient` is REQUIRED and MUST validate
  // against `pair.to.chain`. Defense-in-depth for JS callers who bypass the
  // TS interface (the field is declared non-optional on StreamSwapParams).
  if (
    typeof params.chainRecipient !== 'string' ||
    params.chainRecipient.length === 0
  ) {
    throw new StreamSwapError(
      'INVALID_STATE',
      'chainRecipient must be a non-empty string (sender payout address for pair.to.chain)'
    );
  }
  if (
    !validateChainAddress(
      params.chainRecipient,
      params.pair.to.chain,
      'address'
    )
  ) {
    throw new StreamSwapError(
      'INVALID_CHAIN_RECIPIENT',
      `chainRecipient ${params.chainRecipient} is malformed for chain ${params.pair.to.chain}`
    );
  }
}

// ---------------------------------------------------------------------------
// Core: streamSwapControlled (AC-6, AC-7, AC-10)
// ---------------------------------------------------------------------------

/**
 * Drive a multi-packet swap against a Swap and return a `StreamSwapResult`.
 *
 * `streamSwap()` does NOT throw on mid-stream failure — inspect the result's
 * `state`, `abortReason`, `rejections[]`, and `errors[]` to diagnose.
 *
 * @example
 * ```ts
 * // Discover the SwapPair from the Swap's kind:10032 peer-info event (Story 12.1).
 * const result = await streamSwap({
 *   client: toonClient,
 *   swapPubkey: swap.pubkey,
 *   swapIlpAddress: 'g.toon.swap1',
 *   pair,
 *   senderSecretKey,
 *   totalAmount: 1_000_000n,
 *   packetCount: 10,
 *   onPacket: (p) => console.log('packet', p.index, 'rate', p.effectiveRate),
 *   rateDeviationThreshold: 0.02,
 * });
 * // Feed result.claims into buildSettlementTx() from Story 12.6.
 * ```
 *
 * @throws {StreamSwapError} Only for construction-time validation failures
 *   (INVALID_AMOUNT, INVALID_CHUNKING, INVALID_PAIR, INVALID_STATE).
 */
export async function streamSwap(
  params: StreamSwapParams
): Promise<StreamSwapResult> {
  // Note: validation errors are thrown synchronously inside
  // `streamSwapControlled`. We wrap the call so construction-time throws
  // become Promise rejections for ergonomic `await` / `.rejects` handling.
  return streamSwapControlled(params).result;
}

/**
 * Two-form variant of {@link streamSwap} that additionally returns a
 * {@link StreamSwapController} with `pause()` / `resume()` / `stop()`.
 *
 * @throws {StreamSwapError} Synchronously for construction-time validation.
 */
export function streamSwapControlled(params: StreamSwapParams): {
  result: Promise<StreamSwapResult>;
  controller: StreamSwapController;
} {
  // Construction-time validation — synchronous throw per AC-2 & AC-9.
  validateParams(params);

  const logger = params.logger ?? NOOP_LOGGER;

  // Derive schedule. In adaptive mode (`controller` set) there is no static
  // schedule — packet sizing is decided per-packet by the controller.
  const schedule: bigint[] = params.packetAmounts
    ? [...params.packetAmounts]
    : params.packetCount !== undefined
      ? chunkAmount(params.totalAmount, params.packetCount)
      : [];

  // Freeze a defensive copy of `pair` so callers can't mutate the stored
  // reference on every AccumulatedClaim post-call. (Story 12.5 code-review
  // pass #3.) Shape matches SwapPair (Story 12.1 stable type).
  const frozenPair: SwapPair = Object.freeze({
    from: Object.freeze({ ...params.pair.from }),
    to: Object.freeze({ ...params.pair.to }),
    rate: params.pair.rate,
  }) as SwapPair;

  const senderPubkey = getPublicKey(params.senderSecretKey);

  // Issue #84 (rfc-0039 stream receipts): one 16-byte session nonce per
  // streamSwap invocation, advertised on every rumor's `stream-nonce` tag.
  // The sender plays rfc-0039's Verifier role — it generates the nonce and
  // verifies each per-fulfill receipt the maker signs against it.
  const streamNonceBytes = new Uint8Array(16);
  getRandomValues(streamNonceBytes);
  const streamNonce = Buffer.from(streamNonceBytes).toString('hex');

  // Controller state machine
  type State = 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
  let streamState: State = 'running';
  let resumeDeferred: Deferred<'resume' | 'stop'> | null = null;

  const controller: StreamSwapController = {
    pause(): void {
      if (streamState === 'running') {
        streamState = 'paused';
        // resumeDeferred will be created on first await in loop
      }
    },
    resume(): void {
      if (streamState === 'paused') {
        streamState = 'running';
        if (resumeDeferred) {
          resumeDeferred.resolve('resume');
          resumeDeferred = null;
        }
      } else if (streamState === 'running') {
        // no-op
      } else {
        throw new StreamSwapError(
          'INVALID_STATE',
          `Cannot resume from state "${streamState}"`
        );
      }
    },
    stop(): void {
      if (streamState === 'completed' || streamState === 'failed') return;
      const prev = streamState;
      streamState = 'stopped';
      if (prev === 'paused' && resumeDeferred) {
        resumeDeferred.resolve('stop');
        resumeDeferred = null;
      }
    },
    get state(): State {
      return streamState;
    },
  };

  const getState = (): State => streamState;
  const setState = (v: State): void => {
    streamState = v;
  };
  const waitForResumeOrStop = (): Promise<'resume' | 'stop'> => {
    if (streamState !== 'paused')
      return Promise.resolve('resume' as 'resume' | 'stop');
    if (!resumeDeferred) resumeDeferred = new Deferred<'resume' | 'stop'>();
    return resumeDeferred.promise;
  };

  const result = params.controller
    ? runAdaptiveLoop(
        params,
        frozenPair,
        senderPubkey,
        streamNonce,
        logger,
        getState,
        setState,
        waitForResumeOrStop
      )
    : runLoop(
        params,
        frozenPair,
        schedule,
        senderPubkey,
        streamNonce,
        logger,
        getState,
        setState,
        waitForResumeOrStop
      );

  return { result, controller };
}

// ---------------------------------------------------------------------------
// Shared per-packet machinery (legacy + adaptive loops)
// ---------------------------------------------------------------------------

/** Mutable accumulator context shared by the loop and per-packet processing. */
interface PacketProcessCtx {
  params: StreamSwapParams;
  pair: SwapPair;
  logger: NonNullable<StreamSwapParams['logger']>;
  getState: () => 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
  claims: AccumulatedClaim[];
  rejections: StreamSwapResult['rejections'];
  errors: StreamSwapResult['errors'];
  cumulative: { source: bigint; target: bigint };
  /** Issue #84: session receipt accumulator/verifier (one per stream). */
  receiptTracker: ReceiptChainTracker;
}

/**
 * Outcome of processing one ACCEPTED (fulfilled) packet. `'error'`,
 * `'recipient-mismatch'`, `'below-floor'`, and `'callback-throw'` have
 * already pushed their entry onto `ctx.errors` / `ctx.rejections`; the
 * caller only decides continue-vs-halt.
 */
type ProcessedPacket =
  | {
      status: 'accepted';
      targetAmount: bigint;
      rateDeviation: number;
      rate?: string;
      rateTimestamp?: number;
    }
  | { status: 'error' }
  | { status: 'recipient-mismatch' }
  | { status: 'below-floor' }
  | { status: 'receipt-invalid' }
  | { status: 'callback-throw' };

/**
 * Build the swap rumor + gift wrap for one packet. Throws on wrap failure
 * (callers record the error and skip the packet).
 */
function buildAndWrapPacket(input: {
  params: StreamSwapParams;
  pair: SwapPair;
  senderPubkey: string;
  sourceAmount: bigint;
  /** 1-based sequence number for the rumor `seq` tag. */
  seq: number;
  /** Total packets for the `seq` tag; `0` = unknown (adaptive mode). */
  totalPackets: number;
  /** Issue #84: session nonce advertised as the rumor `stream-nonce` tag. */
  streamNonce: string;
}): { toonData: Uint8Array; packetExpiresAt?: Date } {
  const {
    params,
    pair,
    senderPubkey,
    sourceAmount,
    seq,
    totalPackets,
    streamNonce,
  } = input;
  const nonce = new Uint8Array(16);
  getRandomValues(nonce);
  const rumor = buildSwapRumor({
    senderPubkey,
    pair,
    sourceAmount,
    packetIndex: seq,
    totalPackets,
    nonce,
    createdAt: Math.floor(Date.now() / 1000),
    chainRecipient: params.chainRecipient,
    streamNonce,
  });

  // Per-packet expiry (issue #81 / rolling-swap R7): computed at send
  // time so a stalled packet expires deterministically. Undefined when
  // packetExpiryMs is not set -> transport keeps its timeout-derived
  // default (back-compat).
  const packetExpiresAt =
    params.packetExpiryMs !== undefined
      ? new Date(Date.now() + params.packetExpiryMs)
      : undefined;

  const wrapped = wrapSwapPacketToToon({
    rumor,
    senderSecretKey: params.senderSecretKey,
    recipientPubkey: params.swapPubkey,
    destination: params.swapIlpAddress,
    amount: sourceAmount,
    ...(packetExpiresAt !== undefined && { expiresAt: packetExpiresAt }),
  });
  // `wrapped.ilpPrepare.data` is base64 per buildIlpPrepare. Decode back
  // to raw bytes for the sender API (Uint8Array contract in AC-3).
  const toonData = new Uint8Array(
    Buffer.from(wrapped.ilpPrepare.data, 'base64')
  );
  return {
    toonData,
    ...(packetExpiresAt !== undefined && { packetExpiresAt }),
  };
}

/**
 * Process one fulfilled packet: decode metadata, run the anti-substitution
 * recipient check, enforce the `minExchangeRate` hard floor, decrypt +
 * accumulate the claim, and fire `onPacket`. Extracted verbatim from the
 * Story 12.5 loop so the legacy and adaptive (issue #83) loops share ONE
 * implementation — the floor semantics cannot drift between the two paths.
 */
async function processAcceptedPacket(
  ctx: PacketProcessCtx,
  args: {
    packetIndex: number;
    /** Value surfaced as `PacketProgress.total`. */
    totalForProgress: number;
    sourceAmount: bigint;
    /** FULFILL response `data` (base64 metadata). */
    data: string | undefined;
  }
): Promise<ProcessedPacket> {
  const { params, pair, logger } = ctx;
  const { packetIndex, totalForProgress, sourceAmount, data } = args;

  // --- Decode FULFILL metadata ---
  // Issue #82: when the minExchangeRate floor is armed, the quote tape is
  // REQUIRED on every fulfilled packet — a maker that doesn't emit it (or
  // garbles it) produces a loud per-packet FULFILL_DECODE_FAILED, never a
  // silent drop.
  let metadata: {
    claim: string;
    ephemeralPubkey: string;
    claimId?: string;
    targetAmount?: string;
    rate?: string;
    rateTimestamp?: number;
    receipt?: StreamReceipt;
    channelId?: string;
    nonce?: string;
    cumulativeAmount?: string;
    recipient?: string;
    swapSignerAddress?: string;
  };
  try {
    metadata = decodeFulfillMetadata(data, pair.to.chain, {
      requireQuoteTape: params.minExchangeRate !== undefined,
    });
  } catch (err) {
    logger.error({
      event: 'stream_swap.fulfill_decode_failed',
      packetIndex,
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.errors.push({
      packetIndex,
      cause: err instanceof Error ? err : new Error(String(err)),
    });
    return { status: 'error' };
  }

  // Story 12.9 AC-7: when the Swap echoes a `recipient` in FULFILL metadata
  // (Story 12.6 settlement context), it MUST equal the sender-supplied
  // `chainRecipient`. A mismatch indicates the Swap is substituting its own
  // address — refuse to accumulate the claim and surface a per-packet
  // rejection with a clear reason code. Missing recipient = legacy
  // (pre-12.6) metadata, permitted.
  //
  // #153: EVM addresses are case-insensitive (EIP-55 checksum casing is
  // purely a typo-detection hint). The swap lowercases its echoed recipient
  // while the sender may pass a checksummed `chainRecipient` (or vice versa);
  // compare case-insensitively on EVM targets so a casing-only difference is
  // NOT flagged as a substitution attack. Non-EVM chains keep the exact
  // (base58 case-sensitive) comparison.
  const isEvmTarget = pair.to.chain.startsWith('evm:');
  const recipientMatches =
    metadata.recipient === undefined ||
    (isEvmTarget
      ? metadata.recipient.toLowerCase() === params.chainRecipient.toLowerCase()
      : metadata.recipient === params.chainRecipient);
  if (!recipientMatches) {
    logger.warn({
      event: 'stream_swap.recipient_mismatch',
      packetIndex,
      expected: params.chainRecipient,
      actual: metadata.recipient,
    });
    ctx.rejections.push({
      packetIndex,
      sourceAmount,
      code: 'SWAP_RECIPIENT_MISMATCH',
      message: `Swap echoed recipient ${metadata.recipient} but sender expected ${params.chainRecipient}`,
    });
    return { status: 'recipient-mismatch' };
  }

  // --- Issue #82: minExchangeRate hard floor (rfc-0029 semantics) ---
  // Runs BEFORE claim decryption/accumulation and BEFORE the onPacket
  // callback, and consults NOTHING but the floor itself — not the soft
  // deviation monitor, not the callback, not any controller signal (the
  // issue #83 adaptive controller observes packets strictly AFTER this
  // check and has no seam to weaken it). Two independent breach
  // conditions, either one trips the floor:
  //   1. the maker's tape rate `R_i` is below minExchangeRate (exact
  //      BigInt decimal comparison), or
  //   2. the delivered targetAmount is below ⌊sourceAmount·minRate⌋
  //      (catches a maker painting a rosy tape while under-delivering).
  // A breach is a hard stop: the packet is recorded as a BELOW_FLOOR
  // rejection (never a claims[] success) and the stream halts — filling
  // further packets against a maker quoting under the floor would keep
  // committing source value below the sender's declared worst case.
  if (params.minExchangeRate !== undefined) {
    // requireQuoteTape guarantees both tape fields are present here.
    const tapeRate = metadata.rate as string;
    const floorTargetAmount = applyRate({
      sourceAmount,
      fromScale: pair.from.assetScale,
      toScale: pair.to.assetScale,
      rate: params.minExchangeRate,
    });
    const deliveredTargetAmount: bigint =
      metadata.targetAmount !== undefined
        ? BigInt(metadata.targetAmount)
        : applyRate({
            sourceAmount,
            fromScale: pair.from.assetScale,
            toScale: pair.to.assetScale,
            rate: tapeRate,
          });
    const tapeBelowFloor =
      compareDecimalRates(tapeRate, params.minExchangeRate) < 0;
    if (tapeBelowFloor || deliveredTargetAmount < floorTargetAmount) {
      logger.warn({
        event: 'stream_swap.below_floor',
        packetIndex,
        rate: tapeRate,
        rateTimestamp: metadata.rateTimestamp,
        minExchangeRate: params.minExchangeRate,
        targetAmount: deliveredTargetAmount.toString(),
        floorTargetAmount: floorTargetAmount.toString(),
      });
      ctx.rejections.push({
        packetIndex,
        sourceAmount,
        code: 'BELOW_FLOOR',
        message: `Packet fill below minExchangeRate floor: rate ${tapeRate}, targetAmount ${deliveredTargetAmount} < floor ${params.minExchangeRate} (${floorTargetAmount})`,
      });
      return { status: 'below-floor' };
    }
  }

  // --- Issue #84: stream-receipt verification (rfc-0039 semantics) ---
  // Runs AFTER the floor (a below-floor packet is rejected before its
  // receipt is ever considered — a sender-rejected packet contributes NO
  // receipt to the chain) and BEFORE claim decryption/accumulation: a
  // packet whose proof-of-delivery is forged, replayed from another
  // session, or breaks the monotone cumulative MUST NOT accumulate, and
  // the stream halts — continuing would commit more source value while
  // the audit/dispute artifact is already known-corrupt.
  //   - present + verifies      → accumulate receipt alongside the claim
  //   - absent + !requireReceipts → legacy maker, degrade gracefully
  //   - absent + requireReceipts  → RECEIPT_MISSING rejection + halt
  //   - present + fails verification → RECEIPT_INVALID rejection + halt
  // The receipt's attested tape entry must also match the metadata tape —
  // a maker signing one rate while quoting another is equivocating.
  let verifiedReceipt: StreamReceipt | undefined;
  if (metadata.receipt !== undefined) {
    const receipt = metadata.receipt;
    let failure: string | undefined;
    if (metadata.rate !== undefined && receipt.rate !== metadata.rate) {
      failure = `receipt.rate ${receipt.rate} does not match tape rate ${metadata.rate}`;
    } else if (
      metadata.rateTimestamp !== undefined &&
      receipt.rateTimestamp !== metadata.rateTimestamp
    ) {
      failure = `receipt.rateTimestamp ${receipt.rateTimestamp} does not match tape rateTimestamp ${metadata.rateTimestamp}`;
    } else {
      const added = ctx.receiptTracker.add(receipt);
      if (!added.ok) failure = `${added.code}: ${added.message}`;
    }
    if (failure !== undefined) {
      logger.warn({
        event: 'stream_swap.receipt_invalid',
        packetIndex,
        seq: receipt.seq,
        error: failure,
      });
      ctx.rejections.push({
        packetIndex,
        sourceAmount,
        code: 'RECEIPT_INVALID',
        message: `Stream receipt failed verification: ${failure}`,
      });
      return { status: 'receipt-invalid' };
    }
    verifiedReceipt = receipt;
  } else if (params.requireReceipts === true) {
    logger.warn({
      event: 'stream_swap.receipt_missing',
      packetIndex,
    });
    ctx.rejections.push({
      packetIndex,
      sourceAmount,
      code: 'RECEIPT_MISSING',
      message:
        'FULFILL carried no stream receipt but requireReceipts is set (legacy maker without rfc-0039 receipt support?)',
    });
    return { status: 'receipt-invalid' };
  }

  // --- Decrypt claim ---
  let claimBytes: Uint8Array;
  try {
    const ciphertext = new Uint8Array(Buffer.from(metadata.claim, 'base64'));
    claimBytes = decryptFulfillClaim({
      ciphertext,
      ephemeralPubkey: metadata.ephemeralPubkey,
      recipientSecretKey: params.senderSecretKey,
    });
  } catch (err) {
    logger.error({
      event: 'stream_swap.decrypt_failed',
      packetIndex,
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.errors.push({
      packetIndex,
      cause: err instanceof Error ? err : new Error(String(err)),
    });
    return { status: 'error' };
  }

  if (claimBytes.length === 0) {
    logger.warn({
      event: 'stream_swap.empty_claim_bytes',
      packetIndex,
    });
  }

  // --- Compute expected + actual target + deviation ---
  const expectedTargetAmount = applyRate({
    sourceAmount,
    fromScale: pair.from.assetScale,
    toScale: pair.to.assetScale,
    rate: pair.rate,
  });

  // If the Swap includes a `targetAmount` in the FULFILL metadata, use it
  // (chain-specific parsing of `claimBytes` is Story 12.6's job). Otherwise
  // fall back to the advertised-rate expected amount so settlement-time
  // verification still has a baseline.
  // `metadata.targetAmount`, when present, is already validated as a
  // non-negative integer decimal string by `decodeFulfillMetadata`, so
  // `BigInt()` is safe here (no try/catch needed).
  const targetAmount: bigint =
    metadata.targetAmount !== undefined
      ? BigInt(metadata.targetAmount)
      : expectedTargetAmount;

  // BigInt-safe deviation: scale up by 1e6 before dividing so we don't lose
  // precision on 18-decimal assets. (Epic 11 retro MAX_SAFE_INTEGER guard.)
  let rateDeviation = 0;
  if (expectedTargetAmount > 0n) {
    const diff =
      targetAmount >= expectedTargetAmount
        ? targetAmount - expectedTargetAmount
        : expectedTargetAmount - targetAmount;
    const scaled = (diff * 1_000_000n) / expectedTargetAmount;
    rateDeviation = Number(scaled) / 1_000_000;
  }

  // Display-only effectiveRate for the callback payload. Guard against
  // non-finite results (e.g., advertisedRate=0 + any deviation -> 0;
  // parseFloat surprises) so callback consumers never observe NaN/Infinity.
  const advertisedRate = parseFloat(pair.rate);
  let effectiveRate: number;
  if (targetAmount === expectedTargetAmount) {
    effectiveRate = advertisedRate;
  } else {
    const signedDeviation =
      targetAmount >= expectedTargetAmount ? rateDeviation : -rateDeviation;
    effectiveRate = advertisedRate * (1 + signedDeviation);
  }
  if (!Number.isFinite(effectiveRate)) {
    effectiveRate = advertisedRate;
  }

  ctx.cumulative.source += sourceAmount;
  ctx.cumulative.target += targetAmount;

  const accumulated: AccumulatedClaim = {
    packetIndex,
    sourceAmount,
    targetAmount,
    claimBytes,
    swapEphemeralPubkey: metadata.ephemeralPubkey,
    pair,
    receivedAt: Date.now(),
  };
  if (metadata.claimId !== undefined) accumulated.claimId = metadata.claimId;
  // Story 12.6: thread settlement-context fields through when present.
  if (metadata.channelId !== undefined)
    accumulated.channelId = metadata.channelId;
  if (metadata.nonce !== undefined) accumulated.nonce = metadata.nonce;
  if (metadata.cumulativeAmount !== undefined)
    accumulated.cumulativeAmount = metadata.cumulativeAmount;
  if (metadata.recipient !== undefined)
    accumulated.recipient = metadata.recipient;
  if (metadata.swapSignerAddress !== undefined)
    accumulated.swapSignerAddress = metadata.swapSignerAddress;
  // Issue #82: persist the quote-tape entry on the accumulated claim so
  // post-hoc consumers (settlement audit, controller replay) retain the
  // per-packet `R_i` sequence. Both-or-neither is enforced by the decoder.
  if (metadata.rate !== undefined) {
    accumulated.rate = metadata.rate;
    accumulated.rateTimestamp = metadata.rateTimestamp as number;
  }
  // Issue #84: the verified receipt persists alongside its claim.
  if (verifiedReceipt !== undefined) accumulated.receipt = verifiedReceipt;
  ctx.claims.push(accumulated);

  logger.debug({
    event: 'stream_swap.packet_accepted',
    packetIndex,
    sourceAmount: sourceAmount.toString(),
    targetAmount: targetAmount.toString(),
  });

  // --- onPacket callback ---
  if (params.onPacket) {
    const progress: PacketProgress = Object.freeze({
      index: packetIndex,
      total: totalForProgress,
      sourceAmount,
      targetAmount,
      advertisedRate: pair.rate,
      effectiveRate,
      rateDeviation,
      cumulativeSource: ctx.cumulative.source,
      cumulativeTarget: ctx.cumulative.target,
      // Issue #82 quote tape: surface the maker's fresh per-packet quote
      // to the callback (the adaptive-controller seam, toon#83).
      ...(metadata.rate !== undefined && {
        rate: metadata.rate,
        rateTimestamp: metadata.rateTimestamp as number,
      }),
      // Issue #84: surface the verified per-fulfill receipt to the callback.
      ...(verifiedReceipt !== undefined && { receipt: verifiedReceipt }),
      state:
        ctx.getState() === 'paused'
          ? 'paused'
          : ctx.getState() === 'stopped'
            ? 'stopped'
            : 'running',
    });

    try {
      const maybePromise = params.onPacket(progress);
      if (
        maybePromise &&
        typeof (maybePromise as Promise<void>).then === 'function'
      ) {
        await maybePromise;
      }
    } catch (err) {
      logger.warn({
        event: 'stream_swap.callback_threw',
        packetIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      ctx.errors.push({
        packetIndex,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
      return { status: 'callback-throw' };
    }
  }

  return {
    status: 'accepted',
    targetAmount,
    rateDeviation,
    ...(metadata.rate !== undefined && {
      rate: metadata.rate,
      rateTimestamp: metadata.rateTimestamp as number,
    }),
  };
}

/** Map the accumulated context + abort reason to the terminal result. */
function finalizeResult(input: {
  ctx: PacketProcessCtx;
  abortReason: StreamSwapResult['abortReason'];
  packetsSent: number;
  packetsScheduled: number;
  setState: (
    v: 'running' | 'paused' | 'stopped' | 'completed' | 'failed'
  ) => void;
}): StreamSwapResult {
  const { claims, rejections, errors, cumulative } = input.ctx;
  let { abortReason } = input;

  let finalState: 'completed' | 'failed' | 'stopped';
  if (abortReason === 'aborted' || abortReason === 'stopped') {
    finalState = 'stopped';
  } else if (
    claims.length === 0 &&
    (rejections.length > 0 || errors.length > 0)
  ) {
    finalState = 'failed';
    // If we drained the entire schedule without accepting any claim AND the
    // only failures were Swap rejections, surface that explicitly so callers
    // can distinguish "all rejected" from "loop aborted early with no claims".
    if (
      abortReason === 'complete' &&
      rejections.length > 0 &&
      errors.length === 0
    ) {
      abortReason = 'all-rejected';
    }
  } else {
    finalState = 'completed';
  }

  input.setState(finalState);

  return {
    state: finalState,
    claims,
    rejections,
    errors,
    abortReason,
    cumulativeSource: cumulative.source,
    cumulativeTarget: cumulative.target,
    packetsSent: input.packetsSent,
    packetsScheduled: input.packetsScheduled,
    // Issue #84: the verified receipt chain — present on abort too,
    // covering exactly the packets that filled before the halt.
    receipts: input.ctx.receiptTracker.chain(),
  };
}

// ---------------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------------

async function runLoop(
  params: StreamSwapParams,
  pair: SwapPair,
  schedule: bigint[],
  senderPubkey: string,
  streamNonce: string,
  logger: NonNullable<StreamSwapParams['logger']>,
  getState: () => 'running' | 'paused' | 'stopped' | 'completed' | 'failed',
  setState: (
    v: 'running' | 'paused' | 'stopped' | 'completed' | 'failed'
  ) => void,
  waitForResumeOrStop: () => Promise<'resume' | 'stop'>
): Promise<StreamSwapResult> {
  const ctx: PacketProcessCtx = {
    params,
    pair,
    logger,
    getState,
    claims: [],
    rejections: [],
    errors: [],
    cumulative: { source: 0n, target: 0n },
    receiptTracker: new ReceiptChainTracker({
      streamNonce,
      makerPubkey: params.receiptPubkey ?? params.swapPubkey,
    }),
  };
  let packetsSent = 0;
  let abortReason: StreamSwapResult['abortReason'] = 'complete';

  const totalPackets = schedule.length;

  // Snapshot the signal abort state at each check — we don't listen via
  // addEventListener because we check at loop boundaries (between packets).
  const isAborted = (): boolean => params.signal?.aborted === true;

  packetLoop: for (
    let packetIndex = 0;
    packetIndex < totalPackets;
    packetIndex++
  ) {
    // --- Abort/stop/pause checks at loop boundary ---
    if (isAborted()) {
      abortReason = 'aborted';
      break;
    }
    if (getState() === 'stopped') {
      abortReason = 'stopped';
      break;
    }
    if (getState() === 'paused') {
      const resumedBy = await waitForResumeOrStop();
      if (resumedBy === 'stop' || getState() === 'stopped') {
        abortReason = 'stopped';
        break;
      }
      // After resume, re-check abort signal
      if (isAborted()) {
        abortReason = 'aborted';
        break;
      }
    }

    // Bounds-checked at loop init (`packetIndex < totalPackets === schedule.length`).
    // Narrow out the `undefined` TS widening without silently masking with 0n,
    // which would hide a real bug if the schedule were ever mutated mid-loop.
    // (Story 12.5 code-review pass #3.)
    const sourceAmount = schedule[packetIndex];
    if (sourceAmount === undefined) {
      // Defensive: should be impossible given the bound check. Surface, don't mask.
      throw new StreamSwapError(
        'INVALID_STATE',
        `schedule[${packetIndex}] is undefined; schedule was mutated mid-stream`
      );
    }

    // --- Build + wrap packet ---
    let built: { toonData: Uint8Array; packetExpiresAt?: Date };
    try {
      built = buildAndWrapPacket({
        params,
        pair,
        senderPubkey,
        sourceAmount,
        seq: packetIndex + 1,
        totalPackets,
        streamNonce,
      });
    } catch (err) {
      logger.error({
        event: 'stream_swap.wrap_failed',
        packetIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      ctx.errors.push({
        packetIndex,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
      continue;
    }
    const { toonData, packetExpiresAt } = built;

    // --- Send packet via client ---
    let sendResult: IlpSendResultLike;
    try {
      sendResult = await params.client.sendSwapPacket({
        destination: params.swapIlpAddress,
        amount: sourceAmount,
        toonData,
        timeout: params.packetTimeoutMs ?? 30000,
        claim: params.claim,
        ...(packetExpiresAt !== undefined && { expiresAt: packetExpiresAt }),
      });
      packetsSent += 1;
    } catch (err) {
      logger.error({
        event: 'stream_swap.send_failed',
        packetIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      ctx.errors.push({
        packetIndex,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
      continue;
    }

    // --- Rejection path ---
    if (!sendResult.accepted) {
      const code = sendResult.code ?? 'F00';
      const message = sendResult.message ?? 'rejected';
      logger.warn({
        event: 'stream_swap.packet_rejected',
        packetIndex,
        code,
        message,
      });
      ctx.rejections.push({ packetIndex, sourceAmount, code, message });
      continue;
    }

    // --- Process the fulfilled packet (decode -> recipient check ->
    //     minExchangeRate floor -> decrypt -> accumulate -> onPacket),
    //     shared with the adaptive loop (issue #83) ---
    const outcome = await processAcceptedPacket(ctx, {
      packetIndex,
      totalForProgress: totalPackets,
      sourceAmount,
      data: sendResult.data,
    });
    if (outcome.status === 'error' || outcome.status === 'recipient-mismatch') {
      continue;
    }
    if (outcome.status === 'below-floor') {
      abortReason = 'below-floor';
      break packetLoop;
    }
    if (outcome.status === 'receipt-invalid') {
      abortReason = 'receipt-invalid';
      break packetLoop;
    }
    if (outcome.status === 'callback-throw') {
      abortReason = 'callback-throw';
      break packetLoop;
    }

    // --- Abort signal / stop check AFTER callback (so tests can abort
    //     inside onPacket and we exit the loop on the next iteration's
    //     boundary check — but honor stopped/aborted without running
    //     additional packets). ---
    if (isAborted()) {
      abortReason = 'aborted';
      break;
    }
    if (getState() === 'stopped') {
      abortReason = 'stopped';
      break;
    }

    // --- Rate deviation check (after callback, after accumulation) ---
    if (
      params.rateDeviationThreshold !== undefined &&
      outcome.rateDeviation > params.rateDeviationThreshold
    ) {
      abortReason = 'rate-deviation';
      break;
    }
  }

  return finalizeResult({
    ctx,
    abortReason,
    packetsSent,
    packetsScheduled: totalPackets,
    setState,
  });
}

// ---------------------------------------------------------------------------
// Adaptive loop (issue #83) — controller-driven δ sizing + W-packet window
// ---------------------------------------------------------------------------

/**
 * Classify a transport-level send failure into a controller resolution
 * class: timeouts/expiries are TIMING signals (shrink W), everything else
 * is a generic error (shrink δ).
 */
function classifySendError(err: Error): PacketResolution {
  return /timeout|timed out|expire/i.test(err.message) ? 'timeout' : 'error';
}

/**
 * Classify an ILP reject into a controller resolution class (spec §4/§6):
 * - `T99` — the maker staleness reject (`stale_rate`, swap#48) → 'reject-stale'
 * - `R`-class (expiry) or timeout-shaped messages → 'timeout'
 * - anything else → 'reject'
 */
function classifyReject(code: string, message: string): PacketResolution {
  if (code === 'T99' || /stale[_-]?rate/i.test(message)) return 'reject-stale';
  if (code.startsWith('R') || /timeout|timed out|expire/i.test(message)) {
    return 'timeout';
  }
  return 'reject';
}

/**
 * Controller-driven variant of {@link runLoop} (issue #83, rolling-swap spec
 * §6). Differences from the legacy loop:
 *
 * - No static schedule: each packet's size δ comes from
 *   `controller.nextDelta(remaining)` at send time (already capped by
 *   `ε/(v·τ)` inside the controller; defensively clamped to
 *   `[1, remaining]` here).
 * - Up to `controller.window` (W) packets are kept in flight concurrently.
 * - Every packet resolution is fed back via `controller.observe(...)` with
 *   measured RTT, the quote-tape entry, realized amounts, and a resolution
 *   class — the controller applies its one-knob-per-step ramp and persists.
 * - On halt (floor breach, deviation, stop, abort, callback throw) no new
 *   packets are scheduled but already-sent in-flight packets are drained so
 *   their claims (committed value) are still harvested.
 *
 * The `minExchangeRate` floor is enforced inside the SHARED
 * `processAcceptedPacket` — before the controller observes anything — so
 * controller state can never weaken it.
 *
 * Failed/rejected packet slices are NOT re-scheduled (`streamSwap` does not
 * retry packets); like the legacy loop, a failed packet reduces the filled
 * amount.
 */
async function runAdaptiveLoop(
  params: StreamSwapParams,
  pair: SwapPair,
  senderPubkey: string,
  streamNonce: string,
  logger: NonNullable<StreamSwapParams['logger']>,
  getState: () => 'running' | 'paused' | 'stopped' | 'completed' | 'failed',
  setState: (
    v: 'running' | 'paused' | 'stopped' | 'completed' | 'failed'
  ) => void,
  waitForResumeOrStop: () => Promise<'resume' | 'stop'>
): Promise<StreamSwapResult> {
  const controller = params.controller as StreamSwapAdaptiveController;
  const ctx: PacketProcessCtx = {
    params,
    pair,
    logger,
    getState,
    claims: [],
    rejections: [],
    errors: [],
    cumulative: { source: 0n, target: 0n },
    receiptTracker: new ReceiptChainTracker({
      streamNonce,
      makerPubkey: params.receiptPubkey ?? params.swapPubkey,
    }),
  };
  let packetsSent = 0;
  let abortReason: StreamSwapResult['abortReason'] = 'complete';
  let halted = false;
  let remaining = params.totalAmount;
  let nextIndex = 0;

  const isAborted = (): boolean => params.signal?.aborted === true;
  const halt = (reason: StreamSwapResult['abortReason']): void => {
    if (!halted) {
      halted = true;
      abortReason = reason;
    }
  };

  /** Feed the controller; a controller/persistence failure never kills the stream. */
  const observeSafe = async (obs: PacketObservation): Promise<void> => {
    try {
      await controller.observe(obs);
    } catch (err) {
      logger.warn({
        event: 'stream_swap.controller_observe_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  interface SettledPacket {
    index: number;
    sourceAmount: bigint;
    /** Measured round-trip time, ms. */
    rttMs: number;
    result?: IlpSendResultLike;
    error?: Error;
  }
  const inflight = new Map<number, Promise<SettledPacket>>();

  for (;;) {
    // --- Boundary checks (mirror the legacy loop) ---
    if (!halted && isAborted()) halt('aborted');
    if (!halted && getState() === 'stopped') halt('stopped');
    if (!halted && getState() === 'paused' && inflight.size === 0) {
      const resumedBy = await waitForResumeOrStop();
      if (resumedBy === 'stop' || getState() === 'stopped') halt('stopped');
      else if (isAborted()) halt('aborted');
    }

    // --- Schedule: fill the in-flight window ---
    if (!halted && getState() === 'running') {
      const rawWindow = controller.window;
      const window =
        Number.isFinite(rawWindow) && rawWindow >= 1
          ? Math.floor(rawWindow)
          : 1;
      while (remaining > 0n && inflight.size < window) {
        let delta: bigint;
        try {
          delta = controller.nextDelta(remaining);
        } catch (err) {
          logger.error({
            event: 'stream_swap.controller_next_delta_failed',
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.errors.push({
            packetIndex: nextIndex,
            cause: err instanceof Error ? err : new Error(String(err)),
          });
          halt('callback-throw');
          break;
        }
        // Defensive clamp: δ ∈ [1, remaining] regardless of controller.
        if (typeof delta !== 'bigint' || delta < 1n) delta = 1n;
        if (delta > remaining) delta = remaining;

        const packetIndex = nextIndex;
        nextIndex += 1;
        remaining -= delta;

        let built: { toonData: Uint8Array; packetExpiresAt?: Date };
        try {
          built = buildAndWrapPacket({
            params,
            pair,
            senderPubkey,
            sourceAmount: delta,
            seq: packetIndex + 1,
            // Adaptive mode: the final packet count is unknown upfront —
            // `0` in the rumor's `seq` tag total position means "open".
            totalPackets: 0,
            streamNonce,
          });
        } catch (err) {
          logger.error({
            event: 'stream_swap.wrap_failed',
            packetIndex,
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.errors.push({
            packetIndex,
            cause: err instanceof Error ? err : new Error(String(err)),
          });
          continue;
        }
        const { toonData, packetExpiresAt } = built;

        const sentAt = Date.now();
        const promise: Promise<SettledPacket> = (async () => {
          try {
            const result = await params.client.sendSwapPacket({
              destination: params.swapIlpAddress,
              amount: delta,
              toonData,
              timeout: params.packetTimeoutMs ?? 30000,
              claim: params.claim,
              ...(packetExpiresAt !== undefined && {
                expiresAt: packetExpiresAt,
              }),
            });
            return {
              index: packetIndex,
              sourceAmount: delta,
              rttMs: Date.now() - sentAt,
              result,
            };
          } catch (err) {
            return {
              index: packetIndex,
              sourceAmount: delta,
              rttMs: Date.now() - sentAt,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        })();
        inflight.set(packetIndex, promise);
      }
    }

    // --- Done? (nothing in flight and either drained or halted) ---
    if (inflight.size === 0) {
      if (halted || remaining <= 0n) break;
      // Paused with an empty window: loop back to the boundary wait.
      if (getState() === 'paused') continue;
      // Running with remaining > 0 and nothing in flight: every slice in
      // this round failed to wrap. Nothing can progress — finish.
      break;
    }

    // --- Await the next completion and process it ---
    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.index);

    if (settled.error) {
      logger.error({
        event: 'stream_swap.send_failed',
        packetIndex: settled.index,
        error: settled.error.message,
      });
      ctx.errors.push({ packetIndex: settled.index, cause: settled.error });
      await observeSafe({
        resolution: classifySendError(settled.error),
        rttMs: settled.rttMs,
        remaining,
      });
      continue;
    }
    packetsSent += 1;
    const sendResult = settled.result as IlpSendResultLike;

    if (!sendResult.accepted) {
      const code = sendResult.code ?? 'F00';
      const message = sendResult.message ?? 'rejected';
      logger.warn({
        event: 'stream_swap.packet_rejected',
        packetIndex: settled.index,
        code,
        message,
      });
      ctx.rejections.push({
        packetIndex: settled.index,
        sourceAmount: settled.sourceAmount,
        code,
        message,
      });
      await observeSafe({
        resolution: classifyReject(code, message),
        rttMs: settled.rttMs,
        remaining,
      });
      continue;
    }

    const outcome = await processAcceptedPacket(ctx, {
      packetIndex: settled.index,
      totalForProgress: nextIndex,
      sourceAmount: settled.sourceAmount,
      data: sendResult.data,
    });

    switch (outcome.status) {
      case 'error':
        await observeSafe({
          resolution: 'error',
          rttMs: settled.rttMs,
          remaining,
        });
        break;
      case 'recipient-mismatch':
        await observeSafe({
          resolution: 'reject',
          rttMs: settled.rttMs,
          remaining,
        });
        break;
      case 'below-floor':
        // The floor already hard-stopped the packet (shared logic). Feed the
        // shrink signal so the persisted tuple starts cautious next session,
        // then halt the stream. The observation happens strictly AFTER the
        // floor decision — the controller cannot influence it.
        await observeSafe({
          resolution: 'reject',
          rttMs: settled.rttMs,
          remaining,
        });
        halt('below-floor');
        break;
      case 'receipt-invalid':
        // Forged/missing proof-of-delivery (issue #84). Shared logic already
        // recorded the rejection; feed a shrink signal so the persisted
        // tuple starts cautious against this maker, then halt. In-flight
        // packets drain (their claims/receipts are still harvested) but
        // nothing new is scheduled.
        await observeSafe({
          resolution: 'reject',
          rttMs: settled.rttMs,
          remaining,
        });
        halt('receipt-invalid');
        break;
      case 'callback-throw':
        // The fill itself was clean; the sender's own callback threw.
        await observeSafe({
          resolution: 'fulfill',
          rttMs: settled.rttMs,
          remaining,
        });
        halt('callback-throw');
        break;
      case 'accepted': {
        await observeSafe({
          resolution: 'fulfill',
          rttMs: settled.rttMs,
          remaining,
          sourceAmount: settled.sourceAmount,
          targetAmount: outcome.targetAmount,
          ...(outcome.rate !== undefined && {
            rate: outcome.rate,
            rateTimestamp: outcome.rateTimestamp as number,
          }),
        });
        if (isAborted()) halt('aborted');
        else if (getState() === 'stopped') halt('stopped');
        else if (
          params.rateDeviationThreshold !== undefined &&
          outcome.rateDeviation > params.rateDeviationThreshold
        ) {
          halt('rate-deviation');
        }
        break;
      }
    }
  }

  return finalizeResult({
    ctx,
    abortReason,
    packetsSent,
    packetsScheduled: nextIndex,
    setState,
  });
}

// ---------------------------------------------------------------------------
// Crypto RNG — prefer globalThis.crypto; fall back to node:crypto.webcrypto.
// ---------------------------------------------------------------------------

function getRandomValues(buf: Uint8Array): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- defensive env probe
  const g: any = globalThis as any;
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(buf);
    return buf;
  }
  // Node 18/20 fallback
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- fallback only
  const nodeCrypto = require('node:crypto') as {
    webcrypto?: { getRandomValues: (b: Uint8Array) => Uint8Array };
    randomFillSync?: (b: Uint8Array) => Uint8Array;
  };
  if (nodeCrypto.webcrypto?.getRandomValues) {
    nodeCrypto.webcrypto.getRandomValues(buf);
    return buf;
  }
  if (nodeCrypto.randomFillSync) {
    nodeCrypto.randomFillSync(buf);
    return buf;
  }
  throw new StreamSwapError(
    'INVALID_STATE',
    'No crypto.getRandomValues available in this environment'
  );
}

// Re-export `chunkAmount` / `decodeFulfillMetadata` / `buildSwapRumor` via a
// single-purpose testing surface so unit tests can exercise helpers directly.
// This surface is NOT part of the public SDK; it is intentionally excluded
// from `packages/sdk/src/index.ts` per AC-1.
export const __testing = {
  chunkAmount,
  decodeFulfillMetadata,
  buildSwapRumor,
  compareDecimalRates,
};
