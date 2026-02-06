/**
 * Unit tests for credit limit calculation.
 */

import { describe, it, expect } from 'vitest';
import { calculateCreditLimit, DEFAULT_CREDIT_LIMIT_CONFIG } from './creditLimit.js';
import type { TrustScore, CreditLimitConfig } from '../types.js';

/**
 * Helper to create TrustScore objects for testing.
 */
function createTrustScore(score: number, overrides?: Partial<TrustScore>): TrustScore {
  return {
    score,
    socialDistance: 1,
    mutualFollowerCount: 5,
    breakdown: {
      socialDistanceScore: score,
      mutualFollowersScore: score,
      reputationScore: 0.5,
    },
    ...overrides,
  };
}

describe('creditLimit', () => {
  describe('DEFAULT_CREDIT_LIMIT_CONFIG', () => {
    it('should have all required fields', () => {
      expect(DEFAULT_CREDIT_LIMIT_CONFIG).toHaveProperty('maxCredit');
      expect(DEFAULT_CREDIT_LIMIT_CONFIG).toHaveProperty('minCredit');
      expect(DEFAULT_CREDIT_LIMIT_CONFIG).toHaveProperty('curve');
    });

    it('should have sensible default values', () => {
      expect(DEFAULT_CREDIT_LIMIT_CONFIG.maxCredit).toBe(1000000);
      expect(DEFAULT_CREDIT_LIMIT_CONFIG.minCredit).toBe(0);
      expect(DEFAULT_CREDIT_LIMIT_CONFIG.curve).toBe('linear');
    });

    it('should have curve field that accepts valid values', () => {
      expect(['linear', 'exponential']).toContain(DEFAULT_CREDIT_LIMIT_CONFIG.curve);
    });
  });

  describe('calculateCreditLimit - linear curve', () => {
    const linearConfig: CreditLimitConfig = {
      minCredit: 0,
      maxCredit: 1000000,
      curve: 'linear',
    };

    it('should return minCredit when score is 0', () => {
      const trustScore = createTrustScore(0);
      expect(calculateCreditLimit(trustScore, linearConfig)).toBe(0);
    });

    it('should return maxCredit when score is 1', () => {
      const trustScore = createTrustScore(1);
      expect(calculateCreditLimit(trustScore, linearConfig)).toBe(1000000);
    });

    it('should return midpoint when score is 0.5', () => {
      const trustScore = createTrustScore(0.5);
      expect(calculateCreditLimit(trustScore, linearConfig)).toBe(500000);
    });

    it('should return correct linear interpolation for score 0.25', () => {
      const trustScore = createTrustScore(0.25);
      expect(calculateCreditLimit(trustScore, linearConfig)).toBe(250000);
    });

    it('should return correct linear interpolation for score 0.75', () => {
      const trustScore = createTrustScore(0.75);
      expect(calculateCreditLimit(trustScore, linearConfig)).toBe(750000);
    });

    it('should work with custom minCredit and maxCredit values', () => {
      const customConfig: CreditLimitConfig = {
        minCredit: 100,
        maxCredit: 1000,
        curve: 'linear',
      };
      const trustScore = createTrustScore(0.5);
      // 100 + (1000 - 100) * 0.5 = 100 + 450 = 550
      expect(calculateCreditLimit(trustScore, customConfig)).toBe(550);
    });

    it('should use default config when none provided', () => {
      const trustScore = createTrustScore(0.5);
      // Default: 0 + (1000000 - 0) * 0.5 = 500000
      expect(calculateCreditLimit(trustScore)).toBe(500000);
    });

    it('should return minCredit with custom config when score is 0', () => {
      const customConfig: CreditLimitConfig = {
        minCredit: 100,
        maxCredit: 1000,
        curve: 'linear',
      };
      const trustScore = createTrustScore(0);
      expect(calculateCreditLimit(trustScore, customConfig)).toBe(100);
    });

    it('should return maxCredit with custom config when score is 1', () => {
      const customConfig: CreditLimitConfig = {
        minCredit: 100,
        maxCredit: 1000,
        curve: 'linear',
      };
      const trustScore = createTrustScore(1);
      expect(calculateCreditLimit(trustScore, customConfig)).toBe(1000);
    });
  });

  describe('calculateCreditLimit - exponential curve', () => {
    const expConfig: CreditLimitConfig = {
      minCredit: 0,
      maxCredit: 1000000,
      curve: 'exponential',
    };

    it('should return minCredit when score is 0', () => {
      const trustScore = createTrustScore(0);
      expect(calculateCreditLimit(trustScore, expConfig)).toBe(0);
    });

    it('should return maxCredit when score is 1', () => {
      const trustScore = createTrustScore(1);
      expect(calculateCreditLimit(trustScore, expConfig)).toBe(1000000);
    });

    it('should return minCredit + (maxCredit - minCredit) * 0.25 when score is 0.5', () => {
      const trustScore = createTrustScore(0.5);
      // 0 + (1000000 - 0) * 0.5^2 = 1000000 * 0.25 = 250000
      expect(calculateCreditLimit(trustScore, expConfig)).toBe(250000);
    });

    it('should return approximately midpoint when score is ~sqrt(0.5)', () => {
      const trustScore = createTrustScore(Math.sqrt(0.5)); // ~0.7071
      // 0 + (1000000 - 0) * 0.5 = 500000
      const result = calculateCreditLimit(trustScore, expConfig);
      expect(result).toBe(500000);
    });

    it('should return 62500 for score 0.25 (exponential)', () => {
      const trustScore = createTrustScore(0.25);
      // 0 + (1000000 - 0) * 0.25^2 = 1000000 * 0.0625 = 62500
      expect(calculateCreditLimit(trustScore, expConfig)).toBe(62500);
    });

    it('should produce lower values than linear for same score < 1', () => {
      const linearConfig: CreditLimitConfig = {
        minCredit: 0,
        maxCredit: 1000000,
        curve: 'linear',
      };

      for (const score of [0.25, 0.5, 0.75]) {
        const trustScore = createTrustScore(score);
        const linearResult = calculateCreditLimit(trustScore, linearConfig);
        const expResult = calculateCreditLimit(trustScore, expConfig);
        expect(expResult).toBeLessThan(linearResult);
      }
    });

    it('should produce equal values to linear when score is 0 or 1', () => {
      const linearConfig: CreditLimitConfig = {
        minCredit: 0,
        maxCredit: 1000000,
        curve: 'linear',
      };

      for (const score of [0, 1]) {
        const trustScore = createTrustScore(score);
        const linearResult = calculateCreditLimit(trustScore, linearConfig);
        const expResult = calculateCreditLimit(trustScore, expConfig);
        expect(expResult).toBe(linearResult);
      }
    });
  });

  describe('calculateCreditLimit - edge cases', () => {
    it('should handle TrustScore with various breakdown values', () => {
      const trustScore: TrustScore = {
        score: 0.6,
        socialDistance: 2,
        mutualFollowerCount: 15,
        breakdown: {
          socialDistanceScore: 0.5,
          mutualFollowersScore: 0.8,
          reputationScore: 0.3,
        },
      };
      // Uses score property (0.6), not breakdown values
      const result = calculateCreditLimit(trustScore);
      expect(result).toBe(600000); // 0 + (1000000 - 0) * 0.6 = 600000
    });

    it('should merge partial config with defaults', () => {
      const trustScore = createTrustScore(0.5);

      // Only override maxCredit
      const result1 = calculateCreditLimit(trustScore, { maxCredit: 500000 });
      expect(result1).toBe(250000); // 0 + (500000 - 0) * 0.5 = 250000

      // Only override minCredit
      const result2 = calculateCreditLimit(trustScore, { minCredit: 100000 });
      expect(result2).toBe(550000); // 100000 + (1000000 - 100000) * 0.5 = 550000

      // Only override curve
      const result3 = calculateCreditLimit(trustScore, { curve: 'exponential' });
      expect(result3).toBe(250000); // 0 + (1000000 - 0) * 0.5^2 = 250000
    });

    it('should return that value when minCredit equals maxCredit', () => {
      const config: CreditLimitConfig = {
        minCredit: 500000,
        maxCredit: 500000,
        curve: 'linear',
      };
      const trustScore = createTrustScore(0.5);
      expect(calculateCreditLimit(trustScore, config)).toBe(500000);
    });

    it('should always return a non-negative integer', () => {
      const trustScore = createTrustScore(0.333);
      const result = calculateCreditLimit(trustScore);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('should handle very large maxCredit values without overflow', () => {
      const config: CreditLimitConfig = {
        minCredit: 0,
        maxCredit: Number.MAX_SAFE_INTEGER,
        curve: 'linear',
      };
      const trustScore = createTrustScore(0.5);
      const result = calculateCreditLimit(trustScore, config);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
    });

    it('should clamp score below 0 to 0', () => {
      const trustScore = createTrustScore(-0.5);
      const result = calculateCreditLimit(trustScore);
      expect(result).toBe(0); // Clamped to score = 0 -> returns minCredit
    });

    it('should clamp score above 1 to 1', () => {
      const trustScore = createTrustScore(1.5);
      const result = calculateCreditLimit(trustScore);
      expect(result).toBe(1000000); // Clamped to score = 1 -> returns maxCredit
    });

    it('should handle negative minCredit by clamping result to 0', () => {
      const config: CreditLimitConfig = {
        minCredit: -1000,
        maxCredit: 1000,
        curve: 'linear',
      };
      const trustScore = createTrustScore(0);
      // Would calculate -1000, but clamps to 0
      expect(calculateCreditLimit(trustScore, config)).toBe(0);
    });

    it('should handle minCredit > maxCredit by swapping values', () => {
      const config: CreditLimitConfig = {
        minCredit: 1000,
        maxCredit: 100,
        curve: 'linear',
      };
      const trustScore = createTrustScore(0);
      // After swap: minCredit=100, maxCredit=1000, score=0 -> returns 100
      expect(calculateCreditLimit(trustScore, config)).toBe(100);
    });

    it('should floor the result to an integer', () => {
      const config: CreditLimitConfig = {
        minCredit: 0,
        maxCredit: 999,
        curve: 'linear',
      };
      const trustScore = createTrustScore(0.333);
      // 0 + 999 * 0.333 = 332.667 -> floor to 332
      expect(calculateCreditLimit(trustScore, config)).toBe(332);
    });
  });

  describe('calculateCreditLimit - integration with TrustScore', () => {
    it('should work with high trust scenario', () => {
      // High trust: direct follow (distance 1), many mutual followers
      const highTrustScore: TrustScore = {
        score: 0.95,
        socialDistance: 1,
        mutualFollowerCount: 20,
        breakdown: {
          socialDistanceScore: 1.0,
          mutualFollowersScore: 1.0,
          reputationScore: 0.5,
        },
      };
      const creditLimit = calculateCreditLimit(highTrustScore);
      expect(creditLimit).toBe(950000);
    });

    it('should work with low trust scenario', () => {
      // Low trust: far social distance, few mutual followers
      const lowTrustScore: TrustScore = {
        score: 0.15,
        socialDistance: 3,
        mutualFollowerCount: 1,
        breakdown: {
          socialDistanceScore: 0.1,
          mutualFollowersScore: 0.1,
          reputationScore: 0.5,
        },
      };
      const creditLimit = calculateCreditLimit(lowTrustScore);
      expect(creditLimit).toBe(150000);
    });

    it('should work with medium trust scenario', () => {
      // Medium trust: moderate social distance, some mutual followers
      const mediumTrustScore: TrustScore = {
        score: 0.5,
        socialDistance: 2,
        mutualFollowerCount: 5,
        breakdown: {
          socialDistanceScore: 0.5,
          mutualFollowersScore: 0.5,
          reputationScore: 0.5,
        },
      };
      const creditLimit = calculateCreditLimit(mediumTrustScore);
      expect(creditLimit).toBe(500000);
    });

    it('should verify credit limits scale appropriately with trust scores', () => {
      const lowScore = createTrustScore(0.2);
      const mediumScore = createTrustScore(0.5);
      const highScore = createTrustScore(0.9);

      const lowCredit = calculateCreditLimit(lowScore);
      const mediumCredit = calculateCreditLimit(mediumScore);
      const highCredit = calculateCreditLimit(highScore);

      expect(lowCredit).toBeLessThan(mediumCredit);
      expect(mediumCredit).toBeLessThan(highCredit);
    });

    it('should demonstrate conservative exponential vs linear policies', () => {
      const linearConfig: CreditLimitConfig = {
        minCredit: 0,
        maxCredit: 1000000,
        curve: 'linear',
      };
      const exponentialConfig: CreditLimitConfig = {
        minCredit: 0,
        maxCredit: 1000000,
        curve: 'exponential',
      };

      // For moderate trust (0.5), exponential is more conservative
      const moderateTrust = createTrustScore(0.5);
      const linearCredit = calculateCreditLimit(moderateTrust, linearConfig);
      const expCredit = calculateCreditLimit(moderateTrust, exponentialConfig);

      expect(linearCredit).toBe(500000);
      expect(expCredit).toBe(250000);
      expect(expCredit).toBeLessThan(linearCredit);
    });
  });
});
