/**
 * Tests for BootstrapService — two-phase bootstrap lifecycle.
 *
 * Phase 1: Discover peers via relay kind:10032, register with connector
 * Phase 2: Announce own kind:10032 as paid ILP PREPARE
 *
 * Infrastructure: Real nostr-tools crypto. Mocks only at transport
 * boundaries (WebSocket, SimplePool, connectorAdmin, ilpClient).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { BootstrapService, BootstrapError } from './BootstrapService.js';
import type {
  ConnectorAdminClient,
  IlpClient,
  BootstrapEvent,
  IlpSendResult,
  KnownPeer,
} from './types.js';
import type { IlpPeerInfo } from '../types.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { GenesisPeerLoader } from '../discovery/index.js';
import type { GenesisPeer } from '../discovery/index.js';

// ============================================================================
// Mock: WebSocket transport (the only true boundary mock)
// ============================================================================

/** Captured WebSocket handlers so tests can inject relay responses. */
let capturedWs: {
  onOpen?: () => void;
  onMessage?: (data: Buffer) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock('ws', () => ({
  default: vi.fn().mockImplementation(() => {
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'open') capturedWs!.onOpen = handler as () => void;
        if (event === 'message')
          capturedWs!.onMessage = handler as (data: Buffer) => void;
        if (event === 'error')
          capturedWs!.onError = handler as (err: Error) => void;
        if (event === 'close') capturedWs!.onClose = handler as () => void;
      }),
    };
    capturedWs = ws;
    return ws;
  }),
}));

// Mock SimplePool (used only for publishOurInfo in non-ILP flow)
vi.mock('nostr-tools/pool', () => ({
  SimplePool: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    querySync: vi.fn().mockResolvedValue([]),
    subscribeMany: vi.fn(() => ({ close: vi.fn() })),
  })),
}));

// Isolate tests from genesis-peers.json content so adding real peers
// doesn't introduce live network connections or timing-dependent failures.
vi.mock('../discovery/index.js', () => ({
  GenesisPeerLoader: {
    loadAllPeers: vi.fn().mockReturnValue([]),
    loadGenesisPeers: vi.fn().mockReturnValue([]),
    loadAdditionalPeers: vi.fn().mockReturnValue([]),
  },
  ArDrivePeerRegistry: {
    fetchPeers: vi.fn().mockResolvedValue(new Map()),
  },
}));

// ============================================================================
// Factories
// ============================================================================

/** Deterministic timestamp for reproducible tests (2026-01-01T00:00:00Z) */
const TEST_CREATED_AT = 1767225600;

const VALID_PEER_PUBKEY = 'aa'.repeat(32);
const VALID_PEER_INFO: IlpPeerInfo = {
  ilpAddress: 'g.test.peer',
  btpEndpoint: 'ws://peer:3000',
  assetCode: 'USD',
  assetScale: 6,
};

function createKnownPeer(overrides: Partial<KnownPeer> = {}): KnownPeer {
  return {
    pubkey: VALID_PEER_PUBKEY,
    relayUrl: 'ws://localhost:7100',
    btpEndpoint: 'ws://peer:3000',
    ...overrides,
  };
}

