/**
 * ATDD Tests: Swap Handler (Story 12.3)
 *
 * Failing acceptance tests for `createSwapHandler()` factory — the kind:1059
 * Swap inbound-swap handler that unwraps NIP-59 gift-wrapped ILP packets,
 * applies per-packet rate conversion, delegates signed claim issuance to a
 * pluggable ClaimIssuer, and returns the claim NIP-44 encrypted with an
 * ephemeral key on the FULFILL response path.
 *
 * Test IDs map to `_bmad-output/planning-artifacts/test-design-epic-12.md`:
 *   T-017  Handler unwraps valid gift wrap
 *   T-018  Rate applied correctly (6→18 scale golden vector)
 *   T-018b Rate applied correctly (6→6 same-scale pair)
 *   T-019  Handler delegates to ClaimIssuer with correct params
 *   T-020  FULFILL claim is encrypted (decrypt roundtrip)
 *   T-021  Handler rejects non-gift-wrapped packet
 *   T-022  Handler rejects malformed gift wrap
 *   T-023  Rate conversion boundary (large source amount + 18-decimal target)
 *   T-024  Insufficient inventory rejects T04
 *   T-025  Ephemeral pubkey different per call
 *   T-026  Concurrent invocation safety
 *   T-027  Unsupported swap pair rejects F06
 *   T-028a Zero rate rejected
 *   T-028b Large rate handled without overflow
 *   T-R1   Replay: duplicate packet rejected F04 when seenPacketIds provided
 *   T-R2   Replay disabled by default
 *   + findSwapPair helper unit tests (≥3)
 *   + applyRate helper unit tests (≥3)
 *   + rateProvider hook fires per packet
 *
 * These tests MUST fail initially (ATDD RED phase) — they import symbols
 * that do not yet exist. They will pass once Story 12.3 is implemented.
 */

import { describe, it, expect, beforeAll, vi, type Mock } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent } from 'nostr-tools/pure';
import type { SwapPair } from '@toon-protocol/core';

import {
  createSwapHandler,
  findSwapPair,
  applyRate,
  SwapHandlerError,
  wrapSwapPacketToToon,
  decryptFulfillClaim,
} from './index.js';
import type {
  ClaimIssuer,
  IssueClaimParams,
  IssueClaimResult,
} from './index.js';
import { createHandlerContext } from './handler-context.js';
import type { HandlerContext } from './handler-context.js';
import { encodeEventToToon } from '@toon-protocol/core/toon';
import type { ToonRoutingMeta } from '@toon-protocol/core/toon';
import type { NostrEvent } from 'nostr-tools/pure';

/**
 * Factory for a mock ToonRoutingMeta. Provides sensible defaults for all
 * required fields (id, sig, rawBytes) so tests can override only what matters.
 */
