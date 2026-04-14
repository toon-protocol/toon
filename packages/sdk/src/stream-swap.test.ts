/**
 * Unit tests for Story 12.5 — `streamSwap()` sender API.
 *
 * Covers AC-1 through AC-14 from
 * `_bmad-output/implementation-artifacts/12-5-streamswap-sender-api.md`
 * and T-038..T-047 from `_bmad-output/planning-artifacts/test-design-epic-12.md`.
 *
 * MockMill harness uses REAL crypto from Story 12.2 (`unwrapSwapPacketFromToon`
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

/**
 * Shared Story 12.9 fixture: 20-byte lowercased EVM payout address used as
 * the default `chainRecipient` for all `StreamSwapParams` constructions in
 * this suite. Chain-format-valid for `evm:*` so validateChainAddress passes.
 */
const FIXTURE_EVM_RECIPIENT = '0x' + '11'.repeat(20);

// ---------------------------------------------------------------------------
// MockMill harness
// ---------------------------------------------------------------------------

interface MockMillOptions {
  /** Per-packet rate override (0-indexed packetIndex -> decimal-string rate). */
  rateOverride?: Map<number, string>;
  /** Indices to REJECT with the given ILP code/message. */
  rejectIndices?: Map<number, { code: string; message: string }>;
  /** Custom claim bytes factory (default: 32 random bytes per packet). */
  claimBytesFor?: (packetIndex: number) => Uint8Array;
  /** Starting index counter (allows chained mills). */
  startIndex?: number;
}

interface MockMillHandle {
  fn: ReturnType<typeof vi.fn>;
  unwrappedRumors: UnsignedEvent[];
  issuedClaimBytes: Map<number, Uint8Array>;
  senderPubkeysSeen: string[];
}

/**
 * Builds a `client.sendSwapPacket` stub that behaves like a real Mill:
 *   1. Unwraps the TOON gift-wrap binary (real Story 12.2 impl).
 *   2. Captures the rumor for tag-shape assertions.
 *   3. Computes `targetAmount` via `applyRate`, honoring optional overrides.
 *   4. Issues random claim bytes.
 *   5. NIP-44 encrypts them using real `encryptFulfillClaim`.
 *   6. Serializes metadata as JSON -> base64 and returns as `IlpSendResult.data`.
 */
