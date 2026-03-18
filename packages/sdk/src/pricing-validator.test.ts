import { describe, it, expect } from 'vitest';
import { createPricingValidator } from './pricing-validator.js';
import type { ToonRoutingMeta } from '@toon-protocol/core/toon';

// ATDD tests for Story 1.5 -- pricing validator

/**
 * Factory for creating a mock ToonRoutingMeta.
 */
function createMockMeta(
  overrides: Partial<ToonRoutingMeta> = {}
): ToonRoutingMeta {
  return {
    kind: 1,
    pubkey: 'ab'.repeat(32),
    id: 'a'.repeat(64),
    sig: 'c'.repeat(128),
    rawBytes: new Uint8Array(100), // 100 bytes
    ...overrides,
  };
}

describe('Pricing Validator', () => {
  it('[P0] underpaid event produces F04 rejection with required/received metadata', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: 10n,
      ownPubkey: 'ff'.repeat(32),
    });
    const meta = createMockMeta({ rawBytes: new Uint8Array(100) });
    const amount = 500n; // 100 bytes * 10n = 1000n required, paying only 500n

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(false);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.code).toBe('F04');
    expect(result.rejection!.accept).toBe(false);
    expect(result.rejection!.metadata).toBeDefined();
    expect(result.rejection!.metadata!['required']).toBe('1000');
    expect(result.rejection!.metadata!['received']).toBe('500');
  });

  it('[P0] kindPricing override changes price for specific kind', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: 10n,
      ownPubkey: 'ff'.repeat(32),
      kindPricing: { 30023: 0n }, // Custom kind override: free
    });
    const meta = createMockMeta({ kind: 30023, rawBytes: new Uint8Array(200) });
    const amount = 0n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(true);
  });

  it('[P0] self-write bypass accepts event from own pubkey regardless of amount', () => {
    // Arrange
    const ownPubkey = 'ab'.repeat(32);
    const validator = createPricingValidator({
      basePricePerByte: 10n,
      ownPubkey,
    });
    const meta = createMockMeta({
      pubkey: ownPubkey,
      rawBytes: new Uint8Array(1000),
    });
    const amount = 0n; // Zero payment from self

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(true);
  });

  it('[P1] default basePricePerByte is 10n when not specified', () => {
    // Arrange
    const validator = createPricingValidator({
      ownPubkey: 'ff'.repeat(32),
    });
    const meta = createMockMeta({ rawBytes: new Uint8Array(50) });
    const amount = 500n; // 50 bytes * 10n = 500n (exact match)

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(true);
  });

  it('[P0] overpaid event is accepted', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: 10n,
      ownPubkey: 'ff'.repeat(32),
    });
    const meta = createMockMeta({ rawBytes: new Uint8Array(100) });
    const amount = 999999n; // Way more than required 1000n

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(true);
  });

  it('[P1] exactly-priced event is accepted', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: 10n,
      ownPubkey: 'ff'.repeat(32),
    });
    const meta = createMockMeta({ rawBytes: new Uint8Array(100) });
    const amount = 1000n; // 100 bytes * 10n = exactly 1000n

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(true);
  });

  it('[P0] kindPricing override takes precedence over per-byte calculation', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: 10n,
      ownPubkey: 'ff'.repeat(32),
      kindPricing: { 1: 5n }, // Kind 1 costs 5n per byte instead of 10n
    });
    const meta = createMockMeta({ kind: 1, rawBytes: new Uint8Array(100) });
    // 100 bytes * 5n = 500n required (not 100 * 10n = 1000n)
    const amount = 500n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(true);
  });

  // --- Gap-filling tests for tighter AC coverage ---

  it('[P1] default basePricePerByte rejects underpayment proving default is exactly 10n (AC #4)', () => {
    // Arrange: no basePricePerByte configured, default should be 10n
    const validator = createPricingValidator({
      ownPubkey: 'ff'.repeat(32),
    });
    const meta = createMockMeta({ rawBytes: new Uint8Array(50) });
    // 50 bytes * 10n = 500n required; pay 499n to prove default is at least 10n
    const amount = 499n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(false);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.code).toBe('F04');
    expect(result.rejection!.metadata!['required']).toBe('500');
    expect(result.rejection!.metadata!['received']).toBe('499');
  });

  it('[P1] underpaid event under kindPricing produces F04 with kind-specific required amount (AC #2, #7)', () => {
    // Arrange: kindPricing sets kind 1 to 5n per byte, base is 10n
    const validator = createPricingValidator({
      basePricePerByte: 10n,
      ownPubkey: 'ff'.repeat(32),
      kindPricing: { 1: 5n },
    });
    const meta = createMockMeta({ kind: 1, rawBytes: new Uint8Array(100) });
    // Kind 1: 100 bytes * 5n = 500n required; pay 499n (underpaid)
    // If base rate were used: 100 * 10n = 1000n (wrong)
    const amount = 499n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(false);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.code).toBe('F04');
    // Verify the required amount uses kind-specific price, not base price
    expect(result.rejection!.metadata!['required']).toBe('500');
    expect(result.rejection!.metadata!['received']).toBe('499');
  });
});

