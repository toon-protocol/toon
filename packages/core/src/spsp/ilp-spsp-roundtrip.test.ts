/**
 * Integration test: TOON + NIP-44 round-trip for SPSP handshakes.
 *
 * Verifies that the full encode → send → receive → decode cycle
 * preserves NIP-44 encrypted content and settlement fields intact.
 */

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';
import { buildSpspRequestEvent, buildSpspResponseEvent } from '../events/builders.js';
import { parseSpspRequest, parseSpspResponse } from '../events/parsers.js';

describe('TOON + NIP-44 SPSP round-trip', () => {
  it('SPSP request with settlement survives TOON + NIP-44 round-trip', () => {
    // 1. Generate sender and receiver keypairs
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const receiverSecretKey = generateSecretKey();
    const receiverPubkey = getPublicKey(receiverSecretKey);

    // 2. Build kind:23194 event with settlement fields
    const settlementInfo = {
      supportedChains: ['evm:base:8453', 'xrp:mainnet'],
      settlementAddresses: { 'evm:base:8453': '0xSENDER_ADDR' },
      preferredTokens: { 'evm:base:8453': '0xTOKEN' },
    };

    const { event, requestId } = buildSpspRequestEvent(
      receiverPubkey,
      senderSecretKey,
      settlementInfo
    );

    // 3. TOON-encode the event
    const toonBytes = encodeEventToToon(event);

    // 4. Simulate ILP transport — base64 encode
    const base64 = Buffer.from(toonBytes).toString('base64');

    // 5. Simulate BLS receive — base64 decode
    const decoded = Buffer.from(base64, 'base64');

    // 6. TOON-decode
    const decodedEvent = decodeEventFromToon(new Uint8Array(decoded));

    // 7. Verify kind
    expect(decodedEvent.kind).toBe(23194);

    // 8. Verify NIP-44 ciphertext preserved byte-for-byte
    expect(decodedEvent.content).toBe(event.content);

    // 9. Parse and decrypt
    const parsed = parseSpspRequest(decodedEvent, receiverSecretKey, senderPubkey);

    // 10. Verify all settlement fields match original input
    expect(parsed.requestId).toBe(requestId);
    expect(parsed.supportedChains).toEqual(['evm:base:8453', 'xrp:mainnet']);
    expect(parsed.settlementAddresses).toEqual({ 'evm:base:8453': '0xSENDER_ADDR' });
    expect(parsed.preferredTokens).toEqual({ 'evm:base:8453': '0xTOKEN' });
  });

  it('SPSP response with settlement survives TOON + NIP-44 round-trip', () => {
    // 1. Generate responder and requester keypairs
    const responderSecretKey = generateSecretKey();
    const responderPubkey = getPublicKey(responderSecretKey);
    const requesterSecretKey = generateSecretKey();
    const requesterPubkey = getPublicKey(requesterSecretKey);

    // 2. Build kind:23195 event with settlement fields
    const response = {
      requestId: 'test-request-id',
      destinationAccount: 'g.responder.test',
      sharedSecret: Buffer.from('test-shared-secret').toString('base64'),
      negotiatedChain: 'evm:base:8453',
      settlementAddress: '0xRESPONDER_ADDR',
      tokenAddress: '0xTOKEN',
      tokenNetworkAddress: '0xTOKEN_NETWORK',
      channelId: '0xCHANNEL_123',
      settlementTimeout: 86400,
    };

    const event = buildSpspResponseEvent(
      response,
      requesterPubkey,
      responderSecretKey
    );

    // 3. TOON-encode → base64 encode → base64 decode → TOON-decode
    const toonBytes = encodeEventToToon(event);
    const base64 = Buffer.from(toonBytes).toString('base64');
    const decoded = Buffer.from(base64, 'base64');
    const decodedEvent = decodeEventFromToon(new Uint8Array(decoded));

    // 4. Verify NIP-44 ciphertext preserved byte-for-byte
    expect(decodedEvent.content).toBe(event.content);

    // 5. Parse and decrypt
    const parsed = parseSpspResponse(decodedEvent, requesterSecretKey, responderPubkey);

    // 6. Verify required fields
    expect(parsed.requestId).toBe('test-request-id');
    expect(parsed.destinationAccount).toBe('g.responder.test');
    expect(parsed.sharedSecret).toBe(Buffer.from('test-shared-secret').toString('base64'));

    // 7. Verify all settlement fields match original input
    expect(parsed.negotiatedChain).toBe('evm:base:8453');
    expect(parsed.settlementAddress).toBe('0xRESPONDER_ADDR');
    expect(parsed.tokenAddress).toBe('0xTOKEN');
    expect(parsed.tokenNetworkAddress).toBe('0xTOKEN_NETWORK');
    expect(parsed.channelId).toBe('0xCHANNEL_123');
    expect(parsed.settlementTimeout).toBe(86400);
  });

  it('TOON encoding preserves NIP-44 ciphertext byte-for-byte', () => {
    // 1. Create a kind:23194 event with NIP-44 encrypted content
    const senderSecretKey = generateSecretKey();
    const receiverSecretKey = generateSecretKey();
    const receiverPubkey = getPublicKey(receiverSecretKey);

    const { event: originalEvent } = buildSpspRequestEvent(
      receiverPubkey,
      senderSecretKey
    );

    // 2. Record the exact content string (ciphertext)
    const originalContent = originalEvent.content;

    // 3. TOON-encode → TOON-decode
    const toonBytes = encodeEventToToon(originalEvent);
    const decodedEvent = decodeEventFromToon(toonBytes);

    // 4. Assert strict equality (catches any base64 ciphertext mangling)
    expect(decodedEvent.content).toBe(originalContent);
  });

  it('Basic SPSP request/response without settlement survives round-trip', () => {
    // 1. Generate keypairs
    const senderSecretKey = generateSecretKey();
    const senderPubkey = getPublicKey(senderSecretKey);
    const receiverSecretKey = generateSecretKey();
    const receiverPubkey = getPublicKey(receiverSecretKey);

    // 2. Build kind:23194 with no settlement (omit 3rd arg)
    const { event: requestEvent, requestId } = buildSpspRequestEvent(
      receiverPubkey,
      senderSecretKey
    );

    // 3. TOON-encode → base64 → base64 decode → TOON-decode
    const reqToonBytes = encodeEventToToon(requestEvent);
    const reqBase64 = Buffer.from(reqToonBytes).toString('base64');
    const reqDecoded = Buffer.from(reqBase64, 'base64');
    const decodedRequestEvent = decodeEventFromToon(new Uint8Array(reqDecoded));

    // 4. Parse request
    const parsedRequest = parseSpspRequest(
      decodedRequestEvent,
      receiverSecretKey,
      senderPubkey
    );

    // 5. Verify requestId and timestamp preserved, no settlement fields
    expect(parsedRequest.requestId).toBe(requestId);
    expect(typeof parsedRequest.timestamp).toBe('number');
    expect(parsedRequest.supportedChains).toBeUndefined();
    expect(parsedRequest.settlementAddresses).toBeUndefined();
    expect(parsedRequest.preferredTokens).toBeUndefined();

    // 6. Build kind:23195 with only required fields
    const responsePayload = {
      requestId: 'test-id',
      destinationAccount: 'g.test.receiver',
      sharedSecret: Buffer.from('basic-secret').toString('base64'),
    };

    const responseEvent = buildSpspResponseEvent(
      responsePayload,
      senderPubkey,
      receiverSecretKey
    );

    // 7. TOON-encode → base64 → base64 decode → TOON-decode
    const resToonBytes = encodeEventToToon(responseEvent);
    const resBase64 = Buffer.from(resToonBytes).toString('base64');
    const resDecoded = Buffer.from(resBase64, 'base64');
    const decodedResponseEvent = decodeEventFromToon(new Uint8Array(resDecoded));

    // 8. Parse response
    const parsedResponse = parseSpspResponse(
      decodedResponseEvent,
      senderSecretKey,
      receiverPubkey
    );

    // 9. Verify required fields preserved, no settlement fields
    expect(parsedResponse.requestId).toBe('test-id');
    expect(parsedResponse.destinationAccount).toBe('g.test.receiver');
    expect(parsedResponse.sharedSecret).toBe(
      Buffer.from('basic-secret').toString('base64')
    );
    expect(parsedResponse.negotiatedChain).toBeUndefined();
    expect(parsedResponse.settlementAddress).toBeUndefined();
    expect(parsedResponse.tokenAddress).toBeUndefined();
    expect(parsedResponse.tokenNetworkAddress).toBeUndefined();
    expect(parsedResponse.channelId).toBeUndefined();
    expect(parsedResponse.settlementTimeout).toBeUndefined();
  });
});
