import { describe, it, expect } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { parseIlpPeerInfo, validateChainId } from './parsers.js';
import { buildIlpPeerInfoEvent } from './builders.js';
import { InvalidEventError } from '../errors.js';
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

function createMockEvent(kind: number, content: string): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: '0'.repeat(64),
    kind,
    content,
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

describe('parseIlpPeerInfo', () => {
  it('parses valid kind:10032 event', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfo();
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert
    expect(result.ilpAddress).toBe('g.example.connector');
    expect(result.btpEndpoint).toBe('wss://btp.example.com');
    expect(result.assetCode).toBe('USD');
    expect(result.assetScale).toBe(6);
    expect(result.settlementEngine).toBeUndefined();
  });

  it('parses event with optional settlementEngine', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfoWithSettlement();
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert
    expect(result.settlementEngine).toBe('xrp-paychan');
  });

  it('throws for wrong event kind', () => {
    // Arrange
    const event = createMockEvent(1, JSON.stringify(createTestIlpPeerInfo()));

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      `Expected event kind ${ILP_PEER_INFO_KIND}, got 1`
    );
  });

  it('throws for invalid JSON content', () => {
    // Arrange
    const event = createMockEvent(ILP_PEER_INFO_KIND, 'not valid json');

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Failed to parse event content as JSON'
    );
  });

  it('throws for non-object JSON content', () => {
    // Arrange
    const event = createMockEvent(ILP_PEER_INFO_KIND, '"just a string"');

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Event content must be a JSON object'
    );
  });

  it('throws for missing ilpAddress', () => {
    // Arrange
    const content = JSON.stringify({
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Missing or invalid required field: ilpAddress'
    );
  });

  it('throws for missing btpEndpoint', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      assetCode: 'USD',
      assetScale: 6,
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Missing or invalid required field: btpEndpoint'
    );
  });

  it('throws for missing assetCode', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetScale: 6,
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Missing or invalid required field: assetCode'
    );
  });

  it('throws for missing assetScale', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Missing or invalid required field: assetScale'
    );
  });

  it('throws for non-integer assetScale', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6.5,
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Missing or invalid required field: assetScale'
    );
  });

  it('throws for invalid settlementEngine type', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      settlementEngine: 123,
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Invalid optional field: settlementEngine must be a string'
    );
  });
});

describe('parseIlpPeerInfo - settlement fields', () => {
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

  it('parses event with all new settlement fields', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ...createTestIlpPeerInfoWithChains(),
      preferredTokens: { 'evm:base:8453': '0xUSDC_TOKEN' },
      tokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
    };
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert
    expect(result.supportedChains).toEqual(['evm:base:8453', 'xrp:mainnet']);
    expect(result.settlementAddresses).toEqual({
      'evm:base:8453': '0x1234567890abcdef1234567890abcdef12345678',
      'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
    });
    expect(result.preferredTokens).toEqual({
      'evm:base:8453': '0xUSDC_TOKEN',
    });
    expect(result.tokenNetworks).toEqual({
      'evm:base:8453': '0xTOKEN_NETWORK',
    });
  });

  it('parses event with only supportedChains and settlementAddresses', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfoWithChains();
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert
    expect(result.supportedChains).toEqual(['evm:base:8453', 'xrp:mainnet']);
    expect(result.settlementAddresses).toEqual({
      'evm:base:8453': '0x1234567890abcdef1234567890abcdef12345678',
      'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
    });
    expect(result.preferredTokens).toBeUndefined();
    expect(result.tokenNetworks).toBeUndefined();
  });

  it('backward compat — parses event without any new fields', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert
    expect(result.supportedChains).toEqual([]);
    expect(result.settlementAddresses).toEqual({});
    expect(result.preferredTokens).toBeUndefined();
    expect(result.tokenNetworks).toBeUndefined();
  });

  it('backward compat — parses event with old settlementEngine field', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      settlementEngine: 'xrp-paychan',
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert
    expect(result.settlementEngine).toBe('xrp-paychan');
    expect(result.supportedChains).toEqual([]);
    expect(result.settlementAddresses).toEqual({});
  });

  it('throws for empty supportedChains array', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: [],
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'supportedChains must be a non-empty array when provided'
    );
  });

  it('throws for invalid chain ID in supportedChains', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: ['evm'],
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'Invalid chain identifier: evm'
    );
  });

  it('throws for non-array supportedChains', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: 'evm:base:8453',
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'supportedChains must be an array'
    );
  });

  it('throws for non-object settlementAddresses', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      settlementAddresses: 'not-an-object',
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'settlementAddresses must be an object'
    );
  });

  it('throws for settlementAddresses with non-string values', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      settlementAddresses: { 'evm:base:8453': 123 },
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'settlementAddresses values must be non-empty strings'
    );
  });

  it('throws when settlementAddresses key is not in supportedChains', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'xrp:mainnet': 'rSOME_ADDRESS' },
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      "settlementAddresses key 'xrp:mainnet' is not in supportedChains"
    );
  });

  it('allows settlementAddresses when keys are subset of supportedChains', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: ['evm:base:8453', 'xrp:mainnet'],
      settlementAddresses: { 'evm:base:8453': '0xADDRESS' },
    };
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert — subset is fine
    expect(result.settlementAddresses).toEqual({
      'evm:base:8453': '0xADDRESS',
    });
  });
});

