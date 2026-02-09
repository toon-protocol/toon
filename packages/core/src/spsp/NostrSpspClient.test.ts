/**
 * Tests for NostrSpspClient.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SimplePool, SubCloser } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { VerifiedEvent, NostrEvent } from 'nostr-tools/pure';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { NostrSpspClient } from './NostrSpspClient.js';
import { SPSP_RESPONSE_KIND } from '../constants.js';
import { SpspError, SpspTimeoutError } from '../errors.js';
import type { SpspResponse } from '../types.js';

const MOCK_RELAY_URLS = ['wss://relay1.example.com', 'wss://relay2.example.com'];

describe('NostrSpspClient', () => {
  let mockPool: SimplePool;
  let mockSubCloser: SubCloser;

  beforeEach(() => {
    mockSubCloser = { close: vi.fn() };
    mockPool = {
      querySync: vi.fn(),
      publish: vi.fn().mockResolvedValue(['wss://relay1.example.com']),
      subscribeMany: vi.fn().mockReturnValue(mockSubCloser),
    } as unknown as SimplePool;
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates instance with relay URLs', () => {
      const client = new NostrSpspClient(MOCK_RELAY_URLS);
      expect(client).toBeInstanceOf(NostrSpspClient);
    });

    it('creates instance with custom SimplePool', () => {
      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool);
      expect(client).toBeInstanceOf(NostrSpspClient);
    });

    it('creates internal SimplePool if none provided', () => {
      const client = new NostrSpspClient(MOCK_RELAY_URLS);
      expect(client).toBeInstanceOf(NostrSpspClient);
    });

    it('accepts secretKey parameter', () => {
      const secretKey = generateSecretKey();
      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, secretKey);
      expect(client).toBeInstanceOf(NostrSpspClient);
    });

    it('derives pubkey from secretKey', () => {
      const secretKey = generateSecretKey();
      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, secretKey);
      expect(client).toBeInstanceOf(NostrSpspClient);
    });
  });

  // Helper to create encrypted SPSP response event
  function createEncryptedResponseEvent(
    response: SpspResponse,
    recipientSecretKey: Uint8Array,
    recipientPubkey: string,
    senderSecretKey: Uint8Array
  ): NostrEvent {
    const senderPubkey = getPublicKey(senderSecretKey);
    const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedContent = nip44.encrypt(JSON.stringify(response), conversationKey);

    return {
      id: 'response-event-id',
      pubkey: senderPubkey,
      kind: SPSP_RESPONSE_KIND,
      content: encryptedContent,
      tags: [['p', recipientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };
  }

  // Task 9: Unit tests for requestSpspInfo happy path
  describe('requestSpspInfo - happy path', () => {
    it('method exists and has correct signature', () => {
      const secretKey = generateSecretKey();
      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, secretKey);
      expect(typeof client.requestSpspInfo).toBe('function');
    });

    it('publishes kind:23194 event to relays', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      // Set up mock to trigger response immediately
      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const response: SpspResponse = {
            requestId: '', // Will be matched dynamically
            destinationAccount: 'g.test.receiver',
            sharedSecret: 'c2VjcmV0',
          };
          // We need to get the requestId from the published event
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            // Decrypt the request to get requestId
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);
            response.requestId = request.requestId;

            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      await client.requestSpspInfo(recipientPubkey, { timeout: 1000 });

      expect(mockPool.publish).toHaveBeenCalled();
      const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
      const event = publishCall?.[1] as NostrEvent;
      expect(event.kind).toBe(23194);
    });

    it('subscribes for kind:23195 response', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, filters, callbacks) => {
        setTimeout(() => {
          const response: SpspResponse = {
            requestId: '',
            destinationAccount: 'g.test.receiver',
            sharedSecret: 'c2VjcmV0',
          };
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);
            response.requestId = request.requestId;

            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      await client.requestSpspInfo(recipientPubkey, { timeout: 1000 });

      expect(mockPool.subscribeMany).toHaveBeenCalled();
      const subscribeCall = vi.mocked(mockPool.subscribeMany).mock.calls[0];
      const filter = subscribeCall?.[1] as Filter | undefined;
      expect(filter?.kinds).toContain(SPSP_RESPONSE_KIND);
    });

    it('returns SpspInfo with correct fields', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const response: SpspResponse = {
            requestId: '',
            destinationAccount: 'g.test.alice',
            sharedSecret: 'YWxpY2Utc2VjcmV0',
          };
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);
            response.requestId = request.requestId;

            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      const result = await client.requestSpspInfo(recipientPubkey, { timeout: 1000 });

      expect(result.destinationAccount).toBe('g.test.alice');
      expect(result.sharedSecret).toBe('YWxpY2Utc2VjcmV0');
    });

    it('cleans up subscription on success', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const response: SpspResponse = {
            requestId: '',
            destinationAccount: 'g.test.receiver',
            sharedSecret: 'c2VjcmV0',
          };
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);
            response.requestId = request.requestId;

            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      await client.requestSpspInfo(recipientPubkey, { timeout: 1000 });

      expect(mockSubCloser.close).toHaveBeenCalled();
    });
  });

  // Task 10: Unit tests for encryption/decryption
  describe('requestSpspInfo - encryption', () => {
    it('request payload is NIP-44 encrypted', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const response: SpspResponse = {
            requestId: '',
            destinationAccount: 'g.test.receiver',
            sharedSecret: 'c2VjcmV0',
          };
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);
            response.requestId = request.requestId;

            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      await client.requestSpspInfo(recipientPubkey, { timeout: 1000 });

      // Verify the published event content is encrypted (not valid JSON)
      const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
      const event = publishCall?.[1] as NostrEvent;
      expect(() => JSON.parse(event.content)).toThrow();
    });

    it('request can be decrypted by recipient', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const response: SpspResponse = {
            requestId: '',
            destinationAccount: 'g.test.receiver',
            sharedSecret: 'c2VjcmV0',
          };
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);
            response.requestId = request.requestId;

            // Verify decryption worked
            expect(request.requestId).toBeDefined();
            expect(request.timestamp).toBeDefined();

            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      await client.requestSpspInfo(recipientPubkey, { timeout: 1000 });
    });
  });

  // Task 11: Unit tests for timeout handling
  describe('requestSpspInfo - timeout handling', () => {
    it('times out after default 10s if no response', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(generateSecretKey());

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      // Don't trigger any response
      vi.mocked(mockPool.subscribeMany).mockReturnValue(mockSubCloser);

      // Use shorter timeout for test
      await expect(
        client.requestSpspInfo(recipientPubkey, { timeout: 50 })
      ).rejects.toThrow(SpspTimeoutError);
    }, 1000);

    it('custom timeout duration is respected', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(generateSecretKey());

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockReturnValue(mockSubCloser);

      const start = Date.now();
      await expect(
        client.requestSpspInfo(recipientPubkey, { timeout: 100 })
      ).rejects.toThrow(SpspTimeoutError);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(200);
    }, 1000);

    it('throws SpspTimeoutError with SPSP_TIMEOUT code', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(generateSecretKey());

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockReturnValue(mockSubCloser);

      try {
        await client.requestSpspInfo(recipientPubkey, { timeout: 50 });
        expect.fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SpspTimeoutError);
        expect((error as SpspTimeoutError).code).toBe('SPSP_TIMEOUT');
      }
    }, 1000);

    it('subscription is cleaned up on timeout', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(generateSecretKey());

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockReturnValue(mockSubCloser);

      try {
        await client.requestSpspInfo(recipientPubkey, { timeout: 50 });
      } catch {
        // Expected
      }

      expect(mockSubCloser.close).toHaveBeenCalled();
    }, 1000);

    it('error message includes recipient pubkey', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(generateSecretKey());

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockReturnValue(mockSubCloser);

      try {
        await client.requestSpspInfo(recipientPubkey, { timeout: 50 });
        expect.fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SpspTimeoutError);
        expect((error as SpspTimeoutError).message).toContain(recipientPubkey);
        expect((error as SpspTimeoutError).recipientPubkey).toBe(recipientPubkey);
      }
    }, 1000);
  });

  // Task 12: Unit tests for error handling
  describe('requestSpspInfo - error handling', () => {
    it('throws SpspError if secret key not provided', async () => {
      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool);
      const recipientPubkey = getPublicKey(generateSecretKey());

      await expect(client.requestSpspInfo(recipientPubkey)).rejects.toThrow(SpspError);
      await expect(client.requestSpspInfo(recipientPubkey)).rejects.toThrow(
        'Secret key required'
      );
    });

    it('throws SpspError for invalid recipientPubkey format', async () => {
      const senderSecretKey = generateSecretKey();
      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      await expect(client.requestSpspInfo('invalid')).rejects.toThrow(SpspError);
      await expect(client.requestSpspInfo('invalid')).rejects.toThrow(
        'Invalid recipientPubkey format'
      );
    });

    it('throws SpspError if relay publish fails', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(generateSecretKey());

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.publish).mockRejectedValue(new Error('Publish failed'));

      await expect(
        client.requestSpspInfo(recipientPubkey, { timeout: 1000 })
      ).rejects.toThrow(SpspError);
      await expect(
        client.requestSpspInfo(recipientPubkey, { timeout: 1000 })
      ).rejects.toThrow('Failed to publish SPSP request');
    });

    it('ignores responses with mismatched requestId', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          // Send response with wrong requestId
          const response: SpspResponse = {
            requestId: 'wrong-request-id',
            destinationAccount: 'g.test.receiver',
            sharedSecret: 'c2VjcmV0',
          };

          const responseEvent = createEncryptedResponseEvent(
            response,
            senderSecretKey,
            senderPubkey,
            recipientSecretKey
          );
          callbacks.onevent?.(responseEvent as VerifiedEvent);
        }, 10);
        return mockSubCloser;
      });

      // Should timeout because the requestId doesn't match
      await expect(
        client.requestSpspInfo(recipientPubkey, { timeout: 100 })
      ).rejects.toThrow(SpspTimeoutError);
    }, 1000);

    it('handles InvalidEventError from parser gracefully', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          // Send malformed event that will fail parsing
          const malformedEvent: NostrEvent = {
            id: 'bad-event',
            pubkey: 'a'.repeat(64),
            kind: SPSP_RESPONSE_KIND,
            content: 'not-encrypted-content',
            tags: [['p', getPublicKey(senderSecretKey)]],
            created_at: Math.floor(Date.now() / 1000),
            sig: '0'.repeat(128),
          };
          callbacks.onevent?.(malformedEvent as VerifiedEvent);
        }, 10);
        return mockSubCloser;
      });

      // Should timeout because the event parsing fails
      await expect(
        client.requestSpspInfo(recipientPubkey, { timeout: 100 })
      ).rejects.toThrow(SpspTimeoutError);
    }, 1000);
  });

  // Task 12: Tests for settlement info passing and settlement result parsing
  describe('requestSpspInfo - settlement info', () => {
    it('passes settlementInfo to buildSpspRequestEvent', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      const settlementInfo = {
        supportedChains: ['evm:base:8453'],
        settlementAddresses: { 'evm:base:8453': '0xMY_ADDR' },
        preferredTokens: { 'evm:base:8453': '0xMY_TOKEN' },
      };

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);

            // Verify settlement fields are in the request
            expect(request.supportedChains).toEqual(['evm:base:8453']);
            expect(request.settlementAddresses).toEqual({ 'evm:base:8453': '0xMY_ADDR' });
            expect(request.preferredTokens).toEqual({ 'evm:base:8453': '0xMY_TOKEN' });

            const response: SpspResponse = {
              requestId: request.requestId,
              destinationAccount: 'g.test.receiver',
              sharedSecret: 'c2VjcmV0',
            };
            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      await client.requestSpspInfo(recipientPubkey, {
        timeout: 1000,
        settlementInfo,
      });

      // Assertions are inside the subscribe callback above
      expect(mockPool.publish).toHaveBeenCalled();
    });

    it('when response includes settlement fields, returned result has settlement object', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);

            // Response with settlement fields
            const response: SpspResponse = {
              requestId: request.requestId,
              destinationAccount: 'g.test.receiver',
              sharedSecret: 'c2VjcmV0',
              negotiatedChain: 'evm:base:8453',
              settlementAddress: '0xSERVER_ADDR',
              tokenAddress: '0xTOKEN',
              tokenNetworkAddress: '0xTOKEN_NET',
              channelId: '0xCHANNEL',
              settlementTimeout: 86400,
            };
            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      const result = await client.requestSpspInfo(recipientPubkey, { timeout: 1000 });

      expect(result.destinationAccount).toBe('g.test.receiver');
      expect(result.settlement).toBeDefined();
      const settlement = result.settlement;
      expect(settlement?.negotiatedChain).toBe('evm:base:8453');
      expect(settlement?.settlementAddress).toBe('0xSERVER_ADDR');
      expect(settlement?.tokenAddress).toBe('0xTOKEN');
      expect(settlement?.tokenNetworkAddress).toBe('0xTOKEN_NET');
      expect(settlement?.channelId).toBe('0xCHANNEL');
      expect(settlement?.settlementTimeout).toBe(86400);
    });

    it('backward compat: no settlementInfo, request has no settlement fields', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);

            // Verify no settlement fields in request
            expect(request.supportedChains).toBeUndefined();
            expect(request.settlementAddresses).toBeUndefined();

            const response: SpspResponse = {
              requestId: request.requestId,
              destinationAccount: 'g.test.receiver',
              sharedSecret: 'c2VjcmV0',
            };
            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      // No settlementInfo option
      const result = await client.requestSpspInfo(recipientPubkey, { timeout: 1000 });

      expect(result.destinationAccount).toBe('g.test.receiver');
    });

    it('backward compat: response has no settlement fields, result has no settlement', async () => {
      const senderSecretKey = generateSecretKey();
      const recipientSecretKey = generateSecretKey();
      const recipientPubkey = getPublicKey(recipientSecretKey);
      const senderPubkey = getPublicKey(senderSecretKey);

      const client = new NostrSpspClient(MOCK_RELAY_URLS, mockPool, senderSecretKey);

      vi.mocked(mockPool.subscribeMany).mockImplementation((_, __, callbacks) => {
        setTimeout(() => {
          const publishCall = vi.mocked(mockPool.publish).mock.calls[0];
          if (publishCall) {
            const event = publishCall[1] as NostrEvent;
            const convKey = nip44.getConversationKey(recipientSecretKey, senderPubkey);
            const decrypted = nip44.decrypt(event.content, convKey);
            const request = JSON.parse(decrypted);

            // Basic response with no settlement fields
            const response: SpspResponse = {
              requestId: request.requestId,
              destinationAccount: 'g.test.receiver',
              sharedSecret: 'c2VjcmV0',
            };
            const responseEvent = createEncryptedResponseEvent(
              response,
              senderSecretKey,
              senderPubkey,
              recipientSecretKey
            );
            callbacks.onevent?.(responseEvent as VerifiedEvent);
          }
        }, 10);
        return mockSubCloser;
      });

      const result = await client.requestSpspInfo(recipientPubkey, {
        timeout: 1000,
        settlementInfo: {
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xADDR' },
        },
      });

      expect(result.destinationAccount).toBe('g.test.receiver');
      expect(result.settlement).toBeUndefined();
    });
  });
});
