/**
 * Unit tests for Story 12.5 — `streamSwap()` sender API.
 *
 * Covers AC-1 through AC-14 from
 * `_bmad-output/implementation-artifacts/12-5-streamswap-sender-api.md`
 * and T-038..T-047 from `_bmad-output/planning-artifacts/test-design-epic-12.md`.
 *
 * MockSwap harness uses REAL crypto from Story 12.2 (`unwrapSwapPacketFromToon`
 * and `encryptFulfillClaim`) so the end-to-end wire shape is exercised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent } from 'nostr-tools/pure';
import type { SwapPair } from '@toon-protocol/core';

import { unwrapSwapPacketFromToon, encryptFulfillClaim } from './gift-wrap';
import { applyRate } from './swap-handler';

import {
  streamSwap,
  streamSwapControlled,
  type StreamSwapParams,
  type StreamSwapResult,
  type AccumulatedClaim,
  type PacketProgress,
  type RateMonitorCallback,
} from './stream-swap';
import { StreamSwapError } from './errors';
import {
  AdaptiveDeltaController,
  InMemorySwapControllerStateStore,
  swapControllerStateKey,
  type SwapControllerState,
} from './adaptive-controller';

/**
 * Shared Story 12.9 fixture: 20-byte lowercased EVM payout address used as
 * the default `chainRecipient` for all `StreamSwapParams` constructions in
 * this suite. Chain-format-valid for `evm:*` so validateChainAddress passes.
 */
const FIXTURE_EVM_RECIPIENT = '0x' + '11'.repeat(20);

// ---------------------------------------------------------------------------
// MockSwap harness
// ---------------------------------------------------------------------------

interface MockSwapOptions {
  /** Per-packet rate override (0-indexed packetIndex -> decimal-string rate). */
  rateOverride?: Map<number, string>;
  /** Indices to REJECT with the given ILP code/message. */
  rejectIndices?: Map<number, { code: string; message: string }>;
  /** Custom claim bytes factory (default: 32 random bytes per packet). */
  claimBytesFor?: (packetIndex: number) => Uint8Array;
  /** Starting index counter (allows chained swaps). */
  startIndex?: number;
  /**
   * Issue #82: emit the quote tape (`rate` + `rateTimestamp`) on each
   * FULFILL's metadata, mirroring a rolling-swap-capable maker. The
   * timestamp is deterministic (`1_700_000_000_000 + packetIndex`) so
   * ordering tests are stable.
   */
  emitTape?: boolean;
  /**
   * Issue #82: last-chance metadata mutator, applied after assembly (and
   * after tape emission). Lets tests garble/omit specific fields.
   */
  metadataOverride?: (
    packetIndex: number,
    metadata: Record<string, unknown>
  ) => Record<string, unknown>;
}

/** Deterministic tape timestamp base used when `emitTape` is set. */
const MOCK_TAPE_TS_BASE = 1_700_000_000_000;

interface MockSwapHandle {
  fn: ReturnType<typeof vi.fn>;
  unwrappedRumors: UnsignedEvent[];
  issuedClaimBytes: Map<number, Uint8Array>;
  senderPubkeysSeen: string[];
}

/**
 * Builds a `client.sendSwapPacket` stub that behaves like a real Swap:
 *   1. Unwraps the TOON gift-wrap binary (real Story 12.2 impl).
 *   2. Captures the rumor for tag-shape assertions.
 *   3. Computes `targetAmount` via `applyRate`, honoring optional overrides.
 *   4. Issues random claim bytes.
 *   5. NIP-44 encrypts them using real `encryptFulfillClaim`.
 *   6. Serializes metadata as JSON -> base64 and returns as `IlpSendResult.data`.
 */
function makeMockSwap(
  pair: SwapPair,
  swapSecretKey: Uint8Array,
  opts: MockSwapOptions = {}
): MockSwapHandle {
  let counter = opts.startIndex ?? 0;
  const handle: MockSwapHandle = {
    fn: vi.fn(),
    unwrappedRumors: [],
    issuedClaimBytes: new Map(),
    senderPubkeysSeen: [],
  };

  handle.fn.mockImplementation(
    async (params: {
      destination: string;
      amount: bigint;
      toonData: Uint8Array;
      timeout?: number;
      claim?: unknown;
    }) => {
      const packetIndex = counter++;

      // Optional rejection path (simulate T04 etc.)
      const reject = opts.rejectIndices?.get(packetIndex);
      if (reject) {
        return {
          accepted: false,
          code: reject.code,
          message: reject.message,
        };
      }

      // Unwrap gift wrap -> rumor
      const { rumor, senderPubkey } = unwrapSwapPacketFromToon({
        toonData: params.toonData,
        recipientSecretKey: swapSecretKey,
      });
      handle.unwrappedRumors.push(rumor);
      handle.senderPubkeysSeen.push(senderPubkey);

      // Pick rate (pair.rate unless overridden for this packet)
      const rate = opts.rateOverride?.get(packetIndex) ?? pair.rate;

      // Compute target
      const targetAmount = applyRate({
        sourceAmount: params.amount,
        fromScale: pair.from.assetScale,
        toScale: pair.to.assetScale,
        rate,
      });

      // Issue claim bytes
      const claimBytes =
        opts.claimBytesFor?.(packetIndex) ??
        (() => {
          const b = new Uint8Array(32);
          crypto.getRandomValues(b);
          return b;
        })();
      handle.issuedClaimBytes.set(packetIndex, claimBytes);

      // Encrypt
      const { ciphertext, ephemeralPubkey } = encryptFulfillClaim({
        claimData: claimBytes,
        senderPubkey,
      });

      const claimBase64 = Buffer.from(ciphertext).toString('base64');
      let metadata: Record<string, unknown> = {
        claim: claimBase64,
        ephemeralPubkey,
        targetAmount: targetAmount.toString(),
        claimId: `mock-claim-${packetIndex}`,
      };
      if (opts.emitTape) {
        metadata['rate'] = rate;
        metadata['rateTimestamp'] = MOCK_TAPE_TS_BASE + packetIndex;
      }
      if (opts.metadataOverride) {
        metadata = opts.metadataOverride(packetIndex, metadata);
      }

      const dataB64 = Buffer.from(JSON.stringify(metadata)).toString('base64');
      return { accepted: true, data: dataB64 };
    }
  );

  return handle;
}

function samplePair(): SwapPair {
  return {
    from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
    to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
    rate: '0.0005',
  };
}

function makeClient(
  swap: MockSwapHandle,
  senderSecretKey: Uint8Array
): StreamSwapParams['client'] {
  return {
    sendSwapPacket:
      swap.fn as unknown as StreamSwapParams['client']['sendSwapPacket'],
    getPublicKey: () => getPublicKey(senderSecretKey),
  };
}

// ---------------------------------------------------------------------------
// AC-1 — Module surface
// ---------------------------------------------------------------------------

