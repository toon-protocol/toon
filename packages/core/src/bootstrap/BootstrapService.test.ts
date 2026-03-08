/**
 * Tests for BootstrapService — two-phase bootstrap lifecycle.
 *
 * Phase 1: Discover peers via relay kind:10032, register with connector
 * Phase 2: Announce own kind:10032 as paid ILP PREPARE
 *
 * Infrastructure: Real nostr-tools crypto. Mocks only at transport
 * boundaries (WebSocket, SimplePool, connectorAdmin, agentRuntime).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { BootstrapService, BootstrapError } from './BootstrapService.js';
import type {
  ConnectorAdminClient,
  AgentRuntimeClient,
  BootstrapEvent,
  IlpSendResult,
  KnownPeer,
} from './types.js';
import type { IlpPeerInfo } from '../types.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';

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

function createMockAgentRuntime(
  result: Partial<IlpSendResult> = {}
): AgentRuntimeClient & { sendIlpPacket: ReturnType<typeof vi.fn> } {
  return {
    sendIlpPacket: vi.fn().mockResolvedValue({
      accepted: true,
      fulfillment: 'test-fulfillment',
      data: undefined,
      ...result,
    }),
  };
}

/**
 * Simulate the relay responding with a kind:10032 event for the peer.
 * Must be called after a WebSocket connection is established.
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

  // Build a fake kind:10032 event with peer info in content
  const subId = JSON.parse(
    (capturedWs.send.mock.calls[0]?.[0] as string) ?? '["REQ","unknown",{}]'
  )[1] as string;

  const event = {
    id: 'ee'.repeat(32),
    pubkey,
    created_at: TEST_CREATED_AT,
    kind: ILP_PEER_INFO_KIND,
    tags: [],
    content: JSON.stringify(peerInfo),
    sig: 'ff'.repeat(64),
  };

  // Send EVENT then EOSE
  capturedWs.onMessage(Buffer.from(JSON.stringify(['EVENT', subId, event])));
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

    // Without agentRuntimeClient: discovering → registering → ready
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

  it('should send paid ILP announcement via agentRuntimeClient for registered peers', async () => {
    const admin = createMockConnectorAdmin();
    const runtime = createMockAgentRuntime();

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
    service.setAgentRuntimeClient(runtime);

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

  it('should skip Phase 2 when agentRuntimeClient not configured', async () => {
    const admin = createMockConnectorAdmin();

    const service = new BootstrapService(
      { knownPeers: [createKnownPeer()], ardriveEnabled: false },
      secretKey,
      ownIlpInfo
    );
    service.setConnectorAdmin(admin);
    // No agentRuntimeClient set

    const bootstrapPromise = service.bootstrap();
    await vi.waitFor(() => expect(capturedWs).not.toBeNull());
    simulateRelayResponse(VALID_PEER_INFO);

    const results = await bootstrapPromise;

    // Should still succeed, just no ILP announcement
    expect(results).toHaveLength(1);
  });

  it('should continue on ILP announce reject (non-fatal)', async () => {
    const admin = createMockConnectorAdmin();
    const runtime = createMockAgentRuntime({
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
    service.setAgentRuntimeClient(runtime);
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
    const runtime = createMockAgentRuntime();

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
    service.setAgentRuntimeClient(runtime);
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

  it('should emit bootstrap:announce-failed on announce rejection', async () => {
    const admin = createMockConnectorAdmin();
    // Announce ILP send is rejected
    const runtime = createMockAgentRuntime({
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
    service.setAgentRuntimeClient(runtime);
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
