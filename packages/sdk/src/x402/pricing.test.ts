import { describe, it, expect } from 'vitest';
import { computeX402RequiredAmount } from './pricing.js';
import type { X402PricingConfig } from './types.js';

const DEFAULT_CONFIG: X402PricingConfig = {
  basePricePerByte: 10n,
  routingBuffer: 100n,
};

describe('computeX402RequiredAmount', () => {
  it('zero-byte payload returns only the routing buffer', () => {
    const result = computeX402RequiredAmount(0, DEFAULT_CONFIG);
    expect(result).toBe(100n);
  });

  it('minimal payload (1 byte) returns basePricePerByte + routingBuffer', () => {
    const result = computeX402RequiredAmount(1, DEFAULT_CONFIG);
    expect(result).toBe(110n); // 1 * 10n + 100n
  });

  it('routing buffer is always added regardless of payload size', () => {
    const noBuffer: X402PricingConfig = { basePricePerByte: 10n, routingBuffer: 0n };
    const withBuffer: X402PricingConfig = { basePricePerByte: 10n, routingBuffer: 500n };

    const bytes = 100;
    expect(computeX402RequiredAmount(bytes, withBuffer)).toBe(
      computeX402RequiredAmount(bytes, noBuffer) + 500n,
    );
  });

  it('custom per-byte rate override changes the computed amount', () => {
    const customConfig: X402PricingConfig = { basePricePerByte: 50n, routingBuffer: 100n };
    const result = computeX402RequiredAmount(10, customConfig);
    expect(result).toBe(600n); // 10 * 50n + 100n
  });
});
