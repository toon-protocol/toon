/**
 * Story 12.1 — Builder kind:10032 swapPairs serialization (ATDD RED PHASE).
 *
 * These tests are written BEFORE implementation. They will FAIL until:
 *   1. `SwapPair` is added to `packages/core/src/types.ts`
 *   2. `IlpPeerInfo.swapPairs?: SwapPair[]` is added
 *   3. `buildIlpPeerInfoEvent` validates swapPairs via
 *      `assertSwapPairForBuild` and throws `ToonError('INVALID_SWAP_PAIR')`
 *
 * Traceability: AC-3, AC-8 (T-001, T-006, T-007, T-008)
 *
 * Kept in a separate file from the existing builders.test.ts so pre-existing
 * tests stay green while the dev agent implements this story.
 */

import { describe, it, expect } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { buildIlpPeerInfoEvent } from './builders.js';
import { ToonError } from '../errors.js';
import type { IlpPeerInfo, SwapPair } from '../types.js';

function basePeerInfo(): IlpPeerInfo {
  return {
    ilpAddress: 'g.example.connector',
    btpEndpoint: 'wss://btp.example.com',
    assetCode: 'USD',
    assetScale: 6,
  };
}

function validPair(): SwapPair {
  return {
    from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
    to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
    rate: '0.00025',
    minAmount: '1000000',
    maxAmount: '1000000000',
  };
}

