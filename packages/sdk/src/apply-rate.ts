/**
 * Exchange-rate application — `applyRate()` and its parameter type.
 *
 * **Path-agnostic.** This helper was originally introduced for the legacy
 * claim-in-FULFILL swap handler (Story 12.3, AC-8) and physically lived in
 * `swap-handler.ts`, but it is the *only* rate-conversion primitive in the SDK
 * and the **rolling** swap protocol depends on it just as hard:
 *
 * - `adaptive-controller.ts` (the rolling δ/W controller) sizes packets with it,
 * - `@toon-protocol/swap`'s `rolling-engine.ts` prices every coupled fill with it.
 *
 * It was relocated here by toon#210 (ADR 0003 stage 3) so that withdrawing the
 * legacy handler in toon#211 (ADR 0003 stage 7) was a mechanical deletion of
 * `swap-handler.ts` and `stream-swap.ts` rather than a deletion that silently
 * broke the rolling engine. The move is source-only: `applyRate` and
 * `ApplyRateParams` are still exported from `@toon-protocol/sdk` under
 * exactly the same names.
 *
 * @module
 */

import { SwapHandlerError } from './errors.js';

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
