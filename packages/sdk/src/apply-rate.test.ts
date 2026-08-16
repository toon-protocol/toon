/**
 * Unit tests for `applyRate()` — the SDK's only rate-conversion primitive.
 *
 * Re-homed here from `swap-handler.test.ts` by toon#210 (ADR 0003 stage 3).
 * `applyRate` is shared by the legacy handler AND the rolling path
 * (`adaptive-controller.ts`, and `@toon-protocol/swap`'s `rolling-engine.ts`),
 * so its coverage must not be deleted alongside the legacy handler in
 * toon#211. The assertions below are unchanged from their original home —
 * test IDs T-018 / T-018b / T-023 map to
 * `_bmad-output/planning-artifacts/test-design-epic-12.md`.
 */

import { describe, it, expect } from 'vitest';

import { applyRate } from './apply-rate.js';
import { SwapHandlerError } from './errors.js';

describe('applyRate helper (AC-8)', () => {
  it('[P0] T-018: USDC(6) → ETH(18) at rate 0.000357 golden vector', () => {
    const out = applyRate({
      sourceAmount: 1_000_000n,
      fromScale: 6,
      toScale: 18,
      rate: '0.000357',
    });
    expect(out).toBe(357_000_000_000_000n);
  });

  it('[P0] ETH(18) → USDC(6) at rate 2800 golden vector', () => {
    const out = applyRate({
      sourceAmount: 10n ** 15n, // 0.001 ETH
      fromScale: 18,
      toScale: 6,
      rate: '2800',
    });
    expect(out).toBe(2_800_000n); // 2.8 USDC
  });

  it('[P1] T-018b: same-scale pair preserves sub-bigint precision without rounding drift', () => {
    // 6→6 USDC→USDT at 1.0005 rate
    const out = applyRate({
      sourceAmount: 1_000_000_000n, // 1000 USDC
      fromScale: 6,
      toScale: 6,
      rate: '1.0005',
    });
    expect(out).toBe(1_000_500_000n); // 1000.5 USDT
  });

  it('[P1] T-023: large source amount + 18-decimal target is deterministic (no overflow)', () => {
    const out = applyRate({
      sourceAmount: 2n ** 63n,
      fromScale: 6,
      toScale: 18,
      rate: '2800.5',
    });
    expect(typeof out).toBe('bigint');
    expect(out > 0n).toBe(true);
    // Re-compute to verify determinism
    const again = applyRate({
      sourceAmount: 2n ** 63n,
      fromScale: 6,
      toScale: 18,
      rate: '2800.5',
    });
    expect(out).toBe(again);
  });

  it('[P1] throws SwapHandlerError on invalid rate format', () => {
    expect(() =>
      applyRate({ sourceAmount: 1n, fromScale: 6, toScale: 6, rate: 'abc' })
    ).toThrow(SwapHandlerError);
    expect(() =>
      applyRate({ sourceAmount: 1n, fromScale: 6, toScale: 6, rate: '1.2.3' })
    ).toThrow(SwapHandlerError);
    expect(() =>
      applyRate({ sourceAmount: 1n, fromScale: 6, toScale: 6, rate: '-1' })
    ).toThrow(SwapHandlerError);
  });

  it('[P1] throws SwapHandlerError on zero rate', () => {
    expect(() =>
      applyRate({ sourceAmount: 1n, fromScale: 6, toScale: 6, rate: '0' })
    ).toThrow(/Rate is zero/);
  });

  // Story 12.5 code-review pass #3 regression — fractional zero rates like
  // "0.0", "0.00", "0.000000" must also be rejected (previously slipped past
  // the strict-equality check and produced a silent zero-valued targetAmount).
  it('[P1] throws SwapHandlerError on fractional zero rate (0.0, 0.00, 0.000)', () => {
    for (const rate of ['0.0', '0.00', '0.000', '0.000000']) {
      expect(() =>
        applyRate({ sourceAmount: 1n, fromScale: 6, toScale: 6, rate })
      ).toThrow(/Rate is zero/);
    }
  });

  it('[P1] throws SwapHandlerError when sourceAmount <= 0', () => {
    expect(() =>
      applyRate({ sourceAmount: 0n, fromScale: 6, toScale: 6, rate: '1' })
    ).toThrow(/sourceAmount must be positive/);
    expect(() =>
      applyRate({ sourceAmount: -1n, fromScale: 6, toScale: 6, rate: '1' })
    ).toThrow(/sourceAmount must be positive/);
  });
});