describe('buildIlpPeerInfoEvent — swapPairs serialization', () => {
  // ---------------------------------------------------------------------------
  // T-001: single valid pair serializes correctly
  // ---------------------------------------------------------------------------
  it('(T-001) serializes a single valid swapPair into event content', () => {
    const sk = generateSecretKey();
    const info: IlpPeerInfo = {
      ...basePeerInfo(),
      swapPairs: [validPair()],
    };

    const event = buildIlpPeerInfoEvent(info, sk);
    const content = JSON.parse(event.content);

    expect(Array.isArray(content.swapPairs)).toBe(true);
    expect(content.swapPairs).toHaveLength(1);
    expect(content.swapPairs[0]).toEqual(validPair());
  });

  // ---------------------------------------------------------------------------
  // T-006: multiple pairs across chains, order preserved
  // ---------------------------------------------------------------------------
  it('(T-006) preserves array order for multiple pairs across chains', () => {
    const sk = generateSecretKey();
    const pair1: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
      rate: '0.00025',
    };
    const pair2: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'mina:mainnet' },
      to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
      rate: '1.5',
    };
    const pair3: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'solana:mainnet' },
      to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
      rate: '0.0065',
    };

    const info: IlpPeerInfo = {
      ...basePeerInfo(),
      swapPairs: [pair1, pair2, pair3],
    };
    const event = buildIlpPeerInfoEvent(info, sk);
    const content = JSON.parse(event.content);

    expect(content.swapPairs).toHaveLength(3);
    expect(content.swapPairs[0].to.chain).toBe('evm:base:8453');
    expect(content.swapPairs[1].to.chain).toBe('mina:mainnet');
    expect(content.swapPairs[2].to.chain).toBe('solana:mainnet');
  });

  // ---------------------------------------------------------------------------
  // T-007a: empty array is preserved
  // ---------------------------------------------------------------------------
  it('(T-007) serializes swapPairs:[] as an empty array (distinct from undefined)', () => {
    const sk = generateSecretKey();
    const info: IlpPeerInfo = { ...basePeerInfo(), swapPairs: [] };

    const event = buildIlpPeerInfoEvent(info, sk);
    const content = JSON.parse(event.content);

    expect('swapPairs' in content).toBe(true);
    expect(Array.isArray(content.swapPairs)).toBe(true);
    expect(content.swapPairs).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // T-007b: swapPairs undefined → key omitted entirely
  // ---------------------------------------------------------------------------
  it('(T-007) omits swapPairs key entirely when swapPairs is undefined', () => {
    const sk = generateSecretKey();
    const info = basePeerInfo(); // no swapPairs property at all

    const event = buildIlpPeerInfoEvent(info, sk);
    const content = JSON.parse(event.content);

    expect('swapPairs' in content).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // T-008: invalid pairs throw ToonError with code INVALID_SWAP_PAIR
  // ---------------------------------------------------------------------------
  it('(T-008) throws INVALID_SWAP_PAIR on negative assetScale', () => {
    const sk = generateSecretKey();
    const bad: SwapPair = {
      ...validPair(),
      from: { ...validPair().from, assetScale: -1 },
    };
    const info: IlpPeerInfo = { ...basePeerInfo(), swapPairs: [bad] };

    try {
      buildIlpPeerInfoEvent(info, sk);
      expect.fail('expected ToonError');
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('INVALID_SWAP_PAIR');
    }
  });

  it('(T-008) throws INVALID_SWAP_PAIR on non-numeric rate', () => {
    const sk = generateSecretKey();
    const bad = { ...validPair(), rate: 'abc' };
    const info: IlpPeerInfo = { ...basePeerInfo(), swapPairs: [bad] };

    expect(() => buildIlpPeerInfoEvent(info, sk)).toThrow(ToonError);
    try {
      buildIlpPeerInfoEvent(info, sk);
    } catch (e) {
      expect((e as ToonError).code).toBe('INVALID_SWAP_PAIR');
    }
  });

  it('(T-008) throws INVALID_SWAP_PAIR when minAmount > maxAmount (20-digit BigInt)', () => {
    const sk = generateSecretKey();
    const bad: SwapPair = {
      ...validPair(),
      minAmount: '99999999999999999999',
      maxAmount: '1',
    };
    const info: IlpPeerInfo = { ...basePeerInfo(), swapPairs: [bad] };

    expect(() => buildIlpPeerInfoEvent(info, sk)).toThrow(ToonError);
  });

  it('(T-008) throws INVALID_SWAP_PAIR on malformed chain format', () => {
    const sk = generateSecretKey();
    const bad: SwapPair = {
      ...validPair(),
      to: { ...validPair().to, chain: 'ethereum' }, // no colon
    };
    const info: IlpPeerInfo = { ...basePeerInfo(), swapPairs: [bad] };

    expect(() => buildIlpPeerInfoEvent(info, sk)).toThrow(ToonError);
  });

  it('(defensive) throws INVALID_SWAP_PAIR when swapPairs is a non-array value (JS caller)', () => {
    const sk = generateSecretKey();
    // Simulate an untyped JS caller passing garbage through the TS boundary.
    const info = {
      ...basePeerInfo(),
      swapPairs: 'not-an-array' as unknown as SwapPair[],
    };
    try {
      buildIlpPeerInfoEvent(info, sk);
      expect.fail('expected ToonError');
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('INVALID_SWAP_PAIR');
    }
  });

  it('(T-008) throws INVALID_SWAP_PAIR on empty assetCode', () => {
    const sk = generateSecretKey();
    const bad: SwapPair = {
      ...validPair(),
      from: { ...validPair().from, assetCode: '' },
    };
    const info: IlpPeerInfo = { ...basePeerInfo(), swapPairs: [bad] };

    expect(() => buildIlpPeerInfoEvent(info, sk)).toThrow(ToonError);
  });

  // ---------------------------------------------------------------------------
  // Regression: pre-Epic-12 IlpPeerInfo (no swapPairs) behaves identically
  // ---------------------------------------------------------------------------
  it('regression: pre-Epic-12 IlpPeerInfo builds without swapPairs key in content', () => {
    const sk = generateSecretKey();
    const info: IlpPeerInfo = {
      ...basePeerInfo(),
      feePerByte: '2',
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0xabc' },
    };

    const event = buildIlpPeerInfoEvent(info, sk);
    const content = JSON.parse(event.content);

    expect('swapPairs' in content).toBe(false);
    // Sanity: all pre-existing fields still present
    expect(content.ilpAddress).toBe('g.example.connector');
    expect(content.feePerByte).toBe('2');
    expect(content.supportedChains).toEqual(['evm:base:8453']);
  });
});
