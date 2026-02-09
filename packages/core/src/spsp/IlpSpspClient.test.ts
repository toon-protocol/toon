/**
 * Tests for IlpSpspClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { IlpSpspClient } from './IlpSpspClient.js';
import { SpspError, SpspTimeoutError } from '../errors.js';
import { SPSP_RESPONSE_KIND } from '../constants.js';
import type { AgentRuntimeClient, IlpSendResult } from '../bootstrap/types.js';
import type { SpspResponse } from '../types.js';

/**
 * Helper: create a mock AgentRuntimeClient.
 */
function createMockAgentRuntimeClient(): AgentRuntimeClient & {
  sendIlpPacket: ReturnType<typeof vi.fn>;
} {
  return {
    sendIlpPacket: vi.fn(),
  };
}

/**
 * Helper: create an encrypted kind:23195 response event as TOON bytes (mocked).
 * In tests, toonDecoder will return the event directly, so we just need
 * the event to be valid for parseSpspResponse.
 */
function createResponseEvent(
  response: SpspResponse,
  responderSecretKey: Uint8Array,
  requesterPubkey: string
): NostrEvent {
  const responderPubkey = getPublicKey(responderSecretKey);
  const conversationKey = nip44.getConversationKey(responderSecretKey, requesterPubkey);
  const encryptedContent = nip44.encrypt(JSON.stringify(response), conversationKey);

  return {
    id: 'response-event-id',
    pubkey: responderPubkey,
    kind: SPSP_RESPONSE_KIND,
    content: encryptedContent,
    tags: [['p', requesterPubkey]],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

describe('IlpSpspClient', () => {
  let mockClient: ReturnType<typeof createMockAgentRuntimeClient>;
  let senderSecretKey: Uint8Array;
  let senderPubkey: string;
  let recipientSecretKey: Uint8Array;
  let recipientPubkey: string;
  let mockToonEncoder: ReturnType<typeof vi.fn>;
  let mockToonDecoder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockAgentRuntimeClient();
    senderSecretKey = generateSecretKey();
    senderPubkey = getPublicKey(senderSecretKey);
    recipientSecretKey = generateSecretKey();
    recipientPubkey = getPublicKey(recipientSecretKey);
    mockToonEncoder = vi.fn((event: NostrEvent) =>
      new TextEncoder().encode(JSON.stringify(event))
    );
    mockToonDecoder = vi.fn((bytes: Uint8Array) =>
      JSON.parse(new TextDecoder().decode(bytes)) as NostrEvent
    );
  });

  /**
   * Helper: set up mockClient to return a FULFILL with a valid SPSP response.
   */
  function setupFulfillResponse(
    response: SpspResponse,
    responderSecretKey: Uint8Array,
    requesterPubkey: string
  ): void {
    const responseEvent = createResponseEvent(response, responderSecretKey, requesterPubkey);
    const responseBytes = new TextEncoder().encode(JSON.stringify(responseEvent));
    const responseBase64 = Buffer.from(responseBytes).toString('base64');

    mockClient.sendIlpPacket.mockResolvedValue({
      accepted: true,
      fulfillment: 'mock-fulfillment',
      data: responseBase64,
    } satisfies IlpSendResult);
  }

  // --- Constructor tests ---
  describe('constructor', () => {
    it('creates instance with required parameters', () => {
      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });
      expect(client).toBeInstanceOf(IlpSpspClient);
    });

    it('throws if toonEncoder not provided', () => {
      expect(
        () =>
          new IlpSpspClient(mockClient, senderSecretKey, {
            toonEncoder: undefined as unknown as (event: NostrEvent) => Uint8Array,
            toonDecoder: mockToonDecoder,
          })
      ).toThrow(SpspError);
      expect(
        () =>
          new IlpSpspClient(mockClient, senderSecretKey, {
            toonEncoder: undefined as unknown as (event: NostrEvent) => Uint8Array,
            toonDecoder: mockToonDecoder,
          })
      ).toThrow('toonEncoder is required');
    });

    it('throws if toonDecoder not provided', () => {
      expect(
        () =>
          new IlpSpspClient(mockClient, senderSecretKey, {
            toonEncoder: mockToonEncoder,
            toonDecoder: undefined as unknown as (bytes: Uint8Array) => NostrEvent,
          })
      ).toThrow(SpspError);
      expect(
        () =>
          new IlpSpspClient(mockClient, senderSecretKey, {
            toonEncoder: mockToonEncoder,
            toonDecoder: undefined as unknown as (bytes: Uint8Array) => NostrEvent,
          })
      ).toThrow('toonDecoder is required');
    });
  });

  // --- TOON encoding tests ---
  describe('TOON encoding', () => {
    it('SPSP request event is TOON-encoded before sending', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(mockToonEncoder).toHaveBeenCalledTimes(1);
    });

    it('toonEncoder is called with the built kind:23194 event', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      const encodedEvent = mockToonEncoder.mock.calls[0][0] as NostrEvent;
      expect(encodedEvent.kind).toBe(23194);
    });

    it('base64 encoding of TOON bytes is correct', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      // Verify the data sent to sendIlpPacket is valid base64
      const sentData = mockClient.sendIlpPacket.mock.calls[0][0].data as string;
      expect(() => Buffer.from(sentData, 'base64')).not.toThrow();
      // Verify it decodes to the TOON-encoded event bytes
      const decoded = Buffer.from(sentData, 'base64');
      const toonOutput = mockToonEncoder.mock.results[0].value as Uint8Array;
      expect(Buffer.from(decoded).equals(Buffer.from(toonOutput))).toBe(true);
    });
  });

  // --- ILP send tests ---
  describe('ILP send', () => {
    it('sends ILP packet via agentRuntimeClient.sendIlpPacket()', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(mockClient.sendIlpPacket).toHaveBeenCalled();
    });

    it('destination is set to peer ILP address', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(mockClient.sendIlpPacket.mock.calls[0][0].destination).toBe('g.peer1');
    });

    it('amount defaults to "0" when not specified', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(mockClient.sendIlpPacket.mock.calls[0][0].amount).toBe('0');
    });

    it('amount is set to provided value for paid handshakes', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1', { amount: '1000' });

      expect(mockClient.sendIlpPacket.mock.calls[0][0].amount).toBe('1000');
    });

    it('timeout is passed through to sendIlpPacket', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1', { timeout: 60000 });

      expect(mockClient.sendIlpPacket.mock.calls[0][0].timeout).toBe(60000);
    });
  });

  // --- Response parsing tests ---
  describe('response parsing', () => {
    it('FULFILL data decoded as SpspResponse (base64 -> TOON -> Nostr -> parseSpspResponse)', async () => {
      const response: SpspResponse = {
        requestId: 'test-req-id',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      const result = await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(mockToonDecoder).toHaveBeenCalledTimes(1);
      expect(result.destinationAccount).toBe('g.test.receiver');
      expect(result.sharedSecret).toBe('c2VjcmV0');
    });

    it('returns SpspInfo with destinationAccount and sharedSecret', async () => {
      const response: SpspResponse = {
        requestId: 'test-req-id',
        destinationAccount: 'g.alice.spsp.payment123',
        sharedSecret: 'YWxpY2Utc2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      const result = await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(result.destinationAccount).toBe('g.alice.spsp.payment123');
      expect(result.sharedSecret).toBe('YWxpY2Utc2VjcmV0');
    });

    it('returns settlement fields when present in response', async () => {
      const response: SpspResponse = {
        requestId: 'test-req-id',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
        negotiatedChain: 'evm:base:8453',
        settlementAddress: '0xSERVER_ADDR',
        tokenAddress: '0xTOKEN',
        tokenNetworkAddress: '0xTOKEN_NET',
        channelId: '0xCHANNEL',
        settlementTimeout: 86400,
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      const result = await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(result.settlement).toBeDefined();
      expect(result.settlement?.negotiatedChain).toBe('evm:base:8453');
      expect(result.settlement?.settlementAddress).toBe('0xSERVER_ADDR');
      expect(result.settlement?.tokenAddress).toBe('0xTOKEN');
      expect(result.settlement?.tokenNetworkAddress).toBe('0xTOKEN_NET');
      expect(result.settlement?.channelId).toBe('0xCHANNEL');
      expect(result.settlement?.settlementTimeout).toBe(86400);
    });

    it('returns no settlement when response lacks settlement fields', async () => {
      const response: SpspResponse = {
        requestId: 'test-req-id',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      const result = await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(result.settlement).toBeUndefined();
    });

    it('malformed TOON response data throws SpspError', async () => {
      mockClient.sendIlpPacket.mockResolvedValue({
        accepted: true,
        fulfillment: 'mock-fulfillment',
        data: Buffer.from('garbage-data').toString('base64'),
      } satisfies IlpSendResult);

      // Make toonDecoder throw on garbage input
      mockToonDecoder.mockImplementation(() => {
        throw new Error('Invalid TOON data');
      });

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await expect(
        client.requestSpspInfo(recipientPubkey, 'g.peer1')
      ).rejects.toThrow(SpspError);
      await expect(
        client.requestSpspInfo(recipientPubkey, 'g.peer1')
      ).rejects.toThrow('Failed to decode TOON response data');
    });
  });

  // --- REJECT handling tests ---
  describe('REJECT handling', () => {
    it('REJECT response throws SpspError with code and message', async () => {
      mockClient.sendIlpPacket.mockResolvedValue({
        accepted: false,
        code: 'F06',
        message: 'Insufficient amount',
      } satisfies IlpSendResult);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await expect(
        client.requestSpspInfo(recipientPubkey, 'g.peer1')
      ).rejects.toThrow(SpspError);
      await expect(
        client.requestSpspInfo(recipientPubkey, 'g.peer1')
      ).rejects.toThrow('F06');
    });

    it('no retry on explicit REJECT', async () => {
      mockClient.sendIlpPacket.mockResolvedValue({
        accepted: false,
        code: 'F00',
        message: 'Bad request',
      } satisfies IlpSendResult);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await expect(
        client.requestSpspInfo(recipientPubkey, 'g.peer1')
      ).rejects.toThrow(SpspError);

      // Should only have been called once (no retry)
      expect(mockClient.sendIlpPacket).toHaveBeenCalledTimes(1);
    });
  });

  // --- Timeout and retry tests ---
  describe('timeout and retry', () => {
    it('default timeout is 30000ms', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(mockClient.sendIlpPacket.mock.calls[0][0].timeout).toBe(30000);
    });

    it('custom timeout is passed through', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await client.requestSpspInfo(recipientPubkey, 'g.peer1', { timeout: 5000 });

      expect(mockClient.sendIlpPacket.mock.calls[0][0].timeout).toBe(5000);
    });

    it('retries once on network/timeout error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      // First call: network error. Second call: success.
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      const responseEvent = createResponseEvent(response, recipientSecretKey, senderPubkey);
      const responseBytes = new TextEncoder().encode(JSON.stringify(responseEvent));
      const responseBase64 = Buffer.from(responseBytes).toString('base64');

      mockClient.sendIlpPacket
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({
          accepted: true,
          fulfillment: 'mock-fulfillment',
          data: responseBase64,
        } satisfies IlpSendResult);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      const result = await client.requestSpspInfo(recipientPubkey, 'g.peer1');

      expect(mockClient.sendIlpPacket).toHaveBeenCalledTimes(2);
      expect(result.destinationAccount).toBe('g.test.receiver');
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('throws SpspTimeoutError after retry failure', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      mockClient.sendIlpPacket
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout again'));

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await expect(
        client.requestSpspInfo(recipientPubkey, 'g.peer1')
      ).rejects.toThrow(SpspTimeoutError);

      expect(mockClient.sendIlpPacket).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
    });

    it('does not retry on explicit REJECT', async () => {
      mockClient.sendIlpPacket.mockResolvedValue({
        accepted: false,
        code: 'F06',
        message: 'Insufficient amount',
      } satisfies IlpSendResult);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await expect(
        client.requestSpspInfo(recipientPubkey, 'g.peer1')
      ).rejects.toThrow(SpspError);

      expect(mockClient.sendIlpPacket).toHaveBeenCalledTimes(1);
    });
  });

  // --- Validation tests ---
  describe('validation', () => {
    it('throws SpspError for invalid recipientPubkey format', async () => {
      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      await expect(
        client.requestSpspInfo('invalid-pubkey', 'g.peer1')
      ).rejects.toThrow(SpspError);
      await expect(
        client.requestSpspInfo('invalid-pubkey', 'g.peer1')
      ).rejects.toThrow('Invalid recipientPubkey format');
    });

    it('passes settlementInfo to buildSpspRequestEvent', async () => {
      const response: SpspResponse = {
        requestId: 'any',
        destinationAccount: 'g.test.receiver',
        sharedSecret: 'c2VjcmV0',
      };
      setupFulfillResponse(response, recipientSecretKey, senderPubkey);

      const client = new IlpSpspClient(mockClient, senderSecretKey, {
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
      });

      const settlementInfo = {
        supportedChains: ['evm:base:8453'],
        settlementAddresses: { 'evm:base:8453': '0xMY_ADDR' },
      };

      await client.requestSpspInfo(recipientPubkey, 'g.peer1', { settlementInfo });

      // Verify the TOON-encoded event contains settlement info by decrypting
      const encodedEvent = mockToonEncoder.mock.calls[0][0] as NostrEvent;
      const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
      const decrypted = nip44.decrypt(encodedEvent.content, convKey);
      const request = JSON.parse(decrypted);

      expect(request.supportedChains).toEqual(['evm:base:8453']);
      expect(request.settlementAddresses).toEqual({ 'evm:base:8453': '0xMY_ADDR' });
    });
  });
});
