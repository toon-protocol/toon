import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocialPeerDiscovery } from './SocialPeerDiscovery.js';
import { PeerDiscoveryError } from '../errors.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import type { SimplePool } from 'nostr-tools/pool';
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { IlpPeerInfo } from '../types.js';
import type { ConnectorAdminClient } from '../bootstrap/index.js';
import type { NostrSpspClient } from '../spsp/index.js';

vi.mock('nostr-tools/pure', () => ({
  getPublicKey: vi.fn().mockReturnValue('a'.repeat(64)),
}));

const TEST_SECRET_KEY = new Uint8Array(32).fill(1);
const TEST_PUBKEY = 'a'.repeat(64);
const PEER1_PUBKEY = 'b'.repeat(64);
const PEER2_PUBKEY = 'c'.repeat(64);
const PEER3_PUBKEY = 'd'.repeat(64);

const DEFAULT_ILP_INFO: IlpPeerInfo = {
  ilpAddress: 'g.test.node',
  btpEndpoint: 'wss://btp.test',
  assetCode: 'USD',
  assetScale: 6,
};

function createKind3Event(tags: string[][], created_at = 1234567890): VerifiedEvent {
  return {
    id: `kind3-${Date.now()}`,
    pubkey: TEST_PUBKEY,
    kind: 3,
    content: '',
    tags,
    created_at,
    sig: 'sig123',
  } as unknown as VerifiedEvent;
}

function createIlpPeerInfoEvent(
  pubkey: string,
  info: Partial<IlpPeerInfo> = {},
  created_at = Math.floor(Date.now() / 1000)
): VerifiedEvent {
  return {
    id: `mock-id-${pubkey.slice(0, 8)}-${created_at}`,
    pubkey,
    kind: ILP_PEER_INFO_KIND,
    content: JSON.stringify({
      ilpAddress: info.ilpAddress ?? 'g.test.peer',
      btpEndpoint: info.btpEndpoint ?? 'wss://btp.test',
      assetCode: info.assetCode ?? 'USD',
      assetScale: info.assetScale ?? 6,
    }),
    tags: [],
    created_at,
    sig: 'mock-sig',
  } as unknown as VerifiedEvent;
}