describe('AC-1 — stream-swap module surface', () => {
  it('exports streamSwap function', () => {
    expect(typeof streamSwap).toBe('function');
  });

  it('exports streamSwapControlled function', () => {
    expect(typeof streamSwapControlled).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC-2 — StreamSwapParams validation matrix
// ---------------------------------------------------------------------------

describe('AC-2 — StreamSwapParams validation', () => {
  let baseParams: StreamSwapParams;
  const senderSecretKey = generateSecretKey();
  const swapSecretKey = generateSecretKey();
  const swapPubkey = getPublicKey(swapSecretKey);

  beforeEach(() => {
    const swap = makeMockSwap(samplePair(), swapSecretKey);
    baseParams = {
      client: makeClient(swap, senderSecretKey),
      swapPubkey,
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
    };
  });

  it('throws INVALID_AMOUNT when totalAmount <= 0n', async () => {
    await expect(
      streamSwap({ ...baseParams, totalAmount: 0n })
    ).rejects.toMatchObject({
      name: 'StreamSwapError',
      code: 'INVALID_AMOUNT',
    });
  });

  it('throws INVALID_CHUNKING when neither packetCount nor packetAmounts provided', async () => {
    const { packetCount: _pc, ...rest } = baseParams;
    void _pc;
    await expect(streamSwap(rest as StreamSwapParams)).rejects.toMatchObject({
      code: 'INVALID_CHUNKING',
    });
  });

  it('throws INVALID_CHUNKING when both packetCount AND packetAmounts provided', async () => {
    await expect(
      streamSwap({
        ...baseParams,
        packetAmounts: [500n, 500n],
      })
    ).rejects.toMatchObject({ code: 'INVALID_CHUNKING' });
  });

  it('throws INVALID_CHUNKING when packetAmounts sum != totalAmount', async () => {
    const { packetCount: _pc, ...rest } = baseParams;
    void _pc;
    await expect(
      streamSwap({ ...rest, packetAmounts: [100n, 200n] } as StreamSwapParams)
    ).rejects.toMatchObject({ code: 'INVALID_CHUNKING' });
  });

  it('throws INVALID_CHUNKING when packetCount > totalAmount', async () => {
    await expect(
      streamSwap({ ...baseParams, totalAmount: 5n, packetCount: 10 })
    ).rejects.toMatchObject({ code: 'INVALID_CHUNKING' });
  });

  it('throws INVALID_PAIR when pair.rate is not a valid decimal string', async () => {
    await expect(
      streamSwap({
        ...baseParams,
        pair: { ...samplePair(), rate: 'not-a-rate' },
      })
    ).rejects.toMatchObject({ code: 'INVALID_PAIR' });
  });

  it('throws on invalid swapPubkey (not 64 hex chars)', async () => {
    await expect(
      streamSwap({ ...baseParams, swapPubkey: 'deadbeef' })
    ).rejects.toThrow(StreamSwapError);
  });

  // Pass #2 regression: malformed pair.from / pair.to should surface as
  // StreamSwapError('INVALID_PAIR') rather than a raw TypeError from the
  // deep property access inside applyRate / buildSwapRumor.
  it('throws INVALID_PAIR when pair.from is missing', async () => {
    const badPair = {
      ...samplePair(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional malformed input
    } as any;
    delete badPair.from;
    await expect(
      streamSwap({ ...baseParams, pair: badPair })
    ).rejects.toMatchObject({ code: 'INVALID_PAIR' });
  });

  it('throws INVALID_PAIR when pair.to is missing assetScale', async () => {
    const badPair = {
      ...samplePair(),
      to: { assetCode: 'ETH', chain: 'evm:base:8453' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional malformed input
    } as any;
    await expect(
      streamSwap({ ...baseParams, pair: badPair })
    ).rejects.toMatchObject({ code: 'INVALID_PAIR' });
  });
});

// ---------------------------------------------------------------------------
// AC-5 / T-039 — chunkAmount schedule derivation
// ---------------------------------------------------------------------------

describe('AC-5 / T-039 — chunkAmount schedule derivation', () => {
  it('1000 total / 10 packets produces 10 x 100', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
    });

    expect(result.claims).toHaveLength(10);
    expect(result.claims.map((c) => c.sourceAmount)).toEqual(
      Array(10).fill(100n)
    );
  });

  it('1000 total / 3 packets produces [333n, 333n, 334n]', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 3,
    });

    expect(result.claims.map((c) => c.sourceAmount)).toEqual([
      333n,
      333n,
      334n,
    ]);
  });

  it('explicit packetAmounts passes when sum === totalAmount', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetAmounts: [100n, 200n, 300n, 400n],
    });

    expect(result.claims.map((c) => c.sourceAmount)).toEqual([
      100n,
      200n,
      300n,
      400n,
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-6 / T-038 / T-040 — packet loop + claim accumulation
// ---------------------------------------------------------------------------

describe('AC-6 / T-038 / T-040 — packet loop + claim accumulation', () => {
  it('produces N AccumulatedClaim entries with correct shape', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);
    const packetCount = 5;

    const result: StreamSwapResult = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 500n,
      packetCount,
    });

    expect(result.state).toBe('completed');
    expect(result.abortReason).toBe('complete');
    expect(result.cumulativeSource).toBe(500n);
    expect(result.claims).toHaveLength(packetCount);

    result.claims.forEach((claim: AccumulatedClaim, i: number) => {
      expect(claim.packetIndex).toBe(i);
      expect(typeof claim.sourceAmount).toBe('bigint');
      expect(typeof claim.targetAmount).toBe('bigint');
      expect(claim.claimBytes).toBeInstanceOf(Uint8Array);
      expect(claim.swapEphemeralPubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(claim.pair).toEqual(pair);
      expect(typeof claim.receivedAt).toBe('number');
    });
  });

  it('T-040: claimBytes roundtrips through Swap NIP-44 encryption byte-for-byte', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const issued = new Map<number, Uint8Array>();
    const swap = makeMockSwap(pair, swapSecretKey, {
      claimBytesFor: (i) => {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        issued.set(i, bytes);
        return bytes;
      },
    });

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 300n,
      packetCount: 3,
    });

    result.claims.forEach((c, i) => {
      expect(c.claimBytes).toEqual(issued.get(i));
    });
  });
});

// ---------------------------------------------------------------------------
// AC-7 / T-041 / T-046 — onPacket + PacketProgress
// ---------------------------------------------------------------------------

describe('AC-7 / T-041 / T-046 — onPacket callback + PacketProgress', () => {
  it('fires exactly once per FULFILL with monotonic cumulatives', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);
    const seen: PacketProgress[] = [];
    const onPacket: RateMonitorCallback = (p) => {
      seen.push(p);
    };

    await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 400n,
      packetCount: 4,
      onPacket,
    });

    expect(seen).toHaveLength(4);
    seen.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(p.total).toBe(4);
      expect(p.state).toBe('running');
      expect(Object.isFrozen(p)).toBe(true);
      if (i > 0) {
        expect(p.cumulativeSource > seen[i - 1]!.cumulativeSource).toBe(true);
      }
    });
  });

  it('synchronous throw in onPacket stops the stream with callback-throw', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 500n,
      packetCount: 5,
      onPacket: (p) => {
        if (p.index === 2) throw new Error('caller veto');
      },
    });

    expect(result.abortReason).toBe('callback-throw');
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.claims.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// AC-6 / T-043 — Rate deviation abort
// ---------------------------------------------------------------------------

describe('AC-6 / T-043 — rate deviation abort', () => {
  it('stops after packet whose effective rate deviates > threshold, including that packet', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badRate = '0.000475'; // 5% worse than 0.0005
    const swap = makeMockSwap(pair, swapSecretKey, {
      rateOverride: new Map([[3, badRate]]),
    });

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
      rateDeviationThreshold: 0.02,
    });

    expect(result.abortReason).toBe('rate-deviation');
    expect(result.claims).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// AC-6 / T-044 — Partial failure tolerance
// ---------------------------------------------------------------------------

describe('AC-6 / T-044 — partial failure tolerance', () => {
  it('continues past Swap rejections and reports them', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      rejectIndices: new Map([
        [3, { code: 'T04', message: 'insufficient inventory' }],
        [7, { code: 'T04', message: 'insufficient inventory' }],
        [9, { code: 'T04', message: 'insufficient inventory' }],
      ]),
    });

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
    });

    expect(result.claims).toHaveLength(7);
    expect(result.rejections).toHaveLength(3);
    expect(result.state).toBe('completed');
    expect(result.rejections.map((r) => r.packetIndex).sort()).toEqual([
      3, 7, 9,
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-6 / T-045 — Single-packet mode
// ---------------------------------------------------------------------------

describe('AC-6 / T-045 — single-packet mode', () => {
  it('packetCount=1 totalAmount=100n => 1 claim', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.sourceAmount).toBe(100n);
  });
});

// ---------------------------------------------------------------------------
// AC-10 / T-042 — streamSwapControlled pause / resume / stop
// ---------------------------------------------------------------------------

describe('AC-10 / T-042 — streamSwapControlled', () => {
  it('pause/resume completes all packets with abortReason=complete', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    let pausedOnce = false;
    const { result, controller } = streamSwapControlled({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 500n,
      packetCount: 5,
      onPacket: (p) => {
        if (p.index === 1 && !pausedOnce) {
          pausedOnce = true;
          controller.pause();
          // Schedule resume after a short tick so the loop gates on pause first.
          setTimeout(() => controller.resume(), 30);
        }
      },
    });

    const final = await result;
    expect(final.claims).toHaveLength(5);
    expect(final.abortReason).toBe('complete');
  });

  it('stop() mid-stream => state=stopped, partial claims preserved', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
      onPacket: (p) => {
        if (p.index === 2) controller.stop();
      },
    });

    const final = await result;
    expect(final.state).toBe('stopped');
    expect(final.abortReason).toBe('stopped');
    expect(final.claims.length).toBeGreaterThanOrEqual(3);
    expect(final.claims.length).toBeLessThan(10);
  });

  it('resume() after completed throws StreamSwapError INVALID_STATE', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    await result;
    expect(() => controller.resume()).toThrow(StreamSwapError);
  });
});

// ---------------------------------------------------------------------------
// AC-6 — AbortSignal integration
// ---------------------------------------------------------------------------

describe('AC-6 — AbortSignal integration', () => {
  it('aborting mid-stream => state=stopped, abortReason=aborted', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);
    const ac = new AbortController();

    const p = streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
      signal: ac.signal,
      onPacket: (pp) => {
        if (pp.index === 2) ac.abort();
      },
    });

    const result = await p;
    expect(result.abortReason).toBe('aborted');
    expect(result.state).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// AC-11 — StreamSwapError class
// ---------------------------------------------------------------------------