function makeMockMeta(
  overrides: Partial<ToonRoutingMeta> = {}
): ToonRoutingMeta {
  return {
    kind: 1059,
    pubkey: '0'.repeat(64),
    id: 'a'.repeat(64),
    sig: 'c'.repeat(128),
    rawBytes: new Uint8Array(0),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let senderSecretKey: Uint8Array;
let senderPubkey: string;
let recipientSecretKey: Uint8Array;
let recipientPubkey: string;

const USDC_BASE_PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
  rate: '0.000357',
};

const ETH_BASE_PAIR: SwapPair = {
  from: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  rate: '2800',
};

/**
 * Shared Story 12.9 fixture: 20-byte lowercased EVM recipient used as
 * the default `chain-recipient` tag value on synthetic rumors.
 */
const FIXTURE_EVM_RECIPIENT = '0x' + '11'.repeat(20);

function makeRumor(overrides: {
  fromTag?: string;
  toTag?: string;
  extraTags?: string[][];
  /**
   * Story 12.9: rumor-level `chain-recipient` tag. Defaults to
   * {@link FIXTURE_EVM_RECIPIENT}. Pass `null` to omit the tag entirely
   * (for AC-1 missing-tag tests); pass a string to override.
   */
  chainRecipient?: string | null;
}): UnsignedEvent {
  const tags: string[][] = [];
  tags.push(['swap-from', overrides.fromTag ?? 'USDC:evm:base:8453']);
  tags.push(['swap-to', overrides.toTag ?? 'ETH:evm:base:8453']);
  // Story 12.9 AC-1/AC-8: emit the `chain-recipient` tag by default so
  // existing test rumors remain valid once the handler enforces presence.
  if (overrides.chainRecipient !== null) {
    tags.push([
      'chain-recipient',
      overrides.chainRecipient ?? FIXTURE_EVM_RECIPIENT,
    ]);
  }
  if (overrides.extraTags) tags.push(...overrides.extraTags);
  return {
    kind: 10032,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: 'swap',
    pubkey: senderPubkey,
  };
}

/**
 * Build a real gift-wrapped packet + TOON-encoded ctx for handler input.
 * Mirrors what the sender-side streamSwap() (Story 12.5) would produce.
 */
function makeGiftWrappedCtx(params: {
  rumor?: UnsignedEvent;
  amount?: bigint;
  destination?: string;
}): HandlerContext {
  const rumor = params.rumor ?? makeRumor({});
  const amount = params.amount ?? 1_000_000n;
  const destination = params.destination ?? 'g.swap.test';

  const { ilpPrepare } = wrapSwapPacketToToon({
    rumor,
    senderSecretKey,
    recipientPubkey,
    destination,
    amount,
  });

  // `buildIlpPrepare` already base64-encodes the raw TOON binary into
  // `ilpPrepare.data`. Per AC-4, `ctx.toon` is that same base64 string
  // lifted verbatim -- do NOT re-encode.
  const toonBase64 = ilpPrepare.data;

  return createHandlerContext({
    toon: toonBase64,
    meta: makeMockMeta({
      kind: 1059,
      pubkey: '0'.repeat(64) /* outer ephemeral */,
    }),
    amount,
    destination,
    toonDecoder: () => {
      throw new Error('decode() should not be called by swap handler');
    },
  });
}

function makeMockIssuer(): {
  issuer: ClaimIssuer;
  calls: IssueClaimParams[];
  issueClaim: Mock<[IssueClaimParams], Promise<IssueClaimResult>>;
} {
  const calls: IssueClaimParams[] = [];
  let i = 0;
  const issueClaim = vi.fn(
    async (p: IssueClaimParams): Promise<IssueClaimResult> => {
      calls.push(p);
      return {
        claim: new Uint8Array([1, 2, 3, 4, ++i]),
        claimId: `test-claim-${i}`,
      };
    }
  );
  return {
    issuer: { issueClaim: issueClaim as ClaimIssuer['issueClaim'] },
    calls,
    issueClaim,
  };
}

beforeAll(() => {
  senderSecretKey = generateSecretKey();
  senderPubkey = getPublicKey(senderSecretKey);
  recipientSecretKey = generateSecretKey();
  recipientPubkey = getPublicKey(recipientSecretKey);
});

// ---------------------------------------------------------------------------
// AC-1, AC-3, AC-13: Factory signature / type exports
// ---------------------------------------------------------------------------

describe('createSwapHandler factory (AC-3, AC-13)', () => {
  it('[P0] exports createSwapHandler as a function', () => {
    expect(typeof createSwapHandler).toBe('function');
  });

  it('[P0] returns a Handler (async function) from factory', () => {
    const { issuer } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });
    expect(typeof handler).toBe('function');
  });

  it('[P1] produces independent handler instances for identical configs', () => {
    const { issuer } = makeMockIssuer();
    const cfg = {
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    };
    const h1 = createSwapHandler(cfg);
    const h2 = createSwapHandler(cfg);
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// T-017: Handler unwraps valid gift wrap and accepts
// ---------------------------------------------------------------------------

describe('T-017 Handler unwraps valid gift-wrapped packet and accepts (AC-4, AC-5)', () => {
  it('[P0] accepts a well-formed gift-wrapped USDC→ETH swap packet', async () => {
    const { issuer, calls } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });

    const ctx = makeGiftWrappedCtx({});
    const res = await handler(ctx);

    expect(res.accept).toBe(true);
    if (res.accept) {
      expect(res.metadata).toBeDefined();
      expect(typeof res.metadata!['claim']).toBe('string');
      expect(typeof res.metadata!['ephemeralPubkey']).toBe('string');
      expect(res.metadata!['claimId']).toBe('test-claim-1');
      // Story 12.5 extension: Swap MUST emit the computed targetAmount as a
      // decimal string so senders can rate-deviation-check without parsing
      // chain-specific claim bytes. Without this, streamSwap's
      // rateDeviationThreshold feature silently no-ops against real Swaps.
      expect(typeof res.metadata!['targetAmount']).toBe('string');
      expect(res.metadata!['targetAmount']).toMatch(/^[0-9]+$/);
    }
    expect(calls).toHaveLength(1);
  });

  it('[P1] defensively rejects F02 when ctx.kind is not 1059', async () => {
    const { issuer } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });

    const ctx = createHandlerContext({
      toon: Buffer.from(new Uint8Array([0])).toString('base64'),
      meta: makeMockMeta({ kind: 1, pubkey: '0'.repeat(64) }),
      amount: 1_000_000n,
      destination: 'g.swap.test',
      toonDecoder: () => {
        throw new Error('unused');
      },
    });

    const res = await handler(ctx);
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('F02');
  });
});

// ---------------------------------------------------------------------------
// T-019: Handler delegates to ClaimIssuer with correct params
// ---------------------------------------------------------------------------

describe('T-019 Handler delegates to ClaimIssuer with correct params (AC-9)', () => {
  it('[P0] calls issueClaim with {sourceAmount, targetAmount, pair, senderPubkey, rumor}', async () => {
    const { issuer, calls, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });
    const ctx = makeGiftWrappedCtx({ amount: 1_000_000n });
    await handler(ctx);

    expect(issueClaim).toHaveBeenCalledTimes(1);
    expect(calls[0]!.sourceAmount).toBe(1_000_000n);
    expect(calls[0]!.targetAmount).toBe(357_000_000_000_000n);
    expect(calls[0]!.pair).toEqual(USDC_BASE_PAIR);
    expect(calls[0]!.senderPubkey).toBe(senderPubkey);
    expect(calls[0]!.rumor.kind).toBe(10032);
  });
});

// ---------------------------------------------------------------------------
// T-020: FULFILL claim is encrypted — decrypt roundtrip
// ---------------------------------------------------------------------------