// =============================================================================
// Story 3.1 Gap-Filling: USDC Denomination Integration (T-3.1-06)
//
// AC #2: "pricing is calculated for an event, then the amount is denominated
// in USDC (micro-units), and the pricing model remains basePricePerByte *
// toonData.length"
//
// These tests verify the actual createPricingValidator works correctly with
// realistic USDC-scale amounts (6 decimals, not 18).
// =============================================================================
describe('Pricing Validator — USDC denomination (Story 3.1, AC #2)', () => {
  /**
   * USDC has 6 decimals: 1 USDC = 1,000,000 micro-USDC.
   * basePricePerByte = 10n means 10 micro-USDC per byte = $0.00001/byte.
   */
  const USDC_BASE_PRICE = 10n;

  it('[P1] 1KB event costs 10,240 micro-USDC (~$0.01) with default pricing', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: USDC_BASE_PRICE,
      ownPubkey: 'ff'.repeat(32),
    });
    const meta = createMockMeta({ rawBytes: new Uint8Array(1024) }); // 1KB

    // Expected: 1024 bytes * 10 micro-USDC/byte = 10,240 micro-USDC
    const exactPayment = 10240n;

    // Act — exact payment accepted
    const result = validator.validate(meta, exactPayment);

    // Assert
    expect(result.accepted).toBe(true);

    // Verify underpayment by 1 micro-USDC is rejected
    const underpaid = validator.validate(meta, exactPayment - 1n);
    expect(underpaid.accepted).toBe(false);
    expect(underpaid.rejection!.metadata!['required']).toBe('10240');
    expect(underpaid.rejection!.metadata!['received']).toBe('10239');
  });

  it('[P1] 10KB event costs 102,400 micro-USDC (~$0.10) with default pricing', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: USDC_BASE_PRICE,
      ownPubkey: 'ff'.repeat(32),
    });
    const meta = createMockMeta({
      rawBytes: new Uint8Array(10 * 1024),
    }); // 10KB

    // Expected: 10,240 bytes * 10 micro-USDC/byte = 102,400 micro-USDC = $0.1024
    const exactPayment = 102400n;

    // Act
    const result = validator.validate(meta, exactPayment);

    // Assert
    expect(result.accepted).toBe(true);
  });

  it('[P1] USDC micro-unit amounts are compatible with 6-decimal token', () => {
    // Arrange: demonstrate that pricing produces amounts that make sense
    // in USDC 6-decimal context (not 18-decimal like old AGENT token)
    const validator = createPricingValidator({
      basePricePerByte: USDC_BASE_PRICE,
      ownPubkey: 'ff'.repeat(32),
    });

    // A typical small Nostr event (~256 bytes)
    const meta = createMockMeta({ rawBytes: new Uint8Array(256) });
    const payment = USDC_BASE_PRICE * 256n; // 2,560 micro-USDC

    // Act
    const result = validator.validate(meta, payment);

    // Assert
    expect(result.accepted).toBe(true);

    // Verify the amount is in a reasonable USDC range
    // 2,560 micro-USDC = 0.00256 USDC = ~$0.00256
    // This is a sensible micropayment amount for a single event
    const usdcDollars = Number(payment) / 1_000_000; // 6 decimals
    expect(usdcDollars).toBeGreaterThan(0);
    expect(usdcDollars).toBeLessThan(1); // well under $1 per event
  });

  it('[P1] pricing formula is denomination-agnostic (bigint arithmetic only)', () => {
    // Arrange: the same validator works regardless of decimal interpretation
    // This proves the formula basePricePerByte * rawBytes.length is unchanged
    const validator = createPricingValidator({
      basePricePerByte: 10n,
      ownPubkey: 'ff'.repeat(32),
    });

    // Test with various sizes
    const sizes = [1, 100, 512, 1024, 4096, 65536];
    for (const size of sizes) {
      const meta = createMockMeta({ rawBytes: new Uint8Array(size) });
      const required = 10n * BigInt(size);

      // Exact payment accepted
      expect(validator.validate(meta, required).accepted).toBe(true);

      // 1 below rejected
      if (required > 0n) {
        expect(validator.validate(meta, required - 1n).accepted).toBe(false);
      }
    }
  });
});
