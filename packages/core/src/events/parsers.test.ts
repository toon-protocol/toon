import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { parseIlpPeerInfo, parseSpspRequest, parseSpspResponse, validateChainId } from './parsers.js';
import { buildIlpPeerInfoEvent, buildSpspRequestEvent, buildSpspResponseEvent } from './builders.js';
import { InvalidEventError } from '../errors.js';
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
    const event = createMockEvent(SPSP_REQUEST_KIND, JSON.stringify(createTestIlpPeerInfo()));

    // Act & Assert
    expect(() => parseIlpPeerInfo(event)).toThrow(InvalidEventError);
    expect(() => parseIlpPeerInfo(event)).toThrow(
      `Expected event kind ${ILP_PEER_INFO_KIND}, got ${SPSP_REQUEST_KIND}`
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
      preferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
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
    expect(result.preferredTokens).toEqual({ 'evm:base:8453': '0xAGENT_TOKEN' });
    expect(result.tokenNetworks).toEqual({ 'evm:base:8453': '0xTOKEN_NETWORK' });
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
    expect(() => parseIlpPeerInfo(event)).toThrow('supportedChains must be a non-empty array when provided');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('Invalid chain identifier: evm');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('supportedChains must be an array');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('settlementAddresses must be an object');
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
    expect(() => parseIlpPeerInfo(event)).toThrow('settlementAddresses values must be non-empty strings');
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
    expect(result.settlementAddresses).toEqual({ 'evm:base:8453': '0xADDRESS' });
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

// Helper to create encrypted SPSP response event
function createEncryptedSpspResponseEvent(
  payload: SpspResponse,
  senderSecretKey: Uint8Array,
  recipientPubkey: string
): NostrEvent {
  const senderPubkey = getPublicKey(senderSecretKey);
  const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
  const encryptedContent = nip44.encrypt(JSON.stringify(payload), conversationKey);

  return {
    id: '0'.repeat(64),
    pubkey: senderPubkey,
    kind: SPSP_RESPONSE_KIND,
    content: encryptedContent,
    tags: [['p', recipientPubkey]],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

describe('parseSpspResponse', () => {
  it('parses valid encrypted kind:23195 event', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload: SpspResponse = {
      requestId: 'test-request-123',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0MTIz',
    };

    const event = createEncryptedSpspResponseEvent(payload, senderSecretKey, recipientPubkey);

    // Act
    const result = parseSpspResponse(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.requestId).toBe('test-request-123');
    expect(result.destinationAccount).toBe('g.example.receiver');
    expect(result.sharedSecret).toBe('c2VjcmV0MTIz');
  });

  it('throws for wrong event kind', () => {
    // Arrange
    const recipientSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(generateSecretKey());
    const event = createMockEvent(ILP_PEER_INFO_KIND, 'encrypted-content');

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      `Expected event kind ${SPSP_RESPONSE_KIND}, got ${ILP_PEER_INFO_KIND}`
    );
  });

  it('throws for decryption failure', () => {
    // Arrange
    const recipientSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(generateSecretKey());

    // Create event with content encrypted for wrong recipient
    const event = createMockEvent(SPSP_RESPONSE_KIND, 'invalid-encrypted-content');

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'Failed to decrypt event content'
    );
  });

  it('throws for invalid JSON after decryption', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    // Encrypt invalid JSON
    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt('not valid json', conversationKey);

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_RESPONSE_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'Failed to parse decrypted content as JSON'
    );
  });

  it('throws for non-object JSON content', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt('"just a string"', conversationKey);

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_RESPONSE_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'Decrypted content must be a JSON object'
    );
  });

  it('throws for missing requestId', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        destinationAccount: 'g.example.receiver',
        sharedSecret: 'c2VjcmV0',
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_RESPONSE_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: requestId'
    );
  });

  it('throws for missing destinationAccount', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-123',
        sharedSecret: 'c2VjcmV0',
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_RESPONSE_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: destinationAccount'
    );
  });

  it('throws for missing sharedSecret', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-123',
        destinationAccount: 'g.example.receiver',
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_RESPONSE_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: sharedSecret'
    );
  });

  it('throws for empty requestId', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload = {
      requestId: '',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0',
    };
    const event = createEncryptedSpspResponseEvent(
      payload as SpspResponse,
      senderSecretKey,
      recipientPubkey
    );

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: requestId'
    );
  });
});