describe('T-020 FULFILL claim is NIP-44 encrypted with ephemeral key (AC-10)', () => {
  it('[P0] claim metadata decrypts to the original claim bytes', async () => {
    const issueClaim = vi.fn(async () => ({
      claim: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
      claimId: 'roundtrip-1',
    }));
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: { issueClaim } as ClaimIssuer,
    });

    const ctx = makeGiftWrappedCtx({});
    const res = await handler(ctx);

    expect(res.accept).toBe(true);
    if (!res.accept) throw new Error('unreachable');

    const claimBase64 = res.metadata!['claim'] as string;
    const ephemeralPubkey = res.metadata!['ephemeralPubkey'] as string;

    expect(/^[0-9a-f]{64}$/.test(ephemeralPubkey)).toBe(true);

    const ciphertext = new Uint8Array(Buffer.from(claimBase64, 'base64'));
    const recovered = decryptFulfillClaim({
      ciphertext,
      ephemeralPubkey,
      recipientSecretKey: senderSecretKey,
    });
    expect(Array.from(recovered)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });
});

// ---------------------------------------------------------------------------
// T-021: Handler rejects non-gift-wrapped packet
// ---------------------------------------------------------------------------

describe('T-021 Handler rejects non-gift-wrapped packet (AC-6)', () => {
  it('[P0] rejects F01 and does NOT call issueClaim when ctx.kind is 1059 but payload is not 1059', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });

    // Construct a fake NostrEvent with kind:1 (not 1059) but route via ctx with meta.kind=1059
    const fakeEvent: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'not a gift wrap',
      sig: '0'.repeat(128),
    };
    const toonBinary = encodeEventToToon(fakeEvent);
    const toonBase64 = Buffer.from(toonBinary).toString('base64');

    const ctx = createHandlerContext({
      toon: toonBase64,
      meta: makeMockMeta({ kind: 1059, pubkey: '0'.repeat(64) }),
      amount: 1_000_000n,
      destination: 'g.swap.test',
      toonDecoder: () => fakeEvent,
    });

    const res = await handler(ctx);
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('F01');
    expect(issueClaim).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-022: Handler rejects malformed gift wrap (tampered ciphertext)
// ---------------------------------------------------------------------------

describe('T-022 Handler rejects malformed gift wrap (AC-5)', () => {
  it('[P0] rejects F01 when TOON data is garbage', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });

    const garbage = new Uint8Array([0xff, 0x00, 0xff, 0x00, 0x13, 0x37]);
    const ctx = createHandlerContext({
      toon: Buffer.from(garbage).toString('base64'),
      meta: makeMockMeta({ kind: 1059, pubkey: '0'.repeat(64) }),
      amount: 1n,
      destination: 'g.swap.test',
      toonDecoder: () => {
        throw new Error('should not decode');
      },
    });

    const res = await handler(ctx);
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('F01');
    expect(issueClaim).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-024: Insufficient inventory → T04
// ---------------------------------------------------------------------------

describe('T-024 Insufficient inventory rejects T04 (AC-9)', () => {
  it('[P0] rejects T04 when issuer throws INSUFFICIENT_INVENTORY', async () => {
    const issueClaim = vi.fn(async () => {
      const e = new Error('insufficient inventory') as Error & { code: string };
      e.code = 'INSUFFICIENT_INVENTORY';
      throw e;
    });
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: { issueClaim } as ClaimIssuer,
    });
    const ctx = makeGiftWrappedCtx({});
    const res = await handler(ctx);
    expect(res.accept).toBe(false);
    if (!res.accept) {
      expect(res.code).toBe('T04');
      expect(res.message).toBe('Insufficient liquidity');
    }
  });

  it('[P1] rejects T04 by message-match regex when no code set', async () => {
    const issueClaim = vi.fn(async () => {
      throw new Error('Reserves insufficient for this swap');
    });
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: { issueClaim } as ClaimIssuer,
    });
    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('T04');
  });

  it('[P1] rejects T00 for generic issuer failure', async () => {
    const issueClaim = vi.fn(async () => {
      throw new Error('signing hardware offline');
    });
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: { issueClaim } as ClaimIssuer,
    });
    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('T00');
  });
});

// ---------------------------------------------------------------------------
// T-025: Ephemeral pubkey different per call
// ---------------------------------------------------------------------------

