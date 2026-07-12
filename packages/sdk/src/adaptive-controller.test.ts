/**
 * Unit tests for the adaptive δ/W controller (issue #83, rolling-swap spec
 * §6): delta_cap = ε/(v·τ) enforcement from synthetic tapes, the
 * one-knob-per-step property, multiplicative-shrink / additive-widen
 * asymmetry, cold-start ramp, slow-start, and per-(chain, maker, pair)
 * persistence round-trips.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SwapPair } from '@toon-protocol/core';

import {
  AdaptiveDeltaController,
  InMemorySwapControllerStateStore,
  JsonFileSwapControllerStateStore,
  SwapControllerError,
  isSwapControllerState,
  swapControllerStateKey,
  type AdaptiveDeltaControllerConfig,
  type PacketObservation,
  type SwapControllerState,
} from './adaptive-controller';
import { applyRate } from './swap-handler';

const MAKER = 'a'.repeat(64);
const OTHER_MAKER = 'b'.repeat(64);
const T0 = 1_700_000_000_000;

function samplePair(): SwapPair {
  return {
    from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
    to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
    rate: '4.0',
  };
}

/**
 * Default test config: two-sided spread 0.004 (40 bps) → halfSpread 0.002 →
 * ε = 0.5 × 0.002 = 0.001.
 */
function baseConfig(
  overrides: Partial<AdaptiveDeltaControllerConfig> = {}
): AdaptiveDeltaControllerConfig {
  return {
    makerPubkey: MAKER,
    pair: samplePair(),
    advertisedSpread: 0.004,
    now: () => T0,
    ...overrides,
  };
}

/** A clean fulfilled-packet observation at the advertised rate. */
function cleanFulfill(
  overrides: Partial<PacketObservation> = {}
): PacketObservation {
  return {
    resolution: 'fulfill',
    rttMs: 2000,
    ...overrides,
  };
}

