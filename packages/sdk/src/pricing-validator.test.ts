import { describe, it, expect } from 'vitest';
import { createPricingValidator } from './pricing-validator.js';
import type { ToonRoutingMeta } from '@crosstown/core/toon';

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
      kindPricing: { 23194: 0n }, // SPSP requests are free
    });
    const meta = createMockMeta({ kind: 23194, rawBytes: new Uint8Array(200) });
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
