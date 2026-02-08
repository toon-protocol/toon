import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { buildIlpPeerInfoEvent, buildSpspRequestEvent, buildSpspResponseEvent } from './builders.js';
import { parseIlpPeerInfo, parseSpspResponse } from './parsers.js';
import { ILP_PEER_INFO_KIND, SPSP_REQUEST_KIND, SPSP_RESPONSE_KIND } from '../constants.js';
import type { IlpPeerInfo, SpspRequest, SpspResponse } from '../types.js';

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
});

describe('buildSpspRequestEvent', () => {
  it('creates valid signed event with kind 23194', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);

    // Assert
    expect(event.kind).toBe(SPSP_REQUEST_KIND);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(event.pubkey).toBe(getPublicKey(senderSecretKey));
  });

  it('includes p tag with recipient pubkey', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);

    // Assert
    expect(event.tags).toEqual([['p', recipientPubkey]]);
  });

  it('returns unique requestId', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(generateSecretKey());

    // Act
    const result1 = buildSpspRequestEvent(recipientPubkey, senderSecretKey);
    const result2 = buildSpspRequestEvent(recipientPubkey, senderSecretKey);

    // Assert
    expect(result1.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(result1.requestId).not.toBe(result2.requestId);
  });

  it('content is NIP-44 encrypted', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);

    // Assert - content should not be valid JSON (it's encrypted)
    expect(() => JSON.parse(event.content)).toThrow();
    // Content should be non-empty base64-like string
    expect(event.content.length).toBeGreaterThan(0);
  });

  it('encrypted content can be decrypted by recipient', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const { event, requestId } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);

    // Decrypt as recipient
    const conversationKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload: SpspRequest = JSON.parse(decrypted);

    // Assert
    expect(payload.requestId).toBe(requestId);
    expect(typeof payload.timestamp).toBe('number');
    expect(payload.timestamp).toBeGreaterThan(0);
  });

  it('signature verification passes', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(generateSecretKey());

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);
    const isValid = verifyEvent(event);

    // Assert
    expect(isValid).toBe(true);
  });

  it('created_at matches payload timestamp', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);

    // Decrypt and check timestamp
    const conversationKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload: SpspRequest = JSON.parse(decrypted);

    // Assert
    expect(event.created_at).toBe(payload.timestamp);
  });
});

describe('buildSpspResponseEvent', () => {
  const testResponse: SpspResponse = {
    requestId: 'test-request-123',
    destinationAccount: 'g.example.receiver',
    sharedSecret: 'c2VjcmV0MTIz',
  };

  it('creates valid signed event with kind 23195', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const event = buildSpspResponseEvent(testResponse, senderPubkey, responderSecretKey);

    // Assert
    expect(event.kind).toBe(SPSP_RESPONSE_KIND);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(event.pubkey).toBe(getPublicKey(responderSecretKey));
  });

  it('includes p tag with original sender pubkey', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const event = buildSpspResponseEvent(testResponse, senderPubkey, responderSecretKey);

    // Assert
    expect(event.tags).toContainEqual(['p', senderPubkey]);
  });

  it('includes optional e tag with request event ID', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const requestEventId = 'a'.repeat(64);

    // Act
    const event = buildSpspResponseEvent(
      testResponse,
      senderPubkey,
      responderSecretKey,
      requestEventId
    );

    // Assert
    expect(event.tags).toContainEqual(['p', senderPubkey]);
    expect(event.tags).toContainEqual(['e', requestEventId]);
    expect(event.tags).toHaveLength(2);
  });

  it('omits e tag when requestEventId is not provided', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const event = buildSpspResponseEvent(testResponse, senderPubkey, responderSecretKey);

    // Assert
    expect(event.tags).toHaveLength(1);
    expect(event.tags[0]).toEqual(['p', senderPubkey]);
  });

  it('content is NIP-44 encrypted', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const event = buildSpspResponseEvent(testResponse, senderPubkey, responderSecretKey);

    // Assert - content should not be valid JSON (it's encrypted)
    expect(() => JSON.parse(event.content)).toThrow();
    // Content should be non-empty string
    expect(event.content.length).toBeGreaterThan(0);
  });

  it('encrypted content can be decrypted by sender', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const responderPubkey = getPublicKey(responderSecretKey);

    // Act
    const event = buildSpspResponseEvent(testResponse, senderPubkey, responderSecretKey);

    // Decrypt as sender
    const conversationKey = nip44.getConversationKey(senderSecretKey, responderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload: SpspResponse = JSON.parse(decrypted);

    // Assert
    expect(payload.requestId).toBe(testResponse.requestId);
    expect(payload.destinationAccount).toBe(testResponse.destinationAccount);
    expect(payload.sharedSecret).toBe(testResponse.sharedSecret);
  });

  it('signature verification passes', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const event = buildSpspResponseEvent(testResponse, senderPubkey, responderSecretKey);
    const isValid = verifyEvent(event);

    // Assert
    expect(isValid).toBe(true);
  });

  it('round-trip: build → parse preserves all data', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const responderPubkey = getPublicKey(responderSecretKey);

    // Act
    const event = buildSpspResponseEvent(testResponse, senderPubkey, responderSecretKey);
    const parsed = parseSpspResponse(event, senderSecretKey, responderPubkey);

    // Assert
    expect(parsed).toEqual(testResponse);
  });
});