// ---------------------------------------------------------------------------
// Story 7.3: Multi-address kind:10032 parser tests (Tasks 7.2, 7.4, 7.5, 7.10, 10.1, 10.2)
// ---------------------------------------------------------------------------

describe('parseIlpPeerInfo - multi-address (Story 7.3)', () => {
  it('T-7.3-01 parser: extracts ilpAddresses array from event with two addresses (Task 7.2)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234', 'g.toon.euwest.abcd1234'],
    };
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert
    expect(result.ilpAddresses).toEqual([
      'g.toon.useast.abcd1234',
      'g.toon.euwest.abcd1234',
    ]);
  });

  it('T-7.3-04: parseIlpPeerInfo on pre-Epic-7 event (no ilpAddresses field) defaults to [ilpAddress] (Task 7.4)', () => {
    // Arrange -- event without ilpAddresses field (pre-Epic-7 format)
    const content = JSON.stringify({
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert -- should default to wrapping ilpAddress in an array
    expect(result.ilpAddresses).toEqual(['g.example.connector']);
  });

  it('parseIlpPeerInfo with ilpAddresses as non-array throws InvalidEventError', () => {
    // Arrange -- ilpAddresses is a string instead of an array
    const content = JSON.stringify({
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: 'g.toon.useast.abcd1234',
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      'ilpAddresses must be an array'
    );
  });

  it('T-7.3-10: parseIlpPeerInfo with ilpAddresses containing non-string elements throws InvalidEventError (Task 7.10)', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234', 42],
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
  });

  it('T-7.3-10: parseIlpPeerInfo with ilpAddresses containing invalid ILP address structure throws InvalidEventError', () => {
    // Arrange
    const content = JSON.stringify({
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234', 'INVALID..ADDRESS'],
    });
    const event = createMockEvent(ILP_PEER_INFO_KIND, content);

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
  });

  it('T-7.3-03: parseIlpPeerInfo returns ilpAddresses array accessible for route selection (Task 10.1)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ilpAddress: 'g.toon.useast.abcd1234',
      btpEndpoint: 'wss://btp.example.com',
      assetCode: 'USD',
      assetScale: 6,
      ilpAddresses: ['g.toon.useast.abcd1234', 'g.toon.euwest.abcd1234'],
    };
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert -- ilpAddresses must be a string array
    expect(Array.isArray(result.ilpAddresses)).toBe(true);
    expect(result.ilpAddresses!.length).toBe(2);
    for (const addr of result.ilpAddresses!) {
      expect(typeof addr).toBe('string');
    }
  });

  it('T-7.3-05: client code can filter/select from ilpAddresses array (Task 10.2)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
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
    const event = buildIlpPeerInfoEvent(info, secretKey);

    // Act
    const result = parseIlpPeerInfo(event);

    // Assert -- standard JS array methods work for route selection
    const euAddresses = result.ilpAddresses!.filter((a) =>
      a.includes('euwest')
    );
    expect(euAddresses).toEqual(['g.toon.euwest.abcd1234']);

    const found = result.ilpAddresses!.find((a) => a.includes('apac'));
    expect(found).toBe('g.toon.apac.abcd1234');
  });
});

describe('validateChainId', () => {
  it('accepts valid 2-segment format', () => {
    expect(validateChainId('xrp:mainnet')).toBe(true);
  });

  it('accepts valid 3-segment format', () => {
    expect(validateChainId('evm:base:8453')).toBe(true);
    expect(validateChainId('aptos:mainnet:1')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateChainId('')).toBe(false);
  });

  it('rejects single segment', () => {
    expect(validateChainId('evm')).toBe(false);
  });

  it('rejects trailing colon', () => {
    expect(validateChainId('evm:')).toBe(false);
  });

  it('rejects leading colon', () => {
    expect(validateChainId(':base')).toBe(false);
  });

  it('rejects more than 3 segments', () => {
    expect(validateChainId('evm:base:8453:extra')).toBe(false);
  });
});
