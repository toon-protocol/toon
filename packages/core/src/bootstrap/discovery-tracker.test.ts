/**
 * Tests for createDiscoveryTracker — event processing, peer discovery,
 * explicit peering via peerWith(), and local settlement negotiation.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { createDiscoveryTracker } from './discovery-tracker.js';
import type { DiscoveryTracker } from './discovery-tracker.js';
import { BootstrapError } from './BootstrapService.js';
import type {
  ConnectorAdminClient,
  BootstrapEvent,
} from './types.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import type { IlpPeerInfo } from '../types.js';

describe('createDiscoveryTracker', () => {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  const peerPubkey = 'a'.repeat(64);
  const peerPubkey2 = 'b'.repeat(64);

  const validPeerInfo: IlpPeerInfo = {
    ilpAddress: 'g.test.peer',
    btpEndpoint: 'ws://peer:3000',
    assetCode: 'USD',
    assetScale: 6,
  };

  let mockAdmin: ConnectorAdminClient & {
    addPeer: Mock;
    removePeer: Mock;
  };

  function createTracker(): DiscoveryTracker {
    return createDiscoveryTracker({
      secretKey,
    });
  }

  function createWiredTracker(): DiscoveryTracker {
    const tracker = createTracker();
    tracker.setConnectorAdmin(mockAdmin);
    return tracker;
  }

  function makeEvent(
    pk: string,
    content: string,
    createdAt: number = Math.floor(Date.now() / 1000)
  ): NostrEvent {
    return {
      id: 'e'.repeat(64),
      pubkey: pk,
      created_at: createdAt,
      kind: ILP_PEER_INFO_KIND,
      tags: [],
      content,
      sig: 'f'.repeat(128),
    };
  }

  function makeValidEvent(
    pk: string = peerPubkey,
    createdAt?: number
  ): NostrEvent {
    return makeEvent(pk, JSON.stringify(validPeerInfo), createdAt);
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockAdmin = {
      addPeer: vi.fn().mockResolvedValue(undefined),
      removePeer: vi.fn().mockResolvedValue(undefined),
    };
  });

  // --- processEvent() discovery ---

  it('processEvent() adds to discovered peers and emits bootstrap:peer-discovered', () => {
    const events: BootstrapEvent[] = [];
    const tracker = createTracker();
    tracker.on((event) => events.push(event));

    tracker.processEvent(makeValidEvent());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'bootstrap:peer-discovered',
      peerPubkey,
      ilpAddress: 'g.test.peer',
    });
  });

  it('own pubkey excluded from discovery', () => {
    const events: BootstrapEvent[] = [];
    const tracker = createTracker();
    tracker.on((event) => events.push(event));

    tracker.processEvent(makeValidEvent(pubkey));

    expect(events).toHaveLength(0);
    expect(tracker.getDiscoveredPeers()).toHaveLength(0);
  });

  it('stale events (older timestamp) are ignored', () => {
    const events: BootstrapEvent[] = [];
    const tracker = createTracker();
    tracker.on((event) => events.push(event));

    tracker.processEvent(makeValidEvent(peerPubkey, 2000));
    tracker.processEvent(makeValidEvent(peerPubkey, 1000));

    const discoveries = events.filter(
      (e) => e.type === 'bootstrap:peer-discovered'
    );
    expect(discoveries).toHaveLength(1);
  });

  it('events with non-10032 kind are ignored', () => {
    const events: BootstrapEvent[] = [];
    const tracker = createTracker();
    tracker.on((event) => events.push(event));

    const event = makeValidEvent();
    (event as { kind: number }).kind = 1;
    tracker.processEvent(event);

    expect(events).toHaveLength(0);
  });

  // --- Deregistration ---

  it('empty content triggers deregistration of a peered peer', async () => {
    const events: BootstrapEvent[] = [];
    const tracker = createWiredTracker();
    tracker.on((event) => events.push(event));

    tracker.processEvent(makeValidEvent(peerPubkey, 1000));
    await tracker.peerWith(peerPubkey);

    tracker.processEvent(makeEvent(peerPubkey, '', 1001));

    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'bootstrap:peer-deregistered')
      ).toBe(true);
    });

    expect(mockAdmin.removePeer).toHaveBeenCalledWith(
      `nostr-${peerPubkey.slice(0, 16)}`
    );

    const deregistered = events.find(
      (e) => e.type === 'bootstrap:peer-deregistered'
    );
    expect(deregistered).toEqual({
      type: 'bootstrap:peer-deregistered',
      peerId: `nostr-${peerPubkey.slice(0, 16)}`,
      peerPubkey,
      reason: 'empty-content',
    });
  });

  it('deregistration of unpeered peer removes from map silently', () => {
    const events: BootstrapEvent[] = [];
    const tracker = createTracker();
    tracker.on((event) => events.push(event));

    tracker.processEvent(makeValidEvent(peerPubkey, 1000));
    tracker.processEvent(makeEvent(peerPubkey, '', 1001));

    const deregistered = events.filter(
      (e) => e.type === 'bootstrap:peer-deregistered'
    );
    expect(deregistered).toHaveLength(0);

    expect(
      tracker.getDiscoveredPeers().find((p) => p.pubkey === peerPubkey)
    ).toBeUndefined();
  });

  // --- peerWith() ---

  it('peerWith() registers via connector admin and emits bootstrap:peer-registered', async () => {
    const events: BootstrapEvent[] = [];
    const tracker = createWiredTracker();
    tracker.on((event) => events.push(event));

    tracker.processEvent(makeValidEvent());
    await tracker.peerWith(peerPubkey);

    expect(mockAdmin.addPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `nostr-${peerPubkey.slice(0, 16)}`,
        url: 'ws://peer:3000',
        authToken: '',
        routes: [{ prefix: 'g.test.peer' }],
      })
    );

    const registered = events.find(
      (e) => e.type === 'bootstrap:peer-registered'
    );
    expect(registered).toEqual({
      type: 'bootstrap:peer-registered',
      peerId: `nostr-${peerPubkey.slice(0, 16)}`,
      peerPubkey,
      ilpAddress: 'g.test.peer',
    });
  });

  it('peerWith() is idempotent (second call is no-op)', async () => {
    const tracker = createWiredTracker();

    tracker.processEvent(makeValidEvent());

    await tracker.peerWith(peerPubkey);
    await tracker.peerWith(peerPubkey);

    const initialRegistrations = mockAdmin.addPeer.mock.calls.filter(
      (call: unknown[]) =>
        !(call[0] as { settlement?: unknown }).settlement
    );
    expect(initialRegistrations).toHaveLength(1);
  });

  it('peerWith() throws if peer not discovered', async () => {
    const tracker = createWiredTracker();

    await expect(tracker.peerWith('c'.repeat(64))).rejects.toThrow(
      BootstrapError
    );
    await expect(tracker.peerWith('c'.repeat(64))).rejects.toThrow(
      'not discovered yet'
    );
  });

  it('peerWith() throws if connectorAdmin not set', async () => {
    const tracker = createTracker();

    tracker.processEvent(makeValidEvent());

    await expect(tracker.peerWith(peerPubkey)).rejects.toThrow(
      BootstrapError
    );
    await expect(tracker.peerWith(peerPubkey)).rejects.toThrow(
      'connectorAdmin must be set'
    );
  });

  it('peerWith() with channel client and settlement data opens channel', async () => {
    const mockChannelClient = {
      openChannel: vi.fn().mockResolvedValue({
        channelId: 'channel-001',
      }),
      getChannelState: vi.fn(),
    };

    const peerInfoWithSettlement: IlpPeerInfo = {
      ...validPeerInfo,
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0x1234' },
    };

    const events: BootstrapEvent[] = [];
    const tracker = createDiscoveryTracker({
      secretKey,
      settlementInfo: {
        supportedChains: ['evm:base:8453'],
      },
    });
    tracker.setConnectorAdmin(mockAdmin);
    tracker.setChannelClient(mockChannelClient);
    tracker.on((event) => events.push(event));

    tracker.processEvent(
      makeEvent(peerPubkey, JSON.stringify(peerInfoWithSettlement))
    );
    await tracker.peerWith(peerPubkey);

    const opened = events.find(
      (e) => e.type === 'bootstrap:channel-opened'
    );
    expect(opened).toEqual({
      type: 'bootstrap:channel-opened',
      peerId: `nostr-${peerPubkey.slice(0, 16)}`,
      channelId: 'channel-001',
      negotiatedChain: 'evm:base:8453',
    });
  });

  it('settlement failure is non-fatal', async () => {
    const mockChannelClient = {
      openChannel: vi
        .fn()
        .mockRejectedValue(new Error('Channel open timeout')),
      getChannelState: vi.fn(),
    };

    const peerInfoWithSettlement: IlpPeerInfo = {
      ...validPeerInfo,
      supportedChains: ['evm:base:8453'],
      settlementAddresses: { 'evm:base:8453': '0x1234' },
    };

    const events: BootstrapEvent[] = [];
    const tracker = createDiscoveryTracker({
      secretKey,
      settlementInfo: {
        supportedChains: ['evm:base:8453'],
      },
    });
    tracker.setConnectorAdmin(mockAdmin);
    tracker.setChannelClient(mockChannelClient);
    tracker.on((event) => events.push(event));

    tracker.processEvent(
      makeEvent(
        peerPubkey,
        JSON.stringify(peerInfoWithSettlement),
        1000
      )
    );
    await tracker.peerWith(peerPubkey);

    expect(
      events.some((e) => e.type === 'bootstrap:peer-registered')
    ).toBe(true);
    expect(
      events.some((e) => e.type === 'bootstrap:settlement-failed')
    ).toBe(true);

    // Can still peer with another peer
    tracker.processEvent(
      makeEvent(
        peerPubkey2,
        JSON.stringify(peerInfoWithSettlement),
        1000
      )
    );
    await tracker.peerWith(peerPubkey2);

    const registered = events.filter(
      (e) => e.type === 'bootstrap:peer-registered'
    );
    expect(registered).toHaveLength(2);
  });

  // --- Counts ---

  it('getPeerCount() returns count of peered peers', async () => {
    const tracker = createWiredTracker();

    tracker.processEvent(makeValidEvent(peerPubkey, 1000));
    tracker.processEvent(makeValidEvent(peerPubkey2, 1001));

    expect(tracker.getPeerCount()).toBe(0);

    await tracker.peerWith(peerPubkey);
    expect(tracker.getPeerCount()).toBe(1);

    await tracker.peerWith(peerPubkey2);
    expect(tracker.getPeerCount()).toBe(2);
  });

  it('getDiscoveredCount() returns count of all discovered peers', () => {
    const tracker = createTracker();

    tracker.processEvent(makeValidEvent(peerPubkey, 1000));
    tracker.processEvent(makeValidEvent(peerPubkey2, 1001));

    expect(tracker.getDiscoveredCount()).toBe(2);
  });

  // --- getDiscoveredPeers / isPeered ---

  it('getDiscoveredPeers() returns discovered peers not yet peered with', () => {
    const tracker = createTracker();

    tracker.processEvent(makeValidEvent(peerPubkey, 1000));
    tracker.processEvent(makeValidEvent(peerPubkey2, 1001));

    const discovered = tracker.getDiscoveredPeers();
    expect(discovered).toHaveLength(2);
    expect(discovered.map((p) => p.pubkey)).toContain(peerPubkey);
    expect(discovered.map((p) => p.pubkey)).toContain(peerPubkey2);
  });

  it('getDiscoveredPeers() excludes peered peers', async () => {
    const tracker = createWiredTracker();

    tracker.processEvent(makeValidEvent(peerPubkey, 1000));
    tracker.processEvent(makeValidEvent(peerPubkey2, 1001));

    await tracker.peerWith(peerPubkey);

    const discovered = tracker.getDiscoveredPeers();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.pubkey).toBe(peerPubkey2);
  });

  it('isPeered() returns false for discovered but not peered', () => {
    const tracker = createTracker();

    tracker.processEvent(makeValidEvent());

    expect(tracker.isPeered(peerPubkey)).toBe(false);
  });

  it('isPeered() returns true after peerWith()', async () => {
    const tracker = createWiredTracker();

    tracker.processEvent(makeValidEvent());
    await tracker.peerWith(peerPubkey);

    expect(tracker.isPeered(peerPubkey)).toBe(true);
  });

  // --- addExcludedPubkeys ---

  it('addExcludedPubkeys() prevents discovery of specified pubkeys', () => {
    const events: BootstrapEvent[] = [];
    const tracker = createTracker();
    tracker.on((event) => events.push(event));

    tracker.addExcludedPubkeys([peerPubkey]);
    tracker.processEvent(makeValidEvent(peerPubkey));

    expect(events).toHaveLength(0);
    expect(tracker.getDiscoveredPeers()).toHaveLength(0);
  });

  // --- on()/off() ---

  it('on()/off() event listener management', () => {
    const events: BootstrapEvent[] = [];
    const listener = (event: BootstrapEvent) => events.push(event);
    const tracker = createTracker();

    tracker.on(listener);
    tracker.processEvent(makeValidEvent(peerPubkey, 1000));
    expect(events).toHaveLength(1);

    tracker.off(listener);
    tracker.processEvent(makeValidEvent(peerPubkey2, 1001));
    expect(events).toHaveLength(1); // no new events
  });
});