// Helper to create encrypted SPSP request event
function createEncryptedSpspRequestEvent(
  payload: SpspRequest,
  senderSecretKey: Uint8Array,
  recipientPubkey: string
): NostrEvent {
  const senderPubkey = getPublicKey(senderSecretKey);
  const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
  const encryptedContent = nip44.encrypt(JSON.stringify(payload), conversationKey);

  return {
    id: '0'.repeat(64),
    pubkey: senderPubkey,
    kind: SPSP_REQUEST_KIND,
    content: encryptedContent,
    tags: [['p', recipientPubkey]],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

describe('parseSpspRequest', () => {
  it('parses valid encrypted kind:23194 event', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload: SpspRequest = {
      requestId: 'test-request-123',
      timestamp: Math.floor(Date.now() / 1000),
    };

    const event = createEncryptedSpspRequestEvent(payload, senderSecretKey, recipientPubkey);

    // Act
    const result = parseSpspRequest(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.requestId).toBe('test-request-123');
    expect(result.timestamp).toBe(payload.timestamp);
  });

  it('parses event built with buildSpspRequestEvent', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const { event, requestId } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);

    // Act
    const result = parseSpspRequest(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.requestId).toBe(requestId);
    expect(typeof result.timestamp).toBe('number');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('throws for wrong event kind', () => {
    // Arrange
    const recipientSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(generateSecretKey());
    const event = createMockEvent(ILP_PEER_INFO_KIND, 'encrypted-content');

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      `Expected event kind ${SPSP_REQUEST_KIND}, got ${ILP_PEER_INFO_KIND}`
    );
  });

  it('throws for decryption failure', () => {
    // Arrange
    const recipientSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(generateSecretKey());

    // Create event with content encrypted for wrong recipient
    const event = createMockEvent(SPSP_REQUEST_KIND, 'invalid-encrypted-content');

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Failed to decrypt event content'
    );
  });

  it('throws for invalid JSON after decryption', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    // Encrypt invalid JSON
    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt('not valid json', conversationKey);

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Failed to parse decrypted content as JSON'
    );
  });

  it('throws for non-object JSON content', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt('"just a string"', conversationKey);

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Decrypted content must be a JSON object'
    );
  });

  it('throws for missing requestId', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: requestId'
    );
  });

  it('throws for empty requestId', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload = {
      requestId: '',
      timestamp: Math.floor(Date.now() / 1000),
    };
    const event = createEncryptedSpspRequestEvent(
      payload as SpspRequest,
      senderSecretKey,
      recipientPubkey
    );

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: requestId'
    );
  });

  it('throws for missing timestamp', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-123',
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: timestamp'
    );
  });

  it('throws for non-integer timestamp', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-123',
        timestamp: 123.456,
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: timestamp'
    );
  });

  it('throws for string timestamp', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-123',
        timestamp: '1234567890',
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: senderPubkey,
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Missing or invalid required field: timestamp'
    );
  });
});

