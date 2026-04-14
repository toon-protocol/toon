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
  /** Mill's 64-char lowercase hex pubkey (recipient of gift wrap). */
  millPubkey: string;
  /** Mill's ILP destination address (e.g., 'g.toon.mill1'). */
  millIlpAddress: string;
  /** The `SwapPair` being executed (from kind:10032 discovery, Story 12.1). */
  pair: SwapPair;
  /** Sender's 32-byte secp256k1 secret key. Used for seal signing AND FULFILL decryption. */
  senderSecretKey: Uint8Array;
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
  /** Mill's ephemeral pubkey from the FULFILL (64-char lowercase hex). */
  millEphemeralPubkey: string;
  /** Optional Mill-side claim ID (passed through from handler metadata). */
  claimId?: string;
  /** Swap pair this claim was priced against (copy of `pair` for settlement-time routing). */
  pair: SwapPair;
  /** Unix ms timestamp when this claim was accepted. */
  receivedAt: number;
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

/** Build the kind:20032 unsigned "swap rumor" event per AC-4. */
function buildSwapRumor(input: {
  senderPubkey: string;
  pair: SwapPair;
  sourceAmount: bigint;
  packetIndex: number;
  totalPackets: number;
  nonce: Uint8Array;
  createdAt: number;
}): UnsignedEvent {
  const {
    senderPubkey,
    pair,
    sourceAmount,
    packetIndex,
    totalPackets,
    nonce,
    createdAt,
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
    ],
  };
}

/**
 * Decode the FULFILL response `data` (base64-encoded JSON metadata) into
 * the `{ claim, ephemeralPubkey, claimId? }` shape per AC-12.
 */
function decodeFulfillMetadata(data: string | undefined): {
  claim: string;
  ephemeralPubkey: string;
  claimId?: string;
  /** Optional Mill-reported actual target amount (decimal string). Used for rate deviation when present. */
  targetAmount?: string;
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
  } = {
    claim,
    ephemeralPubkey,
  };
  if (typeof obj['claimId'] === 'string') {
    result.claimId = obj['claimId'] as string;
  }
  // Mill-reported target amount (optional). MUST be a non-negative integer
  // decimal string — reject signed / fractional / non-numeric values so a
  // malicious or buggy Mill cannot poison `cumulativeTarget`, the deviation
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
    typeof params.millPubkey !== 'string' ||
    !HEX64_REGEX.test(params.millPubkey)
  ) {
    throw new StreamSwapError(
      'INVALID_STATE',
      'millPubkey must be a 64-char lowercase hex string'
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
}

// ---------------------------------------------------------------------------
// Core: streamSwapControlled (AC-6, AC-7, AC-10)
// ---------------------------------------------------------------------------

/**
 * Drive a multi-packet swap against a Mill and return a `StreamSwapResult`.
 *
 * `streamSwap()` does NOT throw on mid-stream failure — inspect the result's
 * `state`, `abortReason`, `rejections[]`, and `errors[]` to diagnose.
 *
 * @example
 * ```ts
 * // Discover the SwapPair from the Mill's kind:10032 peer-info event (Story 12.1).
 * const result = await streamSwap({
 *   client: toonClient,
 *   millPubkey: mill.pubkey,
 *   millIlpAddress: 'g.toon.mill1',
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
    });

    let toonData: Uint8Array;
    try {
      const wrapped = wrapSwapPacketToToon({
        rumor,
        senderSecretKey: params.senderSecretKey,
        recipientPubkey: params.millPubkey,
        destination: params.millIlpAddress,
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
        destination: params.millIlpAddress,
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
    };
    try {
      metadata = decodeFulfillMetadata(sendResult.data);
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

    // If the Mill includes a `targetAmount` in the FULFILL metadata, use it
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
      millEphemeralPubkey: metadata.ephemeralPubkey,
      pair,
      receivedAt: Date.now(),
    };
    if (metadata.claimId !== undefined) accumulated.claimId = metadata.claimId;
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
    // only failures were Mill rejections, surface that explicitly so callers
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
