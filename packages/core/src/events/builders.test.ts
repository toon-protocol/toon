import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { buildIlpPeerInfoEvent, buildSpspRequestEvent, buildSpspResponseEvent } from './builders.js';
import { parseIlpPeerInfo, parseSpspRequest, parseSpspResponse } from './parsers.js';
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

    // Assert — parser adds settlement defaults for events without new fields
    expect(parsed.ilpAddress).toBe(original.ilpAddress);
    expect(parsed.btpEndpoint).toBe(original.btpEndpoint);
    expect(parsed.settlementEngine).toBe(original.settlementEngine);
    expect(parsed.assetCode).toBe(original.assetCode);
    expect(parsed.assetScale).toBe(original.assetScale);
    expect(parsed.supportedChains).toEqual([]);
    expect(parsed.settlementAddresses).toEqual({});
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
      preferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
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
    expect(content.preferredTokens).toEqual({ 'evm:base:8453': '0xAGENT_TOKEN' });
    expect(content.tokenNetworks).toEqual({ 'evm:base:8453': '0xTOKEN_NETWORK' });
  });

  it('serializes with only supportedChains and settlementAddresses', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info = createTestIlpPeerInfoWithChains();

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert
    expect(content.supportedChains).toEqual(['evm:base:8453', 'xrp:mainnet']);
    expect(content.settlementAddresses).toBeDefined();
    expect(content.preferredTokens).toBeUndefined();
    expect(content.tokenNetworks).toBeUndefined();
  });

  it('includes optional preferredTokens and tokenNetworks in content', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const info: IlpPeerInfo = {
      ...createTestIlpPeerInfoWithChains(),
      preferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
      tokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
    };

    // Act
    const event = buildIlpPeerInfoEvent(info, secretKey);
    const content = JSON.parse(event.content);

    // Assert
    expect(content.preferredTokens).toEqual({ 'evm:base:8453': '0xAGENT_TOKEN' });
    expect(content.tokenNetworks).toEqual({ 'evm:base:8453': '0xTOKEN_NETWORK' });
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
  it('build → parse round-trip preserves all settlement fields including optional ones', () => {
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
      preferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
      tokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
    };

    // Act
    const event = buildIlpPeerInfoEvent(original, secretKey);
    const parsed = parseIlpPeerInfo(event);

    // Assert
    expect(parsed).toEqual(original);
  });

  it('build → parse round-trip with optional fields omitted returns defaults', () => {
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
    expect(parsed.supportedChains).toEqual([]);
    expect(parsed.settlementAddresses).toEqual({});
    expect(parsed.preferredTokens).toBeUndefined();
    expect(parsed.tokenNetworks).toBeUndefined();
  });

  it('build → parse round-trip preserves deprecated settlementEngine alongside new fields', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const original: IlpPeerInfo = {
      ilpAddress: 'g.example.connector',
      btpEndpoint: 'wss://btp.example.com',
      settlementEngine: 'xrp-paychan',
      assetCode: 'XRP',
      assetScale: 9,
      supportedChains: ['xrp:mainnet'],
      settlementAddresses: { 'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit' },
    };

    // Act
    const event = buildIlpPeerInfoEvent(original, secretKey);
    const parsed = parseIlpPeerInfo(event);

    // Assert
    expect(parsed.settlementEngine).toBe('xrp-paychan');
    expect(parsed.supportedChains).toEqual(['xrp:mainnet']);
    expect(parsed.settlementAddresses).toEqual({ 'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit' });
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

describe('buildSpspRequestEvent - settlement fields', () => {
  const settlementInfo = {
    ilpAddress: 'g.example.sender',
    supportedChains: ['evm:base:8453', 'xrp:mainnet'],
    settlementAddresses: {
      'evm:base:8453': '0x1234567890abcdef1234567890abcdef12345678',
      'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
    },
    preferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
  };

  it('includes all settlement fields in encrypted payload', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const { event, requestId } = buildSpspRequestEvent(recipientPubkey, senderSecretKey, settlementInfo);

    // Decrypt as recipient
    const conversationKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload: SpspRequest = JSON.parse(decrypted);

    // Assert
    expect(payload.requestId).toBe(requestId);
    expect(payload.ilpAddress).toBe('g.example.sender');
    expect(payload.supportedChains).toEqual(['evm:base:8453', 'xrp:mainnet']);
    expect(payload.settlementAddresses).toEqual(settlementInfo.settlementAddresses);
    expect(payload.preferredTokens).toEqual({ 'evm:base:8453': '0xAGENT_TOKEN' });
  });

  it('with only supportedChains and settlementAddresses serializes correctly', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const partialInfo = {
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0xABC' },
    };

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey, partialInfo);

    // Decrypt as recipient
    const conversationKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload: SpspRequest = JSON.parse(decrypted);

    // Assert
    expect(payload.supportedChains).toEqual(['evm:base:8453']);
    expect(payload.settlementAddresses).toEqual({ 'evm:base:8453': '0xABC' });
    expect(payload.preferredTokens).toBeUndefined();
    expect(payload.ilpAddress).toBeUndefined();
  });

  it('without settlement info produces identical output to current behavior', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);

    // Decrypt as recipient
    const conversationKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload = JSON.parse(decrypted);

    // Assert - only requestId and timestamp, no settlement fields
    expect(Object.keys(payload)).toEqual(['requestId', 'timestamp']);
  });

  it('settlement fields are NIP-44 encrypted', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(generateSecretKey());

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey, settlementInfo);

    // Assert - content is encrypted, not plaintext JSON
    expect(() => JSON.parse(event.content)).toThrow();
    expect(event.content).not.toContain('supportedChains');
    expect(event.content).not.toContain('evm:base:8453');
  });

  it('signature verification passes with settlement fields present', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(generateSecretKey());

    // Act
    const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey, settlementInfo);
    const isValid = verifyEvent(event);

    // Assert
    expect(isValid).toBe(true);
  });
});

