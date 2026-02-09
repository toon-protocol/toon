/**
 * Tests for settlement negotiation pure functions.
 */

import { describe, it, expect } from 'vitest';
import { negotiateSettlementChain, resolveTokenForChain } from './settlement.js';

describe('negotiateSettlementChain', () => {
  it('returns first matching chain when both peers support multiple chains', () => {
    const result = negotiateSettlementChain(
      ['evm:base:8453', 'xrp:mainnet'],
      ['xrp:mainnet', 'evm:base:8453']
    );
    expect(result).toBe('evm:base:8453');
  });

  it('returns null when no chain intersection', () => {
    const result = negotiateSettlementChain(
      ['evm:base:8453'],
      ['xrp:mainnet']
    );
    expect(result).toBeNull();
  });

  it('prefers chain with requester preferred token when available', () => {
    const result = negotiateSettlementChain(
      ['evm:base:8453', 'xrp:mainnet'],
      ['evm:base:8453', 'xrp:mainnet'],
      { 'xrp:mainnet': '0xREQUESTER_TOKEN' }
    );
    expect(result).toBe('xrp:mainnet');
  });

  it('prefers chain with responder preferred token when no requester preference', () => {
    const result = negotiateSettlementChain(
      ['evm:base:8453', 'xrp:mainnet'],
      ['evm:base:8453', 'xrp:mainnet'],
      undefined,
      { 'xrp:mainnet': '0xRESPONDER_TOKEN' }
    );
    expect(result).toBe('xrp:mainnet');
  });

  it('falls back to first intersection match when no token preferences', () => {
    const result = negotiateSettlementChain(
      ['evm:base:8453', 'xrp:mainnet', 'aptos:mainnet:1'],
      ['aptos:mainnet:1', 'xrp:mainnet', 'evm:base:8453']
    );
    expect(result).toBe('evm:base:8453');
  });

  it('handles empty requester chains (returns null)', () => {
    const result = negotiateSettlementChain(
      [],
      ['evm:base:8453', 'xrp:mainnet']
    );
    expect(result).toBeNull();
  });

  it('handles empty responder chains (returns null)', () => {
    const result = negotiateSettlementChain(
      ['evm:base:8453', 'xrp:mainnet'],
      []
    );
    expect(result).toBeNull();
  });

  it("preserves requester's chain order for intersection", () => {
    const result = negotiateSettlementChain(
      ['xrp:mainnet', 'evm:base:8453', 'aptos:mainnet:1'],
      ['aptos:mainnet:1', 'evm:base:8453', 'xrp:mainnet']
    );
    // Should be xrp:mainnet because it's first in requester's list
    expect(result).toBe('xrp:mainnet');
  });
});

describe('resolveTokenForChain', () => {
  it("returns requester's preferred token when available", () => {
    const result = resolveTokenForChain(
      'evm:base:8453',
      { 'evm:base:8453': '0xREQUESTER_TOKEN' },
      { 'evm:base:8453': '0xRESPONDER_TOKEN' }
    );
    expect(result).toBe('0xREQUESTER_TOKEN');
  });

  it("returns responder's preferred token when requester has none", () => {
    const result = resolveTokenForChain(
      'evm:base:8453',
      undefined,
      { 'evm:base:8453': '0xRESPONDER_TOKEN' }
    );
    expect(result).toBe('0xRESPONDER_TOKEN');
  });

  it('returns undefined when neither has a preference for the chain', () => {
    const result = resolveTokenForChain(
      'evm:base:8453',
      { 'xrp:mainnet': '0xTOKEN' },
      { 'xrp:mainnet': '0xTOKEN2' }
    );
    expect(result).toBeUndefined();
  });

  it("requester preference takes priority over responder's", () => {
    const result = resolveTokenForChain(
      'evm:base:8453',
      { 'evm:base:8453': '0xREQUESTER' },
      { 'evm:base:8453': '0xRESPONDER' }
    );
    expect(result).toBe('0xREQUESTER');
  });
});
