/**
 * Tests for RelayMonitor - relay subscription, event processing,
 * reverse registration, and SPSP handshake orchestration.
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
    addPeer: ReturnType<typeof vi.fn>;
    removePeer: ReturnType<typeof vi.fn>;
  };
  let mockAgentRuntime: AgentRuntimeClient & {
    sendIlpPacket: ReturnType<typeof vi.fn>;
  };
  let mockToonEncoder: ReturnType<typeof vi.fn>;
  let mockToonDecoder: ReturnType<typeof vi.fn>;
  let mockSpspRequestSpspInfo: ReturnType<typeof vi.fn>;

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
      sendIlpPacket: vi.fn(async (): Promise<IlpSendResult> => ({
        accepted: true,
        fulfillment: 'test-fulfillment',
        data: Buffer.from('response').toString('base64'),
      })),
    };
    mockToonEncoder = vi.fn((_event: NostrEvent) =>
      new TextEncoder().encode('encoded-toon-data')
    );
    mockToonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    // Reset mock IlpSpspClient so requestSpspInfo is fresh
    mockSpspRequestSpspInfo = vi.fn(async () => ({
      destinationAccount: 'g.test.peer.spsp.123',
      sharedSecret: 'secret123',
    }));
    (IlpSpspClient as unknown as Mock).mockImplementation(() => ({
      requestSpspInfo: mockSpspRequestSpspInfo,
    }));
  });

  // --- Precondition checks ---

  it('throws BootstrapError if connectorAdmin not set before start()', () => {
    const monitor = createMonitor();
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    expect(() => monitor.start()).toThrow(BootstrapError);
    expect(() => monitor.start()).toThrow('connectorAdmin must be set');
  });

  it('throws BootstrapError if agentRuntimeClient not set before start()', () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    expect(() => monitor.start()).toThrow(BootstrapError);
    expect(() => monitor.start()).toThrow('agentRuntimeClient must be set');
  });

  // --- Subscription ---

  it('subscribes to relay for kind:10032 events with correct filter', () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);

    const pool = (SimplePool as unknown as Mock).mock.results[0].value;
    monitor.start();

    expect(pool.subscribeMany).toHaveBeenCalledWith(
      ['ws://localhost:7100'],
      [{ kinds: [ILP_PEER_INFO_KIND] }],
      expect.objectContaining({ onevent: expect.any(Function) })
    );
  });

  // --- Peer registration ---

  it('registers discovered peer via addPeer() with correct peerId and routes', async () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.start();

    expect(capturedOnevent).toBeTruthy();
    fireEvent(makeValidEvent());

    await vi.waitFor(() => {
      expect(mockAdmin.addPeer).toHaveBeenCalled();
    });

    expect(mockAdmin.addPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `nostr-${peerPubkey.slice(0, 16)}`,
        url: 'ws://peer:3000',
        authToken: '',
        routes: [{ prefix: 'g.test.peer' }],
      })
    );
  });

  // --- SPSP handshake ---

  it('sends paid SPSP handshake for newly discovered peer', async () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.start();

    fireEvent(makeValidEvent());

    await vi.waitFor(() => {
      expect(mockSpspRequestSpspInfo).toHaveBeenCalled();
    });

    expect(mockSpspRequestSpspInfo).toHaveBeenCalledWith(
      peerPubkey,
      'g.test.peer',
      expect.objectContaining({
        amount: expect.any(String),
        timeout: 30000,
      })
    );
  });

  it('updates registration with channel/settlement info from handshake', async () => {
    mockSpspRequestSpspInfo.mockResolvedValueOnce({
      destinationAccount: 'g.test.peer.spsp.123',
      sharedSecret: 'secret123',
      settlement: {
        negotiatedChain: 'evm:base:8453',
        settlementAddress: '0x1234',
        channelId: 'channel-001',
      },
    });

    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.start();

    fireEvent(makeValidEvent());

    await vi.waitFor(() => {
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(2);
    });

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

  it('emits bootstrap:peer-discovered event on new event', async () => {
    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.on((event) => events.push(event));
    monitor.start();

    fireEvent(makeValidEvent());

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'bootstrap:peer-discovered')).toBe(true);
    });

    const discovered = events.find((e) => e.type === 'bootstrap:peer-discovered');
    expect(discovered).toEqual({
      type: 'bootstrap:peer-discovered',
      peerPubkey,
      ilpAddress: 'g.test.peer',
    });
  });

  it('emits bootstrap:peer-registered event after registration', async () => {
    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.on((event) => events.push(event));
    monitor.start();

    fireEvent(makeValidEvent());

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'bootstrap:peer-registered')).toBe(true);
    });

    const registered = events.find((e) => e.type === 'bootstrap:peer-registered');
    expect(registered).toEqual({
      type: 'bootstrap:peer-registered',
      peerId: `nostr-${peerPubkey.slice(0, 16)}`,
      peerPubkey,
      ilpAddress: 'g.test.peer',
    });
  });

  it('emits bootstrap:channel-opened event after handshake with channel', async () => {
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
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.on((event) => events.push(event));
    monitor.start();

    fireEvent(makeValidEvent());

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'bootstrap:channel-opened')).toBe(true);
    });

    const opened = events.find((e) => e.type === 'bootstrap:channel-opened');
    expect(opened).toEqual({
      type: 'bootstrap:channel-opened',
      peerId: `nostr-${peerPubkey.slice(0, 16)}`,
      channelId: 'channel-001',
      negotiatedChain: 'evm:base:8453',
    });
  });

  // --- Idempotency (AC 6) ---

  it('duplicate kind:10032 from same pubkey does NOT re-register (idempotent)', async () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.start();

    const event1 = makeValidEvent(peerPubkey, 1000);
    const event2 = makeValidEvent(peerPubkey, 1001);

    fireEvent(event1);

    // Wait for full processing (SPSP handshake happens after registeredPeers.add)
    await vi.waitFor(() => {
      expect(mockSpspRequestSpspInfo).toHaveBeenCalledTimes(1);
    });

    // Second event from same pubkey (newer timestamp) — should be skipped
    fireEvent(event2);

    // Small delay to ensure processing would have occurred
    await new Promise((r) => setTimeout(r, 50));

    // addPeer should only be called once (initial registration)
    // No second initial registration since peer is already in registeredPeers
    const addPeerCalls = mockAdmin.addPeer.mock.calls;
    const initialRegistrations = addPeerCalls.filter(
      (call: unknown[]) => !(call[0] as { settlement?: unknown }).settlement
    );
    expect(initialRegistrations).toHaveLength(1);
  });

  // --- Deregistration (AC 7) ---

  it('kind:10032 with empty content triggers deregistration', async () => {
    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.on((event) => events.push(event));
    monitor.start();

    // First register the peer
    fireEvent(makeValidEvent(peerPubkey, 1000));

    // Wait for full processing (SPSP handshake happens after registeredPeers.add)
    await vi.waitFor(() => {
      expect(mockSpspRequestSpspInfo).toHaveBeenCalledTimes(1);
    });

    // Then send empty content event with newer timestamp
    fireEvent(makeEvent(peerPubkey, '', 1001));

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

  // --- Stale events ---

  it('stale events (older timestamp) are ignored', async () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.start();

    // Send newer event first
    fireEvent(makeValidEvent(peerPubkey, 2000));

    await vi.waitFor(() => {
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(1);
    });

    // Send stale event (older timestamp)
    fireEvent(makeValidEvent(peerPubkey, 1000));

    await new Promise((r) => setTimeout(r, 50));

    // Should not re-process — still only 1 initial registration
    const initialRegistrations = mockAdmin.addPeer.mock.calls.filter(
      (call: unknown[]) => !(call[0] as { settlement?: unknown }).settlement
    );
    expect(initialRegistrations).toHaveLength(1);
  });

  // --- Error handling ---

  it('SPSP handshake failure is non-fatal (peer remains registered, monitoring continues)', async () => {
    mockSpspRequestSpspInfo.mockRejectedValueOnce(new Error('SPSP timeout'));

    const events: BootstrapEvent[] = [];
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.on((event) => events.push(event));
    monitor.start();

    fireEvent(makeValidEvent(peerPubkey, 1000));

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'bootstrap:handshake-failed')).toBe(true);
    });

    // Peer was still registered
    expect(events.some((e) => e.type === 'bootstrap:peer-registered')).toBe(true);

    // Can still process a different peer (monitoring continues)
    fireEvent(makeValidEvent(peerPubkey2, 1000));

    await vi.waitFor(() => {
      const registered = events.filter((e) => e.type === 'bootstrap:peer-registered');
      expect(registered).toHaveLength(2);
    });
  });

  // --- Unsubscribe ---

  it('unsubscribe stops event processing', async () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);

    const pool = (SimplePool as unknown as Mock).mock.results[0].value;
    const subscription = monitor.start();

    // Get the subCloser
    const subCloser = pool.subscribeMany.mock.results[0].value;

    subscription.unsubscribe();

    expect(subCloser.close).toHaveBeenCalled();

    // Events after unsubscribe should be ignored
    fireEvent(makeValidEvent());

    await new Promise((r) => setTimeout(r, 50));
    expect(mockAdmin.addPeer).not.toHaveBeenCalled();
  });

  // --- Excludes own pubkey ---

  it('excludes own pubkey from discovery', async () => {
    const monitor = createMonitor();
    monitor.setConnectorAdmin(mockAdmin);
    monitor.setAgentRuntimeClient(mockAgentRuntime);
    monitor.start();

    // Send event from our own pubkey
    fireEvent(makeValidEvent(pubkey));

    await new Promise((r) => setTimeout(r, 50));
    expect(mockAdmin.addPeer).not.toHaveBeenCalled();
  });
});
