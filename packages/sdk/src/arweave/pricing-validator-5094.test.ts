/**
 * ATDD tests for Story 8.0: Pricing Validator for kind:5094
 *
 * Test ID: 8.0-UNIT-016
 *
 * AC covered:
 * - AC #6: Insufficient payment rejection (F04 before handler invoked)
 * - Edge cases: zero-length rawBytes, kindPricing override vs basePricePerByte
 */

import { describe, it, expect } from 'vitest';
import { createPricingValidator } from '../pricing-validator.js';
import type { ToonRoutingMeta } from '@toon-protocol/core/toon';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockMeta(
  overrides: Partial<ToonRoutingMeta> = {}
): ToonRoutingMeta {
  return {
    kind: 5094,
    pubkey: 'ab'.repeat(32),
    id: 'a'.repeat(64),
    sig: 'c'.repeat(128),
    rawBytes: new Uint8Array(1024), // 1KB blob
    ...overrides,
  };
}

// ============================================================================
// 8.0-UNIT-016: Pricing Validator Handles kind:5094 (AC #6)
// ============================================================================

describe('Pricing Validator for kind:5094 (Story 8.0)', () => {
  it('[P0] kindPricing[5094] underpayment -> F04 rejection BEFORE handler invoked', () => {
    // Arrange: kindPricing sets 5094 at 10n per byte
    const validator = createPricingValidator({
      basePricePerByte: 1n, // base rate is cheap
      ownPubkey: 'ff'.repeat(32),
      kindPricing: { 5094: 10n }, // but kind:5094 costs 10n per byte
    });
    const meta = createMockMeta({
      kind: 5094,
      rawBytes: new Uint8Array(1024), // 1KB blob
    });
    // Required: 1024 * 10n = 10240n. Pay only 5000n (underpaid).
    const amount = 5000n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert: F04 rejection with correct amounts
    expect(result.accepted).toBe(false);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.code).toBe('F04');
    expect(result.rejection!.metadata!['required']).toBe('10240');
    expect(result.rejection!.metadata!['received']).toBe('5000');
  });

  it('[P0] kindPricing[5094] exact payment -> accepted', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: 1n,
      ownPubkey: 'ff'.repeat(32),
      kindPricing: { 5094: 10n },
    });
    const meta = createMockMeta({
      kind: 5094,
      rawBytes: new Uint8Array(512), // 512 bytes
    });
    // Required: 512 * 10n = 5120n
    const amount = 5120n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(true);
  });

  it('[P0] kindPricing[5094] overpayment -> accepted', () => {
    // Arrange
    const validator = createPricingValidator({
      basePricePerByte: 1n,
      ownPubkey: 'ff'.repeat(32),
      kindPricing: { 5094: 10n },
    });
    const meta = createMockMeta({
      kind: 5094,
      rawBytes: new Uint8Array(256),
    });
    // Required: 256 * 10n = 2560n. Pay 10000n (overpaid).
    const amount = 10000n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert
    expect(result.accepted).toBe(true);
  });

  it('[P1] zero-length rawBytes -> requires 0 payment -> accepted with amount 0', () => {
    // Arrange: zero-length blob edge case (test design 8.0-UNIT-006)
    const validator = createPricingValidator({
      basePricePerByte: 1n,
      ownPubkey: 'ff'.repeat(32),
      kindPricing: { 5094: 10n },
    });
    const meta = createMockMeta({
      kind: 5094,
      rawBytes: new Uint8Array(0), // zero-length
    });
    // Required: 0 * 10n = 0n
    const amount = 0n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert: accepted because 0 >= 0
    expect(result.accepted).toBe(true);
  });

  it('[P1] kind:5094 uses kindPricing override, not basePricePerByte', () => {
    // Arrange: base is 100n, but kind:5094 override is 5n (cheaper)
    const validator = createPricingValidator({
      basePricePerByte: 100n,
      ownPubkey: 'ff'.repeat(32),
      kindPricing: { 5094: 5n },
    });
    const meta = createMockMeta({
      kind: 5094,
      rawBytes: new Uint8Array(200),
    });
    // If base rate: 200 * 100n = 20000n
    // With override: 200 * 5n = 1000n
    // Pay 1000n (exact for override, underpaid for base)
    const amount = 1000n;

    // Act
    const result = validator.validate(meta, amount);

    // Assert: accepted because kindPricing override is used
    expect(result.accepted).toBe(true);
  });
});