describe('SocialPeerDiscovery', () => {
  let mockPool: SimplePool;
  let mockSubCloser: { close: ReturnType<typeof vi.fn> };
  let mockAdmin: ConnectorAdminClient;
  let mockSpspClient: NostrSpspClient;
  let mockRequestSpspInfo: ReturnType<typeof vi.fn>;
  let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSubCloser = { close: vi.fn() };
    mockPool = {
      querySync: vi.fn().mockResolvedValue([]),
      subscribeMany: vi.fn().mockImplementation((_relays, _filters, params) => {
        capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
        return mockSubCloser;
      }),
    } as unknown as SimplePool;
    mockAdmin = {
      addPeer: vi.fn().mockResolvedValue(undefined),
      removePeer: vi.fn().mockResolvedValue(undefined),
    };
    mockRequestSpspInfo = vi.fn().mockResolvedValue({
      destinationAccount: 'g.test.receiver',
      sharedSecret: 'c2VjcmV0',
    });
    mockSpspClient = {
      requestSpspInfo: mockRequestSpspInfo,
    } as unknown as NostrSpspClient;
    capturedOnevent = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
    vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createDiscovery(
    configOverrides: Partial<{
      cooldownMs: number;
      spspTimeout: number;
      removePeersOnUnfollow: boolean;
    }> = {}
  ): SocialPeerDiscovery {
    const discovery = new SocialPeerDiscovery(
      {
        relayUrls: ['wss://relay.test'],
        cooldownMs: configOverrides.cooldownMs ?? 0,
        spspTimeout: configOverrides.spspTimeout ?? 10000,
        removePeersOnUnfollow: configOverrides.removePeersOnUnfollow ?? false,
      },
      TEST_SECRET_KEY,
      DEFAULT_ILP_INFO,
      mockPool,
      mockSpspClient
    );
    discovery.setConnectorAdmin(mockAdmin);
    return discovery;
  }

  describe('start()', () => {
    it('subscribes to kind:3 events for the node pubkey', () => {
      const discovery = createDiscovery();
      discovery.start();

      expect(mockPool.subscribeMany).toHaveBeenCalledWith(
        ['wss://relay.test'],
        { kinds: [3], authors: [TEST_PUBKEY] },
        expect.objectContaining({ onevent: expect.any(Function) })
      );
    });

    it('returns Subscription with working unsubscribe()', () => {
      const discovery = createDiscovery();
      const sub = discovery.start();

      expect(typeof sub.unsubscribe).toBe('function');
      sub.unsubscribe();
      expect(mockSubCloser.close).toHaveBeenCalledTimes(1);
    });

    it('throws PeerDiscoveryError when called twice', () => {
      const discovery = createDiscovery();
      discovery.start();

      expect(() => discovery.start()).toThrow(PeerDiscoveryError);
      expect(() => discovery.start()).toThrow('already started');
    });

    it('can restart after unsubscribe', () => {
      const discovery = createDiscovery();
      const sub = discovery.start();
      sub.unsubscribe();

      const sub2 = discovery.start();
      expect(sub2).toBeDefined();
      sub2.unsubscribe();
    });
  });

  describe('new follow handling', () => {
    it('triggers kind:10032 query, SPSP handshake, and admin API registration', async () => {
      const discovery = createDiscovery();
      discovery.start();

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createIlpPeerInfoEvent(PEER1_PUBKEY, {
          ilpAddress: 'g.peer1',
          btpEndpoint: 'wss://btp.peer1',
        }),
      ]);

      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      await vi.advanceTimersByTimeAsync(0);

      // Verify kind:10032 query
      expect(mockPool.querySync).toHaveBeenCalledWith(
        ['wss://relay.test'],
        expect.objectContaining({
          kinds: [ILP_PEER_INFO_KIND],
          authors: [PEER1_PUBKEY],
          limit: 1,
        })
      );

      // Verify SPSP handshake called
      expect(mockRequestSpspInfo).toHaveBeenCalledWith(PEER1_PUBKEY, {
        timeout: 10000,
      });

      // Verify admin API registration
      expect(mockAdmin.addPeer).toHaveBeenCalledWith({
        id: `nostr-${PEER1_PUBKEY.slice(0, 16)}`,
        url: 'wss://btp.peer1',
        authToken: '',
        routes: [{ prefix: 'g.peer1' }],
      });

      // Verify success log
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[SocialDiscovery] Peered with')
      );
    });

    it('skips peer with no kind:10032 event (warns)', async () => {
      const discovery = createDiscovery();
      discovery.start();

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([]);

      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockAdmin.addPeer).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('No kind:10032')
      );
    });

    it('skips peer on SPSP handshake failure (non-fatal)', async () => {
      const discovery = createDiscovery();
      discovery.start();

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createIlpPeerInfoEvent(PEER1_PUBKEY),
      ]);

      mockRequestSpspInfo.mockRejectedValueOnce(new Error('SPSP timeout'));

      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockAdmin.addPeer).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to peer with'),
        'SPSP timeout'
      );
    });

    it('skips peer on admin API failure (non-fatal)', async () => {
      const discovery = createDiscovery();
      discovery.start();

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createIlpPeerInfoEvent(PEER1_PUBKEY),
      ]);

      vi.mocked(mockAdmin.addPeer).mockRejectedValueOnce(
        new Error('Admin API error')
      );

      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      await vi.advanceTimersByTimeAsync(0);

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to peer with'),
        'Admin API error'
      );
    });

    it('does not re-process already-peered pubkey', async () => {
      const discovery = createDiscovery();
      discovery.start();

      // First follow list update with PEER1
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createIlpPeerInfoEvent(PEER1_PUBKEY),
      ]);
      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(1);

      // Second follow list update still has PEER1 (no change)
      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      await vi.advanceTimersByTimeAsync(0);

      // Should not call addPeer again
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(1);
    });
  });

  describe('unfollow handling', () => {
    it('triggers removePeer() when removePeersOnUnfollow is true', async () => {
      const discovery = createDiscovery({ removePeersOnUnfollow: true });
      discovery.start();

      // First: establish peer
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createIlpPeerInfoEvent(PEER1_PUBKEY),
      ]);
      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      await vi.advanceTimersByTimeAsync(0);

      // Then: unfollow (empty follow list)
      capturedOnevent?.(createKind3Event([]));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockAdmin.removePeer).toHaveBeenCalledWith(
        `nostr-${PEER1_PUBKEY.slice(0, 16)}`
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[SocialDiscovery] Removed peer')
      );
    });

    it('does NOT trigger removePeer() when removePeersOnUnfollow is false', async () => {
      const discovery = createDiscovery({ removePeersOnUnfollow: false });
      discovery.start();

      // First: establish peer
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createIlpPeerInfoEvent(PEER1_PUBKEY),
      ]);
      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      await vi.advanceTimersByTimeAsync(0);

      // Then: unfollow
      capturedOnevent?.(createKind3Event([]));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockAdmin.removePeer).not.toHaveBeenCalled();
    });
  });

  describe('cooldown', () => {
    it('waits cooldownMs between peer processing attempts', async () => {
      const discovery = createDiscovery({ cooldownMs: 5000 });
      discovery.start();

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createIlpPeerInfoEvent(PEER1_PUBKEY)])
        .mockResolvedValueOnce([createIlpPeerInfoEvent(PEER2_PUBKEY)]);

      capturedOnevent?.(
        createKind3Event([
          ['p', PEER1_PUBKEY],
          ['p', PEER2_PUBKEY],
        ])
      );

      // First peer processed immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(1);

      // Second peer not yet (waiting for cooldown)
      await vi.advanceTimersByTimeAsync(4999);
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(1);

      // After cooldown, second peer processed
      await vi.advanceTimersByTimeAsync(1);
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(2);
    });
  });

  describe('error isolation', () => {
    it('errors in one peer do not block processing of other peers', async () => {
      const discovery = createDiscovery();
      discovery.start();

      // PEER1: no kind:10032, PEER2: has kind:10032
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([createIlpPeerInfoEvent(PEER2_PUBKEY)]);

      capturedOnevent?.(
        createKind3Event([
          ['p', PEER1_PUBKEY],
          ['p', PEER2_PUBKEY],
        ])
      );

      await vi.advanceTimersByTimeAsync(0);

      // PEER2 should still be registered despite PEER1 failure
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(1);
      expect(mockAdmin.addPeer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `nostr-${PEER2_PUBKEY.slice(0, 16)}`,
        })
      );
    });

    it('handles multiple peers where some fail and some succeed', async () => {
      const discovery = createDiscovery();
      discovery.start();

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createIlpPeerInfoEvent(PEER1_PUBKEY)])
        .mockResolvedValueOnce([createIlpPeerInfoEvent(PEER2_PUBKEY)])
        .mockResolvedValueOnce([createIlpPeerInfoEvent(PEER3_PUBKEY)]);

      // First call succeeds (PEER1), second fails (PEER2), third succeeds (PEER3)
      mockRequestSpspInfo
        .mockResolvedValueOnce({ destinationAccount: 'g.1', sharedSecret: 's1' })
        .mockRejectedValueOnce(new Error('SPSP failed'))
        .mockResolvedValueOnce({ destinationAccount: 'g.3', sharedSecret: 's3' });

      capturedOnevent?.(
        createKind3Event([
          ['p', PEER1_PUBKEY],
          ['p', PEER2_PUBKEY],
          ['p', PEER3_PUBKEY],
        ])
      );

      await vi.runAllTimersAsync();

      // PEER1 and PEER3 registered, PEER2 skipped
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(2);
    });
  });
});