describe('T-025 Ephemeral pubkey different per call (D12-008)', () => {
  it('[P0] 5 identical inputs produce 5 distinct ephemeralPubkey values', async () => {
    const { issuer } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });

    const ephemerals = new Set<string>();
    for (let i = 0; i < 5; i++) {
      // Vary the ILP amount so the Story 12.8 default replay-protection
      // (always-on under AC-14) does not collapse these identical-rumor
      // calls into F04 rejects. The point of this test is ephemeral-key
      // uniqueness, not replay behavior.
      const res = await handler(
        makeGiftWrappedCtx({ amount: BigInt(1_000_000 + i) })
      );
      if (!res.accept) throw new Error('unexpected reject');
      ephemerals.add(res.metadata!['ephemeralPubkey'] as string);
    }
    expect(ephemerals.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// T-026: Concurrent invocation safety
// ---------------------------------------------------------------------------

describe('T-026 Concurrent invocation safety (AC-12)', () => {
  it('[P1] Promise.all of 10 invocations all accept with distinct claimIds', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });

    const ctxs = Array.from({ length: 10 }, (_, i) =>
      makeGiftWrappedCtx({ amount: 1_000_000n + BigInt(i) })
    );
    const results = await Promise.all(ctxs.map((ctx) => handler(ctx)));

    expect(issueClaim).toHaveBeenCalledTimes(10);

    const claimIds = new Set<string>();
    for (const r of results) {
      expect(r.accept).toBe(true);
      if (r.accept) claimIds.add(r.metadata!['claimId'] as string);
    }
    expect(claimIds.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// T-027: Unsupported swap pair → F06
// ---------------------------------------------------------------------------

describe('T-027 Unsupported swap pair rejects F06 (AC-7)', () => {
  it('[P0] rejects F06 when rumor tags reference a pair NOT in config.swapPairs', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR], // only USDC→ETH supported
      claimIssuer: issuer,
    });

    const rumor = makeRumor({
      fromTag: 'DAI:evm:base:8453',
      toTag: 'ETH:evm:base:8453',
    });
    const res = await handler(makeGiftWrappedCtx({ rumor }));
    expect(res.accept).toBe(false);
    if (!res.accept) {
      expect(res.code).toBe('F06');
      expect(res.message).toBe('Unsupported swap pair');
    }
    expect(issueClaim).not.toHaveBeenCalled();
  });

  it('[P1] rejects F06 when swap-from tag is missing', async () => {
    const { issuer } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });
    const rumor: UnsignedEvent = {
      kind: 10032,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['swap-to', 'ETH:evm:base:8453']],
      content: '',
      pubkey: senderPubkey,
    };
    const res = await handler(makeGiftWrappedCtx({ rumor }));
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('F06');
  });
});

// ---------------------------------------------------------------------------
// T-028a / T-028b: Zero rate / large rate
// ---------------------------------------------------------------------------

describe('T-028 Rate edge cases (AC-8)', () => {
  it('[P0] T-028a: zero rate on matched pair rejects T00', async () => {
    const zeroPair: SwapPair = { ...USDC_BASE_PAIR, rate: '0' };
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [zeroPair],
      claimIssuer: issuer,
    });
    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('T00');
    expect(issueClaim).not.toHaveBeenCalled();
  });

  it('[P1] T-028b: large rate produces finite bigint without throw', async () => {
    const largePair: SwapPair = { ...USDC_BASE_PAIR, rate: '999999999.999999' };
    const { issuer } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [largePair],
      claimIssuer: issuer,
    });
    const res = await handler(makeGiftWrappedCtx({ amount: 1n }));
    expect(res.accept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-R1 / T-R2: Replay protection
// ---------------------------------------------------------------------------

describe('Replay protection hook (AC-11)', () => {
  it('[P0] T-R1: with seenPacketIds configured, duplicate packet rejects F04', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const seen = new Set<string>();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
      seenPacketIds: seen,
    });

    // Build one fixed rumor (same id) and submit twice via identical ctx shape.
    // NOTE: each wrapSwapPacket call uses a fresh ephemeral key, but the rumor
    // id + sender + amount remain the same, so packet ID hash is stable.
    const rumor = makeRumor({});
    const ctx1 = makeGiftWrappedCtx({ rumor });
    const ctx2 = makeGiftWrappedCtx({ rumor });

    const r1 = await handler(ctx1);
    const r2 = await handler(ctx2);

    expect(r1.accept).toBe(true);
    expect(r2.accept).toBe(false);
    if (!r2.accept) {
      expect(r2.code).toBe('F04');
      expect(r2.message).toBe('Duplicate packet');
    }
    expect(issueClaim).toHaveBeenCalledTimes(1);
  });

  it('[P1] T-R2: without seenPacketIds, dedup runs against the bounded default (Story 12.8 AC-14)', async () => {
    // Story 12.8 AC-14 flipped the default: replay protection now ALWAYS runs,
    // backed by BoundedSeenPacketIds(DEFAULT_SEEN_PACKET_IDS_CAP) when the
    // operator does not supply a custom set. Duplicates REJECT F04 by default;
    // the opt-out behavior has been retired.
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
      // no seenPacketIds — defaults to BoundedSeenPacketIds.
    });

    const rumor = makeRumor({});
    const r1 = await handler(makeGiftWrappedCtx({ rumor }));
    const r2 = await handler(makeGiftWrappedCtx({ rumor }));

    expect(r1.accept).toBe(true);
    expect(r2.accept).toBe(false);
    if (r2.accept === false) {
      expect(r2.code).toBe('F04');
      expect(r2.message).toBe('Duplicate packet');
    }
    expect(issueClaim).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// rateProvider hook (AC-3)
// ---------------------------------------------------------------------------

describe('rateProvider hook fires per packet (D12-006)', () => {
  it('[P0] when rateProvider is configured, it overrides pair.rate per-call', async () => {
    const rateProvider = vi.fn(async (_p: SwapPair) => '0.0004');
    const { issuer, calls } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR], // pair.rate is '0.000357'
      claimIssuer: issuer,
      rateProvider,
    });

    await handler(makeGiftWrappedCtx({ amount: 1_000_000n }));

    expect(rateProvider).toHaveBeenCalledTimes(1);
    // 1_000_000 * 0.0004 with 6→18 scale = 400_000_000_000_000n
    expect(calls[0]!.targetAmount).toBe(400_000_000_000_000n);
  });
});

