/**
 * Story 12.1 — Parser kind:10032 swapPairs deserialization (ATDD RED PHASE).
 *
 * These tests are written BEFORE implementation. They will FAIL until
 * `parseIlpPeerInfo` is extended to read and validate `swapPairs`.
 *
 * Traceability: AC-4, AC-8 (T-002, T-003, T-004, T-005, T-008)
 *   + R-011: pre-Epic-12 backward compatibility
 *
 * Parser tests must NOT depend on the builder — construct content JSON
 * by hand and sign with a throwaway key via finalizeEvent.
 */

import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { parseIlpPeerInfo } from './parsers.js';
import { buildIlpPeerInfoEvent } from './builders.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { InvalidEventError } from '../errors.js';
import type { SwapPair } from '../types.js';

function buildEvent(contentObj: Record<string, unknown>): NostrEvent {
  return finalizeEvent(
    {
      kind: ILP_PEER_INFO_KIND,
      content: JSON.stringify(contentObj),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    generateSecretKey()
  );
}

function baseContent(): Record<string, unknown> {
  return {
    ilpAddress: 'g.example.connector',
    btpEndpoint: 'wss://btp.example.com',
    assetCode: 'USD',
    assetScale: 6,
  };
}

describe('parseIlpPeerInfo — swapPairs deserialization', () => {
  // ---------------------------------------------------------------------------
  // T-003: pre-Epic-12 event (no swapPairs) parses with swapPairs absent
  // ---------------------------------------------------------------------------
  it('(T-003) parses a pre-Epic-12 event with no swapPairs key → swapPairs omitted from result', () => {
    const event = buildEvent(baseContent());
    const result = parseIlpPeerInfo(event);

    expect(result.swapPairs).toBeUndefined();
    // Must be literally absent (not { swapPairs: undefined }) — critical for
    // deep-equality roundtrip of legacy events.
    expect('swapPairs' in result).toBe(false);

    // Sanity: other required fields parsed correctly
    expect(result.ilpAddress).toBe('g.example.connector');
    expect(result.assetCode).toBe('USD');
    expect(result.assetScale).toBe(6);
  });

  // ---------------------------------------------------------------------------
  // T-002: one valid pair roundtrips exactly
  // ---------------------------------------------------------------------------
  it('(T-002) parses an event with one swapPair — all fields preserved', () => {
    const pair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
      rate: '0.00025',
      minAmount: '1000000',
      maxAmount: '1000000000',
    };
    const event = buildEvent({ ...baseContent(), swapPairs: [pair] });

    const result = parseIlpPeerInfo(event);
    expect(result.swapPairs).toBeDefined();
    expect(result.swapPairs).toHaveLength(1);
    expect(result.swapPairs?.[0]).toEqual(pair);
  });

  // ---------------------------------------------------------------------------
  // T-004: high-precision rate preserved exactly (no float coercion)
  // ---------------------------------------------------------------------------
  it('(T-004) preserves a high-precision rate string with > 15 significant digits', () => {
    const pair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
      rate: '0.000123456789012345', // 18 significant digits
    };
    const event = buildEvent({ ...baseContent(), swapPairs: [pair] });

    const result = parseIlpPeerInfo(event);
    expect(result.swapPairs?.[0]?.rate).toBe('0.000123456789012345');
    expect(typeof result.swapPairs?.[0]?.rate).toBe('string');
  });

  // ---------------------------------------------------------------------------
  // T-005: optional amounts omitted
  // ---------------------------------------------------------------------------
  it('(T-005) parses a pair with minAmount/maxAmount omitted → both undefined', () => {
    const pair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'mina:mainnet' },
      to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
      rate: '1.5',
    };
    const event = buildEvent({ ...baseContent(), swapPairs: [pair] });

    const result = parseIlpPeerInfo(event);
    expect(result.swapPairs?.[0]?.minAmount).toBeUndefined();
    expect(result.swapPairs?.[0]?.maxAmount).toBeUndefined();
  });

  it('(T-005) parses a pair with both minAmount/maxAmount present → preserved as strings', () => {
    const pair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
      rate: '0.00025',
      minAmount: '500',
      maxAmount: '5000000',
    };
    const event = buildEvent({ ...baseContent(), swapPairs: [pair] });

    const result = parseIlpPeerInfo(event);
    expect(result.swapPairs?.[0]?.minAmount).toBe('500');
    expect(result.swapPairs?.[0]?.maxAmount).toBe('5000000');
  });

  // ---------------------------------------------------------------------------
  // T-008: invalid shapes throw InvalidEventError with descriptive field name
  // ---------------------------------------------------------------------------
  it('(T-008) throws InvalidEventError when swapPairs is not an array', () => {
    const event = buildEvent({ ...baseContent(), swapPairs: 'not-an-array' });
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(/array/i);
  });

  it('(T-008) throws InvalidEventError when swapPairs is null (distinct from undefined)', () => {
    // `null` is not `undefined` — conditional-spread guard at the parser must
    // reject it rather than silently treat it as "field absent". This locks
    // in the `rawSwapPairs !== undefined` vs `!= undefined` distinction.
    const event = buildEvent({ ...baseContent(), swapPairs: null });
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(/array/i);
  });

  // ---------------------------------------------------------------------------
  // Empty-array parse: distinct from undefined, must survive roundtrip
  // ---------------------------------------------------------------------------
  it('parses swapPairs:[] as an empty array (present but empty, distinct from undefined)', () => {
    const event = buildEvent({ ...baseContent(), swapPairs: [] });
    const result = parseIlpPeerInfo(event);

    expect(result.swapPairs).toBeDefined();
    expect(Array.isArray(result.swapPairs)).toBe(true);
    expect(result.swapPairs).toHaveLength(0);
    // Must be literally present (not stripped like `undefined` would be) —
    // an empty array means "swap peer with no currently active pairs".
    expect('swapPairs' in result).toBe(true);
  });

  it('(T-008) throws InvalidEventError when a pair is missing from', () => {
    const event = buildEvent({
      ...baseContent(),
      swapPairs: [
        {
          to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
          rate: '0.5',
        },
      ],
    });
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    try {
      parseIlpPeerInfo(event);
    } catch (e) {
      expect((e as Error).message).toContain('from');
    }
  });

  it('(T-008) throws InvalidEventError when rate is a number not a string', () => {
    const event = buildEvent({
      ...baseContent(),
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
          to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
          rate: 0.5, // number, not string
        },
      ],
    });
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    try {
      parseIlpPeerInfo(event);
    } catch (e) {
      expect((e as Error).message).toContain('rate');
    }
  });

  it('(T-008) throws InvalidEventError when chain is malformed', () => {
    const event = buildEvent({
      ...baseContent(),
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: 'not-a-chain-id' },
          to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
          rate: '0.5',
        },
      ],
    });
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    try {
      parseIlpPeerInfo(event);
    } catch (e) {
      expect((e as Error).message).toContain('chain');
    }
  });

  it('(T-008) includes swapPairs[index] in the error message', () => {
    // Invalid pair is the second element (index 1)
    const event = buildEvent({
      ...baseContent(),
      swapPairs: [
        {
          from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
          to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
          rate: '0.5',
        },
        {
          from: { assetCode: '', assetScale: 6, chain: 'evm:base:8453' }, // empty assetCode
          to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
          rate: '0.5',
        },
      ],
    });
    try {
      parseIlpPeerInfo(event);
      expect.fail('expected InvalidEventError');
    } catch (e) {
      expect((e as Error).message).toContain('swapPairs[1]');
    }
  });
});

