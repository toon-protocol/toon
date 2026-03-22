import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { buildIlpPeerInfoEvent } from './builders.js';
import { parseIlpPeerInfo } from './parsers.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import type { IlpPeerInfo } from '../types.js';

// Test fixtures
function createTestIlpPeerInfo(): IlpPeerInfo {
  return {
    ilpAddress: 'g.example.connector',
    btpEndpoint: 'wss://btp.example.com',
    assetCode: 'USD',
    assetScale: 6,
  };
}

function createTestIlpPeerInfoWithSettlement(): IlpPeerInfo {
  return {
    ...createTestIlpPeerInfo(),
    settlementEngine: 'xrp-paychan',
  };
}

describe('buildIlpPeerInfoEvent', () => {
  it('creates valid signed event with kind 10032', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfo();

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Assert
    expect(event.kind).toBe(ILP_PEER_INFO_KIND);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(event.pubkey).toBe(getPublicKey(secretKey));
    expect(event.tags).toEqual([]);
    expect(event.created_at).toBeGreaterThan(0);
  });

  it('content contains correct serialized IlpPeerInfo', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfo();

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert
    expect(content.ilpAddress).toBe('g.example.connector');
    expect(content.btpEndpoint).toBe('wss://btp.example.com');
    expect(content.assetCode).toBe('USD');
    expect(content.assetScale).toBe(6);
  });

  it('includes optional settlementEngine in content', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfoWithSettlement();

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert
    expect(content.settlementEngine).toBe('xrp-paychan');
  });

  it('signature verification passes', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfo();

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const isValid = verifyEvent(event);

    // Assert
    expect(isValid).toBe(true);
  });
});

describe('round-trip tests', () => {
  it('build -> parse round-trip for IlpPeerInfo preserves all data', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const original: IlpPeerInfo = {
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      settlementEngine: 'xrp-paychan',
      assetCode: 'XRP',
      assetScale: 9,
    };

    // Act
    const event = buildIlpPeerInfoEvent(original, secretKey);
    const parsed = parseIlpPeerInfo(event);

    // Assert — parser adds settlement defaults for events without new fields
    expect(parsed.ilpAddress).toBe(original.ilpAddress);
    expect(parsed.btpEndpoint).toBe(original.btpEndpoint);
    expect(parsed.settlementEngine).toBe(original.settlementEngine);
    expect(parsed.assetCode).toBe(original.assetCode);
    expect(parsed.assetScale).toBe(original.assetScale);
    expect(parsed.supportedChains).toEqual([]);
    expect(parsed.settlementAddresses).toEqual({});
  });

  it('build -> parse round-trip for IlpPeerInfo without optional fields', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const original: IlpPeerInfo = {
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
    };

    // Act
    const event = buildIlpPeerInfoEvent(original, secretKey);
    const parsed = parseIlpPeerInfo(event);

    // Assert
    expect(parsed.ilpAddress).toBe(original.ilpAddress);
    expect(parsed.btpEndpoint).toBe(original.btpEndpoint);
    expect(parsed.assetCode).toBe(original.assetCode);
    expect(parsed.assetScale).toBe(original.assetScale);
    expect(parsed.settlementEngine).toBeUndefined();
  });
});

describe('buildIlpPeerInfoEvent - settlement fields', () => {
  function createTestIlpPeerInfoWithChains(): IlpPeerInfo {
    return {
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: ['evm:base:8453', 'xrp:mainnet'],
      settlementAddresses: {
        'evm:base:8453': '0x1234567890abcdef1234567890abcdef12345678',
        'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
      },
    };
  }

  function createTestIlpPeerInfoWithAllFields(): IlpPeerInfo {
    return {
      ...createTestIlpPeerInfoWithChains(),
      settlementEngine: 'xrp-paychan',
      preferredTokens: { 'evm:base:8453': '0xUSDC_TOKEN' },
      tokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
    };
  }

  it('serializes all new settlement fields', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfoWithAllFields();

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert
    expect(content.supportedChains).toEqual(['evm:base:8453', 'xrp:mainnet']);
    expect(content.settlementAddresses).toEqual({
      'evm:base:8453': '0x1234567890abcdef1234567890abcdef12345678',
      'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
    });
    expect(content.preferredTokens).toEqual({
      'evm:base:8453': '0xUSDC_TOKEN',
    });
    expect(content.tokenNetworks).toEqual({
      'evm:base:8453': '0xTOKEN_NETWORK',
    });
  });

  it('signature verification passes with new fields present', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfoWithAllFields();

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const isValid = verifyEvent(event);

    // Assert
    expect(isValid).toBe(true);
  });
});