// ---------------------------------------------------------------------------
// applyRate helper unit tests (AC-8)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// findSwapPair helper unit tests (AC-7)
// ---------------------------------------------------------------------------

describe('findSwapPair helper (AC-7)', () => {
  it('[P0] exact match returns the pair', () => {
    const rumor = makeRumor({
      fromTag: 'USDC:evm:base:8453',
      toTag: 'ETH:evm:base:8453',
    });
    const result = findSwapPair(rumor, [USDC_BASE_PAIR, ETH_BASE_PAIR]);
    expect(result).toBe(USDC_BASE_PAIR);
  });

  it('[P0] mismatched chain returns null', () => {
    const rumor = makeRumor({
      fromTag: 'USDC:evm:optimism:10',
      toTag: 'ETH:evm:base:8453',
    });
    const result = findSwapPair(rumor, [USDC_BASE_PAIR]);
    expect(result).toBeNull();
  });

  it('[P1] malformed tag (no colon) returns null', () => {
    const rumor: UnsignedEvent = {
      kind: 10032,
      created_at: 0,
      tags: [
        ['swap-from', 'USDConly'],
        ['swap-to', 'ETH:evm:base:8453'],
      ],
      content: '',
      pubkey: senderPubkey,
    };
    expect(findSwapPair(rumor, [USDC_BASE_PAIR])).toBeNull();
  });

  it('[P1] missing swap-to tag returns null', () => {
    const rumor: UnsignedEvent = {
      kind: 10032,
      created_at: 0,
      tags: [['swap-from', 'USDC:evm:base:8453']],
      content: '',
      pubkey: senderPubkey,
    };
    expect(findSwapPair(rumor, [USDC_BASE_PAIR])).toBeNull();
  });

  it('[P1] multi-segment chain id (evm:base:8453) splits on first colon', () => {
    // assetCode=USDC, chain=evm:base:8453 (split on FIRST `:` so chain retains its colons)
    const rumor = makeRumor({
      fromTag: 'USDC:evm:base:8453',
      toTag: 'ETH:evm:base:8453',
    });
    const result = findSwapPair(rumor, [USDC_BASE_PAIR]);
    expect(result).toBe(USDC_BASE_PAIR);
  });
});

// ---------------------------------------------------------------------------
// Constructor validation (AC-3)
// ---------------------------------------------------------------------------

describe('createSwapHandler constructor validation (AC-3)', () => {
  it('[P1] throws SwapHandlerError when recipientSecretKey is not a 32-byte Uint8Array', () => {
    const { issuer } = makeMockIssuer();
    expect(() =>
      createSwapHandler({
        // @ts-expect-error - intentionally wrong type for validation test
        recipientSecretKey: 'not-a-uint8array',
        swapPairs: [USDC_BASE_PAIR],
        claimIssuer: issuer,
      })
    ).toThrow(SwapHandlerError);

    expect(() =>
      createSwapHandler({
        recipientSecretKey: new Uint8Array(16), // wrong length
        swapPairs: [USDC_BASE_PAIR],
        claimIssuer: issuer,
      })
    ).toThrow(/32-byte/);
  });

  it('[P1] throws SwapHandlerError when swapPairs is not an array', () => {
    const { issuer } = makeMockIssuer();
    expect(() =>
      createSwapHandler({
        recipientSecretKey,
        // @ts-expect-error - intentionally wrong type
        swapPairs: 'not-an-array',
        claimIssuer: issuer,
      })
    ).toThrow(/swapPairs/);
  });

  it('[P1] throws SwapHandlerError when claimIssuer is missing issueClaim', () => {
    expect(() =>
      createSwapHandler({
        recipientSecretKey,
        swapPairs: [USDC_BASE_PAIR],
        // @ts-expect-error - intentionally missing issueClaim
        claimIssuer: {},
      })
    ).toThrow(/claimIssuer/);
  });
});

// ---------------------------------------------------------------------------
// rateProvider error path (AC-9)
// ---------------------------------------------------------------------------

describe('rateProvider error handling (AC-9)', () => {
  it('[P1] rejects T00 when rateProvider throws', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
      rateProvider: async () => {
        throw new Error('oracle unreachable');
      },
    });

    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(false);
    if (!res.accept) {
      expect(res.code).toBe('T00');
      expect(res.message).toBe('Rate provider error');
    }
    // Issuer MUST NOT be called when rate resolution fails.
    expect(issueClaim).not.toHaveBeenCalled();
  });

  it('[P1] rejects T00 when rateProvider returns an invalid rate format', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
      rateProvider: async () => 'not-a-number',
    });

    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('T00');
    expect(issueClaim).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SwapHandlerError (AC-2)
// ---------------------------------------------------------------------------

