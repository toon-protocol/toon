import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NostrPeerDiscovery } from './NostrPeerDiscovery.js';
import { PeerDiscoveryError } from '../errors.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import type { SimplePool } from 'nostr-tools/pool';
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { IlpPeerInfo, Subscription } from '../types.js';

// Helper to create a minimal valid kind:3 event
function createKind3Event(
  tags: string[][],
  created_at = 1234567890
): VerifiedEvent {
  return {
    id: 'abc123',
    pubkey: '0'.repeat(64),
    kind: 3,
    content: '',
    tags,
    created_at,
    sig: 'sig123',
  } as unknown as VerifiedEvent;
}

// Helper to create a kind:10032 ILP Peer Info event
function createIlpPeerInfoEvent(
  pubkey: string,
  info: Partial<IlpPeerInfo> = {},
  created_at = Math.floor(Date.now() / 1000)
): VerifiedEvent {
  return {
    id: `mock-id-${pubkey.slice(0, 8)}`,
    pubkey,
    kind: ILP_PEER_INFO_KIND,
    content: JSON.stringify({
      ilpAddress: info.ilpAddress ?? 'g.test.peer',
      btpEndpoint: info.btpEndpoint ?? 'wss://btp.test',
      assetCode: info.assetCode ?? 'USD',
      assetScale: info.assetScale ?? 6,
      ...(info.settlementEngine && { settlementEngine: info.settlementEngine }),
    }),
    tags: [],
    created_at,
    sig: 'mock-sig',
  } as unknown as VerifiedEvent;
}