/** Fully-formed persisted state for seeding stores in tests. */
function seededState(
  overrides: Partial<SwapControllerState> = {}
): SwapControllerState {
  return {
    v: 1,
    delta: '8000',
    W: 2,
    vEwma: 0,
    tauEwma: 0,
    cleanStreak: 0,
    everShrunk: true,
    lastWidened: 'window',
    updatedAt: T0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State key
// ---------------------------------------------------------------------------

describe('swapControllerStateKey — per-(chain, maker, pair) keying', () => {
  it('builds ${chain}:${makerPubkey}:${from}:${to} with chain-qualified assets', () => {
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    expect(key).toBe(
      `evm:base:8453:${MAKER}:USDC@evm:base:8453:MINA@mina:devnet`
    );
  });

  it('distinguishes cross-chain pairs sharing asset codes', () => {
    const solanaTarget: SwapPair = {
      ...samplePair(),
      to: { assetCode: 'MINA', assetScale: 9, chain: 'solana:devnet' },
    };
    expect(
      swapControllerStateKey({ makerPubkey: MAKER, pair: samplePair() })
    ).not.toBe(
      swapControllerStateKey({ makerPubkey: MAKER, pair: solanaTarget })
    );
  });

  it('distinguishes makers', () => {
    expect(
      swapControllerStateKey({ makerPubkey: MAKER, pair: samplePair() })
    ).not.toBe(
      swapControllerStateKey({ makerPubkey: OTHER_MAKER, pair: samplePair() })
    );
  });
});

// ---------------------------------------------------------------------------
// Cold start (spec §6: δ_0 = min(delta_cap, notional/256, maxAmount), W_0 = 1)
// ---------------------------------------------------------------------------

describe('cold start', () => {
  it('starts with W = 1', async () => {
    const c = await AdaptiveDeltaController.create(baseConfig());
    expect(c.window).toBe(1);
  });

  it('seeds δ_0 = notional/256 on first nextDelta', async () => {
    const c = await AdaptiveDeltaController.create(baseConfig());
    expect(c.nextDelta(1_000_000n)).toBe(1_000_000n / 256n); // 3906n
  });

  it('clamps δ_0 by maxPacketAmount (the maker maxAmount absolute cap)', async () => {
    const c = await AdaptiveDeltaController.create(
      baseConfig({ maxPacketAmount: 1000n })
    );
    expect(c.nextDelta(1_000_000n)).toBe(1000n);
  });

  it('never returns less than 1 micro-unit for a tiny notional', async () => {
    const c = await AdaptiveDeltaController.create(baseConfig());
    expect(c.nextDelta(10n)).toBe(1n); // 10/256 = 0 → min-packet floor
  });

  it('never returns more than the remaining notional', async () => {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(key, seededState({ delta: '999999999' }));
    const c = await AdaptiveDeltaController.create(baseConfig({ store }));
    expect(c.nextDelta(500n)).toBe(500n);
  });

  it('returns 0n for a non-positive remaining', async () => {
    const c = await AdaptiveDeltaController.create(baseConfig());
    expect(c.nextDelta(0n)).toBe(0n);
    expect(c.nextDelta(-5n)).toBe(0n);
  });

  it('cold tape (no v·τ measurement) leaves delta_cap unbounded', async () => {
    const c = await AdaptiveDeltaController.create(baseConfig());
    expect(c.deltaCapFraction).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// delta_cap = ε/(v·τ) from measured tape volatility + RTT (synthetic tapes)
// ---------------------------------------------------------------------------

describe('delta_cap = ε/(v·τ) enforcement', () => {
  /**
   * Feed a synthetic two-tick tape: R 1.0 → 1.01 over 1s (v = 0.01/s) with a
   * 2000 ms RTT on every packet (τ = 2s). With ε = 0.001:
   * delta_cap = 0.001 / (0.01 × 2) = 0.05 of remaining.
   */
  async function seededController(
    overrides: Partial<AdaptiveDeltaControllerConfig> = {}
  ): Promise<AdaptiveDeltaController> {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    // Persisted δ deliberately HUGE so only the cap can be binding.
    await store.save(key, seededState({ delta: '500000' }));
    const c = await AdaptiveDeltaController.create(
      baseConfig({ store, ...overrides })
    );
    await c.observe(cleanFulfill({ rate: '1', rateTimestamp: T0 }));
    await c.observe(cleanFulfill({ rate: '1.01', rateTimestamp: T0 + 1000 }));
    return c;
  }

  it('measures v (tape EWMA) and τ (RTT EWMA) from observations', async () => {
    const c = await seededController();
    expect(c.state.vEwma).toBeCloseTo(0.01, 10);
    expect(c.state.tauEwma).toBeCloseTo(2, 10);
  });

  it('caps δ at ε/(v·τ) of remaining even when the ramp value is larger', async () => {
    const c = await seededController();
    expect(c.deltaCapFraction).toBeCloseTo(0.05, 10);
    const d = c.nextDelta(1_000_000n);
    // 5% of 1_000_000 = 50_000 (float→fixed-point rounding tolerance of 1).
    expect(d >= 49_999n && d <= 50_001n).toBe(true);
    // And decisively below the persisted 500_000 ramp value.
    expect(d < 100_000n).toBe(true);
  });

  it('a more volatile tape tightens the cap', async () => {
    const calm = await seededController();
    const volatile = await seededController();
    // Third tick: +5% in 1s on the volatile tape.
    await volatile.observe(
      cleanFulfill({ rate: '1.0605', rateTimestamp: T0 + 2000 })
    );
    expect(volatile.deltaCapFraction).toBeLessThan(calm.deltaCapFraction);
    expect(volatile.nextDelta(1_000_000n) < calm.nextDelta(1_000_000n)).toBe(
      true
    );
  });

  it('a slower link (higher RTT) tightens the cap', async () => {
    const fast = await seededController();
    const slow = await seededController();
    for (let i = 0; i < 20; i++) {
      await slow.observe(cleanFulfill({ rttMs: 10_000 }));
    }
    expect(slow.state.tauEwma).toBeGreaterThan(fast.state.tauEwma);
    expect(slow.nextDelta(1_000_000n) < fast.nextDelta(1_000_000n)).toBe(true);
  });

  it('ε is spread-denominated: a wider advertised spread loosens the cap', async () => {
    const tight = await seededController({ advertisedSpread: 0.004 });
    const loose = await seededController({ advertisedSpread: 0.04 });
    expect(loose.deltaCapFraction).toBeCloseTo(tight.deltaCapFraction * 10, 6);
  });

  it('the absolute maxPacketAmount cap binds independently of the measured cap', async () => {
    const c = await seededController({ maxPacketAmount: 123n });
    expect(c.nextDelta(1_000_000n)).toBe(123n);
  });
});

// ---------------------------------------------------------------------------
// Asymmetric adjustment: multiplicative shrink / additive widen, one knob
// ---------------------------------------------------------------------------

describe('multiplicative shrink', () => {
  async function shrinkFixture(): Promise<AdaptiveDeltaController> {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(key, seededState({ delta: '8000', W: 4 }));
    return AdaptiveDeltaController.create(baseConfig({ store }));
  }

  it('halves δ on a stale-rate reject (δ ← max(δ_min, δ/2)), leaving W alone', async () => {
    const c = await shrinkFixture();
    await c.observe({ resolution: 'reject-stale', rttMs: 2000 });
    expect(c.state.delta).toBe('4000');
    expect(c.state.W).toBe(4);
    await c.observe({ resolution: 'reject-stale', rttMs: 2000 });
    expect(c.state.delta).toBe('2000');
  });

  it('halves δ on a generic reject and on an error', async () => {
    const c = await shrinkFixture();
    await c.observe({ resolution: 'reject' });
    expect(c.state.delta).toBe('4000');
    await c.observe({ resolution: 'error' });
    expect(c.state.delta).toBe('2000');
    expect(c.state.W).toBe(4);
  });

  it('halves W (⌈W/2⌉) on a timeout, leaving δ alone', async () => {
    const c = await shrinkFixture();
    await c.observe({ resolution: 'timeout' });
    expect(c.state.W).toBe(2);
    expect(c.state.delta).toBe('8000');
    await c.observe({ resolution: 'timeout' });
    expect(c.state.W).toBe(1);
    await c.observe({ resolution: 'timeout' });
    expect(c.state.W).toBe(1); // floor at 1
  });

  it('treats realized slip > ε on a fulfill as a shrink signal', async () => {
    const c = await shrinkFixture();
    const source = 1_000_000n; // 1 USDC
    const expected = applyRate({
      sourceAmount: source,
      fromScale: 6,
      toScale: 9,
      rate: '4.0',
    }); // 4_000_000_000n
    // Delivered 2.5% short of the packet's own tape rate → slip 0.025 > ε 0.001.
    await c.observe(
      cleanFulfill({
        rate: '4.0',
        rateTimestamp: T0,
        sourceAmount: source,
        targetAmount: expected - expected / 40n,
      })
    );
    expect(c.state.delta).toBe('4000');
    expect(c.state.everShrunk).toBe(true);
  });

  it('a fulfill delivering the tape amount exactly is clean (no shrink)', async () => {
    const c = await shrinkFixture();
    const source = 1_000_000n;
    const expected = applyRate({
      sourceAmount: source,
      fromScale: 6,
      toScale: 9,
      rate: '4.0',
    });
    await c.observe(
      cleanFulfill({
        rate: '4.0',
        rateTimestamp: T0,
        sourceAmount: source,
        targetAmount: expected,
      })
    );
    expect(c.state.delta).toBe('8000');
    expect(c.state.cleanStreak).toBe(1);
  });

  it('respects the δ_min floor', async () => {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(key, seededState({ delta: '1' }));
    const c = await AdaptiveDeltaController.create(baseConfig({ store }));
    await c.observe({ resolution: 'reject' });
    expect(c.state.delta).toBe('1');
  });

  it('resets the clean streak and latches everShrunk', async () => {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(key, seededState({ cleanStreak: 7, everShrunk: false }));
    const c = await AdaptiveDeltaController.create(baseConfig({ store }));
    await c.observe({ resolution: 'reject' });
    expect(c.state.cleanStreak).toBe(0);
    expect(c.state.everShrunk).toBe(true);
  });
});

describe('additive widen on clean streaks (alternating knobs)', () => {
  it('after K clean fulfills widens δ by δ_0; the NEXT streak widens W; never both', async () => {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(key, seededState({ delta: '8000', W: 2 }));
    const c = await AdaptiveDeltaController.create(
      baseConfig({ store, cleanStreakLength: 4 })
    );
    // Establish δ_0 (the additive increment) from the session notional.
    expect(c.nextDelta(1_024_000n)).toBe(8000n); // δ_0 = 1_024_000/256 = 4000
    // Streak 1 → δ knob (alternation starts on δ).
    for (let i = 0; i < 4; i++) await c.observe(cleanFulfill());
    expect(c.state.delta).toBe('12000'); // 8000 + δ_0(4000)
    expect(c.state.W).toBe(2);
    expect(c.state.lastWidened).toBe('delta');
    // Streak 2 → W knob.
    for (let i = 0; i < 4; i++) await c.observe(cleanFulfill());
    expect(c.state.delta).toBe('12000');
    expect(c.state.W).toBe(3);
    expect(c.state.lastWidened).toBe('window');
    // Streak 3 → δ again.
    for (let i = 0; i < 4; i++) await c.observe(cleanFulfill());
    expect(c.state.delta).toBe('16000');
    expect(c.state.W).toBe(3);
  });

  it('W widen clamps at maxWindow', async () => {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(key, seededState({ W: 3, lastWidened: 'delta' }));
    const c = await AdaptiveDeltaController.create(
      baseConfig({ store, cleanStreakLength: 2, maxWindow: 3 })
    );
    await c.observe(cleanFulfill());
    await c.observe(cleanFulfill());
    expect(c.state.W).toBe(3);
  });

  it('δ widen clamps at maxPacketAmount', async () => {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(key, seededState({ delta: '8000' }));
    const c = await AdaptiveDeltaController.create(
      baseConfig({ store, cleanStreakLength: 2, maxPacketAmount: 9000n })
    );
    c.nextDelta(1_024_000n);
    await c.observe(cleanFulfill());
    await c.observe(cleanFulfill());
    expect(c.state.delta).toBe('9000');
  });

  it('TCP-style asymmetry: one bad event undoes many good ones', async () => {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(
      key,
      seededState({ delta: '8000', lastWidened: 'window' })
    );
    const c = await AdaptiveDeltaController.create(
      baseConfig({ store, cleanStreakLength: 2 })
    );
    c.nextDelta(1_024_000n); // δ_0 = 4000
    // Two full clean streaks worth of δ growth (δ and then W get a turn).
    for (let i = 0; i < 4; i++) await c.observe(cleanFulfill());
    const grown = BigInt(c.state.delta);
    expect(grown).toBe(12000n);
    // ONE shrink signal halves δ — bigger than the additive step it undoes.
    await c.observe({ resolution: 'reject-stale' });
    expect(BigInt(c.state.delta)).toBe(6000n);
    expect(BigInt(c.state.delta)).toBeLessThan(8000n); // below pre-streak value
  });
});

describe('slow start (multiplicative widen until the first-ever shrink)', () => {
  it('doubles δ per clean streak while everShrunk = false, then goes additive after a loss', async () => {
    const c = await AdaptiveDeltaController.create(
      baseConfig({ cleanStreakLength: 2 })
    );
    const d0 = c.nextDelta(1_024_000n); // 4000n cold start
    expect(d0).toBe(4000n);
    // Streak 1 (δ knob): slow-start ×2.
    await c.observe(cleanFulfill());
    await c.observe(cleanFulfill());
    expect(c.state.delta).toBe('8000');
    // Streak 2 (W knob).
    await c.observe(cleanFulfill());
    await c.observe(cleanFulfill());
    expect(c.state.W).toBe(2);
    // Streak 3 (δ knob): still slow-start ×2.
    await c.observe(cleanFulfill());
    await c.observe(cleanFulfill());
    expect(c.state.delta).toBe('16000');
    // First loss ever → everShrunk latches, δ halves.
    await c.observe({ resolution: 'reject' });
    expect(c.state.delta).toBe('8000');
    // Next widen turn is the W knob (alternation continues from 'delta').
    await c.observe(cleanFulfill());
    await c.observe(cleanFulfill());
    expect(c.state.W).toBe(3);
    expect(c.state.delta).toBe('8000');
    // δ's next turn is additive (+δ_0 = +4000) — slow-start is over for good.
    await c.observe(cleanFulfill());
    await c.observe(cleanFulfill());
    expect(c.state.delta).toBe('12000');
  });
});

describe('one knob per step', () => {
  it('every observation changes at most one of {δ, W}', async () => {
    const c = await AdaptiveDeltaController.create(
      baseConfig({ cleanStreakLength: 3 })
    );
    c.nextDelta(1_000_000n);
    const sequence: PacketObservation[] = [
      cleanFulfill({ rate: '4.0', rateTimestamp: T0 }),
      cleanFulfill({ rate: '4.001', rateTimestamp: T0 + 500 }),
      cleanFulfill(),
      { resolution: 'timeout' },
      cleanFulfill(),
      cleanFulfill(),
      cleanFulfill(),
      { resolution: 'reject-stale', rttMs: 1500 },
      { resolution: 'error' },
      cleanFulfill(),
      cleanFulfill(),
      cleanFulfill(),
      cleanFulfill(),
      cleanFulfill(),
      cleanFulfill(),
      { resolution: 'reject' },
    ];
    for (const obs of sequence) {
      const before = c.state;
      await c.observe(obs);
      const after = c.state;
      const deltaChanged = before.delta !== after.delta ? 1 : 0;
      const windowChanged = before.W !== after.W ? 1 : 0;
      expect(deltaChanged + windowChanged).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Persistence: per-(chain, maker, pair) state round-trips
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('round-trips ramp state through a shared store (new session resumes trust)', async () => {
    const store = new InMemorySwapControllerStateStore();
    const c1 = await AdaptiveDeltaController.create(
      baseConfig({ store, cleanStreakLength: 2 })
    );
    c1.nextDelta(1_024_000n);
    await c1.observe(cleanFulfill({ rate: '4.0', rateTimestamp: T0 }));
    await c1.observe(cleanFulfill({ rate: '4.01', rateTimestamp: T0 + 1000 }));
    await c1.observe({ resolution: 'timeout', rttMs: 3000 });
    const persisted = c1.state;

    const c2 = await AdaptiveDeltaController.create(baseConfig({ store }));
    expect(c2.state).toEqual(persisted);
    expect(c2.window).toBe(persisted.W);
  });

  it('keys state by (chain, maker, pair): another maker cold-starts', async () => {
    const store = new InMemorySwapControllerStateStore();
    const c1 = await AdaptiveDeltaController.create(baseConfig({ store }));
    c1.nextDelta(1_024_000n);
    await c1.observe({ resolution: 'reject' }); // persists shrunk state

    const other = await AdaptiveDeltaController.create(
      baseConfig({ store, makerPubkey: OTHER_MAKER })
    );
    expect(other.state.everShrunk).toBe(false);
    expect(other.state.delta).toBe('0'); // uninitialized cold start
  });

  it('keys state by pair: a different target chain cold-starts', async () => {
    const store = new InMemorySwapControllerStateStore();
    const c1 = await AdaptiveDeltaController.create(baseConfig({ store }));
    c1.nextDelta(1_024_000n);
    await c1.observe({ resolution: 'reject' });

    const otherPair: SwapPair = {
      ...samplePair(),
      to: { assetCode: 'MINA', assetScale: 9, chain: 'solana:devnet' },
    };
    const c2 = await AdaptiveDeltaController.create(
      baseConfig({ store, pair: otherPair })
    );
    expect(c2.state.everShrunk).toBe(false);
  });

  it('cold-starts on a malformed persisted blob', async () => {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({
      makerPubkey: MAKER,
      pair: samplePair(),
    });
    await store.save(key, { garbage: true } as unknown as SwapControllerState);
    const c = await AdaptiveDeltaController.create(baseConfig({ store }));
    expect(c.window).toBe(1);
    expect(c.state.delta).toBe('0');
  });

  describe('JsonFileSwapControllerStateStore (Node JSON-file pattern)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'toon-controller-store-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('persists to disk and reloads keyed state', async () => {
      const file = join(dir, 'nested', 'controller-state.json');
      const store = new JsonFileSwapControllerStateStore(file);
      const key = swapControllerStateKey({
        makerPubkey: MAKER,
        pair: samplePair(),
      });
      const state = seededState({ delta: '4242', W: 3 });
      await store.save(key, state);

      const reloaded = await new JsonFileSwapControllerStateStore(file).load(
        key
      );
      expect(reloaded).toEqual(state);
      // The on-disk document is a { key: state } map.
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      expect(isSwapControllerState(doc[key])).toBe(true);
    });

    it('returns undefined for a missing file or unknown key', async () => {
      const store = new JsonFileSwapControllerStateStore(
        join(dir, 'missing.json')
      );
      expect(await store.load('nope')).toBeUndefined();
    });

    it('treats a corrupt file as empty instead of failing forever', async () => {
      const file = join(dir, 'corrupt.json');
      writeFileSync(file, '{not json', 'utf8');
      const store = new JsonFileSwapControllerStateStore(file);
      expect(await store.load('any')).toBeUndefined();
      // And a save after corruption recovers the file.
      await store.save('k', seededState());
      expect(await store.load('k')).toEqual(seededState());
    });

    it('drives a full controller session end-to-end (create → observe → recreate)', async () => {
      const file = join(dir, 'controller-state.json');
      const store = new JsonFileSwapControllerStateStore(file);
      const c1 = await AdaptiveDeltaController.create(baseConfig({ store }));
      c1.nextDelta(1_024_000n);
      await c1.observe({ resolution: 'reject-stale', rttMs: 1000 });
      const c2 = await AdaptiveDeltaController.create(baseConfig({ store }));
      expect(c2.state).toEqual(c1.state);
      expect(c2.state.everShrunk).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('config validation', () => {
  it('rejects a missing/zero/negative advertisedSpread (ε must be spread-denominated)', async () => {
    for (const advertisedSpread of [0, -0.01, NaN, Infinity]) {
      await expect(
        AdaptiveDeltaController.create(baseConfig({ advertisedSpread }))
      ).rejects.toBeInstanceOf(SwapControllerError);
    }
  });

  it('rejects malformed knobs', async () => {
    await expect(
      AdaptiveDeltaController.create(baseConfig({ maxWindow: 0 }))
    ).rejects.toBeInstanceOf(SwapControllerError);
    await expect(
      AdaptiveDeltaController.create(baseConfig({ cleanStreakLength: 0 }))
    ).rejects.toBeInstanceOf(SwapControllerError);
    await expect(
      AdaptiveDeltaController.create(baseConfig({ ewmaAlpha: 1.5 }))
    ).rejects.toBeInstanceOf(SwapControllerError);
    await expect(
      AdaptiveDeltaController.create(baseConfig({ makerPubkey: '' }))
    ).rejects.toBeInstanceOf(SwapControllerError);
    await expect(
      AdaptiveDeltaController.create(
        baseConfig({ minPacketAmount: 10n, maxPacketAmount: 5n })
      )
    ).rejects.toBeInstanceOf(SwapControllerError);
  });
});
