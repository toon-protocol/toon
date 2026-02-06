import { describe, it, expect } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { parseIlpPeerInfo, parseSpspInfo } from './parsers.js';
import { buildIlpPeerInfoEvent, buildSpspInfoEvent } from './builders.js';
import { InvalidEventError } from '../errors.js';
import { ILP_PEER_INFO_KIND, SPSP_INFO_KIND } from '../constants.js';
import type { IlpPeerInfo, SpspInfo } from '../types.js';

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

function createTestSpspInfo(): SpspInfo {
  return {
    destinationAccount: 'g.example.receiver',
    sharedSecret: 'c2VjcmV0MTIz', // base64 encoded "secret123"
  };
}

function createMockEvent(
  kind: number,
  content: string
): NostrEvent {
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
    const event = createMockEvent(SPSP_INFO_KIND, JSON.stringify(createTestIlpPeerInfo()));

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      `Expected event kind ${ILP_PEER_INFO_KIND}, got ${SPSP_INFO_KIND}`
    );
  });

  it('throws for invalid JSON content', () => {
    // Arrange
    const event = createMockEvent(ILP_PEER_INFO_KIND, 'not valid json');

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow('Failed to parse event content as JSON');
  });

  it('throws for non-object JSON content', () => {
    // Arrange
    const event = createMockEvent(ILP_PEER_INFO_KIND, '"just a string"');

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow('Event content must be a JSON object');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('Missing or invalid required field: ilpAddress');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('Missing or invalid required field: btpEndpoint');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('Missing or invalid required field: assetCode');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('Missing or invalid required field: assetScale');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('Missing or invalid required field: assetScale');
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

describe('parseSpspInfo', () => {
  it('parses valid kind:10047 event', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestSpspInfo();
    const event = buildSpspInfoEvent(info, secretKey);

    // Act
    const result = parseSpspInfo(event);

    // Assert
    expect(result.destinationAccount).toBe('g.example.receiver');
    expect(result.sharedSecret).toBe('c2VjcmV0MTIz');
  });

  it('throws for wrong event kind', () => {
    // Arrange
    const event = createMockEvent(ILP_PEER_INFO_KIND, JSON.stringify(createTestSpspInfo()));

    // Act & Assert
    expect(() => parseSpspInfo(event)).toThrow(InvalidEventError);
    expect(() => parseSpspInfo(event)).toThrow(
      `Expected event kind ${SPSP_INFO_KIND}, got ${ILP_PEER_INFO_KIND}`
    );
  });

  it('throws for invalid JSON content', () => {
    // Arrange
    const event = createMockEvent(SPSP_INFO_KIND, '{invalid');

    // Act & Assert
    expect(() => parseSpspInfo(event)).toThrow(InvalidEventError);
    expect(() => parseSpspInfo(event)).toThrow('Failed to parse event content as JSON');
  });

  it('throws for non-object JSON content', () => {
    // Arrange
    const event = createMockEvent(SPSP_INFO_KIND, '123');

    // Act & Assert
    expect(() => parseSpspInfo(event)).toThrow(InvalidEventError);
    expect(() => parseSpspInfo(event)).toThrow('Event content must be a JSON object');
  });

  it('throws for missing destinationAccount', () => {
    // Arrange
    const content = JSON.stringify({
      sharedSecret: 'c2VjcmV0MTIz',
    });
    const event = createMockEvent(SPSP_INFO_KIND, content);

    // Act & Assert
    expect(() => parseSpspInfo(event)).toThrow(InvalidEventError);
    expect(() => parseSpspInfo(event)).toThrow(
      'Missing or invalid required field: destinationAccount'
    );
  });

  it('throws for missing sharedSecret', () => {
    // Arrange
    const content = JSON.stringify({
      destinationAccount: 'g.example.receiver',
    });
    const event = createMockEvent(SPSP_INFO_KIND, content);

    // Act & Assert
    expect(() => parseSpspInfo(event)).toThrow(InvalidEventError);
    expect(() => parseSpspInfo(event)).toThrow('Missing or invalid required field: sharedSecret');
  });

  it('throws for empty destinationAccount', () => {
    // Arrange
    const content = JSON.stringify({
      destinationAccount: '',
      sharedSecret: 'c2VjcmV0MTIz',
    });
    const event = createMockEvent(SPSP_INFO_KIND, content);

    // Act & Assert
    expect(() => parseSpspInfo(event)).toThrow(InvalidEventError);
    expect(() => parseSpspInfo(event)).toThrow(
      'Missing or invalid required field: destinationAccount'
    );
  });

  it('throws for empty sharedSecret', () => {
    // Arrange
    const content = JSON.stringify({
      destinationAccount: 'g.example.receiver',
      sharedSecret: '',
    });
    const event = createMockEvent(SPSP_INFO_KIND, content);

    // Act & Assert
    expect(() => parseSpspInfo(event)).toThrow(InvalidEventError);
    expect(() => parseSpspInfo(event)).toThrow('Missing or invalid required field: sharedSecret');
  });
});