describe('parseSpspRequest - settlement fields', () => {
  it('parses request with all settlement fields', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload: SpspRequest = {
      requestId: 'test-request-settle',
      timestamp: Math.floor(Date.now() / 1000),
      ilpAddress: 'g.example.sender',
      supportedChains: ['evm:base:8453', 'xrp:mainnet'],
      settlementAddresses: {
        'evm:base:8453': '0x1234567890abcdef1234567890abcdef12345678',
        'xrp:mainnet': 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
      },
      preferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
    };

    const event = createEncryptedSpspRequestEvent(payload, senderSecretKey, recipientPubkey);

    // Act
    const result = parseSpspRequest(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.ilpAddress).toBe('g.example.sender');
    expect(result.supportedChains).toEqual(['evm:base:8453', 'xrp:mainnet']);
    expect(result.settlementAddresses).toEqual(payload.settlementAddresses);
    expect(result.preferredTokens).toEqual({ 'evm:base:8453': '0xAGENT_TOKEN' });
  });

  it('parses request with only supportedChains and settlementAddresses', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload: SpspRequest = {
      requestId: 'test-request-partial',
      timestamp: Math.floor(Date.now() / 1000),
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0xABC' },
    };

    const event = createEncryptedSpspRequestEvent(payload, senderSecretKey, recipientPubkey);

    // Act
    const result = parseSpspRequest(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.supportedChains).toEqual(['evm:base:8453']);
    expect(result.settlementAddresses).toEqual({ 'evm:base:8453': '0xABC' });
    expect(result.ilpAddress).toBeUndefined();
    expect(result.preferredTokens).toBeUndefined();
  });

  it('backward compat — parses request without any settlement fields', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload: SpspRequest = {
      requestId: 'test-request-basic',
      timestamp: Math.floor(Date.now() / 1000),
    };

    const event = createEncryptedSpspRequestEvent(payload, senderSecretKey, recipientPubkey);

    // Act
    const result = parseSpspRequest(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.requestId).toBe('test-request-basic');
    expect(result.ilpAddress).toBeUndefined();
    expect(result.supportedChains).toBeUndefined();
    expect(result.settlementAddresses).toBeUndefined();
    expect(result.preferredTokens).toBeUndefined();
  });

  it('throws InvalidEventError for invalid chain ID in supportedChains', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload = {
      requestId: 'test-request',
      timestamp: Math.floor(Date.now() / 1000),
      supportedChains: ['evm'],
    };

    const event = createEncryptedSpspRequestEvent(payload as SpspRequest, senderSecretKey, recipientPubkey);

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'Invalid chain identifier in SPSP request: evm'
    );
  });

  it('throws InvalidEventError for non-array supportedChains', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-request',
        timestamp: Math.floor(Date.now() / 1000),
        supportedChains: 'evm:base:8453',
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: getPublicKey(senderSecretKey),
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [['p', recipientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'supportedChains must be an array'
    );
  });

  it('throws InvalidEventError for non-object settlementAddresses', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-request',
        timestamp: Math.floor(Date.now() / 1000),
        settlementAddresses: 'not-an-object',
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: getPublicKey(senderSecretKey),
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [['p', recipientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'settlementAddresses must be an object'
    );
  });

  it('throws InvalidEventError for settlementAddresses with non-string values', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-request',
        timestamp: Math.floor(Date.now() / 1000),
        settlementAddresses: { 'evm:base:8453': 123 },
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: getPublicKey(senderSecretKey),
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [['p', recipientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      'settlementAddresses values must be non-empty strings'
    );
  });

  it('round-trip (build with settlement → parse) preserves all settlement fields', () => {
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
    expect(parsed.supportedChains).toEqual(settlementInfo.supportedChains);
    expect(parsed.settlementAddresses).toEqual(settlementInfo.settlementAddresses);
    expect(parsed.preferredTokens).toEqual(settlementInfo.preferredTokens);
  });

  it('throws when settlementAddresses key is not in supportedChains', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-request',
        timestamp: Math.floor(Date.now() / 1000),
        supportedChains: ['evm:base:8453'],
        settlementAddresses: { 'xrp:mainnet': 'rSOME_ADDRESS' },
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: getPublicKey(senderSecretKey),
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [['p', recipientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspRequest(event, recipientSecretKey, senderPubkey)).toThrow(
      "settlementAddresses key 'xrp:mainnet' is not in supportedChains"
    );
  });
});