describe('buildSpspResponseEvent - settlement fields', () => {
  const testResponseWithSettlement: SpspResponse = {
    requestId: 'test-request-456',
    destinationAccount: 'g.example.receiver',
    sharedSecret: 'c2VjcmV0MTIz',
    negotiatedChain: 'evm:base:8453',
    settlementAddress: '0x1234567890abcdef1234567890abcdef12345678',
    tokenAddress: '0xAGENT_TOKEN',
    tokenNetworkAddress: '0xTOKEN_NETWORK',
    channelId: 'channel-abc-123',
    settlementTimeout: 3600,
  };

  it('serializes all settlement fields correctly', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const responderPubkey = getPublicKey(responderSecretKey);

    // Act
    const event = buildSpspResponseEvent(testResponseWithSettlement, senderPubkey, responderSecretKey);

    // Decrypt as sender
    const conversationKey = nip44.getConversationKey(senderSecretKey, responderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload: SpspResponse = JSON.parse(decrypted);

    // Assert
    expect(payload.negotiatedChain).toBe('evm:base:8453');
    expect(payload.settlementAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(payload.tokenAddress).toBe('0xAGENT_TOKEN');
    expect(payload.tokenNetworkAddress).toBe('0xTOKEN_NETWORK');
    expect(payload.channelId).toBe('channel-abc-123');
    expect(payload.settlementTimeout).toBe(3600);
  });

  it('with only negotiatedChain and settlementAddress serializes correctly', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const responderPubkey = getPublicKey(responderSecretKey);

    const partialResponse: SpspResponse = {
      requestId: 'test-request-789',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0MTIz',
      negotiatedChain: 'xrp:mainnet',
      settlementAddress: 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
    };

    // Act
    const event = buildSpspResponseEvent(partialResponse, senderPubkey, responderSecretKey);

    // Decrypt as sender
    const conversationKey = nip44.getConversationKey(senderSecretKey, responderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload: SpspResponse = JSON.parse(decrypted);

    // Assert
    expect(payload.negotiatedChain).toBe('xrp:mainnet');
    expect(payload.settlementAddress).toBe('rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit');
    expect(payload.tokenAddress).toBeUndefined();
    expect(payload.tokenNetworkAddress).toBeUndefined();
    expect(payload.channelId).toBeUndefined();
    expect(payload.settlementTimeout).toBeUndefined();
  });

  it('without settlement fields produces identical output to current behavior', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const responderPubkey = getPublicKey(responderSecretKey);

    const basicResponse: SpspResponse = {
      requestId: 'test-request-123',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0MTIz',
    };

    // Act
    const event = buildSpspResponseEvent(basicResponse, senderPubkey, responderSecretKey);

    // Decrypt as sender
    const conversationKey = nip44.getConversationKey(senderSecretKey, responderPubkey);
    const decrypted = nip44.decrypt(event.content, conversationKey);
    const payload = JSON.parse(decrypted);

    // Assert - only base fields
    expect(Object.keys(payload)).toEqual(['requestId', 'destinationAccount', 'sharedSecret']);
  });

  it('settlement fields are NIP-44 encrypted', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(generateSecretKey());

    // Act
    const event = buildSpspResponseEvent(testResponseWithSettlement, senderPubkey, responderSecretKey);

    // Assert - content is encrypted, not plaintext JSON
    expect(() => JSON.parse(event.content)).toThrow();
    expect(event.content).not.toContain('negotiatedChain');
    expect(event.content).not.toContain('evm:base:8453');
  });

  it('signature verification passes with settlement fields present', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(generateSecretKey());

    // Act
    const event = buildSpspResponseEvent(testResponseWithSettlement, senderPubkey, responderSecretKey);
    const isValid = verifyEvent(event);

    // Assert
    expect(isValid).toBe(true);
  });
});

