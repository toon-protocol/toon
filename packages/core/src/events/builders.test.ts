import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { buildIlpPeerInfoEvent, buildSpspInfoEvent } from './builders.js';
import { parseIlpPeerInfo, parseSpspInfo } from './parsers.js';
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
    sharedSecret: 'c2VjcmV0MTIz',
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

describe('buildSpspInfoEvent', () => {
  it('creates valid signed event with kind 10047', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestSpspInfo();

    // Act
    const event = buildSpspInfoEvent(info, secretKey);

    // Assert
    expect(event.kind).toBe(SPSP_INFO_KIND);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(event.pubkey).toBe(getPublicKey(secretKey));
    expect(event.tags).toEqual([]);
    expect(event.created_at).toBeGreaterThan(0);
  });

  it('content contains correct serialized SpspInfo', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestSpspInfo();

    // Act
    const event = buildSpspInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert
    expect(content.destinationAccount).toBe('g.example.receiver');
    expect(content.sharedSecret).toBe('c2VjcmV0MTIz');
  });

  it('signature verification passes', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestSpspInfo();

    // Act
    const event = buildSpspInfoEvent(info, secretKey);
    const isValid = verifyEvent(event);

    // Assert
    expect(isValid).toBe(true);
  });
});

describe('round-trip tests', () => {
  it('build → parse round-trip for IlpPeerInfo preserves all data', () => {
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

    // Assert
    expect(parsed).toEqual(original);
  });

  it('build → parse round-trip for IlpPeerInfo without optional fields', () => {
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

  it('build → parse round-trip for SpspInfo preserves all data', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const original: SpspInfo = {
      destinationAccount: 'g.example.receiver.alice',
      sharedSecret: 'YmFzZTY0LWVuY29kZWQtc2VjcmV0',
    };

    // Act
    const event = buildSpspInfoEvent(original, secretKey);
    const parsed = parseSpspInfo(event);

    // Assert
    expect(parsed).toEqual(original);
  });
});