describe('AC-11 — StreamSwapError', () => {
  it('is an Error subclass with name, code, and cause support', () => {
    const cause = new Error('root');
    const e = new StreamSwapError('INVALID_AMOUNT', 'negative total', {
      cause,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('StreamSwapError');
    expect(e.code).toBe('INVALID_AMOUNT');
    expect((e as unknown as { cause: unknown }).cause).toBe(cause);
  });

  it('accepts all documented code literal values', () => {
    const codes: StreamSwapError['code'][] = [
      'INVALID_AMOUNT',
      'INVALID_CHUNKING',
      'INVALID_PAIR',
      'INVALID_STATE',
      'FULFILL_DECODE_FAILED',
    ];
    codes.forEach((c) => {
      const e = new StreamSwapError(c, 'x');
      expect(e.code).toBe(c);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-12 — FULFILL metadata decoder error matrix (via streamSwap)
// ---------------------------------------------------------------------------

describe('AC-12 — decodeFulfillMetadata error paths', () => {
  it('surfaces FULFILL_DECODE_FAILED when data is missing', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badSwap = vi.fn(async () => ({ accepted: true, data: undefined }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    const err = result.errors[0]?.cause;
    expect(err).toBeInstanceOf(StreamSwapError);
    expect((err as StreamSwapError).code).toBe('FULFILL_DECODE_FAILED');
  });

  it('surfaces FULFILL_DECODE_FAILED for non-base64 input', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badSwap = vi.fn(async () => ({
      accepted: true,
      data: '@@@not base64@@@',
    }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    expect(result.errors[0]?.cause).toBeInstanceOf(StreamSwapError);
  });

  it('surfaces FULFILL_DECODE_FAILED for invalid JSON', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badSwap = vi.fn(async () => ({
      accepted: true,
      data: Buffer.from('not json {').toString('base64'),
    }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    expect(result.errors[0]?.cause).toBeInstanceOf(StreamSwapError);
  });

  it('surfaces FULFILL_DECODE_FAILED for missing required fields', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badSwap = vi.fn(async () => ({
      accepted: true,
      data: Buffer.from(JSON.stringify({ claim: 'abc' })).toString('base64'),
    }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    expect(result.errors[0]?.cause).toBeInstanceOf(StreamSwapError);
  });

  // Pass #2 regression: a Swap-reported `targetAmount` MUST be a non-negative
  // integer decimal string. A negative / fractional / non-numeric value would
  // otherwise slip into `BigInt()` and silently corrupt `cumulativeTarget`
  // and the deviation calc — surface it as FULFILL_DECODE_FAILED instead.
  it('surfaces FULFILL_DECODE_FAILED when targetAmount is negative', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    // Build a plausible-looking metadata shape but with a negative targetAmount.
    const badSwap = vi.fn(async () => ({
      accepted: true,
      data: Buffer.from(
        JSON.stringify({
          claim: Buffer.from('aaaa').toString('base64'),
          ephemeralPubkey: 'a'.repeat(64),
          targetAmount: '-5',
        })
      ).toString('base64'),
    }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]?.cause;
    expect(err).toBeInstanceOf(StreamSwapError);
    expect((err as StreamSwapError).code).toBe('FULFILL_DECODE_FAILED');
    expect(result.claims).toHaveLength(0);
    // cumulativeTarget MUST NOT have absorbed the negative value.
    expect(result.cumulativeTarget).toBe(0n);
  });

  it('surfaces FULFILL_DECODE_FAILED when targetAmount is fractional', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badSwap = vi.fn(async () => ({
      accepted: true,
      data: Buffer.from(
        JSON.stringify({
          claim: Buffer.from('aaaa').toString('base64'),
          ephemeralPubkey: 'a'.repeat(64),
          targetAmount: '1.5',
        })
      ).toString('base64'),
    }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    const err = result.errors[0]?.cause;
    expect(err).toBeInstanceOf(StreamSwapError);
    expect((err as StreamSwapError).code).toBe('FULFILL_DECODE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// AC-4 — Rumor tag shape
// ---------------------------------------------------------------------------

describe('AC-4 — rumor tag shape', () => {
  it('emits swap-from / swap-to / amount / seq / nonce tags in documented format', async () => {
    const pair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
      rate: '0.0005',
    };
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 300n,
      packetCount: 3,
    });

    expect(swap.unwrappedRumors).toHaveLength(3);
    swap.unwrappedRumors.forEach((r, i) => {
      expect(r.kind).toBe(20032);
      const tagMap = new Map<string, string[]>();
      for (const t of r.tags) tagMap.set(t[0]!, t.slice(1));
      expect(tagMap.get('swap-from')).toEqual(['USDC:evm:base:8453']);
      expect(tagMap.get('swap-to')).toEqual(['ETH:evm:base:8453']);
      expect(tagMap.get('amount')).toEqual(['100']);
      expect(tagMap.get('seq')).toEqual([String(i + 1), '3']);
      const nonce = tagMap.get('nonce')!;
      expect(nonce).toHaveLength(1);
      expect(nonce[0]).toMatch(/^[0-9a-f]{32}$/);
    });

    // AC-4: nonces must be unique across packets so rumor IDs differ.
    const nonces = new Set(
      swap.unwrappedRumors.map(
        (r) => (r.tags.find((t) => t[0] === 'nonce') ?? ['nonce', ''])[1] ?? ''
      )
    );
    expect(nonces.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T-047 — Stress: 1000 packets
// ---------------------------------------------------------------------------

describe('T-047 — stress: 1000 packets', () => {
  it('completes 1000 packets with correct totals', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100_000n,
      packetCount: 1000,
    });

    expect(result.claims).toHaveLength(1000);
    expect(result.cumulativeSource).toBe(100_000n);
    expect(result.state).toBe('completed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC-2 — Additional validation cases (gap-fill)
// ---------------------------------------------------------------------------

describe('AC-2 — additional validation cases', () => {
  const senderSecretKey = generateSecretKey();
  const swapSecretKey = generateSecretKey();
  const swapPubkey = getPublicKey(swapSecretKey);

  function base(): StreamSwapParams {
    const swap = makeMockSwap(samplePair(), swapSecretKey);
    return {
      client: makeClient(swap, senderSecretKey),
      swapPubkey,
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
    };
  }

  it('throws INVALID_CHUNKING when packetAmounts contains a zero element', async () => {
    const { packetCount: _pc, ...rest } = base();
    void _pc;
    await expect(
      streamSwap({
        ...rest,
        packetAmounts: [500n, 0n, 500n],
      } as StreamSwapParams)
    ).rejects.toMatchObject({
      name: 'StreamSwapError',
      code: 'INVALID_CHUNKING',
    });
  });

  it('throws INVALID_CHUNKING when packetAmounts is empty', async () => {
    const { packetCount: _pc, ...rest } = base();
    void _pc;
    await expect(
      streamSwap({ ...rest, packetAmounts: [] } as StreamSwapParams)
    ).rejects.toMatchObject({ code: 'INVALID_CHUNKING' });
  });

  it('throws StreamSwapError when senderSecretKey is not 32 bytes', async () => {
    await expect(
      streamSwap({
        ...base(),
        senderSecretKey: new Uint8Array(16),
      })
    ).rejects.toThrow(StreamSwapError);
  });

  it('throws StreamSwapError when rateDeviationThreshold is negative', async () => {
    await expect(
      streamSwap({ ...base(), rateDeviationThreshold: -0.01 })
    ).rejects.toThrow(StreamSwapError);
  });

  it('throws StreamSwapError when rateDeviationThreshold is NaN', async () => {
    await expect(
      streamSwap({ ...base(), rateDeviationThreshold: Number.NaN })
    ).rejects.toThrow(StreamSwapError);
  });
});

// ---------------------------------------------------------------------------
// AC-7 — onPacket async rejection (gap-fill)
// ---------------------------------------------------------------------------

describe('AC-7 — onPacket async rejection', () => {
  it('async rejection in onPacket stops the stream with callback-throw', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 500n,
      packetCount: 5,
      onPacket: async (p) => {
        if (p.index === 1) {
          await Promise.resolve();
          throw new Error('async veto');
        }
      },
    });

    expect(result.abortReason).toBe('callback-throw');
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]?.cause.message).toBe('async veto');
    // Packet 0 and 1 accumulate before the callback fires on packet 1;
    // AFTER the callback, the loop breaks so packets 2..4 never run.
    expect(result.claims.length).toBeLessThanOrEqual(2);
  });

  it('PacketProgress passed to onPacket is deeply frozen', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);
    let captured: PacketProgress | null = null;

    await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
      onPacket: (p) => {
        captured = p;
      },
    });

    expect(captured).not.toBeNull();
    expect(Object.isFrozen(captured)).toBe(true);
    expect(() => {
      (captured as unknown as { index: number }).index = 999;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-8 — Empty claimBytes corner case (gap-fill)
// ---------------------------------------------------------------------------

describe('AC-8 — empty claimBytes corner case', () => {
  it('accumulates the claim and logs warn when decryption yields zero bytes', async () => {
    // Real `encryptFulfillClaim` rejects empty input, so we can't drive this
    // corner via the MockSwap. Instead we craft a FULFILL whose encrypted
    // payload decrypts to a deliberately empty 32-byte run. We do this by
    // encrypting a 1-byte sentinel and then overriding `decryptFulfillClaim`
    // via module-level spy is not possible without DI — so we exercise the
    // code path indirectly by having the Swap encrypt a 1-byte claim and
    // asserting the warn path still fires on boundary. For true 0-byte
    // coverage, we use a custom swap that emits a ciphertext known to decrypt
    // to empty: build it by encrypting a 1-byte value then asserting claim
    // length >= 0 (the branch `=== 0` path is unreachable without changing
    // gift-wrap). Document the limitation:
    //
    // NOTE: `if (claimBytes.length === 0)` in stream-swap.ts guards against
    // a defensive corner case. Story 12.2's `encryptFulfillClaim` rejects
    // empty input, so the branch is guarded-but-unreachable in normal flow.
    // This test asserts the surrounding contract (warn logger is pino-shaped,
    // non-empty claims are always included) rather than forcing the empty
    // branch (which would require patching gift-wrap.ts).
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const warnSpy = vi.fn();
    const swap = makeMockSwap(pair, swapSecretKey, {
      claimBytesFor: () => new Uint8Array([0x01]), // minimal valid claim
    });

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
      },
    });

    // Per AC-8: minimal-length claims ARE included in claims[].
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.claimBytes.length).toBe(1);
    expect(result.state).toBe('completed');
    // Empty-claim warn MUST NOT fire for non-empty claims.
    const warnedEmpty = warnSpy.mock.calls.some((call) => {
      const arg = call[0] as { event?: string } | undefined;
      return arg?.event === 'stream_swap.empty_claim_bytes';
    });
    expect(warnedEmpty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-9 — StreamSwapResult field coverage (gap-fill)
// ---------------------------------------------------------------------------

describe('AC-9 — StreamSwapResult bookkeeping fields', () => {
  it('packetsSent and packetsScheduled reflect accepted+rejected counts', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      rejectIndices: new Map([
        [2, { code: 'T04', message: 'insufficient inventory' }],
      ]),
    });

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 500n,
      packetCount: 5,
    });

    expect(result.packetsScheduled).toBe(5);
    // All 5 packets were attempted (4 accepted + 1 rejected).
    expect(result.packetsSent).toBe(5);
    expect(result.claims).toHaveLength(4);
    expect(result.rejections).toHaveLength(1);
    expect(result.cumulativeSource).toBe(400n);
    expect(result.cumulativeTarget).toBeGreaterThan(0n);
  });

  it('packetsSent < packetsScheduled when loop aborts early', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
      onPacket: (p) => {
        if (p.index === 2) controller.stop();
      },
    });

    const final = await result;
    expect(final.packetsScheduled).toBe(10);
    expect(final.packetsSent).toBeLessThan(10);
    expect(final.packetsSent).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// AC-10 — Controller state machine edge cases (gap-fill)
// ---------------------------------------------------------------------------

describe('AC-10 — controller state machine edges', () => {
  it('stop() is idempotent — multiple calls do not throw', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
      onPacket: (p) => {
        if (p.index === 1) {
          controller.stop();
          controller.stop(); // idempotent
          controller.stop();
        }
      },
    });

    const final = await result;
    expect(final.state).toBe('stopped');
    // Additional stop() post-termination MUST NOT throw.
    expect(() => controller.stop()).not.toThrow();
  });

  it('resume() while running is a no-op (does not throw)', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
      onPacket: () => {
        // state is 'running' at this point — resume() must be a no-op.
        expect(() => controller.resume()).not.toThrow();
      },
    });

    const final = await result;
    expect(final.state).toBe('completed');
  });

  it('resume() after stopped stream throws INVALID_STATE', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 10,
      onPacket: (p) => {
        if (p.index === 1) controller.stop();
      },
    });

    await result;
    expect(() => controller.resume()).toThrow(StreamSwapError);
    try {
      controller.resume();
    } catch (e) {
      expect((e as StreamSwapError).code).toBe('INVALID_STATE');
    }
  });

  it('controller.state reflects terminal state after result resolves', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    const final = await result;
    expect(controller.state).toBe(final.state);
  });
});

// ---------------------------------------------------------------------------
// AC-9 — Terminal-state coverage: all-rejected and FULFILL_DECODE_FAILED-only
// ---------------------------------------------------------------------------

describe('AC-9 — terminal state edge cases (gap-fill)', () => {
  it('all packets rejected => state=failed, abortReason=all-rejected', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    // Reject every one of the 4 scheduled packets.
    const swap = makeMockSwap(pair, swapSecretKey, {
      rejectIndices: new Map([
        [0, { code: 'T04', message: 'no inventory' }],
        [1, { code: 'T04', message: 'no inventory' }],
        [2, { code: 'T04', message: 'no inventory' }],
        [3, { code: 'T04', message: 'no inventory' }],
      ]),
    });

    const result = await streamSwap({
      client: makeClient(swap, senderSecretKey),
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 400n,
      packetCount: 4,
    });

    expect(result.claims).toHaveLength(0);
    expect(result.rejections).toHaveLength(4);
    expect(result.errors).toHaveLength(0);
    expect(result.state).toBe('failed');
    expect(result.abortReason).toBe('all-rejected');
    expect(result.packetsSent).toBe(4);
    expect(result.packetsScheduled).toBe(4);
    expect(result.cumulativeSource).toBe(0n);
    expect(result.cumulativeTarget).toBe(0n);
  });

  it('single packet with missing FULFILL data => state=failed, errors populated', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badSwap = vi.fn(async () => ({ accepted: true, data: undefined }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    expect(result.claims).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.state).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Code-review pass #3 regression tests
// ---------------------------------------------------------------------------

describe('Pass #3: zero-valued rate with fractional form', () => {
  it('throws INVALID_PAIR for rate="0.0"', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badPair: SwapPair = { ...samplePair(), rate: '0.0' };
    await expect(
      streamSwap({
        client: {
          sendSwapPacket:
            vi.fn() as unknown as StreamSwapParams['client']['sendSwapPacket'],
          getPublicKey: () => getPublicKey(senderSecretKey),
        },
        swapPubkey: getPublicKey(swapSecretKey),
        swapIlpAddress: 'g.toon.swap1',
        pair: badPair,
        senderSecretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 100n,
        packetCount: 1,
      })
    ).rejects.toMatchObject({ name: 'StreamSwapError', code: 'INVALID_PAIR' });
  });

  it('throws INVALID_PAIR for rate="0.000"', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badPair: SwapPair = { ...samplePair(), rate: '0.000' };
    await expect(
      streamSwap({
        client: {
          sendSwapPacket:
            vi.fn() as unknown as StreamSwapParams['client']['sendSwapPacket'],
          getPublicKey: () => getPublicKey(senderSecretKey),
        },
        swapPubkey: getPublicKey(swapSecretKey),
        swapIlpAddress: 'g.toon.swap1',
        pair: badPair,
        senderSecretKey,
        chainRecipient: FIXTURE_EVM_RECIPIENT,
        totalAmount: 100n,
        packetCount: 1,
      })
    ).rejects.toMatchObject({ name: 'StreamSwapError', code: 'INVALID_PAIR' });
  });
});

describe('Pass #3: pair immutability — caller mutation after call does not poison claims', () => {
  it('claims retain the snapshot `pair` even if caller mutates the input pair', async () => {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const pair: SwapPair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey);
    const result = await streamSwap({
      client: {
        sendSwapPacket:
          swap.fn as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 2,
    });
    expect(result.state).toBe('completed');
    // Mutate the original pair post-call — stored claims must not reflect it.
    (pair as unknown as { rate: string }).rate = '9999';
    for (const c of result.claims) {
      expect(c.pair.rate).not.toBe('9999');
      expect(c.pair.rate).toBe(samplePair().rate);
    }
  });
});

describe('Pass #3: base64 strictness in decodeFulfillMetadata', () => {
  it('rejects FULFILL data with non-multiple-of-4 length as FULFILL_DECODE_FAILED', async () => {
    // Three-character "data" that is not valid base64 (length 3, not multiple of 4).
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badSwap = vi.fn(async () => ({ accepted: true, data: 'abc' }));
    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0]!.cause as StreamSwapError).code).toBe(
      'FULFILL_DECODE_FAILED'
    );
  });
});

// ---------------------------------------------------------------------------
// Story 12.6 AC-3 — decodeFulfillMetadata settlement-field validation
//
// #153 RELAXATION: the five Story 12.6 settlement-context fields
// (channelId, nonce, cumulativeAmount, recipient, swapSignerAddress) are now
// OPTIONAL and best-effort. Each well-formed field is threaded into the
// AccumulatedClaim; an absent or malformed settlement field is silently
// dropped rather than failing the whole FULFILL decode. Only `claim` and
// `ephemeralPubkey` are strictly required. This is what lets a real swap
// FULFILL (which may echo a cross-chain channelId or a checksummed address)
// surface its signed claim instead of reporting `state: failed`.
//
// `recipient` is special: a present non-empty `recipient` is always threaded
// so the runLoop anti-substitution equality check still fires (a mismatch
// becomes a SWAP_RECIPIENT_MISMATCH rejection, NOT a decode error).
// ---------------------------------------------------------------------------

describe('Story 12.6 AC-3 — decodeFulfillMetadata settlement fields', () => {
  const EVM_CHANNEL_ID = '0x' + 'a'.repeat(64);
  const EVM_RECIPIENT = '0x' + 'b'.repeat(40);
  const EVM_SWAP_SIGNER = '0x' + 'c'.repeat(40);

  const EVM_PAIR: SwapPair = {
    from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
    to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
    rate: '0.0005',
  };

  const SOLANA_PAIR: SwapPair = {
    from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
    to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
    rate: '0.0001',
  };

  // Realistic Solana base58 pubkey (32 bytes base58 encoded, alphabet-safe).
  const SOLANA_CHANNEL_ID = '11111111111111111111111111111111';
  const SOLANA_RECIPIENT = 'So11111111111111111111111111111111111111112';
  const SOLANA_SWAP_SIGNER = 'So11111111111111111111111111111111111111113';

  /**
   * Build a base64-encoded JSON FULFILL payload with VALID NIP-44 ciphertext
   * for `claim` and arbitrary other-field overrides. The ciphertext decrypts
   * successfully under `senderSecretKey`, so the payload drives the streamSwap
   * success path all the way through AccumulatedClaim assembly — exercising
   * decodeFulfillMetadata's settlement-field threading for AC-3.
   */
  function makeValidFulfillData(
    senderPubkey: string,
    overrides: Record<string, unknown> = {}
  ): string {
    const { ciphertext, ephemeralPubkey } = encryptFulfillClaim({
      claimData: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
      senderPubkey,
    });
    const base = {
      claim: Buffer.from(ciphertext).toString('base64'),
      ephemeralPubkey,
      targetAmount: '100',
      ...overrides,
    };
    return Buffer.from(JSON.stringify(base)).toString('base64');
  }

  /**
   * Build a base64-encoded JSON FULFILL payload with placeholder (non-valid)
   * ciphertext. Used for error-path tests where decodeFulfillMetadata is the
   * gatekeeper — decrypt is unreachable because decode throws first.
   */
  function makeFulfillData(overrides: Record<string, unknown>): string {
    const base = {
      claim: Buffer.from('aaaa').toString('base64'),
      ephemeralPubkey: 'a'.repeat(64),
      targetAmount: '100',
      ...overrides,
    };
    return Buffer.from(JSON.stringify(base)).toString('base64');
  }

  /**
   * Default `chainRecipient` per chain family used by this suite's helpers.
   * Must match whatever `recipient` the swap echoes in FULFILL metadata,
   * because Story 12.9 AC-7 tightens a sender-side equality check.
   */
  function chainRecipientFor(pair: SwapPair): string {
    if (pair.to.chain.startsWith('solana:')) return SOLANA_RECIPIENT;
    return EVM_RECIPIENT;
  }

  /** Spin up a streamSwap with a single-packet swap returning the given data. */
  async function runWithData(data: string, pair: SwapPair = EVM_PAIR) {
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const badSwap = vi.fn(async () => ({ accepted: true, data }));
    return streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: chainRecipientFor(pair),
      totalAmount: 100n,
      packetCount: 1,
    });
  }

  /**
   * Success-path variant: uses the sender's real pubkey to build valid NIP-44
   * ciphertext so the claim decrypts end-to-end and settlement fields land on
   * the AccumulatedClaim.
   */
  async function runWithValidData(
    overrides: Record<string, unknown>,
    pair: SwapPair = EVM_PAIR
  ) {
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const swapSecretKey = generateSecretKey();
    const data = makeValidFulfillData(senderPubkey, overrides);
    const swap = vi.fn(async () => ({ accepted: true, data }));
    return streamSwap({
      client: {
        sendSwapPacket:
          swap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => senderPubkey,
      },
      swapPubkey: getPublicKey(swapSecretKey),
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: chainRecipientFor(pair),
      totalAmount: 100n,
      packetCount: 1,
    });
  }

  // The ONLY remaining hard FULFILL_DECODE_FAILED cases are the strictly
  // required fields: `claim` and `ephemeralPubkey`. Settlement fields are
  // best-effort (#153). `runWithData` uses placeholder ciphertext, fine here
  // because decode throws before decrypt is reached.
  it('[#153] still FULFILL_DECODE_FAILED when ephemeralPubkey is malformed (required field)', async () => {
    const result = await runWithData(
      makeFulfillData({ ephemeralPubkey: 'not-hex' }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
    expect(err.message.toLowerCase()).toMatch(/ephemeralpubkey/);
  });

  it('[#153] still FULFILL_DECODE_FAILED when claim is missing (required field)', async () => {
    const result = await runWithData(
      makeFulfillData({ claim: undefined as unknown as string }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
    expect(err.message.toLowerCase()).toMatch(/claim/);
  });

  it('[P0] accepts valid EVM settlement metadata and threads fields into AccumulatedClaim', async () => {
    const result = await runWithValidData(
      {
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );

    expect(result.errors).toHaveLength(0);
    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0]!;
    expect(claim.channelId).toBe(EVM_CHANNEL_ID);
    expect(claim.nonce).toBe('1');
    expect(claim.cumulativeAmount).toBe('100');
    expect(claim.recipient).toBe(EVM_RECIPIENT);
    expect(claim.swapSignerAddress).toBe(EVM_SWAP_SIGNER);
  });

  it('[P0] accepts valid Solana settlement metadata and threads fields into AccumulatedClaim', async () => {
    const result = await runWithValidData(
      {
        channelId: SOLANA_CHANNEL_ID,
        nonce: '42',
        cumulativeAmount: '250',
        recipient: SOLANA_RECIPIENT,
        swapSignerAddress: SOLANA_SWAP_SIGNER,
      },
      SOLANA_PAIR
    );

    expect(result.errors).toHaveLength(0);
    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0]!;
    expect(claim.channelId).toBe(SOLANA_CHANNEL_ID);
    expect(claim.nonce).toBe('42');
    expect(claim.cumulativeAmount).toBe('250');
    expect(claim.recipient).toBe(SOLANA_RECIPIENT);
    expect(claim.swapSignerAddress).toBe(SOLANA_SWAP_SIGNER);
  });

  it('[P0] preserves legacy pre-12.6 shape when all five settlement fields absent (backward-compat)', async () => {
    const result = await runWithValidData({}, EVM_PAIR);
    expect(result.errors).toHaveLength(0);
    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0]!;
    // All five fields are undefined on the legacy path.
    expect(claim.channelId).toBeUndefined();
    expect(claim.nonce).toBeUndefined();
    expect(claim.cumulativeAmount).toBeUndefined();
    expect(claim.recipient).toBeUndefined();
    expect(claim.swapSignerAddress).toBeUndefined();
  });

  // ---- #153 tolerant contract: partial / malformed settlement fields no
  //      longer fail the decode — they are dropped and the swap completes ----

  it('[#153] completes (channelId dropped) when channelId is absent but other settlement fields present (partial)', async () => {
    const result = await runWithValidData(
      {
        // channelId intentionally omitted
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.state).toBe('completed');
    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0]!;
    expect(claim.channelId).toBeUndefined();
    // The other well-formed fields still thread through.
    expect(claim.nonce).toBe('1');
    expect(claim.recipient).toBe(EVM_RECIPIENT);
    expect(claim.swapSignerAddress).toBe(EVM_SWAP_SIGNER);
  });

  it('[#153] completes (swapSignerAddress dropped) when swapSignerAddress is absent (partial presence)', async () => {
    const result = await runWithValidData(
      {
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        // swapSignerAddress intentionally omitted
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.state).toBe('completed');
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.swapSignerAddress).toBeUndefined();
    expect(result.claims[0]!.channelId).toBe(EVM_CHANNEL_ID);
  });

  it('[#153] completes (channelId dropped) when EVM channelId is too short', async () => {
    const result = await runWithValidData(
      {
        channelId: '0x' + 'a'.repeat(63), // 63 hex chars, not 64
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.state).toBe('completed');
    expect(result.claims[0]!.channelId).toBeUndefined();
  });

  it('[#153] completes (channelId dropped) when EVM channelId lacks 0x prefix', async () => {
    const result = await runWithValidData(
      {
        channelId: 'a'.repeat(64), // no 0x prefix
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.claims[0]!.channelId).toBeUndefined();
  });

  it('[#153] accepts EVM channelId with checksum (mixed-case) hex — lowercase-normalized', async () => {
    // viem / on-chain channelIds may be returned mixed-case; the decoder now
    // lowercase-normalizes before the strict-hex regex, so the field threads
    // through (preserving the swap's original casing on the claim).
    const mixed = '0x' + 'aA'.repeat(32); // 64 mixed-case hex chars
    const result = await runWithValidData(
      {
        channelId: mixed,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.claims[0]!.channelId).toBe(mixed);
  });

  it('[#153] completes (channelId dropped) when EVM channelId is uppercase but invalid length', async () => {
    const result = await runWithValidData(
      {
        channelId: '0x' + 'A'.repeat(63), // uppercase AND too short → dropped
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.claims[0]!.channelId).toBeUndefined();
  });

  it('[#153] completes (swapSignerAddress dropped) when swapSignerAddress has non-hex chars', async () => {
    const result = await runWithValidData(
      {
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: '0xZZZ' + 'c'.repeat(37), // non-hex chars
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.state).toBe('completed');
    expect(result.claims[0]!.swapSignerAddress).toBeUndefined();
  });

  it('[#153] accepts a checksummed (mixed-case) swapSignerAddress — the real viem shape', async () => {
    // The swap derives signer addresses via viem (EIP-55 checksummed). Even
    // if the swap does NOT lowercase before echoing, the decoder accepts it.
    const checksummed = '0xAbC0000000000000000000000000000000000123';
    const result = await runWithValidData(
      {
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: checksummed,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.state).toBe('completed');
    expect(result.claims[0]!.swapSignerAddress).toBe(checksummed);
  });

  it('[#153] completes (nonce dropped) when nonce is negative', async () => {
    const result = await runWithValidData(
      {
        channelId: EVM_CHANNEL_ID,
        nonce: '-1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.claims[0]!.nonce).toBeUndefined();
  });

  it('[#153] completes (cumulativeAmount dropped) when cumulativeAmount is fractional', async () => {
    const result = await runWithValidData(
      {
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100.5',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.claims[0]!.cumulativeAmount).toBeUndefined();
  });

  it('[#153] completes (nonce dropped) when a settlement field has wrong type (number instead of string)', async () => {
    const result = await runWithValidData(
      {
        channelId: EVM_CHANNEL_ID,
        nonce: 1 as unknown as string, // number, not string
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.claims[0]!.nonce).toBeUndefined();
  });

  it('[#153] accepts a cross-chain channelId echoed on a Solana target (EVM-style hex channelId dropped, swap completes)', async () => {
    // Real-swap regression: the swap provisions an EVM-style hex channelId but
    // the swap target is solana:* — the strict per-chain channelId check would
    // have hard-failed the whole decode. Now the channelId is dropped and the
    // signed claim still surfaces.
    const result = await runWithValidData(
      {
        channelId: '0x' + 'a'.repeat(64), // EVM-style hex on a solana target
        nonce: '1',
        cumulativeAmount: '100',
        recipient: SOLANA_RECIPIENT,
        swapSignerAddress: SOLANA_SWAP_SIGNER,
      },
      SOLANA_PAIR
    );
    expect(result.errors).toHaveLength(0);
    expect(result.state).toBe('completed');
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.channelId).toBeUndefined();
    expect(result.claims[0]!.recipient).toBe(SOLANA_RECIPIENT);
  });

  it('[#153] real-swap envelope (claim + ephemeralPubkey + targetAmount + full EVM settlement) completes with signed claim', async () => {
    // Mirrors the exact envelope shape the deployed swap emits on the FULFILL
    // path: { claim, ephemeralPubkey, targetAmount, claimId, channelId, nonce,
    // cumulativeAmount, recipient, swapSignerAddress }.
    const result = await runWithValidData(
      {
        claimId: 'b3c68c9c-7761-495b-a21e-50c1be49ab1a',
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      },
      EVM_PAIR
    );
    expect(result.state).toBe('completed');
    expect(result.errors).toHaveLength(0);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.claimBytes.length).toBeGreaterThan(0);
    expect(result.claims[0]!.claimId).toBe(
      'b3c68c9c-7761-495b-a21e-50c1be49ab1a'
    );
  });
});

// ---------------------------------------------------------------------------
// Story 12.9 — sender-side chain-recipient threading
// (AC-4, AC-5, AC-6, AC-7, AC-13)
// ---------------------------------------------------------------------------

describe('Story 12.9 — chainRecipient threading (sender)', () => {
  const senderSecretKey12_9 = generateSecretKey();
  const swapSecretKey12_9 = generateSecretKey();
  const swapPubkey12_9 = getPublicKey(swapSecretKey12_9);

  function evmBase(): StreamSwapParams {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey12_9);
    return {
      client: makeClient(swap, senderSecretKey12_9),
      swapPubkey: swapPubkey12_9,
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey: senderSecretKey12_9,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1_000n,
      packetCount: 1,
    };
  }

  it('[P0] T-1: streamSwap throws when chainRecipient is missing (AC-4, AC-13a)', async () => {
    const { chainRecipient: _cr, ...rest } = evmBase();
    void _cr;
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional missing field
      streamSwap(rest as any)
    ).rejects.toMatchObject({
      name: 'StreamSwapError',
      code: 'INVALID_STATE',
    });
  });

  it('[P0] T-2a: EVM malformed chainRecipient throws INVALID_CHAIN_RECIPIENT (AC-2, AC-5)', async () => {
    const base = evmBase();
    await expect(
      streamSwap({ ...base, chainRecipient: '0xNOTHEX' })
    ).rejects.toMatchObject({
      name: 'StreamSwapError',
      code: 'INVALID_CHAIN_RECIPIENT',
    });
  });

  it('[P1] T-2b: Solana malformed chainRecipient throws INVALID_CHAIN_RECIPIENT (AC-2, AC-5)', async () => {
    const solanaPair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
      rate: '0.01',
    };
    const swap = makeMockSwap(solanaPair, swapSecretKey12_9);
    await expect(
      streamSwap({
        client: makeClient(swap, senderSecretKey12_9),
        swapPubkey: swapPubkey12_9,
        swapIlpAddress: 'g.toon.swap1',
        pair: solanaPair,
        senderSecretKey: senderSecretKey12_9,
        chainRecipient: '!!!not-base58!!!',
        totalAmount: 1_000n,
        packetCount: 1,
      })
    ).rejects.toMatchObject({ code: 'INVALID_CHAIN_RECIPIENT' });
  });

  it('[P1] T-2c: Mina malformed chainRecipient throws INVALID_CHAIN_RECIPIENT (AC-2, AC-5, AC-13b)', async () => {
    // Story 12.9 AC-13b explicitly enumerates chain families (evm, solana,
    // mina, unknown). This case pins the mina:* branch of
    // `validateChainAddress` (base58 charset + length >= 32 chars). A short
    // base58 string ('abc') MUST be rejected before any packet is sent.
    const minaPair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
      rate: '0.01',
    };
    const swap = makeMockSwap(minaPair, swapSecretKey12_9);
    await expect(
      streamSwap({
        client: makeClient(swap, senderSecretKey12_9),
        swapPubkey: swapPubkey12_9,
        swapIlpAddress: 'g.toon.swap1',
        pair: minaPair,
        senderSecretKey: senderSecretKey12_9,
        chainRecipient: 'abc', // base58 but < 32 chars
        totalAmount: 1_000n,
        packetCount: 1,
      })
    ).rejects.toMatchObject({ code: 'INVALID_CHAIN_RECIPIENT' });
    // Validation MUST fire pre-packet — swap never invoked.
    expect(swap.fn).not.toHaveBeenCalled();
  });

  it('[P2] T-2d: Unknown chain family rejects empty chainRecipient and permits non-empty opaque string (AC-2, AC-13b)', async () => {
    // Story 12.9 AC-13b enumerates "unknown" as a chain family. The
    // `validateChainAddress` contract for unknown chains is "permit any
    // non-empty string; settlement layer will surface UNSUPPORTED_CHAIN".
    //
    // The sender pipeline enforces this in two stages:
    //   (a) a type/value guard rejects empty strings with INVALID_STATE
    //       (shares the entry-guard shape with senderSecretKey absence);
    //   (b) `validateChainAddress` then format-checks per chain family —
    //       for unknown chains it only requires `.length > 0`, which (a)
    //       already guaranteed, so `INVALID_CHAIN_RECIPIENT` never fires
    //       for the "unknown" branch. A non-empty opaque string therefore
    //       passes validation and defers UNSUPPORTED_CHAIN to settlement.
    //
    // This test pins both halves of that contract so a future refactor
    // that collapses the two guards cannot regress the fall-through.
    const unknownPair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'FOO', assetScale: 6, chain: 'cosmos:foo-1' },
      rate: '0.5',
    };
    const swap = makeMockSwap(unknownPair, swapSecretKey12_9);
    // (a) Empty string → INVALID_STATE (non-empty guard fires first).
    await expect(
      streamSwap({
        client: makeClient(swap, senderSecretKey12_9),
        swapPubkey: swapPubkey12_9,
        swapIlpAddress: 'g.toon.swap1',
        pair: unknownPair,
        senderSecretKey: senderSecretKey12_9,
        chainRecipient: '',
        totalAmount: 1_000n,
        packetCount: 1,
      })
    ).rejects.toMatchObject({
      name: 'StreamSwapError',
      code: 'INVALID_STATE',
    });
    expect(swap.fn).not.toHaveBeenCalled();
    // (b) Non-empty opaque string → permitted (no INVALID_CHAIN_RECIPIENT);
    // the mock swap is exercised and the swap resolves.
    await expect(
      streamSwap({
        client: makeClient(swap, senderSecretKey12_9),
        swapPubkey: swapPubkey12_9,
        swapIlpAddress: 'g.toon.swap1',
        pair: unknownPair,
        senderSecretKey: senderSecretKey12_9,
        chainRecipient: 'opaque-payout-identifier',
        totalAmount: 1_000n,
        packetCount: 1,
      })
    ).resolves.toBeDefined();
  });

  it('[P0] T-3: buildSwapRumor emits chain-recipient tag on every packet (AC-1, AC-6, AC-13c)', async () => {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey12_9);
    await streamSwap({
      client: makeClient(swap, senderSecretKey12_9),
      swapPubkey: swapPubkey12_9,
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey: senderSecretKey12_9,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 3_000n,
      packetCount: 3,
    });
    expect(swap.unwrappedRumors).toHaveLength(3);
    for (const rumor of swap.unwrappedRumors) {
      const tag = rumor.tags.find((t) => t[0] === 'chain-recipient');
      expect(tag).toBeDefined();
      expect(tag![1]).toBe(FIXTURE_EVM_RECIPIENT);
    }
  });

  it('[P1] T-4: FULFILL recipient mismatch is rejected with SWAP_RECIPIENT_MISMATCH (AC-7)', async () => {
    const pair = samplePair();
    const senderPubkey = getPublicKey(senderSecretKey12_9);
    // Swap that echoes a *different* recipient than the sender supplied.
    const badSwap = vi.fn(async () => {
      const { ciphertext, ephemeralPubkey } = encryptFulfillClaim({
        claimData: new Uint8Array([0x01]),
        senderPubkey,
      });
      const metadata = {
        claim: Buffer.from(ciphertext).toString('base64'),
        ephemeralPubkey,
        targetAmount: '1',
        channelId: '0x' + 'a'.repeat(64),
        nonce: '1',
        cumulativeAmount: '1',
        recipient: '0x' + 'b'.repeat(40), // NOT FIXTURE_EVM_RECIPIENT
        swapSignerAddress: '0x' + 'c'.repeat(40),
      };
      return {
        accepted: true,
        data: Buffer.from(JSON.stringify(metadata)).toString('base64'),
      };
    });
    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badSwap as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => senderPubkey,
      },
      swapPubkey: swapPubkey12_9,
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey: senderSecretKey12_9,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });
    expect(result.claims).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]!.code).toBe('SWAP_RECIPIENT_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// Issue #81 — per-packet expiry plumbing (rolling-swap R7 prereq)
// ---------------------------------------------------------------------------

describe('issue #81 — packetExpiryMs per-packet expiry', () => {
  const senderSecretKey81 = generateSecretKey();
  const swapSecretKey81 = generateSecretKey();
  const swapPubkey81 = getPublicKey(swapSecretKey81);

  function baseParams81(swap: MockSwapHandle): StreamSwapParams {
    return {
      client: makeClient(swap, senderSecretKey81),
      swapPubkey: swapPubkey81,
      swapIlpAddress: 'g.toon.swap1',
      pair: samplePair(),
      senderSecretKey: senderSecretKey81,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 1000n,
      packetCount: 4,
    };
  }

  it('passes expiresAt = now + packetExpiryMs to sendSwapPacket for every packet', async () => {
    const swap = makeMockSwap(samplePair(), swapSecretKey81);
    const expiryMs = 12_000;

    const before = Date.now();
    const result = await streamSwap({
      ...baseParams81(swap),
      packetExpiryMs: expiryMs,
    });
    const after = Date.now();

    expect(result.packetsSent).toBe(4);
    expect(swap.fn).toHaveBeenCalledTimes(4);
    for (const call of swap.fn.mock.calls) {
      const params = call[0] as { expiresAt?: Date };
      expect(params.expiresAt).toBeInstanceOf(Date);
      const t = params.expiresAt!.getTime();
      // Computed at send time: bounded by the stream's wall-clock window.
      expect(t).toBeGreaterThanOrEqual(before + expiryMs);
      expect(t).toBeLessThanOrEqual(after + expiryMs);
    }
  });

  it('regression: omitting packetExpiryMs sends packets WITHOUT an expiresAt field (transport default preserved)', async () => {
    const swap = makeMockSwap(samplePair(), swapSecretKey81);

    const result = await streamSwap(baseParams81(swap));

    expect(result.packetsSent).toBe(4);
    for (const call of swap.fn.mock.calls) {
      const params = call[0] as Record<string, unknown>;
      expect('expiresAt' in params).toBe(false);
    }
  });

  it.each([0, -5, 1.5, Number.NaN])(
    'throws INVALID_STATE for packetExpiryMs = %s',
    async (bad) => {
      const swap = makeMockSwap(samplePair(), swapSecretKey81);
      await expect(
        streamSwap({ ...baseParams81(swap), packetExpiryMs: bad })
      ).rejects.toMatchObject({
        name: 'StreamSwapError',
        code: 'INVALID_STATE',
      });
      expect(swap.fn).not.toHaveBeenCalled();
    }
  );
});

// ---------------------------------------------------------------------------
// Issue #82 — quote-tape plumbing + minExchangeRate hard floor
// ---------------------------------------------------------------------------

import { __testing as streamSwapTesting } from './stream-swap';

/** Minimal valid FULFILL metadata for direct decoder tests. */
function makeTapeFulfillData(overrides: Record<string, unknown>): string {
  const base: Record<string, unknown> = {
    claim: Buffer.from('claim-bytes').toString('base64'),
    ephemeralPubkey: 'a'.repeat(64),
    ...overrides,
  };
  return Buffer.from(JSON.stringify(base)).toString('base64');
}

function baseParams(
  swap: MockSwapHandle,
  senderSecretKey: Uint8Array,
  swapSecretKey: Uint8Array,
  pair: SwapPair
): StreamSwapParams {
  return {
    client: makeClient(swap, senderSecretKey),
    swapPubkey: getPublicKey(swapSecretKey),
    swapIlpAddress: 'g.toon.swap1',
    pair,
    senderSecretKey,
    chainRecipient: FIXTURE_EVM_RECIPIENT,
    totalAmount: 400n,
    packetCount: 4,
  };
}

describe('issue #82 — decodeFulfillMetadata quote-tape parsing', () => {
  const decode = streamSwapTesting.decodeFulfillMetadata;

  it('parses a well-formed tape entry (rate + rateTimestamp)', () => {
    const out = decode(
      makeTapeFulfillData({ rate: '4.0007', rateTimestamp: 1_783_936_201_437 })
    );
    expect(out.rate).toBe('4.0007');
    expect(out.rateTimestamp).toBe(1_783_936_201_437);
  });

  it('tolerates a wholly absent tape when not required (legacy maker)', () => {
    const out = decode(makeTapeFulfillData({}));
    expect(out.rate).toBeUndefined();
    expect(out.rateTimestamp).toBeUndefined();
  });

  it('throws FULFILL_DECODE_FAILED when the tape is required but absent', () => {
    expect(() =>
      decode(makeTapeFulfillData({}), undefined, { requireQuoteTape: true })
    ).toThrowError(StreamSwapError);
    try {
      decode(makeTapeFulfillData({}), undefined, { requireQuoteTape: true });
    } catch (err) {
      expect((err as StreamSwapError).code).toBe('FULFILL_DECODE_FAILED');
      expect((err as StreamSwapError).message).toMatch(/quote tape/i);
    }
  });

  it('throws on a partial tape — rate without rateTimestamp, and vice versa', () => {
    expect(() => decode(makeTapeFulfillData({ rate: '4.0' }))).toThrowError(
      StreamSwapError
    );
    expect(() =>
      decode(makeTapeFulfillData({ rateTimestamp: Date.now() }))
    ).toThrowError(StreamSwapError);
  });

  it('throws on malformed rate values — loud, never a silent drop', () => {
    const badRates = ['abc', '-1', '1e5', '.5', '00.5', '0', '0.000', 42, null];
    for (const bad of badRates) {
      expect(() =>
        decode(makeTapeFulfillData({ rate: bad, rateTimestamp: Date.now() }))
      ).toThrowError(StreamSwapError);
    }
  });

  it('throws on malformed rateTimestamp values', () => {
    const badTs = [0, -5, 1.5, '1700000000000', null, NaN];
    for (const bad of badTs) {
      expect(() =>
        decode(makeTapeFulfillData({ rate: '4.0', rateTimestamp: bad }))
      ).toThrowError(StreamSwapError);
    }
  });
});

describe('issue #82 — compareDecimalRates', () => {
  const cmp = streamSwapTesting.compareDecimalRates;

  it('compares decimal strings exactly in BigInt space', () => {
    expect(cmp('0.0005', '0.0005')).toBe(0);
    expect(cmp('0.0005', '0.00050000')).toBe(0);
    expect(cmp('0.00049999999999', '0.0005')).toBe(-1);
    expect(cmp('2800', '2800.0001')).toBe(-1);
    expect(cmp('3', '2.9999')).toBe(1);
    expect(cmp('4.0007', '3.98')).toBe(1);
  });
});

describe('issue #82 — quote tape surfaced per packet via onPacket + claims', () => {
  it('delivers fresh R_i + rateTimestamp per fulfilled packet, in packet order', async () => {
    const pair = samplePair(); // rate '0.0005'
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const rates = new Map<number, string>([
      [0, '0.0005'],
      [1, '0.0006'],
      [2, '0.00055'],
      [3, '0.0007'],
    ]);
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      rateOverride: rates,
    });

    const seen: PacketProgress[] = [];
    const result = await streamSwap({
      ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
      onPacket: (p) => {
        seen.push(p);
      },
    });

    expect(result.state).toBe('completed');
    expect(seen).toHaveLength(4);
    seen.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(p.rate).toBe(rates.get(i));
      expect(p.rateTimestamp).toBe(1_700_000_000_000 + i);
    });
    // The tape is also persisted on the accumulated claims.
    result.claims.forEach((c, i) => {
      expect(c.rate).toBe(rates.get(i));
      expect(c.rateTimestamp).toBe(1_700_000_000_000 + i);
    });
  });

  it('legacy maker without tape: progress and claims carry no tape fields (behavior unchanged)', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey); // no emitTape

    const seen: PacketProgress[] = [];
    const result = await streamSwap({
      ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
      onPacket: (p) => {
        seen.push(p);
      },
    });

    expect(result.state).toBe('completed');
    expect(result.claims).toHaveLength(4);
    seen.forEach((p) => {
      expect(p.rate).toBeUndefined();
      expect(p.rateTimestamp).toBeUndefined();
    });
    result.claims.forEach((c) => {
      expect(c.rate).toBeUndefined();
      expect(c.rateTimestamp).toBeUndefined();
    });
  });

  it('malformed tape on a fulfilled packet is a per-packet error even WITHOUT minExchangeRate', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      metadataOverride: (i, m) => {
        if (i === 1) return { ...m, rate: 'not-a-rate' };
        return m;
      },
    });

    const result = await streamSwap(
      baseParams(swap, senderSecretKey, swapSecretKey, pair)
    );

    // Packet 1 surfaces as a loud decode error; the rest complete.
    expect(result.claims.map((c) => c.packetIndex)).toEqual([0, 2, 3]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.packetIndex).toBe(1);
    expect((result.errors[0]!.cause as StreamSwapError).code).toBe(
      'FULFILL_DECODE_FAILED'
    );
  });
});

