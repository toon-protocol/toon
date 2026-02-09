/**
 * Tests for NostrSpspServer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SimplePool, SubCloser } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { NostrSpspServer } from './NostrSpspServer.js';
import { SPSP_REQUEST_KIND, SPSP_RESPONSE_KIND } from '../constants.js';
import { buildSpspRequestEvent, parseSpspResponse } from '../events/index.js';
import type { SpspInfo, ConnectorChannelClient, SettlementNegotiationConfig } from '../types.js';

const MOCK_RELAY_URLS = ['wss://relay1.example.com', 'wss://relay2.example.com'];

// Generate a mock 32-byte secret key (all 1s for testing)
const MOCK_SECRET_KEY = new Uint8Array(32).fill(1);

const MOCK_SPSP_INFO = {
  destinationAccount: 'g.test.alice',
  sharedSecret: 'YWxpY2Utc2VjcmV0', // base64 "alice-secret"
};

describe('NostrSpspServer', () => {
  let mockPool: SimplePool;

  beforeEach(() => {
    mockPool = {
      publish: vi.fn(),
    } as unknown as SimplePool;
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates instance with relay URLs and secret key', () => {
      const server = new NostrSpspServer(MOCK_RELAY_URLS, MOCK_SECRET_KEY);
      expect(server).toBeInstanceOf(NostrSpspServer);
    });

    it('creates instance with custom SimplePool', () => {
      const server = new NostrSpspServer(
        MOCK_RELAY_URLS,
        MOCK_SECRET_KEY,
        mockPool
      );
      expect(server).toBeInstanceOf(NostrSpspServer);
    });

    it('creates internal SimplePool if none provided', () => {
      const server = new NostrSpspServer(MOCK_RELAY_URLS, MOCK_SECRET_KEY);
      expect(server).toBeInstanceOf(NostrSpspServer);
    });
  });

  // Tests for handleSpspRequests
  describe('handleSpspRequests', () => {
    let mockSub: SubCloser;
    let capturedOnevent: ((event: NostrEvent) => void) | undefined;

    beforeEach(() => {
      mockSub = { close: vi.fn() };
      capturedOnevent = undefined;

      // Mock subscribeMany to capture the onevent callback
      (mockPool as unknown as { subscribeMany: typeof mockPool.subscribeMany }).subscribeMany = vi.fn(
        (relays, filters, callbacks) => {
          capturedOnevent = callbacks.onevent;
          return mockSub;
        }
      );
    });

    // Helper to create an encrypted SPSP request event
    function createMockSpspRequestEvent(
      senderSecretKey: Uint8Array,
      recipientPubkey: string
    ): NostrEvent {
      const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey);
      return event;
    }

    // Task 7: Tests for handleSpspRequests happy path (AC: 1, 2, 3, 4, 5, 6)
    describe('happy path', () => {
      it('returns Subscription object (AC: 1)', () => {
        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          MOCK_SECRET_KEY,
          mockPool
        );
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        const subscription = server.handleSpspRequests(generator);

        expect(subscription).toBeDefined();
        expect(typeof subscription.unsubscribe).toBe('function');
      });

      it('subscribes to kind:23194 events with correct filter (AC: 2)', () => {
        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          MOCK_SECRET_KEY,
          mockPool
        );
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);
        const expectedPubkey = getPublicKey(MOCK_SECRET_KEY);

        server.handleSpspRequests(generator);

        expect(mockPool.subscribeMany).toHaveBeenCalledWith(
          MOCK_RELAY_URLS,
          { kinds: [SPSP_REQUEST_KIND], '#p': [expectedPubkey] },
          expect.objectContaining({ onevent: expect.any(Function) })
        );
      });

      it('decrypts incoming request using NIP-44 (AC: 3)', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // Simulate incoming request
        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        // Wait for async processing
        await vi.waitFor(() => {
          expect(generator).toHaveBeenCalled();
        });
      });

      it('calls generator function for each request (AC: 4)', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // Simulate two requests
        const request1 = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        const request2 = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(request1);
        capturedOnevent?.(request2);

        await vi.waitFor(() => {
          expect(generator).toHaveBeenCalledTimes(2);
        });
      });

      it('works with synchronous generator function', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });
      });

      it('works with async generator function (returns Promise)', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockResolvedValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });
      });

      it('encrypts response with NIP-44 (AC: 5)', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        // Get the published response event
        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;

        // Verify sender can decrypt the response
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);
        expect(parsed.destinationAccount).toBe(MOCK_SPSP_INFO.destinationAccount);
        expect(parsed.sharedSecret).toBe(MOCK_SPSP_INFO.sharedSecret);
      });

      it('publishes kind:23195 response event', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        expect(responseEvent.kind).toBe(SPSP_RESPONSE_KIND);
      });

      it('response includes correct requestId', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const { event: requestEvent, requestId } = buildSpspRequestEvent(
          serverPubkey,
          senderSecretKey
        );
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);
        expect(parsed.requestId).toBe(requestId);
      });

      it("response includes 'p' tag with original sender", async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const senderPubkey = getPublicKey(senderSecretKey);

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        expect(responseEvent.tags).toContainEqual(['p', senderPubkey]);
      });
    });

    // Task 8: Tests for encryption/decryption (AC: 3, 5, 6)
    describe('encryption/decryption', () => {
      it('request is correctly decrypted', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const { event: requestEvent, requestId } = buildSpspRequestEvent(
          serverPubkey,
          senderSecretKey
        );
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        // The response requestId should match, proving decryption worked
        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);
        expect(parsed.requestId).toBe(requestId);
      });

      it('response is correctly encrypted for sender', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        // Sender should be able to decrypt
        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);
        expect(parsed).toBeDefined();
      });

      it('malformed encrypted content is handled gracefully', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // Create an event with invalid encrypted content
        const malformedEvent: NostrEvent = {
          id: '0'.repeat(64),
          pubkey: getPublicKey(senderSecretKey),
          kind: SPSP_REQUEST_KIND,
          content: 'not-valid-encrypted-content',
          tags: [['p', serverPubkey]],
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        };

        // Should not throw
        capturedOnevent?.(malformedEvent);

        // Wait a bit to ensure no error was thrown
        await new Promise((r) => setTimeout(r, 50));

        // Generator should NOT have been called
        expect(generator).not.toHaveBeenCalled();
        // No response should have been published
        expect(mockPool.publish).not.toHaveBeenCalled();
      });

      it('round-trip: client request -> server response -> client decrypt', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const testSpspInfo: SpspInfo = {
          destinationAccount: 'g.roundtrip.test',
          sharedSecret: 'cm91bmR0cmlw', // base64 "roundtrip"
        };
        const generator = vi.fn().mockReturnValue(testSpspInfo);

        server.handleSpspRequests(generator);

        // Client creates request
        const { event: requestEvent, requestId } = buildSpspRequestEvent(
          serverPubkey,
          senderSecretKey
        );

        // Server receives request
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        // Client receives and decrypts response
        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const response = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        // Verify complete round-trip
        expect(response.requestId).toBe(requestId);
        expect(response.destinationAccount).toBe(testSpspInfo.destinationAccount);
        expect(response.sharedSecret).toBe(testSpspInfo.sharedSecret);
      });
    });

    // Task 9: Tests for Subscription lifecycle (AC: 1, 6)
    describe('Subscription lifecycle', () => {
      it('unsubscribe() closes the pool subscription', () => {
        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          MOCK_SECRET_KEY,
          mockPool
        );
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        const subscription = server.handleSpspRequests(generator);
        subscription.unsubscribe();

        expect(mockSub.close).toHaveBeenCalledTimes(1);
      });

      it('no more events processed after unsubscribe', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        const subscription = server.handleSpspRequests(generator);

        // Process one request before unsubscribe
        const request1 = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(request1);

        await vi.waitFor(() => {
          expect(generator).toHaveBeenCalledTimes(1);
        });

        // Unsubscribe
        subscription.unsubscribe();

        // Note: In a real scenario, the relay would stop sending events after close()
        // Here we're just testing that close() is called correctly
        expect(mockSub.close).toHaveBeenCalled();
      });

      it('multiple calls to unsubscribe are safe', () => {
        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          MOCK_SECRET_KEY,
          mockPool
        );
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        const subscription = server.handleSpspRequests(generator);

        // Call unsubscribe multiple times - should not throw
        subscription.unsubscribe();
        subscription.unsubscribe();
        subscription.unsubscribe();

        expect(mockSub.close).toHaveBeenCalledTimes(3);
      });
    });

    // Task 10: Tests for error handling (AC: 6)
    describe('error handling', () => {
      it('handles InvalidEventError from parse gracefully', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // Create malformed request (encrypted but with invalid payload)
        const conversationKey = nip44.getConversationKey(senderSecretKey, serverPubkey);
        const invalidPayload = nip44.encrypt('not-valid-json', conversationKey);
        const malformedEvent: NostrEvent = {
          id: '0'.repeat(64),
          pubkey: getPublicKey(senderSecretKey),
          kind: SPSP_REQUEST_KIND,
          content: invalidPayload,
          tags: [['p', serverPubkey]],
          created_at: Math.floor(Date.now() / 1000),
          sig: '0'.repeat(128),
        };

        // Should not throw
        capturedOnevent?.(malformedEvent);

        await new Promise((r) => setTimeout(r, 50));

        // Generator should NOT have been called
        expect(generator).not.toHaveBeenCalled();
      });

      it('handles generator throwing error gracefully', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockImplementation(() => {
          throw new Error('Generator failed');
        });

        server.handleSpspRequests(generator);

        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);

        // Should not throw
        capturedOnevent?.(requestEvent);

        await new Promise((r) => setTimeout(r, 50));

        // Generator was called but failed
        expect(generator).toHaveBeenCalled();
        // No response published
        expect(mockPool.publish).not.toHaveBeenCalled();
      });

      it('handles publish failure gracefully', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([
          Promise.reject(new Error('publish failed')),
          Promise.reject(new Error('publish failed')),
        ]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);

        // Should not throw
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(generator).toHaveBeenCalled();
        });

        // Wait a bit more for publish to fail silently
        await new Promise((r) => setTimeout(r, 50));

        // publish was called
        expect(mockPool.publish).toHaveBeenCalled();
      });

      it('continues processing after individual request failures', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);

        let callCount = 0;
        const generator = vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            throw new Error('First request fails');
          }
          return MOCK_SPSP_INFO;
        });

        server.handleSpspRequests(generator);

        // First request - will fail in generator
        const request1 = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(request1);

        await new Promise((r) => setTimeout(r, 50));

        // Second request - should succeed
        const request2 = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(request2);

        await vi.waitFor(() => {
          expect(generator).toHaveBeenCalledTimes(2);
        });

        // Wait for second request to be published
        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });
      });
    });

    // Task 9: Tests for settlement negotiation happy path (AC: 1, 3, 4, 5, 6, 10)
    describe('settlement negotiation - happy path', () => {
      const testSettlementConfig: SettlementNegotiationConfig = {
        ownSupportedChains: ['evm:base:8453', 'xrp:mainnet'],
        ownSettlementAddresses: { 'evm:base:8453': '0xSERVER_ADDRESS', 'xrp:mainnet': 'rSERVER_ADDRESS' },
        ownPreferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
        ownTokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
        initialDeposit: '1000000',
        settlementTimeout: 86400,
        channelOpenTimeout: 5000,
      };

      function createMockChannelClient(): ConnectorChannelClient {
        return {
          openChannel: vi.fn().mockResolvedValue({ channelId: '0xCHANNEL123', status: 'opening' }),
          getChannelState: vi.fn().mockResolvedValue({ channelId: '0xCHANNEL123', status: 'open', chain: 'evm:base:8453' }),
        };
      }

      // Helper to create a request event WITH settlement fields
      function createSettlementRequestEvent(
        senderSecretKey: Uint8Array,
        recipientPubkey: string
      ): NostrEvent {
        const { event } = buildSpspRequestEvent(recipientPubkey, senderSecretKey, {
          supportedChains: ['evm:base:8453', 'xrp:mainnet'],
          settlementAddresses: { 'evm:base:8453': '0xPEER_ADDRESS', 'xrp:mainnet': 'rPEER_ADDRESS' },
          preferredTokens: { 'evm:base:8453': '0xPEER_TOKEN' },
        });
        return event;
      }

      it('response includes negotiatedChain, settlementAddress, channelId when settlement succeeds', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient = createMockChannelClient();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createSettlementRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.negotiatedChain).toBe('evm:base:8453');
        expect(parsed.settlementAddress).toBe('0xSERVER_ADDRESS');
        expect(parsed.channelId).toBe('0xCHANNEL123');
      });

      it('openChannel is called with correct params', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const senderPubkey = getPublicKey(senderSecretKey);
        const mockChannelClient = createMockChannelClient();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createSettlementRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        expect(mockChannelClient.openChannel).toHaveBeenCalledWith({
          peerId: `nostr-${senderPubkey.slice(0, 16)}`,
          chain: 'evm:base:8453',
          token: '0xPEER_TOKEN', // requester's preferred token takes priority
          tokenNetwork: '0xTOKEN_NETWORK',
          peerAddress: '0xPEER_ADDRESS',
          initialDeposit: '1000000',
          settlementTimeout: 86400,
        });
      });

      it('getChannelState is called to verify channel is open', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient = createMockChannelClient();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createSettlementRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        expect(mockChannelClient.getChannelState).toHaveBeenCalledWith('0xCHANNEL123');
      });

      it('response includes tokenAddress and tokenNetworkAddress for EVM chain', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient = createMockChannelClient();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createSettlementRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.tokenAddress).toBe('0xPEER_TOKEN');
        expect(parsed.tokenNetworkAddress).toBe('0xTOKEN_NETWORK');
      });

      it('response includes settlementTimeout from config', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient = createMockChannelClient();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const requestEvent = createSettlementRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.settlementTimeout).toBe(86400);
      });

      it('backward compat: no settlementConfig or channelClient, behavior unchanged', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();

        // No settlement config or channel client
        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // Even with settlement fields in request, no settlement negotiation occurs
        const requestEvent = createSettlementRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.negotiatedChain).toBeUndefined();
        expect(parsed.settlementAddress).toBeUndefined();
        expect(parsed.channelId).toBeUndefined();
      });

      it('backward compat: request has no supportedChains, behavior unchanged', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient = createMockChannelClient();

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // Request WITHOUT settlement fields
        const requestEvent = createMockSpspRequestEvent(senderSecretKey, serverPubkey);
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.negotiatedChain).toBeUndefined();
        expect(mockChannelClient.openChannel).not.toHaveBeenCalled();
      });
    });

    // Task 10: Tests for settlement error handling (AC: 7, 8, 9)
    describe('settlement negotiation - error handling', () => {
      const testSettlementConfig: SettlementNegotiationConfig = {
        ownSupportedChains: ['evm:base:8453', 'xrp:mainnet'],
        ownSettlementAddresses: { 'evm:base:8453': '0xSERVER_ADDRESS', 'xrp:mainnet': 'rSERVER_ADDRESS' },
        ownPreferredTokens: { 'evm:base:8453': '0xAGENT_TOKEN' },
        ownTokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
        initialDeposit: '1000000',
        settlementTimeout: 86400,
        channelOpenTimeout: 100, // very short timeout for tests
      };

      it('no chain intersection: returns basic SPSP response without settlement fields', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient: ConnectorChannelClient = {
          openChannel: vi.fn(),
          getChannelState: vi.fn(),
        };

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // Request with chains that don't overlap with server
        const { event: requestEvent } = buildSpspRequestEvent(serverPubkey, senderSecretKey, {
          supportedChains: ['aptos:mainnet:1'],
          settlementAddresses: { 'aptos:mainnet:1': '0xAPTOS_ADDR' },
        });
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.destinationAccount).toBe(MOCK_SPSP_INFO.destinationAccount);
        expect(parsed.negotiatedChain).toBeUndefined();
        expect(parsed.channelId).toBeUndefined();
        expect(mockChannelClient.openChannel).not.toHaveBeenCalled();
      });

      it('missing peerAddress for negotiated chain: returns basic SPSP response', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient: ConnectorChannelClient = {
          openChannel: vi.fn(),
          getChannelState: vi.fn(),
        };

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // Request with matching chain but NO settlement address for it
        const { event: requestEvent } = buildSpspRequestEvent(serverPubkey, senderSecretKey, {
          supportedChains: ['evm:base:8453'],
          // No settlementAddresses — peerAddress will be undefined
        });
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.destinationAccount).toBe(MOCK_SPSP_INFO.destinationAccount);
        expect(parsed.negotiatedChain).toBeUndefined();
        expect(mockChannelClient.openChannel).not.toHaveBeenCalled();
      });

      it('openChannel throws: returns basic SPSP response', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient: ConnectorChannelClient = {
          openChannel: vi.fn().mockRejectedValue(new Error('Connector unavailable')),
          getChannelState: vi.fn(),
        };

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const { event: requestEvent } = buildSpspRequestEvent(serverPubkey, senderSecretKey, {
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xPEER' },
        });
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.destinationAccount).toBe(MOCK_SPSP_INFO.destinationAccount);
        expect(parsed.negotiatedChain).toBeUndefined();
      });

      it('channel state polling times out: returns basic SPSP response', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient: ConnectorChannelClient = {
          openChannel: vi.fn().mockResolvedValue({ channelId: '0xCH', status: 'opening' }),
          getChannelState: vi.fn().mockResolvedValue({ channelId: '0xCH', status: 'opening', chain: 'evm:base:8453' }),
        };

        // Use very short timeout
        const shortTimeoutConfig = { ...testSettlementConfig, channelOpenTimeout: 100 };

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          shortTimeoutConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const { event: requestEvent } = buildSpspRequestEvent(serverPubkey, senderSecretKey, {
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xPEER' },
        });
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        }, { timeout: 5000 });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.destinationAccount).toBe(MOCK_SPSP_INFO.destinationAccount);
        expect(parsed.negotiatedChain).toBeUndefined();
        expect(parsed.channelId).toBeUndefined();
      }, 10000);

      it('polls multiple iterations before channel becomes open', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient: ConnectorChannelClient = {
          openChannel: vi.fn().mockResolvedValue({ channelId: '0xCH_MULTI', status: 'opening' }),
          getChannelState: vi.fn()
            .mockResolvedValueOnce({ channelId: '0xCH_MULTI', status: 'opening', chain: 'evm:base:8453' })
            .mockResolvedValueOnce({ channelId: '0xCH_MULTI', status: 'opening', chain: 'evm:base:8453' })
            .mockResolvedValueOnce({ channelId: '0xCH_MULTI', status: 'open', chain: 'evm:base:8453' }),
        };

        // Use short pollInterval and enough timeout for 3 iterations
        const multiPollConfig: SettlementNegotiationConfig = {
          ...testSettlementConfig,
          channelOpenTimeout: 500,
          pollInterval: 50,
        };

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          multiPollConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const { event: requestEvent } = buildSpspRequestEvent(serverPubkey, senderSecretKey, {
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xPEER' },
        });
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        }, { timeout: 5000 });

        // Verify getChannelState was called 3 times (2 opening + 1 open)
        expect(mockChannelClient.getChannelState).toHaveBeenCalledTimes(3);

        // Verify response includes settlement fields (channel eventually opened)
        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.negotiatedChain).toBe('evm:base:8453');
        expect(parsed.channelId).toBe('0xCH_MULTI');
      }, 10000);

      it('getChannelState throws during polling: returns basic SPSP response', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient: ConnectorChannelClient = {
          openChannel: vi.fn().mockResolvedValue({ channelId: '0xCH', status: 'opening' }),
          getChannelState: vi.fn().mockRejectedValue(new Error('Network error')),
        };

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        const { event: requestEvent } = buildSpspRequestEvent(serverPubkey, senderSecretKey, {
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xPEER' },
        });
        capturedOnevent?.(requestEvent);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalled();
        });

        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent = publishCalls[0][1] as NostrEvent;
        const parsed = parseSpspResponse(responseEvent, senderSecretKey, serverPubkey);

        expect(parsed.destinationAccount).toBe(MOCK_SPSP_INFO.destinationAccount);
        expect(parsed.negotiatedChain).toBeUndefined();
      });

      it('server continues processing subsequent requests after settlement failure', async () => {
        const serverSecretKey = generateSecretKey();
        const serverPubkey = getPublicKey(serverSecretKey);
        const senderSecretKey = generateSecretKey();
        const mockChannelClient: ConnectorChannelClient = {
          openChannel: vi.fn()
            .mockRejectedValueOnce(new Error('First call fails'))
            .mockResolvedValueOnce({ channelId: '0xCH2', status: 'opening' }),
          getChannelState: vi.fn().mockResolvedValue({ channelId: '0xCH2', status: 'open', chain: 'evm:base:8453' }),
        };

        const server = new NostrSpspServer(
          MOCK_RELAY_URLS,
          serverSecretKey,
          mockPool,
          testSettlementConfig,
          mockChannelClient
        );
        vi.mocked(mockPool.publish).mockReturnValue([Promise.resolve('ok')]);
        const generator = vi.fn().mockReturnValue(MOCK_SPSP_INFO);

        server.handleSpspRequests(generator);

        // First request — settlement will fail
        const { event: req1 } = buildSpspRequestEvent(serverPubkey, senderSecretKey, {
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xPEER' },
        });
        capturedOnevent?.(req1);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalledTimes(1);
        });

        // Second request — settlement should succeed
        const { event: req2 } = buildSpspRequestEvent(serverPubkey, senderSecretKey, {
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xPEER' },
        });
        capturedOnevent?.(req2);

        await vi.waitFor(() => {
          expect(mockPool.publish).toHaveBeenCalledTimes(2);
        });

        // Second response should have settlement fields
        const publishCalls = vi.mocked(mockPool.publish).mock.calls;
        const responseEvent2 = publishCalls[1][1] as NostrEvent;
        const parsed2 = parseSpspResponse(responseEvent2, senderSecretKey, serverPubkey);

        expect(parsed2.negotiatedChain).toBe('evm:base:8453');
        expect(parsed2.channelId).toBe('0xCH2');
      });
    });
  });
});
