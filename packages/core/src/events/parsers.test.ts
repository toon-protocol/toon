import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { parseIlpPeerInfo, parseSpspRequest, parseSpspResponse } from './parsers.js';
import { buildIlpPeerInfoEvent, buildSpspRequestEvent } from './builders.js';
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
