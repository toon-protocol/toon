/**
 * Tests for RelayMonitor - relay subscription, passive discovery,
 * explicit peering via peerWith(), and SPSP handshake orchestration.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { RelayMonitor } from './RelayMonitor.js';
import { BootstrapError } from './BootstrapService.js';
import type {
  ConnectorAdminClient,
  AgentRuntimeClient,
  BootstrapEvent,
  IlpSendResult,
} from './types.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import type { IlpPeerInfo } from '../types.js';

// Capture the onevent handler from pool.subscribeMany
let capturedOnevent: ((event: NostrEvent) => void) | null = null;

// Mock SimplePool
vi.mock('nostr-tools/pool', () => ({
  SimplePool: vi.fn(() => ({
    subscribeMany: vi.fn((_relays: string[], _filters: unknown[], opts: { onevent: (event: NostrEvent) => void }) => {
      capturedOnevent = opts.onevent;
      const closer = { close: vi.fn() };
      return closer;
    }),
  })),
}));

// Mock IlpSpspClient
vi.mock('../spsp/IlpSpspClient.js', () => ({
  IlpSpspClient: vi.fn().mockImplementation(() => ({
    requestSpspInfo: vi.fn(),
  })),
}));

import { IlpSpspClient } from '../spsp/IlpSpspClient.js';
import { SimplePool } from 'nostr-tools/pool';

/** Safely invoke capturedOnevent, throwing if not yet captured. */
function fireEvent(event: NostrEvent): void {
  if (!capturedOnevent) throw new Error('onevent not captured yet');
  capturedOnevent(event);
}

