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
  /** Even-split packet count. EXACTLY ONE of this or `packetAmounts` is required. */
  packetCount?: number;
  /** Explicit per-packet amounts. EXACTLY ONE of this or `packetCount` is required. */
  packetAmounts?: readonly bigint[];
  /** Source-asset balance proof claim. Required unless ChannelManager is wired. */
  claim?: SignedBalanceProofLike;
  /** Rate monitoring callback (fires after each accepted FULFILL). */
  onPacket?: RateMonitorCallback;
  /** Rate deviation threshold (decimal, e.g., 0.02 = 2%). */
  rateDeviationThreshold?: number;
  /** Per-packet timeout in ms. Default 30000. */
  packetTimeoutMs?: number;
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
  /** Total number of packets scheduled. */
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
    | 'all-rejected';
  cumulativeSource: bigint;
  cumulativeTarget: bigint;
  packetsSent: number;
  packetsScheduled: number;
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
  } = input;
  return {
    kind: 20032,
    pubkey: senderPubkey,
    content: '',
    created_at: createdAt,
    tags: [
      ['swap-from', `${pair.from.assetCode}:${pair.from.chain}`],
      ['swap-to', `${pair.to.assetCode}:${pair.to.chain}`],
      ['amount', sourceAmount.toString()],
      ['seq', String(packetIndex), String(totalPackets)],
      ['nonce', Buffer.from(nonce).toString('hex')],
      ['chain-recipient', chainRecipient],
    ],
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
 * @param chain Optional `pair.to.chain` string for per-chain format validation
 *   of channelId / recipient / swapSignerAddress. When omitted, format checks
 *   fall back to a length-only sanity check.
 */
function decodeFulfillMetadata(
  data: string | undefined,
  chain?: string
): {
  claim: string;
  ephemeralPubkey: string;
  claimId?: string;
  /** Optional Swap-reported actual target amount (decimal string). Used for rate deviation when present. */
  targetAmount?: string;
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
  if (hasCount === hasAmounts) {
    throw new StreamSwapError(
      'INVALID_CHUNKING',
      'Exactly one of packetCount or packetAmounts must be provided'
    );
  }

  if (hasCount) {
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

  // Derive schedule
  const schedule: bigint[] = params.packetAmounts
    ? [...params.packetAmounts]
    : chunkAmount(params.totalAmount, params.packetCount as number);

  // Freeze a defensive copy of `pair` so callers can't mutate the stored
  // reference on every AccumulatedClaim post-call. (Story 12.5 code-review
  // pass #3.) Shape matches SwapPair (Story 12.1 stable type).
  const frozenPair: SwapPair = Object.freeze({
    from: Object.freeze({ ...params.pair.from }),
    to: Object.freeze({ ...params.pair.to }),
    rate: params.pair.rate,
  }) as SwapPair;

  const senderPubkey = getPublicKey(params.senderSecretKey);

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

  const result = runLoop(
    params,
    frozenPair,
    schedule,
    senderPubkey,
    logger,
    () => streamState,
    (v: State) => {
      streamState = v;
    },
    () => {
      if (streamState !== 'paused') return Promise.resolve('resume');
      if (!resumeDeferred) resumeDeferred = new Deferred<'resume' | 'stop'>();
      return resumeDeferred.promise;
    }
  );

  return { result, controller };
}

// ---------------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------------

async function runLoop(
  params: StreamSwapParams,
  pair: SwapPair,
  schedule: bigint[],
  senderPubkey: string,
  logger: NonNullable<StreamSwapParams['logger']>,
  getState: () => 'running' | 'paused' | 'stopped' | 'completed' | 'failed',
  setState: (
    v: 'running' | 'paused' | 'stopped' | 'completed' | 'failed'
  ) => void,
  waitForResumeOrStop: () => Promise<'resume' | 'stop'>
): Promise<StreamSwapResult> {
  const claims: AccumulatedClaim[] = [];
  const rejections: StreamSwapResult['rejections'] = [];
  const errors: StreamSwapResult['errors'] = [];
  let cumulativeSource = 0n;
  let cumulativeTarget = 0n;
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
    const nonce = new Uint8Array(16);
    getRandomValues(nonce);
    const rumor = buildSwapRumor({
      senderPubkey,
      pair,
      sourceAmount,
      packetIndex: packetIndex + 1,
      totalPackets,
      nonce,
      createdAt: Math.floor(Date.now() / 1000),
      chainRecipient: params.chainRecipient,
    });

    let toonData: Uint8Array;
    try {
      const wrapped = wrapSwapPacketToToon({
        rumor,
        senderSecretKey: params.senderSecretKey,
        recipientPubkey: params.swapPubkey,
        destination: params.swapIlpAddress,
        amount: sourceAmount,
      });
      // `wrapped.ilpPrepare.data` is base64 per buildIlpPrepare. Decode back
      // to raw bytes for the sender API (Uint8Array contract in AC-3).
      toonData = new Uint8Array(Buffer.from(wrapped.ilpPrepare.data, 'base64'));
    } catch (err) {
      logger.error({
        event: 'stream_swap.wrap_failed',
        packetIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      errors.push({
        packetIndex,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
      continue;
    }

    // --- Send packet via client ---
    let sendResult: IlpSendResultLike;
    try {
      sendResult = await params.client.sendSwapPacket({
        destination: params.swapIlpAddress,
        amount: sourceAmount,
        toonData,
        timeout: params.packetTimeoutMs ?? 30000,
        claim: params.claim,
      });
      packetsSent += 1;
    } catch (err) {
      logger.error({
        event: 'stream_swap.send_failed',
        packetIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      errors.push({
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
      rejections.push({ packetIndex, sourceAmount, code, message });
      continue;
    }

    // --- Decode FULFILL metadata ---
    let metadata: {
      claim: string;
      ephemeralPubkey: string;
      claimId?: string;
      targetAmount?: string;
      channelId?: string;
      nonce?: string;
      cumulativeAmount?: string;
      recipient?: string;
      swapSignerAddress?: string;
    };
    try {
      metadata = decodeFulfillMetadata(sendResult.data, pair.to.chain);
    } catch (err) {
      logger.error({
        event: 'stream_swap.fulfill_decode_failed',
        packetIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      errors.push({
        packetIndex,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
      continue;
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
        ? metadata.recipient.toLowerCase() ===
          params.chainRecipient.toLowerCase()
        : metadata.recipient === params.chainRecipient);
    if (!recipientMatches) {
      logger.warn({
        event: 'stream_swap.recipient_mismatch',
        packetIndex,
        expected: params.chainRecipient,
        actual: metadata.recipient,
      });
      rejections.push({
        packetIndex,
        sourceAmount,
        code: 'SWAP_RECIPIENT_MISMATCH',
        message: `Swap echoed recipient ${metadata.recipient} but sender expected ${params.chainRecipient}`,
      });
      continue;
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
      errors.push({
        packetIndex,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
      continue;
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

    cumulativeSource += sourceAmount;
    cumulativeTarget += targetAmount;

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
    claims.push(accumulated);

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
        total: totalPackets,
        sourceAmount,
        targetAmount,
        advertisedRate: pair.rate,
        effectiveRate,
        rateDeviation,
        cumulativeSource,
        cumulativeTarget,
        state:
          getState() === 'paused'
            ? 'paused'
            : getState() === 'stopped'
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
        errors.push({
          packetIndex,
          cause: err instanceof Error ? err : new Error(String(err)),
        });
        abortReason = 'callback-throw';
        break packetLoop;
      }
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
      rateDeviation > params.rateDeviationThreshold
    ) {
      abortReason = 'rate-deviation';
      break;
    }
  }

  // --- Terminal state ---
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

  setState(finalState);

  return {
    state: finalState,
    claims,
    rejections,
    errors,
    abortReason,
    cumulativeSource,
    cumulativeTarget,
    packetsSent,
    packetsScheduled: totalPackets,
  };
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
};