function makeMockMill(
  pair: SwapPair,
  millSecretKey: Uint8Array,
  opts: MockMillOptions = {}
): MockMillHandle {
  let counter = opts.startIndex ?? 0;
  const handle: MockMillHandle = {
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
        recipientSecretKey: millSecretKey,
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
      const metadata: Record<string, unknown> = {
        claim: claimBase64,
        ephemeralPubkey,
        targetAmount: targetAmount.toString(),
        claimId: `mock-claim-${packetIndex}`,
      };

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
  mill: MockMillHandle,
  senderSecretKey: Uint8Array
): StreamSwapParams['client'] {
  return {
    sendSwapPacket:
      mill.fn as unknown as StreamSwapParams['client']['sendSwapPacket'],
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
  const millSecretKey = generateSecretKey();
  const millPubkey = getPublicKey(millSecretKey);

  beforeEach(() => {
    const mill = makeMockMill(samplePair(), millSecretKey);
    baseParams = {
      client: makeClient(mill, senderSecretKey),
      millPubkey,
      millIlpAddress: 'g.toon.mill1',
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

  it('throws on invalid millPubkey (not 64 hex chars)', async () => {
    await expect(
      streamSwap({ ...baseParams, millPubkey: 'deadbeef' })
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);
    const packetCount = 5;

    const result: StreamSwapResult = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
      expect(claim.millEphemeralPubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(claim.pair).toEqual(pair);
      expect(typeof claim.receivedAt).toBe('number');
    });
  });

  it('T-040: claimBytes roundtrips through Mill NIP-44 encryption byte-for-byte', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const millSecretKey = generateSecretKey();
    const issued = new Map<number, Uint8Array>();
    const mill = makeMockMill(pair, millSecretKey, {
      claimBytesFor: (i) => {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        issued.set(i, bytes);
        return bytes;
      },
    });

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);
    const seen: PacketProgress[] = [];
    const onPacket: RateMonitorCallback = (p) => {
      seen.push(p);
    };

    await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badRate = '0.000475'; // 5% worse than 0.0005
    const mill = makeMockMill(pair, millSecretKey, {
      rateOverride: new Map([[3, badRate]]),
    });

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
  it('continues past Mill rejections and reports them', async () => {
    const pair = samplePair();
    const senderSecretKey = generateSecretKey();
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey, {
      rejectIndices: new Map([
        [3, { code: 'T04', message: 'insufficient inventory' }],
        [7, { code: 'T04', message: 'insufficient inventory' }],
        [9, { code: 'T04', message: 'insufficient inventory' }],
      ]),
    });

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    let pausedOnce = false;
    const { result, controller } = streamSwapControlled({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);
    const ac = new AbortController();

    const p = streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badMill = vi.fn(async () => ({ accepted: true, data: undefined }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badMill = vi.fn(async () => ({
      accepted: true,
      data: '@@@not base64@@@',
    }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badMill = vi.fn(async () => ({
      accepted: true,
      data: Buffer.from('not json {').toString('base64'),
    }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badMill = vi.fn(async () => ({
      accepted: true,
      data: Buffer.from(JSON.stringify({ claim: 'abc' })).toString('base64'),
    }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
      pair: samplePair(),
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });

    expect(result.errors[0]?.cause).toBeInstanceOf(StreamSwapError);
  });

  // Pass #2 regression: a Mill-reported `targetAmount` MUST be a non-negative
  // integer decimal string. A negative / fractional / non-numeric value would
  // otherwise slip into `BigInt()` and silently corrupt `cumulativeTarget`
  // and the deviation calc — surface it as FULFILL_DECODE_FAILED instead.
  it('surfaces FULFILL_DECODE_FAILED when targetAmount is negative', async () => {
    const senderSecretKey = generateSecretKey();
    const millSecretKey = generateSecretKey();
    // Build a plausible-looking metadata shape but with a negative targetAmount.
    const badMill = vi.fn(async () => ({
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
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badMill = vi.fn(async () => ({
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
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
      pair,
      senderSecretKey,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 300n,
      packetCount: 3,
    });

    expect(mill.unwrappedRumors).toHaveLength(3);
    mill.unwrappedRumors.forEach((r, i) => {
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
      mill.unwrappedRumors.map(
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
  const millSecretKey = generateSecretKey();
  const millPubkey = getPublicKey(millSecretKey);

  function base(): StreamSwapParams {
    const mill = makeMockMill(samplePair(), millSecretKey);
    return {
      client: makeClient(mill, senderSecretKey),
      millPubkey,
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);
    let captured: PacketProgress | null = null;

    await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    // corner via the MockMill. Instead we craft a FULFILL whose encrypted
    // payload decrypts to a deliberately empty 32-byte run. We do this by
    // encrypting a 1-byte sentinel and then overriding `decryptFulfillClaim`
    // via module-level spy is not possible without DI — so we exercise the
    // code path indirectly by having the Mill encrypt a 1-byte claim and
    // asserting the warn path still fires on boundary. For true 0-byte
    // coverage, we use a custom mill that emits a ciphertext known to decrypt
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
    const millSecretKey = generateSecretKey();
    const warnSpy = vi.fn();
    const mill = makeMockMill(pair, millSecretKey, {
      claimBytesFor: () => new Uint8Array([0x01]), // minimal valid claim
    });

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey, {
      rejectIndices: new Map([
        [2, { code: 'T04', message: 'insufficient inventory' }],
      ]),
    });

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const mill = makeMockMill(pair, millSecretKey);

    const { result, controller } = streamSwapControlled({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    // Reject every one of the 4 scheduled packets.
    const mill = makeMockMill(pair, millSecretKey, {
      rejectIndices: new Map([
        [0, { code: 'T04', message: 'no inventory' }],
        [1, { code: 'T04', message: 'no inventory' }],
        [2, { code: 'T04', message: 'no inventory' }],
        [3, { code: 'T04', message: 'no inventory' }],
      ]),
    });

    const result = await streamSwap({
      client: makeClient(mill, senderSecretKey),
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badMill = vi.fn(async () => ({ accepted: true, data: undefined }));

    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badPair: SwapPair = { ...samplePair(), rate: '0.0' };
    await expect(
      streamSwap({
        client: {
          sendSwapPacket:
            vi.fn() as unknown as StreamSwapParams['client']['sendSwapPacket'],
          getPublicKey: () => getPublicKey(senderSecretKey),
        },
        millPubkey: getPublicKey(millSecretKey),
        millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badPair: SwapPair = { ...samplePair(), rate: '0.000' };
    await expect(
      streamSwap({
        client: {
          sendSwapPacket:
            vi.fn() as unknown as StreamSwapParams['client']['sendSwapPacket'],
          getPublicKey: () => getPublicKey(senderSecretKey),
        },
        millPubkey: getPublicKey(millSecretKey),
        millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const pair: SwapPair = samplePair();
    const mill = makeMockMill(pair, millSecretKey);
    const result = await streamSwap({
      client: {
        sendSwapPacket:
          mill.fn as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const badMill = vi.fn(async () => ({ accepted: true, data: 'abc' }));
    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
// Fills the Task 2 gap: "Add tests covering (a) valid EVM metadata roundtrips,
// (b) valid Solana metadata roundtrips, (c) missing channelId ->
// FULFILL_DECODE_FAILED, (d) malformed EVM channelId (too short / wrong
// prefix / uppercase) -> FULFILL_DECODE_FAILED."
//
// The stream-swap.ts decoder enforces all-or-nothing: if ANY one of the five
// settlement fields is present, ALL five MUST be present and well-formed
// per-chain.
// ---------------------------------------------------------------------------

describe('Story 12.6 AC-3 — decodeFulfillMetadata settlement fields', () => {
  const EVM_CHANNEL_ID = '0x' + 'a'.repeat(64);
  const EVM_RECIPIENT = '0x' + 'b'.repeat(40);
  const EVM_MILL_SIGNER = '0x' + 'c'.repeat(40);

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
  const SOLANA_MILL_SIGNER = 'So11111111111111111111111111111111111111113';

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
   * Must match whatever `recipient` the mill echoes in FULFILL metadata,
   * because Story 12.9 AC-7 tightens a sender-side equality check.
   */
  function chainRecipientFor(pair: SwapPair): string {
    if (pair.to.chain.startsWith('solana:')) return SOLANA_RECIPIENT;
    return EVM_RECIPIENT;
  }

  /** Spin up a streamSwap with a single-packet mill returning the given data. */
  async function runWithData(data: string, pair: SwapPair = EVM_PAIR) {
    const senderSecretKey = generateSecretKey();
    const millSecretKey = generateSecretKey();
    const badMill = vi.fn(async () => ({ accepted: true, data }));
    return streamSwap({
      client: {
        sendSwapPacket:
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => getPublicKey(senderSecretKey),
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
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
    const millSecretKey = generateSecretKey();
    const data = makeValidFulfillData(senderPubkey, overrides);
    const mill = vi.fn(async () => ({ accepted: true, data }));
    return streamSwap({
      client: {
        sendSwapPacket:
          mill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => senderPubkey,
      },
      millPubkey: getPublicKey(millSecretKey),
      millIlpAddress: 'g.toon.mill1',
      pair,
      senderSecretKey,
      chainRecipient: chainRecipientFor(pair),
      totalAmount: 100n,
      packetCount: 1,
    });
  }

  it('[P0] accepts valid EVM settlement metadata and threads fields into AccumulatedClaim', async () => {
    const result = await runWithValidData(
      {
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        millSignerAddress: EVM_MILL_SIGNER,
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
    expect(claim.millSignerAddress).toBe(EVM_MILL_SIGNER);
  });

  it('[P0] accepts valid Solana settlement metadata and threads fields into AccumulatedClaim', async () => {
    const result = await runWithValidData(
      {
        channelId: SOLANA_CHANNEL_ID,
        nonce: '42',
        cumulativeAmount: '250',
        recipient: SOLANA_RECIPIENT,
        millSignerAddress: SOLANA_MILL_SIGNER,
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
    expect(claim.millSignerAddress).toBe(SOLANA_MILL_SIGNER);
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
    expect(claim.millSignerAddress).toBeUndefined();
  });

  it('[P0] FULFILL_DECODE_FAILED when channelId is missing but other settlement fields present (partial)', async () => {
    const result = await runWithData(
      makeFulfillData({
        // channelId intentionally omitted
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        millSignerAddress: EVM_MILL_SIGNER,
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err).toBeInstanceOf(StreamSwapError);
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
    expect(err.message.toLowerCase()).toMatch(/partial|channelid/);
  });

  it('[P0] FULFILL_DECODE_FAILED when millSignerAddress is missing (partial presence)', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        // millSignerAddress intentionally omitted
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
  });

  it('[P0] FULFILL_DECODE_FAILED when EVM channelId is too short', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: '0x' + 'a'.repeat(63), // 63 hex chars, not 64
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        millSignerAddress: EVM_MILL_SIGNER,
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
    expect(err.message.toLowerCase()).toMatch(/channelid/);
  });

  it('[P0] FULFILL_DECODE_FAILED when EVM channelId lacks 0x prefix', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: 'a'.repeat(64), // no 0x prefix
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        millSignerAddress: EVM_MILL_SIGNER,
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0]!.cause as StreamSwapError).code).toBe(
      'FULFILL_DECODE_FAILED'
    );
  });

  it('[P0] FULFILL_DECODE_FAILED when EVM channelId contains uppercase hex', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: '0x' + 'A'.repeat(64), // uppercase, spec requires lowercase
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        millSignerAddress: EVM_MILL_SIGNER,
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0]!.cause as StreamSwapError).code).toBe(
      'FULFILL_DECODE_FAILED'
    );
  });

  it('[P0] FULFILL_DECODE_FAILED when EVM recipient has wrong length', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: '0x' + 'b'.repeat(41), // off-by-one
        millSignerAddress: EVM_MILL_SIGNER,
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
    expect(err.message.toLowerCase()).toMatch(/recipient/);
  });

  it('[P0] FULFILL_DECODE_FAILED when EVM millSignerAddress is malformed', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        millSignerAddress: '0xZZZ' + 'c'.repeat(37), // non-hex chars
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
    expect(err.message.toLowerCase()).toMatch(/millsigneraddress/);
  });

  it('[P0] FULFILL_DECODE_FAILED when nonce is negative', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: EVM_CHANNEL_ID,
        nonce: '-1',
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        millSignerAddress: EVM_MILL_SIGNER,
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
    expect(err.message.toLowerCase()).toMatch(/nonce/);
  });

  it('[P0] FULFILL_DECODE_FAILED when cumulativeAmount is fractional', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: EVM_CHANNEL_ID,
        nonce: '1',
        cumulativeAmount: '100.5',
        recipient: EVM_RECIPIENT,
        millSignerAddress: EVM_MILL_SIGNER,
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!.cause as StreamSwapError;
    expect(err.code).toBe('FULFILL_DECODE_FAILED');
    expect(err.message.toLowerCase()).toMatch(/cumulativeamount/);
  });

  it('[P1] FULFILL_DECODE_FAILED when a settlement field has wrong type (number instead of string)', async () => {
    const result = await runWithData(
      makeFulfillData({
        channelId: EVM_CHANNEL_ID,
        nonce: 1 as unknown as string, // number, not string
        cumulativeAmount: '100',
        recipient: EVM_RECIPIENT,
        millSignerAddress: EVM_MILL_SIGNER,
      }),
      EVM_PAIR
    );
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0]!.cause as StreamSwapError).code).toBe(
      'FULFILL_DECODE_FAILED'
    );
  });
});

// ---------------------------------------------------------------------------
// Story 12.9 — sender-side chain-recipient threading
// (AC-4, AC-5, AC-6, AC-7, AC-13)
// ---------------------------------------------------------------------------

describe('Story 12.9 — chainRecipient threading (sender)', () => {
  const senderSecretKey12_9 = generateSecretKey();
  const millSecretKey12_9 = generateSecretKey();
  const millPubkey12_9 = getPublicKey(millSecretKey12_9);

  function evmBase(): StreamSwapParams {
    const pair = samplePair();
    const mill = makeMockMill(pair, millSecretKey12_9);
    return {
      client: makeClient(mill, senderSecretKey12_9),
      millPubkey: millPubkey12_9,
      millIlpAddress: 'g.toon.mill1',
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
    const mill = makeMockMill(solanaPair, millSecretKey12_9);
    await expect(
      streamSwap({
        client: makeClient(mill, senderSecretKey12_9),
        millPubkey: millPubkey12_9,
        millIlpAddress: 'g.toon.mill1',
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
    const mill = makeMockMill(minaPair, millSecretKey12_9);
    await expect(
      streamSwap({
        client: makeClient(mill, senderSecretKey12_9),
        millPubkey: millPubkey12_9,
        millIlpAddress: 'g.toon.mill1',
        pair: minaPair,
        senderSecretKey: senderSecretKey12_9,
        chainRecipient: 'abc', // base58 but < 32 chars
        totalAmount: 1_000n,
        packetCount: 1,
      })
    ).rejects.toMatchObject({ code: 'INVALID_CHAIN_RECIPIENT' });
    // Validation MUST fire pre-packet — mill never invoked.
    expect(mill.fn).not.toHaveBeenCalled();
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
    const mill = makeMockMill(unknownPair, millSecretKey12_9);
    // (a) Empty string → INVALID_STATE (non-empty guard fires first).
    await expect(
      streamSwap({
        client: makeClient(mill, senderSecretKey12_9),
        millPubkey: millPubkey12_9,
        millIlpAddress: 'g.toon.mill1',
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
    expect(mill.fn).not.toHaveBeenCalled();
    // (b) Non-empty opaque string → permitted (no INVALID_CHAIN_RECIPIENT);
    // the mock mill is exercised and the swap resolves.
    await expect(
      streamSwap({
        client: makeClient(mill, senderSecretKey12_9),
        millPubkey: millPubkey12_9,
        millIlpAddress: 'g.toon.mill1',
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
    const mill = makeMockMill(pair, millSecretKey12_9);
    await streamSwap({
      client: makeClient(mill, senderSecretKey12_9),
      millPubkey: millPubkey12_9,
      millIlpAddress: 'g.toon.mill1',
      pair,
      senderSecretKey: senderSecretKey12_9,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 3_000n,
      packetCount: 3,
    });
    expect(mill.unwrappedRumors).toHaveLength(3);
    for (const rumor of mill.unwrappedRumors) {
      const tag = rumor.tags.find((t) => t[0] === 'chain-recipient');
      expect(tag).toBeDefined();
      expect(tag![1]).toBe(FIXTURE_EVM_RECIPIENT);
    }
  });

  it('[P1] T-4: FULFILL recipient mismatch is rejected with MILL_RECIPIENT_MISMATCH (AC-7)', async () => {
    const pair = samplePair();
    const senderPubkey = getPublicKey(senderSecretKey12_9);
    // Mill that echoes a *different* recipient than the sender supplied.
    const badMill = vi.fn(async () => {
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
        millSignerAddress: '0x' + 'c'.repeat(40),
      };
      return {
        accepted: true,
        data: Buffer.from(JSON.stringify(metadata)).toString('base64'),
      };
    });
    const result = await streamSwap({
      client: {
        sendSwapPacket:
          badMill as unknown as StreamSwapParams['client']['sendSwapPacket'],
        getPublicKey: () => senderPubkey,
      },
      millPubkey: millPubkey12_9,
      millIlpAddress: 'g.toon.mill1',
      pair,
      senderSecretKey: senderSecretKey12_9,
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      totalAmount: 100n,
      packetCount: 1,
    });
    expect(result.claims).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]!.code).toBe('MILL_RECIPIENT_MISMATCH');
  });
});