describe('RelayMonitor', () => {
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
  let mockAgentRuntime: AgentRuntimeClient;
  let mockToonEncoder: (event: NostrEvent) => Uint8Array;
  let mockToonDecoder: (bytes: Uint8Array) => NostrEvent;
  let mockSpspRequestSpspInfo: Mock;

  function createMonitor(basePricePerByte?: bigint): RelayMonitor {
    return new RelayMonitor(
      {
        relayUrl: 'ws://localhost:7100',
        secretKey,
        toonEncoder: mockToonEncoder,
        toonDecoder: mockToonDecoder,
        basePricePerByte,
      }
    );
  }

  /** Create a monitor with admin + runtime wired up (ready for peerWith). */
  function createWiredMonitor(basePricePerByte?: bigint): RelayMonitor {
    const monitor = createMonitor(basePricePerByte);
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    return monitor;
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
    capturedOnevent = null;

    mockAdmin = {
      addPeer: vi.fn().mockResolvedValue(undefined),
      removePeer: vi.fn().mockResolvedValue(undefined),
    };
    mockAgentRuntime = {
      sendIlpPacket: vi.fn<[], Promise<IlpSendResult>>().mockResolvedValue({
        accepted: true,
        fulfillment: 'test-fulfillment',
        data: Buffer.from('response').toString('base64'),
      }),
    };
    mockToonEncoder = vi.fn<[NostrEvent], Uint8Array>((_event) =>
      new TextEncoder().encode('encoded-toon-data')
    );
    mockToonDecoder = vi.fn<[Uint8Array], NostrEvent>((_bytes) => ({}) as NostrEvent);

    // Reset mock IlpSpspClient so requestSpspInfo is fresh
    mockSpspRequestSpspInfo = vi.fn().mockResolvedValue({
      destinationAccount: 'g.test.peer.spsp.123',
      sharedSecret: 'secret123',
    });
    (IlpSpspClient as unknown as Mock).mockImplementation(() => ({
      requestSpspInfo: mockSpspRequestSpspInfo,
    }));
  });

  // --- Discovery-only mode (no admin/runtime needed) ---

  it('start() works without connectorAdmin or agentRuntimeClient (discovery-only)', () => {
    const monitor = createMonitor();
    // Should NOT throw
    const sub = monitor.start();
    expect(sub).toHaveProperty('unsubscribe');
    sub.unsubscribe();
  });

  it('emits bootstrap:peer-discovered event on new event (discovery-only)', () => {
    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.on((event) => events.push(event));
    monitor.start();

    fireEvent(makeValidEvent());

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'bootstrap:peer-discovered',
      peerPubkey,
      ilpAddress: 'g.test.peer',
    });
  });

  // --- Subscription ---

  it('subscribes to relay for kind:10032 events with correct filter', () => {
    const monitor = createMonitor();
    const pool = (SimplePool as unknown as Mock).mock.results[0]!.value;
    monitor.start();

    expect(pool.subscribeMany).toHaveBeenCalledWith(
      ['ws://localhost:7100'],
      { kinds: [ILP_PEER_INFO_KIND] },
      expect.objectContaining({ onevent: expect.any(Function) })
    );
  });

  // --- getDiscoveredPeers / isPeered ---

  it('getDiscoveredPeers() returns discovered peers not yet peered with', () => {
    const monitor = createMonitor();
    monitor.start();

    fireEvent(makeValidEvent(peerPubkey, 1000));
    fireEvent(makeValidEvent(peerPubkey2, 1001));

    const discovered = monitor.getDiscoveredPeers();
    expect(discovered).toHaveLength(2);
    expect(discovered.map((p) => p.pubkey)).toContain(peerPubkey);
    expect(discovered.map((p) => p.pubkey)).toContain(peerPubkey2);
  });

  it('isPeered() returns false for discovered but not peered', () => {
    const monitor = createMonitor();
    monitor.start();

    fireEvent(makeValidEvent());

    expect(monitor.isPeered(peerPubkey)).toBe(false);
  });

  it('isPeered() returns true after peerWith()', async () => {
    const monitor = createWiredMonitor();
    monitor.start();

    fireEvent(makeValidEvent());
    await monitor.peerWith(peerPubkey);

    expect(monitor.isPeered(peerPubkey)).toBe(true);
  });

  it('getDiscoveredPeers() excludes peered peers', async () => {
    const monitor = createWiredMonitor();
    monitor.start();

    fireEvent(makeValidEvent(peerPubkey, 1000));
    fireEvent(makeValidEvent(peerPubkey2, 1001));

    await monitor.peerWith(peerPubkey);

    const discovered = monitor.getDiscoveredPeers();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.pubkey).toBe(peerPubkey2);
  });

  // --- peerWith() precondition checks ---

  it('peerWith() throws if peer not discovered', async () => {
    const monitor = createWiredMonitor();
    monitor.start();

    await expect(monitor.peerWith('c'.repeat(64))).rejects.toThrow(BootstrapError);
    await expect(monitor.peerWith('c'.repeat(64))).rejects.toThrow('not discovered yet');
  });

  it('peerWith() throws if connectorAdmin not set', async () => {
    const monitor = createMonitor();
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.start();

    fireEvent(makeValidEvent());

    await expect(monitor.peerWith(peerPubkey)).rejects.toThrow(BootstrapError);
    await expect(monitor.peerWith(peerPubkey)).rejects.toThrow('connectorAdmin must be set');
  });

  it('peerWith() throws if agentRuntimeClient not set', async () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.start();

    fireEvent(makeValidEvent());

    await expect(monitor.peerWith(peerPubkey)).rejects.toThrow(BootstrapError);
    await expect(monitor.peerWith(peerPubkey)).rejects.toThrow('agentRuntimeClient must be set');
  });

  // --- peerWith() idempotency ---

  it('peerWith() is idempotent (second call is no-op)', async () => {
    const monitor = createWiredMonitor();
    monitor.start();

    fireEvent(makeValidEvent());

    await monitor.peerWith(peerPubkey);
    await monitor.peerWith(peerPubkey);

    // addPeer should only be called once for initial registration
    // (plus possibly once for settlement update, depending on SPSP response)
    const initialRegistrations = mockAdmin.addPeer.mock.calls.filter(
      (call: unknown[]) => !(call[0] as { settlement?: unknown }).settlement
    );
    expect(initialRegistrations).toHaveLength(1);
  });

  // --- Peer registration via peerWith ---

  it('peerWith() registers discovered peer via addPeer() with correct peerId and routes', async () => {
    const monitor = createWiredMonitor();
    monitor.start();

    fireEvent(makeValidEvent());
    await monitor.peerWith(peerPubkey);

    expect(mockAdmin.addPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `nostr-${peerPubkey.slice(0, 16)}`,
        url: 'ws://peer:3000',
        authToken: '',
        routes: [{ prefix: 'g.test.peer' }],
      })
    );
  });

  // --- SPSP handshake via peerWith ---

  it('peerWith() sends paid SPSP handshake for peer', async () => {
    const monitor = createWiredMonitor();
    monitor.start();

    fireEvent(makeValidEvent());
    await monitor.peerWith(peerPubkey);

    expect(mockSpspRequestSpspInfo).toHaveBeenCalledWith(
      peerPubkey,
      'g.test.peer',
      expect.objectContaining({
        amount: expect.any(String),
        timeout: 30000,
      })
    );
  });

  it('peerWith() updates registration with channel/settlement info from handshake', async () => {
    mockSpspRequestSpspInfo.mockResolvedValueOnce({
      destinationAccount: 'g.test.peer.spsp.123',
      sharedSecret: 'secret123',
      settlement: {
        negotiatedChain: 'evm:base:8453',
        settlementAddress: '0x1234',
        channelId: 'channel-001',
      },
    });

    const monitor = createWiredMonitor();
    monitor.start();

    fireEvent(makeValidEvent());
    await monitor.peerWith(peerPubkey);

    // Second call should include settlement info
    expect(mockAdmin.addPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `nostr-${peerPubkey.slice(0, 16)}`,
        settlement: expect.objectContaining({
          preference: 'evm:base:8453',
          evmAddress: '0x1234',
          channelId: 'channel-001',
        }),
      })
    );
  });

  // --- Event emissions ---

  it('emits bootstrap:peer-registered event after peerWith()', async () => {
    const events: BootstrapEvent[] = [];
    const monitor = createWiredMonitor();
    monitor.on((event) => events.push(event));
    monitor.start();

    fireEvent(makeValidEvent());
    await monitor.peerWith(peerPubkey);

    const registered = events.find((e) => e.type === 'bootstrap:peer-registered');
    expect(registered).toEqual({
      type: 'bootstrap:peer-registered',
      peerId: `nostr-${peerPubkey.slice(0, 16)}`,
      peerPubkey,
      ilpAddress: 'g.test.peer',
    });
  });

  it('emits bootstrap:channel-opened event after peerWith() handshake with channel', async () => {
    mockSpspRequestSpspInfo.mockResolvedValueOnce({
      destinationAccount: 'g.test.peer.spsp.123',
      sharedSecret: 'secret123',
      settlement: {
        negotiatedChain: 'evm:base:8453',
        settlementAddress: '0x1234',
        channelId: 'channel-001',
      },
    });

    const events: BootstrapEvent[] = [];
    const monitor = createWiredMonitor();
    monitor.on((event) => events.push(event));
    monitor.start();

    fireEvent(makeValidEvent());
    await monitor.peerWith(peerPubkey);

    const opened = events.find((e) => e.type === 'bootstrap:channel-opened');
    expect(opened).toEqual({
      type: 'bootstrap:channel-opened',
      peerId: `nostr-${peerPubkey.slice(0, 16)}`,
      channelId: 'channel-001',
      negotiatedChain: 'evm:base:8453',
    });
  });

  // --- Deregistration (AC 7) ---

  it('kind:10032 with empty content triggers deregistration of a peered peer', async () => {
    const events: BootstrapEvent[] = [];
    const monitor = createWiredMonitor();
    monitor.on((event) => events.push(event));
    monitor.start();

    // First discover and peer
    fireEvent(makeValidEvent(peerPubkey, 1000));
    await monitor.peerWith(peerPubkey);

    // Then send empty content event with newer timestamp
    fireEvent(makeEvent(peerPubkey, '', 1001));

    // Wait for async removePeer
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'bootstrap:peer-deregistered')).toBe(true);
    });

    expect(mockAdmin.removePeer).toHaveBeenCalledWith(`nostr-${peerPubkey.slice(0, 16)}`);

    const deregistered = events.find((e) => e.type === 'bootstrap:peer-deregistered');
    expect(deregistered).toEqual({
      type: 'bootstrap:peer-deregistered',
      peerId: `nostr-${peerPubkey.slice(0, 16)}`,
      peerPubkey,
      reason: 'empty-content',
    });
  });

  it('empty content for a discovered-but-not-peered peer does NOT emit deregistered', () => {
    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.on((event) => events.push(event));
    monitor.start();

    // Discover but don't peer
    fireEvent(makeValidEvent(peerPubkey, 1000));

    // Send empty content
    fireEvent(makeEvent(peerPubkey, '', 1001));

    const deregistered = events.filter((e) => e.type === 'bootstrap:peer-deregistered');
    expect(deregistered).toHaveLength(0);

    // Peer should be removed from discoveredPeers
    expect(monitor.getDiscoveredPeers().find((p) => p.pubkey === peerPubkey)).toBeUndefined();
  });

  // --- Stale events ---

  it('stale events (older timestamp) are ignored', () => {
    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.on((event) => events.push(event));
    monitor.start();

    // Send newer event first
    fireEvent(makeValidEvent(peerPubkey, 2000));

    // Send stale event (older timestamp)
    fireEvent(makeValidEvent(peerPubkey, 1000));

    // Only one discovery event
    const discoveries = events.filter((e) => e.type === 'bootstrap:peer-discovered');
    expect(discoveries).toHaveLength(1);
  });

  // --- Error handling ---

  it('SPSP handshake failure is non-fatal (peer remains registered, monitoring continues)', async () => {
    mockSpspRequestSpspInfo.mockRejectedValueOnce(new Error('SPSP timeout'));

    const events: BootstrapEvent[] = [];
    const monitor = createWiredMonitor();
    monitor.on((event) => events.push(event));
    monitor.start();

    fireEvent(makeValidEvent(peerPubkey, 1000));
    await monitor.peerWith(peerPubkey);

    // Peer was still registered
    expect(events.some((e) => e.type === 'bootstrap:peer-registered')).toBe(true);
    // Handshake failure emitted
    expect(events.some((e) => e.type === 'bootstrap:handshake-failed')).toBe(true);

    // Can still peer with a different peer (monitoring continues)
    fireEvent(makeValidEvent(peerPubkey2, 1000));
    await monitor.peerWith(peerPubkey2);

    const registered = events.filter((e) => e.type === 'bootstrap:peer-registered');
    expect(registered).toHaveLength(2);
  });

  // --- Unsubscribe ---

  it('unsubscribe stops event processing', () => {
    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.on((event) => events.push(event));

    const pool = (SimplePool as unknown as Mock).mock.results[0]!.value;
    const subscription = monitor.start();

    // Get the subCloser
    const subCloser = pool.subscribeMany.mock.results[0]!.value;

    subscription.unsubscribe();

    expect(subCloser.close).toHaveBeenCalled();

    // Events after unsubscribe should be ignored
    fireEvent(makeValidEvent());

    expect(events).toHaveLength(0);
  });

  // --- Excludes own pubkey ---

  it('excludes own pubkey from discovery', () => {
    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.on((event) => events.push(event));
    monitor.start();

    // Send event from our own pubkey
    fireEvent(makeValidEvent(pubkey));

    expect(events).toHaveLength(0);
    expect(monitor.getDiscoveredPeers()).toHaveLength(0);
  });
});