describe('SwapHandlerError (AC-2)', () => {
  it('[P2] is a class with code SWAP_HANDLER_ERROR', () => {
    const err = new SwapHandlerError('test');
    expect(err).toBeInstanceOf(Error);
    expect((err as { code: string }).code).toBe('SWAP_HANDLER_ERROR');
    expect(err.name).toBe('SwapHandlerError');
  });

  it('[P2] accepts an optional cause', () => {
    const cause = new Error('root');
    const err = new SwapHandlerError('wrapped', cause);
    expect((err as { cause?: Error }).cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// Story 12.6 AC-3 — FULFILL metadata extension regression
//
// The Swap's swap handler MUST emit the five settlement-context fields
// (channelId, nonce, cumulativeAmount, recipient, swapSignerAddress) in the
// FULFILL metadata WHEN the ClaimIssuer returns them. When the issuer omits
// those fields (legacy pre-12.6 path), the metadata MUST remain in the
// pre-12.6 shape (all-or-nothing contract).
//
// This fills the Task 1 regression gap: "Update swap-handler.test.ts to also
// assert the 5 new metadata fields are emitted with correct types/formats."
// ---------------------------------------------------------------------------

describe('Story 12.6 AC-3 — FULFILL metadata settlement fields', () => {
  const EVM_CHANNEL_ID = '0x' + 'a'.repeat(64);
  const EVM_RECIPIENT = '0x' + 'b'.repeat(40);
  const EVM_SWAP_SIGNER = '0x' + 'c'.repeat(40);

  it('[P0] emits channelId/nonce/cumulativeAmount/recipient/swapSignerAddress when issuer supplies them', async () => {
    const issueClaim = vi.fn(
      async (_p: IssueClaimParams): Promise<IssueClaimResult> => ({
        claim: new Uint8Array([1, 2, 3]),
        claimId: 'test-claim-settlement',
        channelId: EVM_CHANNEL_ID,
        nonce: 7n,
        cumulativeAmount: 123_456_789n,
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      })
    );
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: { issueClaim: issueClaim as ClaimIssuer['issueClaim'] },
    });

    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(true);
    if (!res.accept) return;

    // All four existing fields still present.
    expect(typeof res.metadata!['claim']).toBe('string');
    expect(typeof res.metadata!['ephemeralPubkey']).toBe('string');
    expect(typeof res.metadata!['targetAmount']).toBe('string');
    expect(res.metadata!['claimId']).toBe('test-claim-settlement');

    // All five new AC-3 fields present with correct types/formats.
    expect(res.metadata!['channelId']).toBe(EVM_CHANNEL_ID);
    expect(typeof res.metadata!['channelId']).toBe('string');
    expect(res.metadata!['channelId']).toMatch(/^0x[0-9a-f]{64}$/);

    // nonce + cumulativeAmount MUST be emitted as decimal strings
    // (BigInt -> string conversion per AC-3).
    expect(res.metadata!['nonce']).toBe('7');
    expect(typeof res.metadata!['nonce']).toBe('string');
    expect(res.metadata!['nonce']).toMatch(/^(0|[1-9]\d*)$/);

    expect(res.metadata!['cumulativeAmount']).toBe('123456789');
    expect(typeof res.metadata!['cumulativeAmount']).toBe('string');
    expect(res.metadata!['cumulativeAmount']).toMatch(/^(0|[1-9]\d*)$/);

    expect(res.metadata!['recipient']).toBe(EVM_RECIPIENT);
    expect(res.metadata!['recipient']).toMatch(/^0x[0-9a-f]{40}$/);

    expect(res.metadata!['swapSignerAddress']).toBe(EVM_SWAP_SIGNER);
    expect(res.metadata!['swapSignerAddress']).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('[P0] omits all five settlement fields when issuer returns legacy shape', async () => {
    // Legacy issuer — no settlement-context fields.
    const { issuer } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });

    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(true);
    if (!res.accept) return;

    // None of the five new fields present on legacy path (AC-3:
    // "additive, backward-compatible extension").
    expect(res.metadata!['channelId']).toBeUndefined();
    expect(res.metadata!['nonce']).toBeUndefined();
    expect(res.metadata!['cumulativeAmount']).toBeUndefined();
    expect(res.metadata!['recipient']).toBeUndefined();
    expect(res.metadata!['swapSignerAddress']).toBeUndefined();

    // Existing fields unaffected.
    expect(typeof res.metadata!['claim']).toBe('string');
    expect(typeof res.metadata!['ephemeralPubkey']).toBe('string');
    expect(typeof res.metadata!['targetAmount']).toBe('string');
  });

  it('[P1] handles nonce=0n correctly (first balance proof on a fresh channel)', async () => {
    const issueClaim = vi.fn(
      async (_p: IssueClaimParams): Promise<IssueClaimResult> => ({
        claim: new Uint8Array([1]),
        claimId: 'c0',
        channelId: EVM_CHANNEL_ID,
        nonce: 0n,
        cumulativeAmount: 0n,
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      })
    );
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: { issueClaim: issueClaim as ClaimIssuer['issueClaim'] },
    });

    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(true);
    if (!res.accept) return;
    // BigInt 0n -> '0' (zero-safe decimal encoding, NOT '').
    expect(res.metadata!['nonce']).toBe('0');
    expect(res.metadata!['cumulativeAmount']).toBe('0');
  });

  it('[P1] handles very large bigints without Number coercion loss (MAX_SAFE_INTEGER guard)', async () => {
    const HUGE = 2n ** 200n; // way past MAX_SAFE_INTEGER (2^53 - 1)
    const issueClaim = vi.fn(
      async (_p: IssueClaimParams): Promise<IssueClaimResult> => ({
        claim: new Uint8Array([1]),
        claimId: 'c-huge',
        channelId: EVM_CHANNEL_ID,
        nonce: HUGE,
        cumulativeAmount: HUGE,
        recipient: EVM_RECIPIENT,
        swapSignerAddress: EVM_SWAP_SIGNER,
      })
    );
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: { issueClaim: issueClaim as ClaimIssuer['issueClaim'] },
    });
    const res = await handler(makeGiftWrappedCtx({}));
    expect(res.accept).toBe(true);
    if (!res.accept) return;
    // Exact decimal roundtrip — no precision loss, no scientific notation.
    expect(res.metadata!['nonce']).toBe(HUGE.toString());
    expect(res.metadata!['cumulativeAmount']).toBe(HUGE.toString());
  });
});