// -----------------------------------------------------------------------------
// Roundtrip tests — build then parse, assert deep equality on swapPairs.
// -----------------------------------------------------------------------------

describe('swapPairs roundtrip (build → parse)', () => {
  it('roundtrips a 3-pair IlpPeerInfo covering EVM, Mina, and Solana chains', () => {
    const sk = generateSecretKey();

    const pairs: SwapPair[] = [
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
        to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
        rate: '0.00025',
        minAmount: '1000000',
        maxAmount: '1000000000',
      },
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'mina:mainnet' },
        to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
        rate: '1.5',
      },
      {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'solana:mainnet' },
        to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
        rate: '0.0065',
        maxAmount: '10000000',
      },
    ];

    const event = buildIlpPeerInfoEvent(
      {
        ilpAddress: 'g.example.connector',
        btpEndpoint: 'wss://btp.example.com',
        assetCode: 'USD',
        assetScale: 6,
        swapPairs: pairs,
      },
      sk
    );
    const parsed = parseIlpPeerInfo(event);

    expect(parsed.swapPairs).toEqual(pairs);
  });

  it('roundtrips a 20-digit maxAmount losslessly (no precision loss via BigInt strings)', () => {
    const sk = generateSecretKey();

    const pair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
      rate: '0.000123456789012345',
      minAmount: '1',
      maxAmount: '99999999999999999999', // 20 digits, > Number.MAX_SAFE_INTEGER
    };

    const event = buildIlpPeerInfoEvent(
      {
        ilpAddress: 'g.example.connector',
        btpEndpoint: 'wss://btp.example.com',
        assetCode: 'USD',
        assetScale: 6,
        swapPairs: [pair],
      },
      sk
    );
    const parsed = parseIlpPeerInfo(event);

    expect(parsed.swapPairs?.[0]?.maxAmount).toBe('99999999999999999999');
    expect(parsed.swapPairs?.[0]?.rate).toBe('0.000123456789012345');
    expect(parsed.swapPairs).toEqual([pair]);
  });
});
