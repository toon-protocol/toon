/**
 * Mill Swap Handler (Story 12.3)
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
import type { Handler } from './handler-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters passed to a {@link ClaimIssuer.issueClaim} call. */
export interface IssueClaimParams {
  /** Source-asset amount received by the Mill (ILP packet amount, source micro-units). */
  sourceAmount: bigint;
  /** Target-asset amount owed to the sender (post-rate-conversion, target micro-units). */
  targetAmount: bigint;
  /** The `SwapPair` this packet is being priced against. */
  pair: SwapPair;
  /** The sender's real pubkey (extracted from the unwrapped seal). */
  senderPubkey: string;
  /** The inner rumor (for optional Mill-side context; may be ignored by the issuer). */
  rumor: UnsignedEvent;
}

/** Result returned from {@link ClaimIssuer.issueClaim}. */
export interface IssueClaimResult {
  /** Signed claim bytes ready for NIP-44 encryption (chain-specific format). */
  claim: Uint8Array;
  /** Optional Mill-side claim ID for logging/tracing. */
  claimId?: string;
}

/**
 * Pluggable signed-claim issuer. Story 12.3 defines only the contract — the
 * concrete multi-chain implementation ships in Story 12.4.
 *
 * The issuer owns inventory accounting and signing-key material. The handler
 * relies on `issueClaim()` being atomic with inventory debit: if the call
 * resolves, the target-asset amount MUST be considered committed from the
 * Mill's reserves. If the call throws, no inventory change SHOULD have occurred.
 */
export interface ClaimIssuer {
  /**
   * Produce a signed off-chain payment-channel claim in the target asset.
   *
   * @throws Error (or subclass) on insufficient reserves, unsupported pair,
   * or signing failure. Errors with `code === 'INSUFFICIENT_INVENTORY'` or
   * messages matching `/insufficient/i` are surfaced as ILP T04; all other
   * errors as T00.
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

/** Minimal pino-compatible logger interface. */
export interface SwapHandlerLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Configuration for {@link createSwapHandler}. */
export interface CreateSwapHandlerConfig {
  /** Mill's secp256k1 secret key for unwrapping gift-wrapped packets (32 bytes). */
  recipientSecretKey: Uint8Array;
  /** Swap pairs this Mill currently supports. */
  swapPairs: SwapPair[];
  /** Claim issuer delegate (Story 12.4 plugs in the multi-chain implementation). */
  claimIssuer: ClaimIssuer;
  /**
   * Optional live-rate override hook. When provided, the handler calls this per
   * packet instead of reading `pair.rate`. MUST return a decimal string matching
   * `SwapPair.rate` format: /^(0|[1-9]\d*)(\.\d+)?$/.
   */
  rateProvider?: (pair: SwapPair) => string | Promise<string>;
  /**
   * Optional replay-protection set. When provided, the handler computes a
   * deterministic packet ID = sha256(senderPubkey || sourceAmount || rumor.id)
   * and rejects duplicates with ILP F04. Operator is responsible for bounding
   * this set (e.g., LRU) — this module does not pull in an LRU dep.
   */
  seenPacketIds?: Set<string>;
  /** Optional pino-compatible logger. Defaults to a no-op logger. */
  logger?: SwapHandlerLogger;
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
 * Rounds toward zero (integer division), which economically favors the Mill
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
  if (rate === '0') {
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
 * Construct a kind:1059 Mill inbound-swap handler.
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

  const logger = config.logger ?? NOOP_LOGGER;

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

    // AC-11: replay protection check. We RESERVE the packetId synchronously
    // here (before the first `await`) so that two concurrent invocations with
    // an identical packet ID cannot both pass the `has()` gate. Because the
    // JS event loop is cooperative, the check-and-add pair is atomic relative
    // to other microtasks as long as it straddles no `await`. If issuance or
    // encryption later fails, we release the reservation so the sender can
    // legitimately retry (AC-11 requires retries of rejected packets).
    let packetId: string | null = null;
    if (config.seenPacketIds) {
      packetId = computePacketId(senderPubkey, ctx.amount, rumor);
      if (config.seenPacketIds.has(packetId)) {
        logger.debug({
          event: 'swap_handler.duplicate_packet',
          packetId,
        });
        return ctx.reject('F04', 'Duplicate packet');
      }
      // Reserve eagerly to close the concurrent check-then-add race.
      config.seenPacketIds.add(packetId);
    }

    // Helper: release the replay reservation on failure so the sender can retry.
    const releaseReservation = (): void => {
      if (config.seenPacketIds && packetId) {
        config.seenPacketIds.delete(packetId);
      }
    };

    // AC-9 rate resolution (optional live hook per D12-006).
    let rate: string;
    try {
      rate = config.rateProvider ? await config.rateProvider(pair) : pair.rate;
    } catch (err) {
      logger.error({
        event: 'swap_handler.rate_provider_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      releaseReservation();
      return ctx.reject('T00', 'Rate provider error');
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
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({
        event: 'swap_handler.rate_conversion_failed',
        error: msg,
      });
      // Do NOT surface the internal rate string / validation detail to the
      // sender -- return a generic privacy-preserving message.
      releaseReservation();
      return ctx.reject('T00', 'Rate conversion error');
    }

    // AC-9: delegate to claim issuer
    let claim: Uint8Array;
    let claimId: string | undefined;
    try {
      const result = await config.claimIssuer.issueClaim({
        sourceAmount: ctx.amount,
        targetAmount,
        pair,
        senderPubkey,
        rumor,
      });
      claim = result.claim;
      claimId = result.claimId;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'INSUFFICIENT_INVENTORY' || /insufficient/i.test(message)) {
        logger.warn({
          event: 'swap_handler.insufficient_inventory',
          error: message,
        });
        releaseReservation();
        return ctx.reject('T04', 'Insufficient liquidity');
      }
      logger.error({
        event: 'swap_handler.issuer_failed',
        error: message,
      });
      releaseReservation();
      return ctx.reject('T00', 'Internal error');
    }

    // AC-10: NIP-44 encrypt the claim (Story 12.2 handles ephemeral-key zeroing).
    let ciphertext: Uint8Array;
    let ephemeralPubkey: string;
    try {
      const enc = encryptFulfillClaim({ claimData: claim, senderPubkey });
      ciphertext = enc.ciphertext;
      ephemeralPubkey = enc.ephemeralPubkey;
    } catch (err) {
      logger.error({
        event: 'swap_handler.encrypt_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      releaseReservation();
      return ctx.reject('T00', 'Internal error');
    }

    // AC-11: packetId was reserved pre-issuance to close the concurrent
    // check-then-add race; it remains committed on this success path.

    const claimBase64 = Buffer.from(ciphertext).toString('base64');
    logger.info({
      event: 'swap_handler.claim_issued',
      claimId,
      ephemeralPubkey,
    });

    const metadata: Record<string, unknown> = {
      claim: claimBase64,
      ephemeralPubkey,
    };
    if (claimId !== undefined) metadata['claimId'] = claimId;

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
