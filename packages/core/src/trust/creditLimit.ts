/**
 * Credit limit calculation module.
 * Maps trust scores to ILP credit limits.
 */

import type { CreditLimitConfig, TrustScore } from '../types.js';

/**
 * Default credit limit configuration.
 * - maxCredit: 1,000,000 (1M asset units)
 * - minCredit: 0 (no credit for zero trust)
 * - curve: linear (proportional mapping)
 */
export const DEFAULT_CREDIT_LIMIT_CONFIG: CreditLimitConfig = {
  maxCredit: 1000000,
  minCredit: 0,
  curve: 'linear',
};

/**
 * Calculates the credit limit based on a trust score and configuration.
 *
 * @param trustScore - The trust score result from SocialTrustManager
 * @param config - Optional partial configuration (merged with defaults)
 * @returns The calculated credit limit as a non-negative integer
 *
 * @example
 * ```typescript
 * const trustScore = await trustManager.computeTrustScore(pubkeyA, pubkeyB);
 * const creditLimit = calculateCreditLimit(trustScore);
 * // With custom config:
 * const customLimit = calculateCreditLimit(trustScore, { maxCredit: 500000, curve: 'exponential' });
 * ```
 */
export function calculateCreditLimit(
  trustScore: TrustScore,
  config?: Partial<CreditLimitConfig>
): number {
  const mergedConfig = { ...DEFAULT_CREDIT_LIMIT_CONFIG, ...config };
  let { minCredit, maxCredit } = mergedConfig;
  const { curve } = mergedConfig;
  const { score } = trustScore;

  // Handle minCredit > maxCredit by swapping
  if (minCredit > maxCredit) {
    [minCredit, maxCredit] = [maxCredit, minCredit];
  }

  // Clamp score to [0, 1]
  const clampedScore = Math.max(0, Math.min(1, score));

  let creditLimit: number;
  if (curve === 'linear') {
    // Linear: minCredit + (maxCredit - minCredit) * score
    creditLimit = minCredit + (maxCredit - minCredit) * clampedScore;
  } else {
    // Exponential: minCredit + (maxCredit - minCredit) * score^2
    creditLimit = minCredit + (maxCredit - minCredit) * Math.pow(clampedScore, 2);
  }

  // Return as non-negative integer
  return Math.max(0, Math.floor(creditLimit));
}