describe('round-trip encryption tests - SPSP settlement', () => {
  it('SPSP request build → parse round-trip preserves settlement fields through NIP-44', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const settlementInfo = {
      ilpAddress: 'g.example.sender',
      supportedChains: ['evm:base:8453', 'xrp:mainnet'],
      settlementAddresses: {
        'evm:base:8453': '0x1234567890abcdef1234567890abcdef12345678',
        'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
      },
      preferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
    };

    // Act
    const { event, requestId } = buildSpspRequestEvent(recipientPubkey, senderSecretKey, settlementInfo);
    const parsed = parseSpspRequest(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(parsed.requestId).toBe(requestId);
    expect(parsed.ilpAddress).toBe('g.example.sender');
    expect(parsed.supportedChains).toEqual(['evm:base:8453', 'xrp:mainnet']);
    expect(parsed.settlementAddresses).toEqual(settlementInfo.settlementAddresses);
    expect(parsed.preferredTokens).toEqual({ 'evm:base:8453': '0xAGENT_TOKEN' });
  });

  it('SPSP response build → parse round-trip preserves settlement fields through NIP-44', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const responderPubkey = getPublicKey(responderSecretKey);

    const responseWithSettlement: SpspResponse = {
      requestId: 'test-request-456',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0MTIz',
      negotiatedChain: 'evm:base:8453',
      settlementAddress: '0x1234567890abcdef1234567890abcdef12345678',
      tokenAddress: '0xAGENT_TOKEN',
      tokenNetworkAddress: '0xTOKEN_NETWORK',
      channelId: 'channel-abc-123',
      settlementTimeout: 3600,
    };

    // Act
    const event = buildSpspResponseEvent(responseWithSettlement, senderPubkey, responderSecretKey);
    const parsed = parseSpspResponse(event, senderSecretKey, responderPubkey);

    // Assert
    expect(parsed).toEqual(responseWithSettlement);
  });

  it('SPSP request build → parse round-trip without settlement fields still works', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    // Act
    const { event, requestId } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);
    const parsed = parseSpspRequest(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(parsed.requestId).toBe(requestId);
    expect(typeof parsed.timestamp).toBe('number');
    expect(parsed.ilpAddress).toBeUndefined();
    expect(parsed.supportedChains).toBeUndefined();
    expect(parsed.settlementAddresses).toBeUndefined();
    expect(parsed.preferredTokens).toBeUndefined();
  });
});
