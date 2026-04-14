/**
 * Story 12.6 AC-9 / T-054: Mina stub throws UNSUPPORTED_CHAIN.
 */
import { describe, it, expect } from 'vitest';
import type { SwapPair } from '@toon-protocol/core';

import type { AccumulatedClaim } from '../stream-swap.js';
import { SettlementTxError } from '../errors.js';
import { buildMinaSettlementTx } from './mina.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
  rate: '0.5',
};

describe('buildMinaSettlementTx (AC-9, T-054)', () => {
  it('[P0] throws SettlementTxError(UNSUPPORTED_CHAIN)', () => {
    const claim: AccumulatedClaim = {
      packetIndex: 0,
      sourceAmount: 1n,
      targetAmount: 1n,
      claimBytes: new Uint8Array(10),
      millEphemeralPubkey: '0'.repeat(64),
      pair: PAIR,
      receivedAt: 0,
    };
    try {
      buildMinaSettlementTx(claim, { address: 'X' }, 'R', 0, 1);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SettlementTxError);
      expect((err as SettlementTxError).code).toBe('UNSUPPORTED_CHAIN');
    }
  });
});
