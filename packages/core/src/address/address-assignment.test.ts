import { describe, it, expect } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';

import {
  assignAddressFromHandshake,
  isGenesisNode,
} from './address-assignment.js';
import { ToonError } from '../errors.js';
import { buildIlpPeerInfoEvent } from '../events/builders.js';
import { parseIlpPeerInfo } from '../events/parsers.js';

/** Full 64-char lowercase hex pubkey for standard tests. */
const PUBKEY_64 =
  'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

// ---------------------------------------------------------------------------
// T-7.2-02 [P0] assignAddressFromHandshake -- happy path
// ---------------------------------------------------------------------------
describe('assignAddressFromHandshake', () => {
  it('T-7.2-02: derives g.toon.useast.abcd1234 from handshake prefix and pubkey', () => {
    const result = assignAddressFromHandshake(
      { prefix: 'g.toon.useast' },
      PUBKEY_64
    );
    expect(result).toBe('g.toon.useast.abcd1234');
  });

  it('T-7.2-05: throws ADDRESS_MISSING_PREFIX when handshake has no prefix', () => {
    expect(() => assignAddressFromHandshake({}, PUBKEY_64)).toThrow(ToonError);
    try {
      assignAddressFromHandshake({}, PUBKEY_64);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_MISSING_PREFIX');
    }
  });

  it('T-7.2-09: multiple calls with same inputs return same address (deterministic)', () => {
    const input = { prefix: 'g.toon.useast' };
    const result1 = assignAddressFromHandshake(input, PUBKEY_64);
    const result2 = assignAddressFromHandshake(input, PUBKEY_64);
    const result3 = assignAddressFromHandshake(input, PUBKEY_64);
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
    expect(result1).toBe('g.toon.useast.abcd1234');
  });

  it('propagates ADDRESS_INVALID_PUBKEY when pubkey is too short (AC #1: error propagation)', () => {
    expect(() =>
      assignAddressFromHandshake({ prefix: 'g.toon.useast' }, 'abc')
    ).toThrow(ToonError);
    try {
      assignAddressFromHandshake({ prefix: 'g.toon.useast' }, 'abc');
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PUBKEY');
    }
  });

  it('propagates ADDRESS_INVALID_PREFIX when handshake prefix is invalid ILP address (AC #3)', () => {
    expect(() =>
      assignAddressFromHandshake({ prefix: 'INVALID PREFIX' }, PUBKEY_64)
    ).toThrow(ToonError);
    try {
      assignAddressFromHandshake({ prefix: 'INVALID PREFIX' }, PUBKEY_64);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });
});

// ---------------------------------------------------------------------------
// T-7.2-04 [P0] isGenesisNode
// ---------------------------------------------------------------------------
describe('isGenesisNode', () => {
  it('T-7.2-04: returns true when ilpAddress is g.toon', () => {
    expect(isGenesisNode({ ilpAddress: 'g.toon' })).toBe(true);
  });

  it('returns false when ilpAddress is a child address', () => {
    expect(isGenesisNode({ ilpAddress: 'g.toon.abcd1234' })).toBe(false);
  });

  it('returns false when ilpAddress is not set', () => {
    expect(isGenesisNode({})).toBe(false);
  });

  it('returns false when ilpAddress is explicitly undefined', () => {
    expect(isGenesisNode({ ilpAddress: undefined })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC #2: kind:10032 uses derived address (integration)
// ---------------------------------------------------------------------------
describe('kind:10032 uses handshake-derived address (AC #2)', () => {
  it('T-7.2-03: derived address from handshake flows into kind:10032 event content', () => {
    // Arrange -- derive address from handshake
    const derivedAddress = assignAddressFromHandshake(
      { prefix: 'g.toon.useast' },
      PUBKEY_64
    );
    expect(derivedAddress).toBe('g.toon.useast.abcd1234');

    // Act -- build kind:10032 event using the derived address
    const secretKey = generateSecretKey();
    const event = buildIlpPeerInfoEvent(
      {
        ilpAddress: derivedAddress,
        btpEndpoint: 'ws://localhost:8080',
        assetCode: 'USD',
        assetScale: 6,
      },
      secretKey
    );

    // Assert -- parse the event and verify the derived address is in the content
    const parsed = parseIlpPeerInfo(event);
    expect(parsed.ilpAddress).toBe('g.toon.useast.abcd1234');
  });
});