// ---------------------------------------------------------------------------
// Story 12.8 — AC-10 + AC-14 — DEFAULT_SEEN_PACKET_IDS_CAP + LRU eviction
// ---------------------------------------------------------------------------
//
// RED PHASE: describe.skip — dev lifts the skip in Task 1.4 / Task 5.1
// after exporting `DEFAULT_SEEN_PACKET_IDS_CAP = 10_000` and defaulting
// `seenPacketIds` to a bounded access-order (NOT insertion-order) LRU.
//
// CRITICAL GOTCHA (Story 12.8 Dev Notes, R-8N3): insertion-order
// eviction re-opens the replay window after 10k fresh packets. A
// replay attacker retries the same packet forever — under
// insertion-order eviction their packet id ages out and is accepted
// again. Use access-order eviction (Map's `.delete(k); .set(k, v)` on
// each hit is the cheapest correct path).
describe('[Story 12.8] DEFAULT_SEEN_PACKET_IDS_CAP + LRU eviction (AC-10, AC-14, R-8N3)', () => {
  it('AC-14 — swap-handler exports DEFAULT_SEEN_PACKET_IDS_CAP === 10_000', async () => {
    const mod = await import('./swap-handler.js');
    expect(
      (mod as { DEFAULT_SEEN_PACKET_IDS_CAP?: number })
        .DEFAULT_SEEN_PACKET_IDS_CAP
    ).toBe(10_000);
  });

  it('AC-10 — BoundedSeenPacketIds caps size at 10_000 after 10_001 inserts', async () => {
    const { BoundedSeenPacketIds, DEFAULT_SEEN_PACKET_IDS_CAP } =
      await import('./swap-handler.js');
    const s = new BoundedSeenPacketIds();
    for (let i = 0; i < DEFAULT_SEEN_PACKET_IDS_CAP + 1; i++) {
      s.add(`id-${i}`);
    }
    expect(s.size).toBeLessThanOrEqual(DEFAULT_SEEN_PACKET_IDS_CAP);
    expect(s.size).toBe(DEFAULT_SEEN_PACKET_IDS_CAP);
    // The OLDEST id should have been evicted (FIFO under pure insert-then-overflow).
    // NOTE: `.has()` also promotes — we use `Array.from(s).includes()` instead.
    const all = Array.from(s);
    expect(all.includes('id-0')).toBe(false);
    expect(all.includes(`id-${DEFAULT_SEEN_PACKET_IDS_CAP}`)).toBe(true);
  });

  it('AC-10 — eviction is access-order (R-8N3 replay-window guard)', async () => {
    const { BoundedSeenPacketIds } = await import('./swap-handler.js');
    // Use a small cap to keep the test fast and obvious.
    const s = new BoundedSeenPacketIds(3);
    s.add('a'); // [a]
    s.add('b'); // [a, b]
    s.add('c'); // [a, b, c]
    // Re-access 'a' so that it is now the most-recently-accessed.
    s.has('a'); // [b, c, a]  (access-order)
    s.add('d'); // Overflow: evict least-recently-accessed → 'b'. [c, a, d]
    const all = Array.from(s);
    expect(all).toEqual(['c', 'a', 'd']);
    // Critical: 'a' is still present (this is the R-8N3 guarantee — a
    // replay attacker's packet-id does NOT age out).
    expect(all.includes('a')).toBe(true);
    expect(all.includes('b')).toBe(false);
  });

  it('AC-10 — operator-supplied seenPacketIds is used verbatim (no default cap applied)', async () => {
    // When `config.seenPacketIds` is provided, the handler uses it as-is.
    // A plain unbounded Set grows without eviction; the handler does NOT
    // impose the default cap on an operator-supplied instance.
    const custom = new Set<string>();
    const { issuer } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
      seenPacketIds: custom,
    });
    // Drive 5 distinct packets through the handler — vary `amount` so that
    // `computePacketId(senderPubkey, amount, rumor)` yields a distinct hash
    // per packet (rumor timestamp alone can collide at millisecond granularity).
    for (let i = 0; i < 5; i++) {
      const r = await handler(
        makeGiftWrappedCtx({ amount: BigInt(1_000_000 + i) })
      );
      expect(r.accept).toBe(true);
    }
    expect(custom.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Story 12.9 — chain-recipient tag: handler extraction, validation, threading
// ---------------------------------------------------------------------------

describe('Story 12.9 — chain-recipient tag handling', () => {
  it('[P0] T-5: missing `chain-recipient` tag on rumor → ctx.reject T00 (AC-1, AC-8, AC-14a)', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });
    // Omit the chain-recipient tag entirely.
    const rumor = makeRumor({ chainRecipient: null });
    const res = await handler(makeGiftWrappedCtx({ rumor }));
    expect(res.accept).toBe(false);
    if (!res.accept) {
      expect(res.code).toBe('T00');
      expect(res.message).toBe('Internal error');
    }
    expect(issueClaim).not.toHaveBeenCalled();
  });

  it('[P0] T-6a: malformed EVM `chain-recipient` (not 20-byte hex) → T00 (AC-2, AC-8, AC-14b)', async () => {
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });
    const rumor = makeRumor({ chainRecipient: '0xNOTHEX' });
    const res = await handler(makeGiftWrappedCtx({ rumor }));
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('T00');
    expect(issueClaim).not.toHaveBeenCalled();
  });

  it('[P1] T-6b: malformed Solana `chain-recipient` → T00 (AC-2, AC-8, AC-14b)', async () => {
    // Construct a swap pair targeting solana.
    const SOLANA_PAIR: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
      rate: '0.01',
    };
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [SOLANA_PAIR],
      claimIssuer: issuer,
    });
    const rumor = makeRumor({
      toTag: 'SOL:solana:mainnet',
      chainRecipient: '!!!not-base58!!!',
    });
    const res = await handler(makeGiftWrappedCtx({ rumor }));
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('T00');
    expect(issueClaim).not.toHaveBeenCalled();
  });

  it('[P2] T-6c: malformed Mina `chain-recipient` (short base58) → T00 (AC-2, AC-8, AC-14b)', async () => {
    // Story 12.9 AC-14b enumerates per-chain malformed cases. T-6a covers
    // EVM, T-6b covers Solana; this pins the mina:* branch of the local
    // `validateChainRecipient` duplicate in swap-handler.ts so a future
    // edit that drifts from `validateChainAddress` (stream-swap.ts) would
    // fail fast.
    const MINA_PAIR: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
      rate: '0.01',
    };
    const { issuer, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [MINA_PAIR],
      claimIssuer: issuer,
    });
    const rumor = makeRumor({
      toTag: 'MINA:mina:mainnet',
      chainRecipient: 'abc', // base58 charset but < 32 chars
    });
    const res = await handler(makeGiftWrappedCtx({ rumor }));
    expect(res.accept).toBe(false);
    if (!res.accept) expect(res.code).toBe('T00');
    expect(issueClaim).not.toHaveBeenCalled();
  });

  it('[P0] T-7: happy path threads validated chainRecipient into IssueClaimParams (AC-9, AC-14c)', async () => {
    const { issuer, calls, issueClaim } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });
    const rumor = makeRumor({ chainRecipient: FIXTURE_EVM_RECIPIENT });
    const res = await handler(makeGiftWrappedCtx({ rumor }));
    expect(res.accept).toBe(true);
    expect(issueClaim).toHaveBeenCalledTimes(1);
    const params = calls[0]!;
    expect(params.chainRecipient).toBe(FIXTURE_EVM_RECIPIENT);
    // senderPubkey preserved (not overridden by the new field).
    expect(params.senderPubkey).toBe(senderPubkey);
    expect(params.senderPubkey).not.toBe(params.chainRecipient);
  });

  it('[P2] T-7 (AC-3): tag ordering is irrelevant (parse by name)', async () => {
    const { issuer, calls } = makeMockIssuer();
    const handler = createSwapHandler({
      recipientSecretKey,
      swapPairs: [USDC_BASE_PAIR],
      claimIssuer: issuer,
    });
    // Build a rumor where chain-recipient precedes swap-from / swap-to.
    const customRumor: UnsignedEvent = {
      kind: 10032,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['chain-recipient', FIXTURE_EVM_RECIPIENT],
        ['nonce', 'deadbeef'],
        ['swap-to', 'ETH:evm:base:8453'],
        ['swap-from', 'USDC:evm:base:8453'],
        ['amount', '1000000'],
      ],
      content: 'swap',
      pubkey: senderPubkey,
    };
    const res = await handler(makeGiftWrappedCtx({ rumor: customRumor }));
    expect(res.accept).toBe(true);
    expect(calls[0]!.chainRecipient).toBe(FIXTURE_EVM_RECIPIENT);
  });

  it('[P0] T-8: IssueClaimParams TYPE shape includes both senderPubkey and chainRecipient (AC-10)', () => {
    // Compile-time shape guard: if a future change removes either field, this
    // block will fail TypeScript compilation. The `satisfies` operator binds
    // the literal to the interface without widening.
    const shape = {
      sourceAmount: 1n,
      targetAmount: 1n,
      pair: USDC_BASE_PAIR,
      senderPubkey: 'a'.repeat(64),
      chainRecipient: FIXTURE_EVM_RECIPIENT,
      rumor: makeRumor({}),
    } satisfies IssueClaimParams;
    // Runtime sanity — the two fields are separate and non-aliasing.
    expect(shape.senderPubkey).not.toBe(shape.chainRecipient);
    expect(typeof shape.chainRecipient).toBe('string');
    expect(typeof shape.senderPubkey).toBe('string');
  });
});