describe('parseSpspResponse - settlement fields', () => {
  it('parses response with all settlement fields', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload: SpspResponse = {
      requestId: 'test-request-settle',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0MTIz',
      negotiatedChain: 'evm:base:8453',
      settlementAddress: '0x1234567890abcdef1234567890abcdef12345678',
      tokenAddress: '0xAGENT_TOKEN',
      tokenNetworkAddress: '0xTOKEN_NETWORK',
      channelId: 'channel-abc-123',
      settlementTimeout: 3600,
    };

    const event = createEncryptedSpspResponseEvent(payload, senderSecretKey, recipientPubkey);

    // Act
    const result = parseSpspResponse(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.negotiatedChain).toBe('evm:base:8453');
    expect(result.settlementAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(result.tokenAddress).toBe('0xAGENT_TOKEN');
    expect(result.tokenNetworkAddress).toBe('0xTOKEN_NETWORK');
    expect(result.channelId).toBe('channel-abc-123');
    expect(result.settlementTimeout).toBe(3600);
  });

  it('parses response with only negotiatedChain and settlementAddress', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload: SpspResponse = {
      requestId: 'test-request-partial',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0MTIz',
      negotiatedChain: 'xrp:mainnet',
      settlementAddress: 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit',
    };

    const event = createEncryptedSpspResponseEvent(payload, senderSecretKey, recipientPubkey);

    // Act
    const result = parseSpspResponse(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.negotiatedChain).toBe('xrp:mainnet');
    expect(result.settlementAddress).toBe('rN7n3473SaZBCG4dFL83w7p1W9cgZw6dit');
    expect(result.tokenAddress).toBeUndefined();
    expect(result.tokenNetworkAddress).toBeUndefined();
    expect(result.channelId).toBeUndefined();
    expect(result.settlementTimeout).toBeUndefined();
  });

  it('backward compat — parses response without any settlement fields', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload: SpspResponse = {
      requestId: 'test-request-basic',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0MTIz',
    };

    const event = createEncryptedSpspResponseEvent(payload, senderSecretKey, recipientPubkey);

    // Act
    const result = parseSpspResponse(event, recipientSecretKey, senderPubkey);

    // Assert
    expect(result.requestId).toBe('test-request-basic');
    expect(result.negotiatedChain).toBeUndefined();
    expect(result.settlementAddress).toBeUndefined();
    expect(result.tokenAddress).toBeUndefined();
    expect(result.tokenNetworkAddress).toBeUndefined();
    expect(result.channelId).toBeUndefined();
    expect(result.settlementTimeout).toBeUndefined();
  });

  it('throws InvalidEventError for invalid negotiatedChain format', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const payload = {
      requestId: 'test-request',
      destinationAccount: 'g.example.receiver',
      sharedSecret: 'c2VjcmV0MTIz',
      negotiatedChain: 'invalid',
    };

    const event = createEncryptedSpspResponseEvent(payload as SpspResponse, senderSecretKey, recipientPubkey);

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'Invalid negotiatedChain: invalid'
    );
  });

  it('throws InvalidEventError for non-integer settlementTimeout', () => {
    // Arrange
    const senderSecretKey = generateSecretKey();
    const recipientSecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(recipientSecretKey);
    const senderPubkey = getPublicKey(senderSecretKey);

    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(
      JSON.stringify({
        requestId: 'test-request',
        destinationAccount: 'g.example.receiver',
        sharedSecret: 'c2VjcmV0MTIz',
        settlementTimeout: 3.14,
      }),
      conversationKey
    );

    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: getPublicKey(senderSecretKey),
      kind: SPSP_RESPONSE_KIND,
      content: encryptedContent,
      tags: [['p', recipientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act & Assert
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(InvalidEventError);
    expect(() => parseSpspResponse(event, recipientSecretKey, senderPubkey)).toThrow(
      'settlementTimeout must be a positive integer'
    );
  });

  it('round-trip (build with settlement → parse) preserves all settlement fields', () => {
    // Arrange
    const responderSecretKey = generateSecretKey();
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const responderPubkey = getPublicKey(responderSecretKey);

    const responseWithSettlement: SpspResponse = {
      requestId: 'test-request-rt',
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
});