describe('NostrPeerDiscovery', () => {
  let mockPool: SimplePool;
  let mockSubCloser: { close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSubCloser = { close: vi.fn() };
    mockPool = {
      querySync: vi.fn(),
      subscribeMany: vi.fn().mockReturnValue(mockSubCloser),
    } as unknown as SimplePool;
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates instance with relay URLs', () => {
      const discovery = new NostrPeerDiscovery(['wss://relay.example']);
      expect(discovery).toBeInstanceOf(NostrPeerDiscovery);
    });

    it('uses provided SimplePool', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );
      vi.mocked(mockPool.querySync).mockResolvedValue([]);

      await discovery.getFollows('a'.repeat(64));

      expect(mockPool.querySync).toHaveBeenCalled();
    });

    it('creates internal SimplePool if none provided', () => {
      // This test verifies no error is thrown when no pool provided
      const discovery = new NostrPeerDiscovery(['wss://relay.example']);
      expect(discovery).toBeInstanceOf(NostrPeerDiscovery);
    });
  });

  describe('getFollows', () => {
    it('returns followed pubkeys from kind:3 event', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );
      const pubkey1 = 'a'.repeat(64);
      const pubkey2 = 'b'.repeat(64);
      vi.mocked(mockPool.querySync).mockResolvedValue([
        createKind3Event([
          ['p', pubkey1],
          ['p', pubkey2],
        ]),
      ]);

      const follows = await discovery.getFollows('c'.repeat(64));

      expect(follows).toEqual([pubkey1, pubkey2]);
    });

    it('constructs correct filter for kind:3 query', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );
      const targetPubkey = 'd'.repeat(64);
      vi.mocked(mockPool.querySync).mockResolvedValue([]);

      await discovery.getFollows(targetPubkey);

      expect(mockPool.querySync).toHaveBeenCalledWith(['wss://relay.example'], {
        kinds: [3],
        authors: [targetPubkey],
        limit: 1,
      });
    });

    it('returns most recent event when multiple exist', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay1', 'wss://relay2'],
        mockPool
      );
      const oldPubkey = 'a'.repeat(64);
      const newPubkey = 'b'.repeat(64);
      vi.mocked(mockPool.querySync).mockResolvedValue([
        createKind3Event([['p', oldPubkey]], 1000),
        createKind3Event([['p', newPubkey]], 2000), // Most recent
      ]);

      const follows = await discovery.getFollows('c'.repeat(64));

      expect(follows).toEqual([newPubkey]);
    });

    it('deduplicates pubkeys from tags', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );
      const pubkey = 'a'.repeat(64);
      vi.mocked(mockPool.querySync).mockResolvedValue([
        createKind3Event([
          ['p', pubkey],
          ['p', pubkey], // Duplicate
          ['p', pubkey], // Another duplicate
        ]),
      ]);

      const follows = await discovery.getFollows('b'.repeat(64));

      expect(follows).toEqual([pubkey]);
    });

    it('returns empty array for nonexistent pubkey', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );
      vi.mocked(mockPool.querySync).mockResolvedValue([]);

      const follows = await discovery.getFollows('a'.repeat(64));

      expect(follows).toEqual([]);
    });

    it('returns empty array for user with no follows', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );
      vi.mocked(mockPool.querySync).mockResolvedValue([createKind3Event([])]);

      const follows = await discovery.getFollows('a'.repeat(64));

      expect(follows).toEqual([]);
    });

    it('ignores non-p tags', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );
      const pubkey = 'a'.repeat(64);
      vi.mocked(mockPool.querySync).mockResolvedValue([
        createKind3Event([
          ['p', pubkey],
          ['e', 'some-event-id'],
          ['t', 'some-topic'],
        ]),
      ]);

      const follows = await discovery.getFollows('b'.repeat(64));

      expect(follows).toEqual([pubkey]);
    });
  });

  describe('error handling', () => {
    it('throws PeerDiscoveryError for invalid pubkey format', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );

      await expect(discovery.getFollows('invalid')).rejects.toThrow(
        PeerDiscoveryError
      );
      await expect(discovery.getFollows('invalid')).rejects.toThrow(
        'Invalid pubkey format'
      );
    });

    it('throws PeerDiscoveryError for uppercase hex pubkey', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );

      await expect(discovery.getFollows('A'.repeat(64))).rejects.toThrow(
        PeerDiscoveryError
      );
    });

    it('throws PeerDiscoveryError for wrong length pubkey', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );

      await expect(discovery.getFollows('a'.repeat(63))).rejects.toThrow(
        PeerDiscoveryError
      );
      await expect(discovery.getFollows('a'.repeat(65))).rejects.toThrow(
        PeerDiscoveryError
      );
    });

    it('throws PeerDiscoveryError with cause when querySync throws', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );
      const originalError = new Error('Network failure');
      vi.mocked(mockPool.querySync).mockRejectedValue(originalError);

      try {
        await discovery.getFollows('a'.repeat(64));
        expect.fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PeerDiscoveryError);
        expect((error as PeerDiscoveryError).cause).toBe(originalError);
        expect((error as PeerDiscoveryError).code).toBe('PEER_DISCOVERY_FAILED');
      }
    });

    it('has correct error code for PeerDiscoveryError', async () => {
      const discovery = new NostrPeerDiscovery(
        ['wss://relay.example'],
        mockPool
      );

      try {
        await discovery.getFollows('invalid');
        expect.fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PeerDiscoveryError);
        expect((error as PeerDiscoveryError).code).toBe('PEER_DISCOVERY_FAILED');
      }
    });
  });

  describe('discoverPeers', () => {
    // Task 6: Basic flow tests
    describe('basic flow', () => {
      it('returns Map with IlpPeerInfo for peers with kind:10032 events', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const userPubkey = 'a'.repeat(64);
        const peer1Pubkey = 'b'.repeat(64);
        const peer2Pubkey = 'c'.repeat(64);

        // First call: getFollows returns peer pubkeys
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([
            ['p', peer1Pubkey],
            ['p', peer2Pubkey],
          ]),
        ]);
        // Second call: kind:10032 events for peers
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createIlpPeerInfoEvent(peer1Pubkey, { ilpAddress: 'g.peer1' }),
          createIlpPeerInfoEvent(peer2Pubkey, { ilpAddress: 'g.peer2' }),
        ]);

        const result = await discovery.discoverPeers(userPubkey);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(2);
        expect(result.get(peer1Pubkey)?.ilpAddress).toBe('g.peer1');
        expect(result.get(peer2Pubkey)?.ilpAddress).toBe('g.peer2');
      });

      it('calls getFollows with provided pubkey', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const userPubkey = 'd'.repeat(64);

        vi.mocked(mockPool.querySync)
          .mockResolvedValueOnce([]) // getFollows returns empty
          .mockResolvedValueOnce([]); // kind:10032 query (won't be called)

        await discovery.discoverPeers(userPubkey);

        // First call should be getFollows query with user's pubkey
        expect(mockPool.querySync).toHaveBeenCalledWith(['wss://relay.example'], {
          kinds: [3],
          authors: [userPubkey],
          limit: 1,
        });
      });

      it('queries kind:10032 for all followed pubkeys', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const userPubkey = 'a'.repeat(64);
        const peer1 = 'b'.repeat(64);
        const peer2 = 'c'.repeat(64);
        const peer3 = 'd'.repeat(64);

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([
            ['p', peer1],
            ['p', peer2],
            ['p', peer3],
          ]),
        ]);
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([]);

        await discovery.discoverPeers(userPubkey);

        // Second call should query kind:10032 for all follows
        expect(mockPool.querySync).toHaveBeenNthCalledWith(
          2,
          ['wss://relay.example'],
          {
            kinds: [ILP_PEER_INFO_KIND],
            authors: [peer1, peer2, peer3],
          }
        );
      });

      it('returns empty Map when follow list is empty', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([]);

        const result = await discovery.discoverPeers('a'.repeat(64));

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
        // Should not make a second querySync call
        expect(mockPool.querySync).toHaveBeenCalledTimes(1);
      });
    });

    // Task 7: Exclusion cases
    describe('exclusion cases', () => {
      it('excludes peers without kind:10032 events', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peer1 = 'b'.repeat(64);
        const peer2 = 'c'.repeat(64);

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([
            ['p', peer1],
            ['p', peer2],
          ]),
        ]);
        // Only peer1 has a kind:10032 event
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createIlpPeerInfoEvent(peer1),
        ]);

        const result = await discovery.discoverPeers('a'.repeat(64));

        expect(result.size).toBe(1);
        expect(result.has(peer1)).toBe(true);
        expect(result.has(peer2)).toBe(false);
      });

      it('excludes peers with malformed kind:10032 events', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const goodPeer = 'b'.repeat(64);
        const badPeer = 'c'.repeat(64);

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([
            ['p', goodPeer],
            ['p', badPeer],
          ]),
        ]);
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createIlpPeerInfoEvent(goodPeer),
          // Malformed event - missing required fields
          {
            id: 'bad-id',
            pubkey: badPeer,
            kind: ILP_PEER_INFO_KIND,
            content: JSON.stringify({ ilpAddress: 'g.bad' }), // Missing btpEndpoint, assetCode, assetScale
            tags: [],
            created_at: 1234567890,
            sig: 'bad-sig',
          } as unknown as VerifiedEvent,
        ]);

        const result = await discovery.discoverPeers('a'.repeat(64));

        expect(result.size).toBe(1);
        expect(result.has(goodPeer)).toBe(true);
        expect(result.has(badPeer)).toBe(false);
      });

      it('continues when some events fail to parse (returns valid ones)', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peer1 = 'b'.repeat(64);
        const peer2 = 'c'.repeat(64);
        const peer3 = 'd'.repeat(64);

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([
            ['p', peer1],
            ['p', peer2],
            ['p', peer3],
          ]),
        ]);
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createIlpPeerInfoEvent(peer1),
          // Invalid JSON
          {
            id: 'invalid-json',
            pubkey: peer2,
            kind: ILP_PEER_INFO_KIND,
            content: 'not json',
            tags: [],
            created_at: 1234567890,
            sig: 'sig',
          } as unknown as VerifiedEvent,
          createIlpPeerInfoEvent(peer3),
        ]);

        const result = await discovery.discoverPeers('a'.repeat(64));

        expect(result.size).toBe(2);
        expect(result.has(peer1)).toBe(true);
        expect(result.has(peer2)).toBe(false);
        expect(result.has(peer3)).toBe(true);
      });
    });

    // Task 8: Replaceable event handling
    describe('replaceable event handling', () => {
      it('uses most recent event when multiple exist for same pubkey', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peerPubkey = 'b'.repeat(64);

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', peerPubkey]]),
        ]);
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createIlpPeerInfoEvent(peerPubkey, { ilpAddress: 'g.old' }, 1000),
          createIlpPeerInfoEvent(peerPubkey, { ilpAddress: 'g.newest' }, 3000),
          createIlpPeerInfoEvent(peerPubkey, { ilpAddress: 'g.middle' }, 2000),
        ]);

        const result = await discovery.discoverPeers('a'.repeat(64));

        expect(result.size).toBe(1);
        expect(result.get(peerPubkey)?.ilpAddress).toBe('g.newest');
      });

      it('handles events from multiple relays with different timestamps', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay1', 'wss://relay2'],
          mockPool
        );
        const peer1 = 'b'.repeat(64);
        const peer2 = 'c'.repeat(64);

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([
            ['p', peer1],
            ['p', peer2],
          ]),
        ]);
        // Simulate events from multiple relays (querySync aggregates them)
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createIlpPeerInfoEvent(peer1, { ilpAddress: 'g.peer1.old' }, 1000),
          createIlpPeerInfoEvent(peer1, { ilpAddress: 'g.peer1.new' }, 2000),
          createIlpPeerInfoEvent(peer2, { ilpAddress: 'g.peer2.old' }, 1500),
          createIlpPeerInfoEvent(peer2, { ilpAddress: 'g.peer2.new' }, 2500),
        ]);

        const result = await discovery.discoverPeers('a'.repeat(64));

        expect(result.size).toBe(2);
        expect(result.get(peer1)?.ilpAddress).toBe('g.peer1.new');
        expect(result.get(peer2)?.ilpAddress).toBe('g.peer2.new');
      });
    });

    // Task 9: Performance test
    describe('performance', () => {
      it('completes within 5 seconds for 100 follows (mocked)', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const userPubkey = 'a'.repeat(64);

        // Generate 100 unique pubkeys
        const follows = Array.from({ length: 100 }, (_, i) => {
          const hex = i.toString(16).padStart(2, '0');
          return hex.repeat(32);
        });

        // Create kind:3 event with 100 follows
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event(follows.map((pk) => ['p', pk])),
        ]);

        // Create 100 kind:10032 events
        vi.mocked(mockPool.querySync).mockResolvedValueOnce(
          follows.map((pk) => createIlpPeerInfoEvent(pk))
        );

        const start = performance.now();
        const result = await discovery.discoverPeers(userPubkey);
        const elapsed = performance.now() - start;

        expect(result.size).toBe(100);
        expect(elapsed).toBeLessThan(5000);
      });
    });

    // Error handling
    describe('error handling', () => {
      it('throws PeerDiscoveryError for invalid pubkey', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );

        await expect(discovery.discoverPeers('invalid')).rejects.toThrow(
          PeerDiscoveryError
        );
        await expect(discovery.discoverPeers('invalid')).rejects.toThrow(
          'Invalid pubkey format'
        );
      });
    });
  });

  describe('subscribeToPeerUpdates', () => {
    // Task 7: Unit tests for subscription creation
    describe('subscription creation', () => {
      it('returns a Subscription object', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const userPubkey = 'a'.repeat(64);
        const peerPubkey = 'b'.repeat(64);

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', peerPubkey]]),
        ]);

        const subscription = await discovery.subscribeToPeerUpdates(
          userPubkey,
          () => { /* noop */ }
        );

        expect(subscription).toBeDefined();
        expect(typeof subscription.unsubscribe).toBe('function');
      });

      it('Subscription object has unsubscribe method', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', 'b'.repeat(64)]]),
        ]);

        const subscription: Subscription = await discovery.subscribeToPeerUpdates(
          'a'.repeat(64),
          () => { /* noop */ }
        );

        expect(subscription.unsubscribe).toBeInstanceOf(Function);
      });

      it('throws PeerDiscoveryError for invalid pubkey', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );

        await expect(
          discovery.subscribeToPeerUpdates('invalid', () => { /* noop */ })
        ).rejects.toThrow(PeerDiscoveryError);
        await expect(
          discovery.subscribeToPeerUpdates('invalid', () => { /* noop */ })
        ).rejects.toThrow('Invalid pubkey format');
      });

      it('empty follow list returns valid no-op Subscription', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([]); // No follows

        const subscription = await discovery.subscribeToPeerUpdates(
          'a'.repeat(64),
          () => { /* noop */ }
        );

        expect(subscription).toBeDefined();
        expect(typeof subscription.unsubscribe).toBe('function');
        // subscribeMany should NOT be called for empty follow list
        expect(mockPool.subscribeMany).not.toHaveBeenCalled();
      });
    });

    // Task 8: Unit tests for callback invocation
    describe('callback invocation', () => {
      it('callback is invoked when kind:10032 event is received', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peerPubkey = 'b'.repeat(64);
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', peerPubkey]]),
        ]);

        // Capture onevent callback
        let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;
        vi.mocked(mockPool.subscribeMany).mockImplementation(
          (_relays, _filters, params) => {
            capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
            return mockSubCloser;
          }
        );

        await discovery.subscribeToPeerUpdates('a'.repeat(64), callback);

        // Simulate receiving an event
        const mockEvent = createIlpPeerInfoEvent(peerPubkey, {
          ilpAddress: 'g.test.peer',
        });
        capturedOnevent?.(mockEvent);

        expect(callback).toHaveBeenCalledTimes(1);
      });

      it('callback receives pubkey and parsed IlpPeerInfo (not raw event)', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peerPubkey = 'b'.repeat(64);
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', peerPubkey]]),
        ]);

        let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;
        vi.mocked(mockPool.subscribeMany).mockImplementation(
          (_relays, _filters, params) => {
            capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
            return mockSubCloser;
          }
        );

        await discovery.subscribeToPeerUpdates('a'.repeat(64), callback);

        const mockEvent = createIlpPeerInfoEvent(peerPubkey, {
          ilpAddress: 'g.test.peer',
          btpEndpoint: 'wss://btp.example',
          assetCode: 'XRP',
          assetScale: 9,
        });
        capturedOnevent?.(mockEvent);

        expect(callback).toHaveBeenCalledWith(peerPubkey, {
          ilpAddress: 'g.test.peer',
          btpEndpoint: 'wss://btp.example',
          assetCode: 'XRP',
          assetScale: 9,
          supportedChains: [],
          settlementAddresses: {},
        });
      });

      it('callback is not invoked for malformed events (silent skip)', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peerPubkey = 'b'.repeat(64);
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', peerPubkey]]),
        ]);

        let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;
        vi.mocked(mockPool.subscribeMany).mockImplementation(
          (_relays, _filters, params) => {
            capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
            return mockSubCloser;
          }
        );

        await discovery.subscribeToPeerUpdates('a'.repeat(64), callback);

        // Malformed event - invalid JSON
        const malformedEvent = {
          id: 'bad-id',
          pubkey: peerPubkey,
          kind: ILP_PEER_INFO_KIND,
          content: 'not valid json',
          tags: [],
          created_at: Math.floor(Date.now() / 1000),
          sig: 'sig',
        } as unknown as VerifiedEvent;
        capturedOnevent?.(malformedEvent);

        expect(callback).not.toHaveBeenCalled();
      });

      it('multiple callbacks for different peers work correctly', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peer1 = 'b'.repeat(64);
        const peer2 = 'c'.repeat(64);
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([
            ['p', peer1],
            ['p', peer2],
          ]),
        ]);

        let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;
        vi.mocked(mockPool.subscribeMany).mockImplementation(
          (_relays, _filters, params) => {
            capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
            return mockSubCloser;
          }
        );

        await discovery.subscribeToPeerUpdates('a'.repeat(64), callback);

        capturedOnevent?.(createIlpPeerInfoEvent(peer1, { ilpAddress: 'g.peer1' }));
        capturedOnevent?.(createIlpPeerInfoEvent(peer2, { ilpAddress: 'g.peer2' }));

        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenNthCalledWith(1, peer1, expect.objectContaining({ ilpAddress: 'g.peer1' }));
        expect(callback).toHaveBeenNthCalledWith(2, peer2, expect.objectContaining({ ilpAddress: 'g.peer2' }));
      });

      it('empty follow list subscription never invokes callback', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([]); // Empty follows

        await discovery.subscribeToPeerUpdates('a'.repeat(64), callback);

        // No subscribeMany call, so no way to receive events
        expect(mockPool.subscribeMany).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
      });
    });

    // Task 9: Unit tests for unsubscribe lifecycle
    describe('unsubscribe lifecycle', () => {
      it('unsubscribe() stops receiving callbacks', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peerPubkey = 'b'.repeat(64);
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', peerPubkey]]),
        ]);

        let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;
        vi.mocked(mockPool.subscribeMany).mockImplementation(
          (_relays, _filters, params) => {
            capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
            return mockSubCloser;
          }
        );

        const subscription = await discovery.subscribeToPeerUpdates(
          'a'.repeat(64),
          callback
        );

        // First event should trigger callback
        capturedOnevent?.(createIlpPeerInfoEvent(peerPubkey, {}, 1000));
        expect(callback).toHaveBeenCalledTimes(1);

        // Unsubscribe
        subscription.unsubscribe();

        // Event after unsubscribe should not trigger callback
        capturedOnevent?.(createIlpPeerInfoEvent(peerPubkey, {}, 2000));
        expect(callback).toHaveBeenCalledTimes(1); // Still 1
      });

      it('unsubscribe() calls SubCloser.close()', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', 'b'.repeat(64)]]),
        ]);

        const subscription = await discovery.subscribeToPeerUpdates(
          'a'.repeat(64),
          () => { /* noop */ }
        );

        subscription.unsubscribe();

        expect(mockSubCloser.close).toHaveBeenCalledTimes(1);
      });

      it('double unsubscribe is safe (no-op or handled gracefully)', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', 'b'.repeat(64)]]),
        ]);

        const subscription = await discovery.subscribeToPeerUpdates(
          'a'.repeat(64),
          () => { /* noop */ }
        );

        subscription.unsubscribe();
        subscription.unsubscribe(); // Second call should not throw

        // close() should only be called once
        expect(mockSubCloser.close).toHaveBeenCalledTimes(1);
      });

      it('empty follow list subscription unsubscribe is safe no-op', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        vi.mocked(mockPool.querySync).mockResolvedValueOnce([]); // Empty follows

        const subscription = await discovery.subscribeToPeerUpdates(
          'a'.repeat(64),
          () => { /* noop */ }
        );

        // Should not throw
        expect(() => subscription.unsubscribe()).not.toThrow();
        expect(() => subscription.unsubscribe()).not.toThrow(); // Double call safe
      });
    });

    // Task 10: Unit tests for replaceable event handling
    describe('replaceable event handling', () => {
      it('newer event triggers callback', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peerPubkey = 'b'.repeat(64);
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', peerPubkey]]),
        ]);

        let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;
        vi.mocked(mockPool.subscribeMany).mockImplementation(
          (_relays, _filters, params) => {
            capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
            return mockSubCloser;
          }
        );

        await discovery.subscribeToPeerUpdates('a'.repeat(64), callback);

        // First event
        capturedOnevent?.(
          createIlpPeerInfoEvent(peerPubkey, { ilpAddress: 'g.first' }, 1000)
        );
        expect(callback).toHaveBeenCalledTimes(1);

        // Newer event
        capturedOnevent?.(
          createIlpPeerInfoEvent(peerPubkey, { ilpAddress: 'g.second' }, 2000)
        );
        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenLastCalledWith(
          peerPubkey,
          expect.objectContaining({ ilpAddress: 'g.second' })
        );
      });

      it('older/stale event does NOT trigger callback', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peerPubkey = 'b'.repeat(64);
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([['p', peerPubkey]]),
        ]);

        let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;
        vi.mocked(mockPool.subscribeMany).mockImplementation(
          (_relays, _filters, params) => {
            capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
            return mockSubCloser;
          }
        );

        await discovery.subscribeToPeerUpdates('a'.repeat(64), callback);

        // First event with timestamp 2000
        capturedOnevent?.(
          createIlpPeerInfoEvent(peerPubkey, { ilpAddress: 'g.newer' }, 2000)
        );
        expect(callback).toHaveBeenCalledTimes(1);

        // Stale event with timestamp 1000 (older)
        capturedOnevent?.(
          createIlpPeerInfoEvent(peerPubkey, { ilpAddress: 'g.stale' }, 1000)
        );
        expect(callback).toHaveBeenCalledTimes(1); // Still 1, stale event ignored

        // Event with same timestamp should also be ignored
        capturedOnevent?.(
          createIlpPeerInfoEvent(peerPubkey, { ilpAddress: 'g.same' }, 2000)
        );
        expect(callback).toHaveBeenCalledTimes(1); // Still 1
      });

      it('events for different peers are tracked independently', async () => {
        const discovery = new NostrPeerDiscovery(
          ['wss://relay.example'],
          mockPool
        );
        const peer1 = 'b'.repeat(64);
        const peer2 = 'c'.repeat(64);
        const callback = vi.fn();

        vi.mocked(mockPool.querySync).mockResolvedValueOnce([
          createKind3Event([
            ['p', peer1],
            ['p', peer2],
          ]),
        ]);

        let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;
        vi.mocked(mockPool.subscribeMany).mockImplementation(
          (_relays, _filters, params) => {
            capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
            return mockSubCloser;
          }
        );

        await discovery.subscribeToPeerUpdates('a'.repeat(64), callback);

        // peer1 at timestamp 2000
        capturedOnevent?.(createIlpPeerInfoEvent(peer1, {}, 2000));
        // peer2 at timestamp 1000 (older, but different peer - should fire)
        capturedOnevent?.(createIlpPeerInfoEvent(peer2, {}, 1000));

        expect(callback).toHaveBeenCalledTimes(2);

        // peer1 at timestamp 1000 (stale for peer1)
        capturedOnevent?.(createIlpPeerInfoEvent(peer1, {}, 1000));
        expect(callback).toHaveBeenCalledTimes(2); // Still 2, stale

        // peer2 at timestamp 2000 (newer for peer2)
        capturedOnevent?.(createIlpPeerInfoEvent(peer2, {}, 2000));
        expect(callback).toHaveBeenCalledTimes(3); // Now 3
      });
    });
  });
});