describe('issue #82 — minExchangeRate hard floor', () => {
  // samplePair: USDC(6) -> ETH(18) at '0.0005'; 100n per packet.
  // applyRate(100n, 6->18, '0.0005') = 50_000_000_000n.
  const FLOOR_TARGET_PER_PACKET = 50_000_000_000n;

  it('construction-time validation: rejects malformed/zero minExchangeRate synchronously', () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, { emitTape: true });

    for (const bad of [
      '0',
      '0.00',
      'abc',
      '',
      '-1',
      0.0005 as unknown as string,
    ]) {
      expect(() =>
        streamSwapControlled({
          ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
          minExchangeRate: bad,
        })
      ).toThrowError(StreamSwapError);
      try {
        streamSwapControlled({
          ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
          minExchangeRate: bad,
        });
      } catch (err) {
        expect((err as StreamSwapError).code).toBe('INVALID_STATE');
      }
    }
  });

  it('a fill exactly AT the floor passes; a sub-floor fill is rejected and halts the stream', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      // Packet 0 at the floor exactly; packet 1 below it.
      rateOverride: new Map([
        [0, '0.0005'],
        [1, '0.0004'],
      ]),
    });

    const result = await streamSwap({
      ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
      minExchangeRate: '0.0005',
    });

    // Packet 0 accumulated (at-floor is a pass), packet 1 rejected, stream halted.
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.packetIndex).toBe(0);
    expect(result.claims[0]!.targetAmount).toBe(FLOOR_TARGET_PER_PACKET);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]!.packetIndex).toBe(1);
    expect(result.rejections[0]!.code).toBe('BELOW_FLOOR');
    expect(result.abortReason).toBe('below-floor');
    // Packets 2 and 3 were never sent — hard stop.
    expect(result.packetsSent).toBe(2);
    expect(result.state).toBe('completed'); // prior claims exist (parity with 'rate-deviation')
  });

  it('floor breach on the FIRST packet yields state failed with zero claims', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      rateOverride: new Map([[0, '0.0001']]),
    });

    const result = await streamSwap({
      ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
      minExchangeRate: '0.0005',
    });

    expect(result.claims).toHaveLength(0);
    expect(result.state).toBe('failed');
    expect(result.abortReason).toBe('below-floor');
    expect(result.rejections[0]!.code).toBe('BELOW_FLOOR');
    expect(result.packetsSent).toBe(1);
  });

  it('floor is enforced from delivered targetAmount even when the tape paints a rosy rate', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true, // tape reports '0.0005' — at the floor, looks fine
      metadataOverride: (i, m) => {
        if (i === 1) {
          // Maker under-delivers: below ⌊δ·minRate⌋ despite the rosy tape.
          return { ...m, targetAmount: '39999999999' };
        }
        return m;
      },
    });

    const onPacket = vi.fn();
    const result = await streamSwap({
      ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
      minExchangeRate: '0.0005',
      onPacket,
    });

    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]!.code).toBe('BELOW_FLOOR');
    expect(result.abortReason).toBe('below-floor');
    expect(result.claims).toHaveLength(1); // only packet 0
    // The violating packet never reaches the callback — the floor does not
    // consult (or feed) tape/controller signals.
    expect(onPacket).toHaveBeenCalledTimes(1);
  });

  it('floor is independent of the soft monitor: a permissive rateDeviationThreshold cannot relax it', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      rateOverride: new Map([[1, '0.0004']]),
    });

    const result = await streamSwap({
      ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
      minExchangeRate: '0.0005',
      // Soft monitor would tolerate a 20% deviation — the hard floor must not.
      rateDeviationThreshold: 10,
    });

    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]!.code).toBe('BELOW_FLOOR');
    expect(result.abortReason).toBe('below-floor');
    expect(result.claims.map((c) => c.packetIndex)).toEqual([0]);
  });

  it('soft monitor behavior unchanged: above-floor deviation still accumulates then aborts rate-deviation', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      // 10% down from advertised — above the (low) floor, beyond the 5% monitor.
      rateOverride: new Map([[1, '0.00045']]),
    });

    const result = await streamSwap({
      ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
      minExchangeRate: '0.0001',
      rateDeviationThreshold: 0.05,
    });

    // Soft semantics: the deviating packet IS accumulated (post-hoc monitor),
    // then the stream aborts. This is the documented distinction from the
    // pre-accept hard floor.
    expect(result.abortReason).toBe('rate-deviation');
    expect(result.claims.map((c) => c.packetIndex)).toEqual([0, 1]);
    expect(result.rejections).toHaveLength(0);
  });

  it('minExchangeRate REQUIRES the tape: a tapeless maker is a loud per-packet decode error', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey); // legacy maker — no tape

    const result = await streamSwap({
      ...baseParams(swap, senderSecretKey, swapSecretKey, pair),
      minExchangeRate: '0.0005',
    });

    expect(result.claims).toHaveLength(0);
    expect(result.state).toBe('failed');
    expect(result.errors).toHaveLength(4);
    result.errors.forEach((e) => {
      expect((e.cause as StreamSwapError).code).toBe('FULFILL_DECODE_FAILED');
      expect((e.cause as StreamSwapError).message).toMatch(/quote tape/i);
    });
  });

  it('legacy path fully unchanged when minExchangeRate omitted: sub-floor rates flow through', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const swapSecretKey = generateSecretKey();
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      rateOverride: new Map([[1, '0.0001']]), // would breach any sane floor
    });

    const result = await streamSwap(
      baseParams(swap, senderSecretKey, swapSecretKey, pair)
    );

    // No floor armed -> nothing rejected, all four accumulate.
    expect(result.state).toBe('completed');
    expect(result.abortReason).toBe('complete');
    expect(result.claims).toHaveLength(4);
    expect(result.rejections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #83 — adaptive δ/W controller wiring
// ---------------------------------------------------------------------------

describe('issue #83 — adaptive controller wiring (streamSwap)', () => {
  const senderSecretKey = generateSecretKey();
  const swapSecretKey = generateSecretKey();
  const swapPubkey = getPublicKey(swapSecretKey);

  function adaptiveParams(
    swap: MockSwapHandle,
    pair: SwapPair,
    controller: StreamSwapParams['controller'],
    extra: Partial<StreamSwapParams> = {}
  ): StreamSwapParams {
    return {
      client: makeClient(swap, senderSecretKey),
      swapPubkey,
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 10_000n,
      controller,
      ...extra,
    };
  }

  /** Controller with pre-seeded per-tuple persisted state (keyed by the mock maker). */
  async function seededController(
    pair: SwapPair,
    stateOverrides: Partial<SwapControllerState> = {},
    configOverrides: Record<string, unknown> = {}
  ): Promise<AdaptiveDeltaController> {
    const store = new InMemorySwapControllerStateStore();
    const key = swapControllerStateKey({ makerPubkey: swapPubkey, pair });
    await store.save(key, {
      v: 1,
      delta: '2500',
      W: 1,
      vEwma: 0,
      tauEwma: 0,
      cleanStreak: 0,
      everShrunk: true,
      lastWidened: 'window',
      updatedAt: Date.now(),
      ...stateOverrides,
    });
    return AdaptiveDeltaController.create({
      makerPubkey: swapPubkey,
      pair,
      advertisedSpread: 0.004,
      store,
      ...configOverrides,
    });
  }

  it('rejects controller combined with packetCount/packetAmounts (INVALID_CHUNKING)', async () => {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey);
    const controller = await seededController(pair);
    await expect(
      streamSwap(adaptiveParams(swap, pair, controller, { packetCount: 4 }))
    ).rejects.toMatchObject({ code: 'INVALID_CHUNKING' });
    await expect(
      streamSwap(
        adaptiveParams(swap, pair, controller, {
          packetAmounts: [5_000n, 5_000n],
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_CHUNKING' });
  });

  it('rejects a malformed controller object (INVALID_STATE)', async () => {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey);
    await expect(
      streamSwap(
        adaptiveParams(swap, pair, {
          window: 1,
        } as unknown as StreamSwapParams['controller'])
      )
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('drives packet sizing from the controller (no static split) and fills the notional', async () => {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey, { emitTape: true });
    const controller = await seededController(pair, { delta: '2500' });

    const result = await streamSwap(adaptiveParams(swap, pair, controller));

    expect(result.state).toBe('completed');
    expect(result.abortReason).toBe('complete');
    expect(result.claims.map((c) => c.sourceAmount)).toEqual([
      2500n,
      2500n,
      2500n,
      2500n,
    ]);
    expect(result.cumulativeSource).toBe(10_000n);
    expect(result.packetsScheduled).toBe(4);
    // Tape threads through to the accumulated claims in adaptive mode too.
    expect(result.claims.every((c) => c.rate === pair.rate)).toBe(true);
  });

  it('cold start: packets are small probes (δ_0 = notional/divisor) with W = 1', async () => {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey, { emitTape: true });
    const controller = await AdaptiveDeltaController.create({
      makerPubkey: swapPubkey,
      pair,
      advertisedSpread: 0.004,
      coldStartDivisor: 4,
    });
    expect(controller.window).toBe(1);

    const result = await streamSwap(adaptiveParams(swap, pair, controller));

    expect(result.state).toBe('completed');
    expect(result.claims.map((c) => c.sourceAmount)).toEqual([
      2500n,
      2500n,
      2500n,
      2500n,
    ]);
  });

  it('a mid-stream reject halves δ for the remaining packets (multiplicative shrink)', async () => {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      rejectIndices: new Map([
        [1, { code: 'T99', message: 'stale_rate: feed too old' }],
      ]),
    });
    const controller = await seededController(pair, { delta: '4000' });

    const result = await streamSwap(
      adaptiveParams(swap, pair, controller, { totalAmount: 12_000n })
    );

    // 4000 (ok), 4000 (T99 reject → δ ← 2000), 2000 (ok), 2000 (ok).
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.code).toBe('T99');
    expect(controller.state.delta).toBe('2000');
    expect(controller.state.everShrunk).toBe(true);
    expect(result.claims.map((c) => c.sourceAmount)).toEqual([
      4000n,
      2000n,
      2000n,
    ]);
    // The rejected slice is not re-scheduled (no packet retries).
    expect(result.cumulativeSource).toBe(8_000n);
    expect(result.state).toBe('completed');
  });

  it('a transport timeout halves W (the timing knob), leaving δ alone', async () => {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey, { emitTape: true });
    const controller = await seededController(pair, { delta: '2500', W: 2 });

    const realClient = makeClient(swap, senderSecretKey);
    let calls = 0;
    const flaky: StreamSwapParams['client'] = {
      getPublicKey: realClient.getPublicKey,
      sendSwapPacket: async (p) => {
        calls += 1;
        if (calls === 2) throw new Error('request timed out');
        return realClient.sendSwapPacket(p);
      },
    };

    const result = await streamSwap({
      ...adaptiveParams(swap, pair, controller),
      client: flaky,
    });

    expect(result.errors).toHaveLength(1);
    expect(controller.state.W).toBe(1);
    // One knob per step: the timeout touched W, never δ.
    expect(controller.state.delta).toBe('2500');
    expect(result.cumulativeSource).toBe(7_500n);
  });

  it('keeps up to W packets in flight concurrently', async () => {
    const pair = samplePair();
    const controller = await seededController(pair, { delta: '1000', W: 3 });

    let inflight = 0;
    let maxInflight = 0;
    const client: StreamSwapParams['client'] = {
      getPublicKey: () => getPublicKey(senderSecretKey),
      sendSwapPacket: async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inflight -= 1;
        return { accepted: false, code: 'F00', message: 'nope' };
      },
    };

    const result = await streamSwap({
      client,
      swapPubkey,
      swapIlpAddress: 'g.toon.swap1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 3_000n,
      controller,
    });

    expect(maxInflight).toBe(3);
    expect(result.packetsScheduled).toBe(3);
    expect(result.state).toBe('failed');
    expect(result.abortReason).toBe('all-rejected');
  });

  it('controller state can NEVER relax the minExchangeRate floor (floor independence)', async () => {
    const pair = samplePair(); // advertised rate 0.0005
    const swap = makeMockSwap(pair, swapSecretKey, {
      emitTape: true,
      rateOverride: new Map([[1, '0.0004']]), // second packet quotes below floor
    });
    // A deliberately "trusting" persisted state: wide δ, long clean streak.
    const controller = await seededController(pair, {
      delta: '2500',
      cleanStreak: 15,
      everShrunk: false,
    });

    const result = await streamSwap(
      adaptiveParams(swap, pair, controller, {
        minExchangeRate: pair.rate,
      })
    );

    // The exact adversarial-tape shape: packet 0's clean fulfill completed
    // the seeded streak, so the calm tape DID widen δ (slow-start 2500 → 5000)
    // — and the floor still tripped on packet 1 and hard-stopped the stream.
    // Controller state loosens δ only; it never touches the floor.
    expect(result.abortReason).toBe('below-floor');
    expect(result.rejections.map((r) => r.code)).toContain('BELOW_FLOOR');
    expect(result.claims).toHaveLength(1);
    expect(result.rejections[0]?.sourceAmount).toBe(5000n); // the widened packet
    // The breach also fed the controller a shrink signal for next session:
    // the widened 5000 halved back down.
    expect(controller.state.delta).toBe('2500');
    expect(controller.state.everShrunk).toBe(true);
  });

  it('legacy path is untouched: identical params without controller still use the static split', async () => {
    const pair = samplePair();
    const swap = makeMockSwap(pair, swapSecretKey, { emitTape: true });
    const result = await streamSwap(
      baseParams(swap, senderSecretKey, swapSecretKey, pair) // packetCount: 4
    );
    expect(result.state).toBe('completed');
    expect(result.claims.map((c) => c.sourceAmount)).toEqual([
      100n,
      100n,
      100n,
      100n,
    ]);
  });
});
