import { describe, it, expect } from 'vitest';

import { calculateRouteAmount } from './calculate-route-amount.js';

// ---------------------------------------------------------------------------
// T-7.5-01 through T-7.5-03 [P0] Core fee calculation scenarios
// ---------------------------------------------------------------------------
describe('calculateRouteAmount -- core scenarios', () => {
  it('T-7.5-01: direct route with empty hopFees returns basePricePerByte * packetByteLength', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: 100,
      hopFees: [],
    });

    // 10 * 100 = 1000
    expect(result).toBe(1000n);
  });

  it('T-7.5-02: 2-hop route with fees [2n, 3n], basePricePerByte=10n, 100 bytes -> 1500n', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: 100,
      hopFees: [2n, 3n],
    });

    // (10 * 100) + (2 * 100) + (3 * 100) = 1000 + 200 + 300 = 1500
    expect(result).toBe(1500n);
  });

  it('T-7.5-03: 3-hop route with fees [0n, 5n, 1n] correctly handles zero-fee hop', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: 200,
      hopFees: [0n, 5n, 1n],
    });

    // (10 * 200) + (0 * 200) + (5 * 200) + (1 * 200) = 2000 + 0 + 1000 + 200 = 3200
    expect(result).toBe(3200n);
  });

  it('single intermediary hop: 1-hop route with fee [4n] adds intermediary cost', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: 50,
      hopFees: [4n],
    });

    // (10 * 50) + (4 * 50) = 500 + 200 = 700
    expect(result).toBe(700n);
  });
});

// ---------------------------------------------------------------------------
// T-7.5-08, T-7.5-09 [P1] Edge cases and boundary conditions
// ---------------------------------------------------------------------------
describe('calculateRouteAmount -- edge cases', () => {
  it('T-7.5-08: 65536 bytes, 10 hops at 1000n per byte, no overflow', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: 65536,
      hopFees: Array.from({ length: 10 }, () => 1000n),
    });

    // (10 * 65536) + (10 * 1000 * 65536) = 655360 + 655360000 = 656015360
    const expected = 10n * 65536n + 10n * 1000n * 65536n;
    expect(result).toBe(expected);
  });

  it('T-7.5-09: zero packetByteLength returns 0n regardless of fees', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: 0,
      hopFees: [5n, 10n, 100n],
    });

    expect(result).toBe(0n);
  });

  it('zero basePricePerByte with non-zero hop fees charges only intermediary fees', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 0n,
      packetByteLength: 100,
      hopFees: [2n, 3n],
    });

    // (0 * 100) + (2 * 100) + (3 * 100) = 0 + 200 + 300 = 500
    expect(result).toBe(500n);
  });

  it('all zeros: zero basePricePerByte, zero packetByteLength, zero hopFees -> 0n', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 0n,
      packetByteLength: 0,
      hopFees: [0n, 0n],
    });

    expect(result).toBe(0n);
  });

  it('single-byte packet with high fees produces correct small amount', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: 1,
      hopFees: [5n, 3n],
    });

    // (10 * 1) + (5 * 1) + (3 * 1) = 10 + 5 + 3 = 18
    expect(result).toBe(18n);
  });

  it('negative packetByteLength returns 0n (defensive guard)', () => {
    const result = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: -100,
      hopFees: [5n, 3n],
    });

    expect(result).toBe(0n);
  });
});
