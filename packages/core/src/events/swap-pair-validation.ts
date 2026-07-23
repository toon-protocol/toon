/**
 * Shared validation logic for `SwapPair` structures used by kind:10032
 * `IlpPeerInfo` events (Epic 12 — Token Swap Primitive, Story 12.1).
 *
 * The same rules are enforced in two places: the builder (before serializing
 * outgoing events) and the parser (when ingesting events from the wire).
 * Keeping both paths in this module guarantees they cannot diverge.
 *
 * @see Story 12.1 AC-5 for the full rule set.
 */

import { ToonError, InvalidEventError } from '../errors.js';
import { validateChainId } from '../chain/chain-id.js';
import type { SwapPair } from '../types.js';

/** Result of validating an unknown value as a `SwapPair`. */
export type SwapPairValidationResult =
  | { valid: true }
  | { valid: false; reason: string; field: string };

/**
 * Non-negative decimal rate: no leading zeros (except `0`), no exponent, no trailing dot.
 * Rate `"0"` is explicitly valid (means "not currently quoting this pair").
 *
 * Both regexes are linear (no alternation over overlapping classes, no nested
 * quantifiers), so they are not vulnerable to catastrophic backtracking (ReDoS).
 */
const RATE_REGEX = /^(0|[1-9]\d*)(\.\d+)?$/;

/** Non-negative integer (micro-unit) amount. */
const AMOUNT_REGEX = /^\d+$/;

/**
 * Hard cap on numeric string length for `rate`, `minAmount`, and `maxAmount`.
 *
 * `BigInt(str)` is super-linear in the length of `str` (V8 implements it in
 * roughly O(n²)), so an attacker could publish a `kind:10032` event with a
 * multi-megabyte numeric string and force parsers to burn CPU on a single
 * `BigInt()` call during the `minAmount <= maxAmount` cross-check. 80 digits
 * accommodates any realistic token micro-unit amount (2^256 ≈ 78 decimal
 * digits, which is the theoretical ceiling for EVM uint256 balances) with
 * headroom, while keeping `BigInt` conversion effectively constant-time.
 */
const MAX_NUMERIC_STRING_LENGTH = 80;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateAsset(
  asset: unknown,
  side: 'from' | 'to'
): SwapPairValidationResult {
  if (!isObject(asset)) {
    return {
      valid: false,
      reason: `${side} must be an object`,
      field: side,
    };
  }
  if (!isNonEmptyString(asset['assetCode'])) {
    return {
      valid: false,
      reason: `${side}.assetCode must be a non-empty string`,
      field: `${side}.assetCode`,
    };
  }
  if (!isNonNegativeInteger(asset['assetScale'])) {
    return {
      valid: false,
      reason: `${side}.assetScale must be a non-negative integer`,
      field: `${side}.assetScale`,
    };
  }
  if (typeof asset['chain'] !== 'string' || !validateChainId(asset['chain'])) {
    return {
      valid: false,
      reason: `${side}.chain must be a valid chain identifier (e.g., "evm:base:8453")`,
      field: `${side}.chain`,
    };
  }
  return { valid: true };
}

/**
 * Validates an unknown value as a `SwapPair` per AC-5 rules.
 * Pure function — never throws. Returns a discriminated union so callers
 * can emit context-appropriate errors (build-time vs parse-time).
 */
export function isValidSwapPair(pair: unknown): SwapPairValidationResult {
  if (!isObject(pair)) {
    return { valid: false, reason: 'pair must be an object', field: '' };
  }

  const fromResult = validateAsset(pair['from'], 'from');
  if (!fromResult.valid) return fromResult;

  const toResult = validateAsset(pair['to'], 'to');
  if (!toResult.valid) return toResult;

  if (
    typeof pair['rate'] !== 'string' ||
    pair['rate'].length > MAX_NUMERIC_STRING_LENGTH ||
    !RATE_REGEX.test(pair['rate'])
  ) {
    return {
      valid: false,
      reason: `rate must be a non-negative decimal string (no leading zeros, no exponent, max ${MAX_NUMERIC_STRING_LENGTH} chars)`,
      field: 'rate',
    };
  }

  if (pair['minAmount'] !== undefined) {
    if (
      typeof pair['minAmount'] !== 'string' ||
      pair['minAmount'].length > MAX_NUMERIC_STRING_LENGTH ||
      !AMOUNT_REGEX.test(pair['minAmount'])
    ) {
      return {
        valid: false,
        reason: `minAmount must be a non-negative integer string (max ${MAX_NUMERIC_STRING_LENGTH} digits)`,
        field: 'minAmount',
      };
    }
  }

  if (pair['maxAmount'] !== undefined) {
    if (
      typeof pair['maxAmount'] !== 'string' ||
      pair['maxAmount'].length > MAX_NUMERIC_STRING_LENGTH ||
      !AMOUNT_REGEX.test(pair['maxAmount'])
    ) {
      return {
        valid: false,
        reason: `maxAmount must be a non-negative integer string (max ${MAX_NUMERIC_STRING_LENGTH} digits)`,
        field: 'maxAmount',
      };
    }
  }

  if (pair['minAmount'] !== undefined && pair['maxAmount'] !== undefined) {
    // Use BigInt — amounts may exceed Number.MAX_SAFE_INTEGER (Epic 11 retro guard).
    if (BigInt(pair['minAmount'] as string) > BigInt(pair['maxAmount'] as string)) {
      return {
        valid: false,
        reason: 'minAmount must not exceed maxAmount',
        field: 'minAmount/maxAmount',
      };
    }
  }

  return { valid: true };
}

function formatMessage(
  index: number,
  result: Extract<SwapPairValidationResult, { valid: false }>
): string {
  return `swapPairs[${index}]: ${result.reason} (field: ${result.field})`;
}

/**
 * Build-time asserter. Throws `ToonError('INVALID_SWAP_PAIR')` on failure.
 * Used by `buildIlpPeerInfoEvent` to prevent publishing malformed events.
 */
export function assertSwapPairForBuild(
  pair: unknown,
  index: number
): asserts pair is SwapPair {
  const result = isValidSwapPair(pair);
  if (!result.valid) {
    throw new ToonError(formatMessage(index, result), 'INVALID_SWAP_PAIR');
  }
}

/**
 * Parse-time asserter. Throws `InvalidEventError` on failure.
 * Used by `parseIlpPeerInfo` when ingesting events from the wire.
 */
export function assertSwapPairForParse(
  pair: unknown,
  index: number
): asserts pair is SwapPair {
  const result = isValidSwapPair(pair);
  if (!result.valid) {
    throw new InvalidEventError(formatMessage(index, result));
  }
}