function createMockConnectorAdmin(): ConnectorAdminClient & {
  addPeer: ReturnType<typeof vi.fn>;
  removePeer: ReturnType<typeof vi.fn>;
} {
  return {
    addPeer: vi.fn().mockResolvedValue(undefined),
    removePeer: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockIlpClient(result: Partial<IlpSendResult> = {}): IlpClient & {
  sendIlpPacket: ReturnType<typeof vi.fn>;
  sendIlpPacketWithClaim: ReturnType<typeof vi.fn>;
} {
  const defaultResult = {
    accepted: true,
    fulfillment: 'test-fulfillment',
    data: undefined,
    ...result,
  };
  return {
    sendIlpPacket: vi.fn().mockResolvedValue(defaultResult),
    sendIlpPacketWithClaim: vi.fn().mockResolvedValue(defaultResult),
  };
}

/**
 * Simulate the relay responding with a kind:10032 event for the peer.
 * Must be called after a WebSocket connection is established.
 *
 * The response honours the REQ's `authors` filter the way a real relay
 * does: an event whose author is absent from `authors` is never delivered,
 * so the subscription sees only EOSE with zero events. A REQ without
 * `authors` (e.g. the `discoverPeersViaRelay` filter) restricts nothing.
 * That fidelity is what lets the toon#175 self-heal tests prove the author
 * filter is load-bearing rather than incidental.
 */
function simulateRelayResponse(
  peerInfo: IlpPeerInfo,
  pubkey = VALID_PEER_PUBKEY
): void {
  if (!capturedWs?.onOpen || !capturedWs?.onMessage) {
    throw new Error(
      'WebSocket handlers not captured — call after BootstrapService triggers connection'
    );
  }

  // Trigger WS open → service sends REQ
  capturedWs.onOpen();

  const [, subId, filter] = JSON.parse(
    (capturedWs.send.mock.calls[0]?.[0] as string) ?? '["REQ","unknown",{}]'
  ) as [string, string, Filter];

  // Build a fake kind:10032 event with peer info in content
  const event = {
    id: 'ee'.repeat(32),
    pubkey,
    created_at: TEST_CREATED_AT,
    kind: ILP_PEER_INFO_KIND,
    tags: [],
    content: JSON.stringify(peerInfo),
    sig: 'ff'.repeat(64),
  };

  // Send EVENT (only if the filter would have matched it) then EOSE
  if (!filter.authors || filter.authors.includes(pubkey)) {
    capturedWs.onMessage(Buffer.from(JSON.stringify(['EVENT', subId, event])));
  }
  capturedWs.onMessage(Buffer.from(JSON.stringify(['EOSE', subId])));
}

// ============================================================================
// Tests
// ============================================================================

describe('BootstrapService', () => {
  let secretKey: Uint8Array;
  let pubkey: string;
  let ownIlpInfo: IlpPeerInfo;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedWs = null;

    // Real nostr-tools crypto for identity
    secretKey = generateSecretKey();
    pubkey = getPublicKey(secretKey);
    ownIlpInfo = {
      ilpAddress: 'g.test.self',
      btpEndpoint: 'ws://self:3000',
      assetCode: 'USD',
      assetScale: 6,
    };
  });

  afterEach(() => {
    // Note: do NOT use vi.restoreAllMocks() here — it undoes the
    // vi.mock('ws') implementation set up at module scope.
  });

  // ---------------------------------------------------------------------------
  // Constructor & getPubkey
  // ---------------------------------------------------------------------------

  it('should derive pubkey from real nostr-tools secretKey', () => {
    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );

    expect(service.getPubkey()).toBe(pubkey);
    expect(service.getPubkey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should default to discovering phase', () => {
    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );

    expect(service.getPhase()).toBe('discovering');
  });

  // ---------------------------------------------------------------------------
  // bootstrapWithPeer — pubkey validation
  // ---------------------------------------------------------------------------

  it('should reject invalid pubkey format (uppercase)', async () => {
    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );

    await expect(
      service.bootstrapWithPeer(createKnownPeer({ pubkey: 'AA'.repeat(32) }))
    ).rejects.toThrow(BootstrapError);
  });

  it('should reject invalid pubkey format (too short)', async () => {
    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );

    await expect(
      service.bootstrapWithPeer(createKnownPeer({ pubkey: 'aa'.repeat(16) }))
    ).rejects.toThrow(BootstrapError);
  });

  // ---------------------------------------------------------------------------
  // bootstrapWithPeer — relay query + connector registration
  // ---------------------------------------------------------------------------

  it('should query relay for kind:10032 and register peer with connector', async () => {
    const admin = createMockConnectorAdmin();
    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);

    const knownPeer = createKnownPeer();
    const bootstrapPromise = service.bootstrapWithPeer(knownPeer);

    // Wait for WS connection to be created
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    const result = await bootstrapPromise;

    // Verify result shape
    expect(result.registeredPeerId).toBe(
      `nostr-${VALID_PEER_PUBKEY.slice(0, 16)}`
    );
    expect(result.peerInfo.ilpAddress).toBe('g.test.peer');
    expect(result.peerInfo.btpEndpoint).toBe('ws://peer:3000');
    expect(result.knownPeer).toBe(knownPeer);

    // Verify connector registration
    expect(admin.addPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `nostr-${VALID_PEER_PUBKEY.slice(0, 16)}`,
        url: 'ws://peer:3000',
        authToken: '',
        routes: [{ prefix: 'g.test.peer' }],
      })
    );
  });

  it('should continue when connector registration fails (non-fatal)', async () => {
    const admin = createMockConnectorAdmin();
    admin.addPeer.mockRejectedValueOnce(new Error('connector down'));

    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);

    const bootstrapPromise = service.bootstrapWithPeer(createKnownPeer());
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    // Should not throw — connector failure is non-fatal
    const result = await bootstrapPromise;
    expect(result.registeredPeerId).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // bootstrap() — full lifecycle
  // ---------------------------------------------------------------------------

  it('should return empty array when no known peers', async () => {
    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );

    const results = await service.bootstrap();
    expect(results).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Event emitter
  // ---------------------------------------------------------------------------

  it('should emit bootstrap:peer-registered on successful registration', async () => {
    const events: BootstrapEvent[] = [];
    const admin = createMockConnectorAdmin();
    const service = new BootstrapService(
      { knownPeers: [createKnownPeer()], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    await bootstrapPromise;

    const registered = events.find(
      (e) => e.type === 'bootstrap:peer-registered'
    );
    expect(registered).toEqual({
      type: 'bootstrap:peer-registered',
      peerId: `nostr-${VALID_PEER_PUBKEY.slice(0, 16)}`,
      peerPubkey: VALID_PEER_PUBKEY,
      ilpAddress: 'g.test.peer',
    });
  });

  it('should emit phase transitions during bootstrap lifecycle', async () => {
    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      { knownPeers: [createKnownPeer()], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(createMockConnectorAdmin());
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    await bootstrapPromise;

    const phases = events
      .filter((e) => e.type === 'bootstrap:phase')
      .map((e) => (e as { phase: string }).phase);

    // Without ilpClient: discovering → registering → ready
    expect(phases).toContain('discovering');
    expect(phases).toContain('registering');
    expect(phases).toContain('ready');
  });

  it('should emit bootstrap:ready with peer and channel counts', async () => {
    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      { knownPeers: [createKnownPeer()], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(createMockConnectorAdmin());
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    await bootstrapPromise;

    const ready = events.find((e) => e.type === 'bootstrap:ready');
    expect(ready).toEqual({
      type: 'bootstrap:ready',
      peerCount: 1,
      channelCount: 0,
    });
  });

  it('should support on/off for listener management', () => {
    const events: BootstrapEvent[] = [];
    const listener = (event: BootstrapEvent) => events.push(event);

    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );

    service.on(listener);
    service.off(listener);

    // Trigger bootstrap — listener should NOT fire
    void service.bootstrap();

    // Give it a tick to emit discovering phase
    expect(events).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Phase 2: Announce via ILP (peer info announcement)
  // ---------------------------------------------------------------------------

  it('should send paid ILP announcement via ilpClient for registered peers', async () => {
    const admin = createMockConnectorAdmin();
    const runtime = createMockIlpClient();

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const service = new BootstrapService(
      {
        knownPeers: [createKnownPeer()],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
        basePricePerByte: 10n,
      },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.setIlpClient(runtime);

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    await bootstrapPromise;

    // Phase 2 should send announcement via ILP
    expect(runtime.sendIlpPacket).toHaveBeenCalled();

    // Verify the ILP call used the peer's ILP address as destination
    const ilpCall = runtime.sendIlpPacket.mock.calls[0]?.[0] as
      | {
          destination: string;
          amount: string;
          data: string;
        }
      | undefined;
    expect(ilpCall?.destination).toBe('g.test.peer');

    // Amount should be toonBytes.length * basePricePerByte
    const encodedBytes = toonEncoder.mock.results[0]?.value as Uint8Array;
    const expectedAmount = String(BigInt(encodedBytes.length) * 10n);
    expect(ilpCall?.amount).toBe(expectedAmount);
  });

  it('should skip Phase 2 when ilpClient not configured', async () => {
    const admin = createMockConnectorAdmin();

    const service = new BootstrapService(
      { knownPeers: [createKnownPeer()], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    // No ilpClient set

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    const results = await bootstrapPromise;

    // Should still succeed, just no ILP announcement
    expect(results).toHaveLength(1);
  });

  it('should continue on ILP announce reject (non-fatal)', async () => {
    const admin = createMockConnectorAdmin();
    const runtime = createMockIlpClient({
      accepted: false,
      code: 'F04',
      message: 'Insufficient amount',
    });

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      {
        knownPeers: [createKnownPeer()],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
      },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.setIlpClient(runtime);
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    const results = await bootstrapPromise;

    // Bootstrap still returns the result even when ILP send is rejected (non-fatal)
    expect(results).toHaveLength(1);
    // A rejected ILP send triggers announce-failed (settlement failure is non-fatal)
    expect(events.some((e) => e.type === 'bootstrap:announce-failed')).toBe(
      true
    );
  });

  // ---------------------------------------------------------------------------
  // Phase 2: Announce via ILP
  // ---------------------------------------------------------------------------

  it('should announce own kind:10032 as paid ILP PREPARE after registration', async () => {
    const admin = createMockConnectorAdmin();
    const runtime = createMockIlpClient();

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      {
        knownPeers: [createKnownPeer()],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
        basePricePerByte: 10n,
      },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.setIlpClient(runtime);
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    await bootstrapPromise;

    // Announce phase: sends ILP packet with own kind:10032 info
    expect(runtime.sendIlpPacket.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Verify bootstrap:announced event
    const announced = events.find((e) => e.type === 'bootstrap:announced');
    expect(announced).toBeDefined();
    if (announced?.type === 'bootstrap:announced') {
      expect(announced.peerId).toBe(`nostr-${VALID_PEER_PUBKEY.slice(0, 16)}`);
      expect(announced.eventId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('should use sendIlpPacketWithClaim when claimSigner and channelId are present', async () => {
    const admin = createMockConnectorAdmin();
    const runtime = createMockIlpClient();

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      {
        knownPeers: [createKnownPeer()],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
        basePricePerByte: 10n,
      },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.setIlpClient(runtime);
    service.setClaimSigner(async (_channelId: string, _amount: bigint) => ({
      type: 'mock-claim',
    }));
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());

    // Simulate relay response with settlement-capable peer info
    const peerInfoWithSettlement: IlpPeerInfo = {
      ...VALID_PEER_INFO,
      supportedChains: ['evm:anvil:31337'],
      settlementAddresses: { 'evm:anvil:31337': '0x1234' },
    };
    simulateRelayResponse(peerInfoWithSettlement);

    await bootstrapPromise;

    // Without a channelId from settlement, should fall back to sendIlpPacket
    // (no channelClient was configured, so no channel was opened)
    expect(runtime.sendIlpPacket).toHaveBeenCalled();
    expect(runtime.sendIlpPacketWithClaim).not.toHaveBeenCalled();
  });

  it('should use sendIlpPacket (without claim) when lazy channels are enabled (no channelId)', async () => {
    const admin = createMockConnectorAdmin();
    const runtime = createMockIlpClient();

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const mockChannelClient = {
      openChannel: vi.fn().mockResolvedValue({ channelId: '0xchannel123' }),
      getChannelState: vi.fn(),
    };

    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      {
        knownPeers: [createKnownPeer()],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
        basePricePerByte: 10n,
        settlementInfo: {
          supportedChains: ['evm:anvil:31337'],
          settlementAddresses: { 'evm:anvil:31337': '0xself' },
          preferredTokens: { 'evm:anvil:31337': '0xtoken' },
          tokenNetworks: { 'evm:anvil:31337': '0xtokennet' },
        },
      },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.setIlpClient(runtime);
    service.setChannelClient(mockChannelClient);
    service.setClaimSigner(async (_channelId: string, _amount: bigint) => ({
      type: 'mock-claim',
    }));
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());

    // Peer info with settlement support — lazy channels store metadata only
    const peerInfoWithSettlement: IlpPeerInfo = {
      ...VALID_PEER_INFO,
      supportedChains: ['evm:anvil:31337'],
      settlementAddresses: { 'evm:anvil:31337': '0xpeer' },
      tokenNetworks: { 'evm:anvil:31337': '0xtokennet' },
    };
    simulateRelayResponse(peerInfoWithSettlement);

    await bootstrapPromise;

    // Lazy channels: no channelId in result, so sendIlpPacket (without claim) is used
    expect(runtime.sendIlpPacket).toHaveBeenCalled();
    expect(runtime.sendIlpPacketWithClaim).not.toHaveBeenCalled();

    // Channel is NOT opened eagerly — negotiation metadata stored for deferred opening
    expect(mockChannelClient.openChannel).not.toHaveBeenCalled();

    // Verify bootstrap:announced event
    const announced = events.find((e) => e.type === 'bootstrap:announced');
    expect(announced).toBeDefined();
  });

  it('emits bootstrap:settlement-failed naming both chain sets when there is no overlap', async () => {
    // toon#165: a convention mismatch between the local preset and the peer's
    // announce can drop the intended chain out of the intersection entirely.
    // That must be loud, not a silent no-op.
    const admin = createMockConnectorAdmin();
    const runtime = createMockIlpClient();

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const mockChannelClient = {
      openChannel: vi.fn().mockResolvedValue({ channelId: '0xchannel123' }),
      getChannelState: vi.fn(),
    };

    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      {
        knownPeers: [createKnownPeer()],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
        basePricePerByte: 10n,
        settlementInfo: {
          supportedChains: ['evm:84532'],
        },
      },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.setIlpClient(runtime);
    service.setChannelClient(mockChannelClient);
    service.setClaimSigner(async (_channelId: string, _amount: bigint) => ({
      type: 'mock-claim',
    }));
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());

    const peerInfoNoOverlap: IlpPeerInfo = {
      ...VALID_PEER_INFO,
      supportedChains: ['solana:devnet'],
      settlementAddresses: { 'solana:devnet': 'Sol1234' },
    };
    simulateRelayResponse(peerInfoNoOverlap);

    await bootstrapPromise;

    const failure = events.find(
      (e) => e.type === 'bootstrap:settlement-failed'
    );
    expect(failure).toBeDefined();
    if (failure && failure.type === 'bootstrap:settlement-failed') {
      expect(failure.reason).toContain('evm:84532');
      expect(failure.reason).toContain('solana:devnet');
    }
    expect(mockChannelClient.openChannel).not.toHaveBeenCalled();
  });

  it('should emit bootstrap:announce-failed on announce rejection', async () => {
    const admin = createMockConnectorAdmin();
    // Announce ILP send is rejected
    const runtime = createMockIlpClient({
      accepted: false,
      code: 'F06',
      message: 'bad',
    });

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      {
        knownPeers: [createKnownPeer()],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
      },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.setIlpClient(runtime);
    service.on((event) => events.push(event));

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    await bootstrapPromise;

    expect(events.some((e) => e.type === 'bootstrap:announce-failed')).toBe(
      true
    );
  });

  // ---------------------------------------------------------------------------
  // republish() — re-advertise kind:10032 after topology changes
  // ---------------------------------------------------------------------------

  it('should re-announce to all peers via ILP when republish() is called', async () => {
    const admin = createMockConnectorAdmin();
    const runtime = createMockIlpClient();

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const service = new BootstrapService(
      {
        knownPeers: [createKnownPeer()],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
        basePricePerByte: 10n,
      },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    service.setIlpClient(runtime);

    // First bootstrap to get results
    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);
    const results = await bootstrapPromise;

    // Clear mock call counts from initial bootstrap
    runtime.sendIlpPacket.mockClear();

    // Now republish
    const successCount = await service.republish(results);

    expect(successCount).toBe(1);
    expect(runtime.sendIlpPacket).toHaveBeenCalledTimes(1);

    // Verify the ILP call targets the peer
    const ilpCall = runtime.sendIlpPacket.mock.calls[0]?.[0] as
      | { destination: string }
      | undefined;
    expect(ilpCall?.destination).toBe('g.test.peer');
  });

  it('should return 0 when republish() is called with empty results', async () => {
    const service = new BootstrapService(
      { knownPeers: [], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );

    const successCount = await service.republish([]);
    expect(successCount).toBe(0);
  });

  it('should continue on individual peer failure during republish()', async () => {
    const runtime = createMockIlpClient();
    // First call fails, second succeeds
    runtime.sendIlpPacket
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ accepted: true });

    const toonEncoder = vi.fn(
      (_event: NostrEvent) => new Uint8Array([1, 2, 3])
    );
    const toonDecoder = vi.fn((_bytes: Uint8Array) => ({}) as NostrEvent);

    const events: BootstrapEvent[] = [];
    const service = new BootstrapService(
      {
        knownPeers: [],
        ardriveEnabled: false,
        toonEncoder,
        toonDecoder,
        basePricePerByte: 10n,
      },
      secretKey,
      ownIlpInfo
    );
    service.setIlpClient(runtime);
    service.on((event) => events.push(event));

    // Fabricate two results
    const fakeResults = [
      {
        knownPeer: createKnownPeer({ pubkey: 'aa'.repeat(32) }),
        peerInfo: VALID_PEER_INFO,
        registeredPeerId: 'nostr-peer1',
      },
      {
        knownPeer: createKnownPeer({ pubkey: 'bb'.repeat(32) }),
        peerInfo: { ...VALID_PEER_INFO, ilpAddress: 'g.test.peer2' },
        registeredPeerId: 'nostr-peer2',
      },
    ];

    const successCount = await service.republish(fakeResults);

    // First failed, second succeeded
    expect(successCount).toBe(1);
    // Should have emitted announce-failed for the first peer
    const failEvents = events.filter(
      (e) => e.type === 'bootstrap:announce-failed'
    );
    expect(failEvents).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Self-heal: a stale genesis seed must resolve to the announced endpoints
  // (toon#175 / toon-meta#310). The apex-retirement design rests on
  // `queryPeerInfo` filtering `{kinds:[10032], authors:[seededPubkey]}`
  // against the seeded `relayUrl` -- so `pubkey`/`relayUrl` are load-bearing
  // while a seeded `ilpAddress`/`btpEndpoint` are only starting hints,
  // superseded by whatever the live announcement carries. If a stale seed
  // did NOT resolve to the live announcement, retiring the apex would
  // strand every already-deployed client.
  // ---------------------------------------------------------------------------

  describe('self-heal: stale seed resolves to announced endpoints', () => {
    // Arbitrary but fixed valid pubkey standing in for the adopted announce
    // key (toon-meta#310 names its real prefix as `30fdd01d…`). What matters
    // for this test is that it is the SAME author on both the seed and the
    // announcement -- not that it match production.
    const APEX_PUBKEY = 'ab'.repeat(32);
    // A different valid pubkey, used only to prove the author filter matters.
    const IMPOSTER_PUBKEY = 'cd'.repeat(32);

    // The stale genesis entry an already-deployed client would still be
    // holding: apex pubkey + apex relayUrl (both load-bearing, unchanged by
    // the retirement), plus ilpAddress/btpEndpoint pointing at the
    // now-retired apex (stale hints, expected to be superseded).
    const STALE_SEED: GenesisPeer = {
      pubkey: APEX_PUBKEY,
      // Correct because toon-meta#310 keeps this hostname pointed at the
      // relay box across the cutover, specifically so old clients can still
      // reach *something* at the address they already trust.
      relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
      // Correct because this is what the (now-retired) apex used to
      // advertise -- a stale hint the client must NOT end up using.
      ilpAddress: 'g.toon.apex',
      // Same reasoning as ilpAddress above.
      btpEndpoint: 'wss://apex.devnet.toonprotocol.dev/btp',
    };

    // The live kind:10032 the relay box announces post-cutover, authored by
    // the same adopted key. These are the values the client must end up
    // using instead of the seed's stale ones.
    const ANNOUNCED_PEER_INFO: IlpPeerInfo = {
      // Correct because toon-meta#310 has the relay box own `g.toon.relay`
      // outright post-cutover.
      ilpAddress: 'g.toon.relay',
      // Correct because this is the relay box's real BTP endpoint, distinct
      // from the apex's retired one above.
      btpEndpoint: 'wss://relay-ws.devnet.toonprotocol.dev/btp',
      assetCode: 'USD',
      assetScale: 6,
    };

    it('resolves the client to the announced endpoints, not the stale seeded ones', async () => {
      vi.mocked(GenesisPeerLoader.loadAllPeers).mockReturnValueOnce([
        STALE_SEED,
      ]);

      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      const bootstrapPromise = service.bootstrap();
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());

      // The relay enforces its own REQ filter (authors: [APEX_PUBKEY]) the
      // way a real relay would -- the announcement is delivered because its
      // author matches the seeded pubkey.
      simulateRelayResponse(ANNOUNCED_PEER_INFO, APEX_PUBKEY);

      const results = await bootstrapPromise;

      expect(results).toHaveLength(1);
      const result = results[0];
      if (!result) {
        throw new Error('unreachable: asserted results.toHaveLength(1) above');
      }

      // relayUrl and pubkey are what the client actually used to find the
      // peer -- load-bearing, unchanged from the seed.
      expect(result.knownPeer.relayUrl).toBe(STALE_SEED.relayUrl);
      expect(result.knownPeer.pubkey).toBe(STALE_SEED.pubkey);

      // The endpoints the client ends up using come from the LIVE
      // announcement, not the stale seed -- this is the self-heal claim.
      expect(result.peerInfo.ilpAddress).toBe(ANNOUNCED_PEER_INFO.ilpAddress);
      expect(result.peerInfo.btpEndpoint).toBe(ANNOUNCED_PEER_INFO.btpEndpoint);
      expect(result.peerInfo.ilpAddress).not.toBe(STALE_SEED.ilpAddress);
      expect(result.peerInfo.btpEndpoint).not.toBe(STALE_SEED.btpEndpoint);
    });

    it('does not resolve when the announcement is authored by a different pubkey', async () => {
      // Proves the author filter -- not just the relayUrl -- is what makes
      // self-heal work: an identical announcement signed by anyone other
      // than the seeded pubkey must NOT be treated as authoritative.
      vi.mocked(GenesisPeerLoader.loadAllPeers).mockReturnValueOnce([
        STALE_SEED,
      ]);

      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      const bootstrapPromise = service.bootstrap();
      await vi.waitFor(() => expect(capturedWs).not.toBeNull());

      // Same announced endpoints, but authored by IMPOSTER_PUBKEY. A relay
      // honoring `authors: [APEX_PUBKEY]` would never deliver this event.
      simulateRelayResponse(ANNOUNCED_PEER_INFO, IMPOSTER_PUBKEY);

      const results = await bootstrapPromise;

      // No event matched the filter, so queryPeerInfo saw 0 events at EOSE,
      // bootstrapWithPeer rejected, and bootstrap()'s per-peer try/catch
      // swallowed it -- no result for this peer.
      expect(results).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // BootstrapError
  // ---------------------------------------------------------------------------

  it('BootstrapError should have correct name and code', () => {
    const error = new BootstrapError('test message');
    expect(error.name).toBe('BootstrapError');
    expect(error.code).toBe('BOOTSTRAP_FAILED');
    expect(error.message).toBe('test message');
  });

  it('BootstrapError should chain cause error', () => {
    const cause = new Error('root cause');
    const error = new BootstrapError('wrapped', cause);
    expect(error.cause).toBe(cause);
  });
});