describe('round-trip tests - settlement fields', () => {
  it('build -> parse round-trip preserves all settlement fields including optional ones', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const original: IlpPeerInfo = {
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: ['evm:base:8453', 'xrp:mainnet'],
      settlementAddresses: {
        'evm:base:8453': '0x1234567890abcdef1234567890abcdef12345678',
        'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
      },
      preferredTokens: { 'evm:base:8453': '0xUSDC_TOKEN' },
      tokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
    };

    // Act
    const event = buildIlpPeerInfoEvent(original, secretKey);
    const parsed = parseIlpPeerInfo(event);

    // Assert -- parser adds ilpAddresses default when absent from source event
    expect(parsed).toEqual({
      ...original,
      ilpAddresses: ['g.example.connector'],
    });
  });
});

// ---------------------------------------------------------------------------
// Story 7.3: Multi-address kind:10032 builder tests (Tasks 7.1, 7.3, 7.6, 7.7, 7.8, 7.9)
// ---------------------------------------------------------------------------

import { ToonError } from '../errors.js';

describe('buildIlpPeerInfoEvent - multi-address (Story 7.3)', () => {
  it('T-7.3-01 builder: includes ilpAddresses array with two addresses in event content (Task 7.1)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234', 'g.toon.euwest.abcd1234'],
    };

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert
    expect(content.ilpAddresses).toEqual([
      'g.toon.useast.abcd1234',
      'g.toon.euwest.abcd1234',
    ]);
    expect(content.ilpAddress).toBe('g.toon.useast.abcd1234');
  });

  it('T-7.3-01 full roundtrip: build -> parse preserves both addresses in ilpAddresses (Task 7.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const original: IlpPeerInfo = {
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234', 'g.toon.euwest.abcd1234'],
    };

    // Act
    const event = buildIlpPeerInfoEvent(original, secretKey);
    const parsed = parseIlpPeerInfo(event);

    // Assert
    expect(parsed.ilpAddresses).toEqual([
      'g.toon.useast.abcd1234',
      'g.toon.euwest.abcd1234',
    ]);
    expect(parsed.ilpAddress).toBe('g.toon.useast.abcd1234');
  });

  it('T-7.3-06: kind:10032 with 3 addresses -> all preserved through build/parse roundtrip (Task 7.5)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const original: IlpPeerInfo = {
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: [
        'g.toon.useast.abcd1234',
        'g.toon.euwest.abcd1234',
        'g.toon.apac.abcd1234',
      ],
    };

    // Act
    const event = buildIlpPeerInfoEvent(original, secretKey);
    const parsed = parseIlpPeerInfo(event);

    // Assert
    expect(parsed.ilpAddresses).toEqual([
      'g.toon.useast.abcd1234',
      'g.toon.euwest.abcd1234',
      'g.toon.apac.abcd1234',
    ]);
  });

  it('T-7.3-07: buildIlpPeerInfoEvent with empty ilpAddresses throws ToonError ADDRESS_EMPTY_ADDRESSES (Task 7.6)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: [],
    };

    // Act & Assert -- verify both error type and error code
    let thrownError: unknown;
    try {
      buildIlpPeerInfoEvent(info, secretKey);
      // Should not reach here
      expect.unreachable('Expected ToonError to be thrown');
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).toBeInstanceOf(ToonError);
    expect((thrownError as ToonError).code).toBe('ADDRESS_EMPTY_ADDRESSES');
  });

  it('single address in ilpAddresses -> ilpAddress equals that single address (backward compat) (Task 7.7)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234'],
    };

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert
    expect(content.ilpAddress).toBe('g.toon.useast.abcd1234');
    expect(content.ilpAddresses).toEqual(['g.toon.useast.abcd1234']);
  });

  it('ilpAddress (singular) normalized to ilpAddresses[0] when array is present (Task 7.8)', () => {
    // Arrange -- ilpAddress does NOT match ilpAddresses[0] initially
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ilpAddress: 'g.toon.legacy.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234', 'g.toon.euwest.abcd1234'],
    };

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert -- ilpAddress must be normalized to ilpAddresses[0]
    expect(content.ilpAddress).toBe('g.toon.useast.abcd1234');
  });

  it('buildIlpPeerInfoEvent with invalid ILP address in ilpAddresses throws ToonError ADDRESS_INVALID_PREFIX (Task 7.9)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234', 'INVALID..ADDRESS'],
    };

    // Act & Assert -- verify both error type and error code
    let thrownError: unknown;
    try {
      buildIlpPeerInfoEvent(info, secretKey);
      // Should not reach here
      expect.unreachable('Expected ToonError to be thrown');
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).toBeInstanceOf(ToonError);
    expect((thrownError as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
  });
});
