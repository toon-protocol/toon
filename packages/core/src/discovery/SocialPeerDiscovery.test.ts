import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocialPeerDiscovery, type SocialDiscoveryEvent } from './SocialPeerDiscovery.js';
import { PeerDiscoveryError } from '../errors.js';
import type { SimplePool } from 'nostr-tools/pool';
import type { VerifiedEvent } from 'nostr-tools/pure';

vi.mock('nostr-tools/pure', () => ({
  getPublicKey: vi.fn().mockReturnValue('a'.repeat(64)),
}));

const TEST_SECRET_KEY = new Uint8Array(32).fill(1);
const TEST_PUBKEY = 'a'.repeat(64);
const PEER1_PUBKEY = 'b'.repeat(64);
const PEER2_PUBKEY = 'c'.repeat(64);
const PEER3_PUBKEY = 'd'.repeat(64);

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

describe('SocialPeerDiscovery', () => {
  let mockPool: SimplePool;
  let mockSubCloser: { close: ReturnType<typeof vi.fn> };
  let capturedOnevent: ((event: VerifiedEvent) => void) | undefined;

  beforeEach(() => {
    mockSubCloser = { close: vi.fn() };
    mockPool = {
      subscribeMany: vi.fn().mockImplementation((_relays, _filters, params) => {
        capturedOnevent = params?.onevent as (event: VerifiedEvent) => void;
        return mockSubCloser;
      }),
    } as unknown as SimplePool;
    capturedOnevent = undefined;
    vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start()', () => {
    it('subscribes to kind:3 events for the node pubkey', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      discovery.start();

      expect(mockPool.subscribeMany).toHaveBeenCalledWith(
        ['wss://relay.test'],
        { kinds: [3], authors: [TEST_PUBKEY] },
        expect.objectContaining({ onevent: expect.any(Function) })
      );
    });

    it('returns Subscription with working unsubscribe()', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const sub = discovery.start();

      expect(typeof sub.unsubscribe).toBe('function');
      sub.unsubscribe();
      expect(mockSubCloser.close).toHaveBeenCalledTimes(1);
    });

    it('throws PeerDiscoveryError when called twice', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      discovery.start();

      expect(() => discovery.start()).toThrow(PeerDiscoveryError);
      expect(() => discovery.start()).toThrow('already started');
    });

    it('can restart after unsubscribe', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const sub = discovery.start();
      sub.unsubscribe();

      const sub2 = discovery.start();
      expect(sub2).toBeDefined();
      sub2.unsubscribe();
    });
  });

  describe('follow events', () => {
    it('emits social:follow-discovered for new pubkeys in follow list', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events: SocialDiscoveryEvent[] = [];
      discovery.on((e) => events.push(e));
      discovery.start();

      capturedOnevent?.(createKind3Event([
        ['p', PEER1_PUBKEY],
        ['p', PEER2_PUBKEY],
      ]));

      expect(events).toEqual([
        { type: 'social:follow-discovered', pubkey: PEER1_PUBKEY },
        { type: 'social:follow-discovered', pubkey: PEER2_PUBKEY },
      ]);
    });

    it('emits social:follow-removed when pubkey disappears from follow list', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events: SocialDiscoveryEvent[] = [];
      discovery.on((e) => events.push(e));
      discovery.start();

      // First update: follow PEER1 and PEER2
      capturedOnevent?.(createKind3Event([
        ['p', PEER1_PUBKEY],
        ['p', PEER2_PUBKEY],
      ]));

      // Second update: only PEER1 remains
      capturedOnevent?.(createKind3Event([
        ['p', PEER1_PUBKEY],
      ]));

      expect(events).toEqual([
        { type: 'social:follow-discovered', pubkey: PEER1_PUBKEY },
        { type: 'social:follow-discovered', pubkey: PEER2_PUBKEY },
        { type: 'social:follow-removed', pubkey: PEER2_PUBKEY },
      ]);
    });

    it('does not re-emit for pubkeys already in the follow list', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events: SocialDiscoveryEvent[] = [];
      discovery.on((e) => events.push(e));
      discovery.start();

      // First update
      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));

      // Second update with same pubkey (no change)
      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));

      expect(events).toEqual([
        { type: 'social:follow-discovered', pubkey: PEER1_PUBKEY },
      ]);
    });

    it('emits follow-discovered again after follow-removed cycle', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events: SocialDiscoveryEvent[] = [];
      discovery.on((e) => events.push(e));
      discovery.start();

      // Follow
      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      // Unfollow
      capturedOnevent?.(createKind3Event([]));
      // Re-follow
      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));

      expect(events).toEqual([
        { type: 'social:follow-discovered', pubkey: PEER1_PUBKEY },
        { type: 'social:follow-removed', pubkey: PEER1_PUBKEY },
        { type: 'social:follow-discovered', pubkey: PEER1_PUBKEY },
      ]);
    });

    it('handles multiple simultaneous follows and unfollows', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events: SocialDiscoveryEvent[] = [];
      discovery.on((e) => events.push(e));
      discovery.start();

      // Follow PEER1 and PEER2
      capturedOnevent?.(createKind3Event([
        ['p', PEER1_PUBKEY],
        ['p', PEER2_PUBKEY],
      ]));

      // Replace PEER2 with PEER3
      capturedOnevent?.(createKind3Event([
        ['p', PEER1_PUBKEY],
        ['p', PEER3_PUBKEY],
      ]));

      expect(events).toEqual([
        { type: 'social:follow-discovered', pubkey: PEER1_PUBKEY },
        { type: 'social:follow-discovered', pubkey: PEER2_PUBKEY },
        { type: 'social:follow-discovered', pubkey: PEER3_PUBKEY },
        { type: 'social:follow-removed', pubkey: PEER2_PUBKEY },
      ]);
    });

    it('ignores non-p tags', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events: SocialDiscoveryEvent[] = [];
      discovery.on((e) => events.push(e));
      discovery.start();

      capturedOnevent?.(createKind3Event([
        ['e', 'some-event-id'],
        ['p', PEER1_PUBKEY],
        ['t', 'some-tag'],
      ]));

      expect(events).toEqual([
        { type: 'social:follow-discovered', pubkey: PEER1_PUBKEY },
      ]);
    });
  });

  describe('on() / off()', () => {
    it('supports multiple listeners', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events1: SocialDiscoveryEvent[] = [];
      const events2: SocialDiscoveryEvent[] = [];
      discovery.on((e) => events1.push(e));
      discovery.on((e) => events2.push(e));
      discovery.start();

      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    it('off() removes a listener', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events: SocialDiscoveryEvent[] = [];
      const listener = (e: SocialDiscoveryEvent) => events.push(e);
      discovery.on(listener);
      discovery.start();

      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));
      expect(events).toHaveLength(1);

      discovery.off(listener);

      capturedOnevent?.(createKind3Event([
        ['p', PEER1_PUBKEY],
        ['p', PEER2_PUBKEY],
      ]));

      // No new events after off()
      expect(events).toHaveLength(1);
    });

    it('off() with unregistered listener is a no-op', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const listener = () => {};
      // Should not throw
      discovery.off(listener);
    });
  });

  describe('error isolation', () => {
    it('listener errors do not break processing of other listeners', () => {
      const discovery = new SocialPeerDiscovery(
        { relayUrls: ['wss://relay.test'] },
        TEST_SECRET_KEY,
        mockPool
      );
      const events: SocialDiscoveryEvent[] = [];

      discovery.on(() => { throw new Error('bad listener'); });
      discovery.on((e) => events.push(e));
      discovery.start();

      capturedOnevent?.(createKind3Event([['p', PEER1_PUBKEY]]));

      expect(events).toEqual([
        { type: 'social:follow-discovered', pubkey: PEER1_PUBKEY },
      ]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[SocialDiscovery] Listener error:'),
        'bad listener'
      );
    });
  });
});
