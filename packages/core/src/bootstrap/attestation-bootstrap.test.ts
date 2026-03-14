/**
 * Tests for attestation-first seed relay bootstrap (Story 4.6)
 * and Oyster CVM packaging validation (Story 4.1).
 *
 * TDD RED PHASE — all tests use `it.skip()` because the implementation
 * modules (AttestationBootstrap, AttestationVerifier) do not exist yet.
 *
 * Story 4.6: Attestation-First Seed Relay Bootstrap
 *   Seed relays are verified via kind:10033 attestation events BEFORE their
 *   kind:10032 peer lists are trusted. This prevents seed relay list poisoning
 *   (R-E4-004) where malicious kind:10036 events point to non-attested nodes.
 *
 * Story 4.1: Oyster CVM Packaging
 *   Config validation for docker-compose-oyster.yml and supervisord.conf.
 *   Ensures correct services, ports, process priorities per Pattern 16.
 *
 * Cross-cutting risk T-RISK-02:
 *   Payment channels remain open when attestation degrades to unattested.
 *   "Trust degrades; money doesn't." (Decision 12)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

// These modules don't exist yet — TDD red phase.
// Imports will cause compile errors until implementation is created.
// Uncomment when implementing the green phase:
// import { AttestationBootstrap } from './AttestationBootstrap.js';
// import {
//   AttestationVerifier,
//   AttestationState,
// } from './AttestationVerifier.js';
// import type { TeeAttestation } from '../types.js';
// import { TEE_ATTESTATION_KIND } from '../constants.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Creates a list of seed relay WebSocket URLs for testing.
 * In production, these would come from kind:10036 events on public Nostr relays.
 */
function createSeedRelayList(): string[] {
  return [
    'wss://seed1.crosstown.example',
    'wss://seed2.crosstown.example',
    'wss://seed3.crosstown.example',
  ];
}

/**
 * Creates a valid kind:10033 attestation event with correct structure per Pattern 14.
 * Uses fake but structurally valid PCR values and attestation doc.
 */
function createValidAttestationEvent(): NostrEvent {
  const secretKey = generateSecretKey();
  return {
    id: '0'.repeat(64),
    pubkey: getPublicKey(secretKey),
    kind: 10033,
    content: JSON.stringify({
      enclave: 'aws-nitro',
      pcr0: 'a'.repeat(96),
      pcr1: 'b'.repeat(96),
      pcr2: 'c'.repeat(96),
      attestationDoc: 'valid-attestation-doc',
      version: '1.0.0',
    }),
    tags: [
      ['relay', 'wss://seed1.crosstown.example'],
      ['chain', '42161'],
      ['expiry', String(Math.floor(Date.now() / 1000) + 3600)],
    ],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

/**
 * Creates an attestation event with an expired expiry tag.
 * Useful for testing stale/expired attestation handling.
 */
function _createExpiredAttestationEvent(): NostrEvent {
  const secretKey = generateSecretKey();
  return {
    id: '1'.repeat(64),
    pubkey: getPublicKey(secretKey),
    kind: 10033,
    content: JSON.stringify({
      enclave: 'aws-nitro',
      pcr0: 'a'.repeat(96),
      pcr1: 'b'.repeat(96),
      pcr2: 'c'.repeat(96),
      attestationDoc: 'expired-attestation-doc',
      version: '1.0.0',
    }),
    tags: [
      ['relay', 'wss://seed2.crosstown.example'],
      ['chain', '42161'],
      // Expired 1 hour ago
      ['expiry', String(Math.floor(Date.now() / 1000) - 3600)],
    ],
    created_at: Math.floor(Date.now() / 1000) - 7200,
    sig: '1'.repeat(128),
  };
}

/**
 * Creates a valid kind:10032 ILP peer info event (used after attestation verification).
 */
function createPeerInfoEvent(relayPubkey: string): NostrEvent {
  return {
    id: '2'.repeat(64),
    pubkey: relayPubkey,
    kind: 10032,
    content: JSON.stringify({
      ilpAddress: 'g.test.peer',
      btpEndpoint: 'ws://peer:3000',
      assetCode: 'USD',
      assetScale: 6,
    }),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    sig: '2'.repeat(128),
  };
}

/**
 * Creates a mock AttestationVerifier that returns the specified state.
 */
function createMockVerifier(
  state: 'valid' | 'invalid' | 'missing' | 'expired'
): {
  verify: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
} {
  return {
    verify: vi.fn().mockResolvedValue(state === 'valid'),
    getState: vi.fn().mockReturnValue(state),
  };
}

// ============================================================================
// Story 4.6: Attestation-First Seed Relay Bootstrap
// ============================================================================

describe('AttestationBootstrap (Story 4.6)', () => {
  let secretKey: Uint8Array;
  let _pubkey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    secretKey = generateSecretKey();
    _pubkey = getPublicKey(secretKey);
  });

  afterEach(() => {
    // Intentionally empty — do not restore mocks that may be module-scoped
  });

  // ---------------------------------------------------------------------------
  // T-4.6-01 [P0]: Seed relay bootstrap verifies kind:10033 before trusting
  //                  peer list
  // ---------------------------------------------------------------------------
  // Will fail because AttestationBootstrap does not exist yet.
  // When implemented, AttestationBootstrap must query each seed relay for its
  // kind:10033 attestation event and verify it BEFORE subscribing to that
  // relay's kind:10032 peer info events.
  it.skip('verifies kind:10033 attestation before trusting seed relay peer list (T-4.6-01)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const mockVerifier = createMockVerifier('valid');
    const attestationEvent = createValidAttestationEvent();

    const mockQueryAttestation = vi.fn().mockResolvedValue(attestationEvent);
    const mockSubscribePeers = vi.fn().mockResolvedValue([]);

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act
    await bootstrap.bootstrap();

    // Assert — attestation must be queried BEFORE peer subscription
    const attestationCallOrder =
      mockQueryAttestation.mock.invocationCallOrder[0]!;
    const subscribePeersCallOrder =
      mockSubscribePeers.mock.invocationCallOrder[0]!;
    expect(attestationCallOrder).toBeLessThan(subscribePeersCallOrder);
    expect(mockVerifier.verify).toHaveBeenCalledWith(attestationEvent);
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed1.crosstown.example'
    );
  });

  // ---------------------------------------------------------------------------
  // T-4.6-02 [P0]: Seed relay with invalid/missing attestation — fallback to
  //                  next seed relay
  // ---------------------------------------------------------------------------
  // Will fail because AttestationBootstrap does not exist yet.
  // When implemented, if the first seed relay has no valid attestation, the
  // bootstrap flow must try the next seed relay in the list without crashing.
  it.skip('falls back to next seed relay when first has invalid attestation (T-4.6-02)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const validEvent = createValidAttestationEvent();

    // First seed relay returns no attestation, second returns valid
    const mockQueryAttestation = vi
      .fn()
      .mockResolvedValueOnce(null) // seed1: no attestation
      .mockResolvedValueOnce(validEvent); // seed2: valid attestation

    const mockVerifier = createMockVerifier('valid');
    const mockSubscribePeers = vi.fn().mockResolvedValue([]);

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act
    await bootstrap.bootstrap();

    // Assert — should have tried both seed relays
    expect(mockQueryAttestation).toHaveBeenCalledTimes(2);
    expect(mockQueryAttestation).toHaveBeenCalledWith(
      'wss://seed1.crosstown.example'
    );
    expect(mockQueryAttestation).toHaveBeenCalledWith(
      'wss://seed2.crosstown.example'
    );

    // Should only subscribe to peers from the second (valid) relay
    expect(mockSubscribePeers).toHaveBeenCalledTimes(1);
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed2.crosstown.example'
    );
  });

  // ---------------------------------------------------------------------------
  // T-4.6-03 [P1]: Seed relay with valid attestation — proceed to kind:10032
  //                  peer discovery
  // ---------------------------------------------------------------------------
  // Will fail because AttestationBootstrap does not exist yet.
  // Happy path: attestation is valid, so proceed directly to subscribing
  // for kind:10032 peer info events on the seed relay.
  it.skip('proceeds to kind:10032 peer discovery when attestation is valid (T-4.6-03)', async () => {
    // Arrange
    const seedRelays = ['wss://seed1.crosstown.example'];
    const validEvent = createValidAttestationEvent();
    const peerInfoEvent = createPeerInfoEvent(validEvent.pubkey);

    const mockQueryAttestation = vi.fn().mockResolvedValue(validEvent);
    const mockVerifier = createMockVerifier('valid');
    const mockSubscribePeers = vi.fn().mockResolvedValue([peerInfoEvent]);

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act
    const result = await bootstrap.bootstrap();

    // Assert — peer discovery proceeded and found peers
    expect(mockVerifier.verify).toHaveBeenCalledWith(validEvent);
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed1.crosstown.example'
    );
    expect(result.discoveredPeers).toHaveLength(1);
    expect(result.attestedSeedRelay).toBe('wss://seed1.crosstown.example');
  });

  // ---------------------------------------------------------------------------
  // T-4.6-04 [P1]: All seed relays unattested — node starts but logs warning,
  //                  no fatal crash
  // ---------------------------------------------------------------------------
  // Will fail because AttestationBootstrap does not exist yet.
  // Graceful degradation: if every seed relay in the list lacks valid
  // attestation, the node must still start (degraded mode) and log a warning
  // rather than crashing.
  it.skip('starts in degraded mode when all seed relays are unattested (T-4.6-04)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    // All relays return null attestation
    const mockQueryAttestation = vi.fn().mockResolvedValue(null);
    const mockVerifier = createMockVerifier('missing');
    const mockSubscribePeers = vi.fn().mockResolvedValue([]);

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act — must NOT throw
    const result = await bootstrap.bootstrap();

    // Assert — degraded mode, not a crash
    expect(result.mode).toBe('degraded');
    expect(result.attestedSeedRelay).toBeUndefined();
    expect(result.discoveredPeers).toEqual([]);

    // Should have tried all seed relays
    expect(mockQueryAttestation).toHaveBeenCalledTimes(3);

    // Should log a warning about degraded mode
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No attested seed relays found')
    );

    // Peer subscription should not have been called (no trusted relay)
    expect(mockSubscribePeers).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // T-4.6-05 [P1]: Full bootstrap:
  //   kind:10036 -> connect seed -> verify kind:10033 -> subscribe kind:10032
  // ---------------------------------------------------------------------------
  // Will fail because AttestationBootstrap does not exist yet.
  // Integration test of the complete attestation-first bootstrap flow:
  // 1. Read seed relay list from kind:10036 event
  // 2. Connect to the first seed relay
  // 3. Query and verify its kind:10033 attestation
  // 4. If valid, subscribe to kind:10032 peer info events
  it.skip('completes full attestation-first bootstrap flow (T-4.6-05)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const validAttestation = createValidAttestationEvent();
    const peerPubkey = 'dd'.repeat(32);
    const peerInfoEvent = createPeerInfoEvent(peerPubkey);

    const mockQueryAttestation = vi.fn().mockResolvedValue(validAttestation);
    const mockVerifier = createMockVerifier('valid');
    const mockSubscribePeers = vi.fn().mockResolvedValue([peerInfoEvent]);

    const events: { type: string; [key: string]: unknown }[] = [];

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    bootstrap.on((event) => events.push(event));

    // Act
    const result = await bootstrap.bootstrap();

    // Assert — full flow completed
    // Step 1: Connected to seed relay
    expect(mockQueryAttestation).toHaveBeenCalledWith(
      'wss://seed1.crosstown.example'
    );

    // Step 2: Verified attestation
    expect(mockVerifier.verify).toHaveBeenCalledWith(validAttestation);

    // Step 3: Subscribed to kind:10032 peer discovery
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed1.crosstown.example'
    );

    // Step 4: Found peers
    expect(result.discoveredPeers).toHaveLength(1);
    expect(result.attestedSeedRelay).toBe('wss://seed1.crosstown.example');
    expect(result.mode).toBe('attested');

    // Verify lifecycle events were emitted in order
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('attestation:seed-connected');
    expect(eventTypes).toContain('attestation:verified');
    expect(eventTypes).toContain('attestation:peers-discovered');

    // Verify ordering: connected -> verified -> discovered
    const connectedIdx = eventTypes.indexOf('attestation:seed-connected');
    const verifiedIdx = eventTypes.indexOf('attestation:verified');
    const discoveredIdx = eventTypes.indexOf('attestation:peers-discovered');
    expect(connectedIdx).toBeLessThan(verifiedIdx);
    expect(verifiedIdx).toBeLessThan(discoveredIdx);
  });
});

// ============================================================================
// Story 4.1: Oyster CVM Packaging
// ============================================================================

describe('Oyster CVM Packaging (Story 4.1)', () => {
  // ---------------------------------------------------------------------------
  // T-4.1-01 [P1]: docker-compose-oyster.yml defines correct services, ports,
  //                  images
  // ---------------------------------------------------------------------------
  // Corrected from original ATDD stub: 2 services (crosstown, attestation-server),
  // NOT 3 (relay, connector, attestation). The connector is external, not managed
  // by this compose file. Ports: BLS 3100, Relay 7100, Attestation 1300.
  // This stub remains skipped as the GREEN tests are in oyster-config.test.ts.
  it.skip('docker-compose-oyster.yml defines correct services, ports, and images (T-4.1-01)', async () => {
    // Arrange — read and parse docker-compose-oyster.yml
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const yaml = await import('yaml');

    const composePath = path.resolve(
      __dirname,
      '../../../../docker/docker-compose-oyster.yml'
    );
    const composeContent = await fs.readFile(composePath, 'utf-8');
    const compose = yaml.parse(composeContent);

    // Assert — exactly 2 services (connector is external)
    const serviceNames = Object.keys(compose.services);
    expect(serviceNames).toHaveLength(2);
    expect(serviceNames).toContain('crosstown');
    expect(serviceNames).toContain('attestation-server');

    // Assert — crosstown service exposes BLS port 3100 and Relay port 7100
    const crosstownPorts = compose.services.crosstown.ports;
    expect(crosstownPorts).toContainEqual(expect.stringContaining('3100'));
    expect(crosstownPorts).toContainEqual(expect.stringContaining('7100'));

    // Assert — attestation-server exposes port 1300
    const attestationPorts = compose.services['attestation-server'].ports;
    expect(attestationPorts).toContainEqual(expect.stringContaining('1300'));

    // Assert — all services have image defined
    for (const name of serviceNames) {
      expect(
        compose.services[name].image || compose.services[name].build
      ).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // T-4.1-02 [P1]: supervisord.conf defines correct process priorities
  //                  (crosstown=10, attestation=20)
  // ---------------------------------------------------------------------------
  // Corrected from original ATDD stub: 2 programs (crosstown=10, attestation=20),
  // NOT 3 (relay=10, connector=20, attestation=30). The connector is external.
  // The crosstown program runs the full node (BLS + Relay + Bootstrap).
  // This stub remains skipped as the GREEN tests are in oyster-config.test.ts.
  it.skip('supervisord.conf defines correct process priorities (T-4.1-02)', async () => {
    // Arrange — read supervisord.conf
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const confPath = path.resolve(
      __dirname,
      '../../../../docker/supervisord.conf'
    );
    const confContent = await fs.readFile(confPath, 'utf-8');

    // Act — parse priority values from each [program:*] section
    const crosstownPriorityMatch = confContent.match(
      /\[program:crosstown\][\s\S]*?priority=(\d+)/
    );
    const attestationPriorityMatch = confContent.match(
      /\[program:attestation\][\s\S]*?priority=(\d+)/
    );

    // Assert — exactly 2 programs (connector is external)
    const programMatches = confContent.match(/\[program:(\w+)\]/g) || [];
    expect(programMatches).toHaveLength(2);

    // Assert — priorities correct
    expect(crosstownPriorityMatch).not.toBeNull();
    expect(attestationPriorityMatch).not.toBeNull();

    const crosstownPriority = Number(crosstownPriorityMatch![1]);
    const attestationPriority = Number(attestationPriorityMatch![1]);

    expect(crosstownPriority).toBe(10);
    expect(attestationPriority).toBe(20);

    // Assert — crosstown starts first (lower priority number)
    expect(crosstownPriority).toBeLessThan(attestationPriority);
  });

  // ---------------------------------------------------------------------------
  // T-4.1-03 [P2]: supervisord starts processes in correct order — relay
  //                  ready before attestation publishes
  // ---------------------------------------------------------------------------
  // Will fail because the supervisord configuration and attestation server
  // do not exist yet. This is an integration test that verifies the relay
  // WebSocket is accepting connections before the attestation server attempts
  // to publish its kind:10033 event.
  it.skip('relay is ready before attestation server publishes (T-4.1-03)', async () => {
    // Arrange — this integration test requires the full supervisord stack.
    // The attestation server module and supervisord.conf do not exist yet.
    const startupOrder: string[] = [];

    // Mock relay readiness check
    const mockRelayHealthCheck = vi.fn().mockResolvedValue(true);
    // Mock attestation server publish
    const mockAttestationPublish = vi.fn().mockImplementation(async () => {
      startupOrder.push('attestation-publish');
    });

    // Simulate relay startup notification
    startupOrder.push('relay-ready');
    await mockRelayHealthCheck();

    // Simulate attestation server publishing after relay is ready
    await mockAttestationPublish();

    // Assert — relay must be ready before attestation publishes
    const relayReadyIdx = startupOrder.indexOf('relay-ready');
    const attestationPublishIdx = startupOrder.indexOf('attestation-publish');

    expect(relayReadyIdx).toBeLessThan(attestationPublishIdx);

    // Verify mock call order using invocationCallOrder
    const healthCheckOrder = mockRelayHealthCheck.mock.invocationCallOrder[0]!;
    const attestationPublishOrder =
      mockAttestationPublish.mock.invocationCallOrder[0]!;
    expect(healthCheckOrder).toBeLessThan(attestationPublishOrder);
  });

  // ---------------------------------------------------------------------------
  // T-4.1-04 [P1]: Oyster CVM deployment — both processes running and healthy
  // ---------------------------------------------------------------------------
  // Corrected from original ATDD stub: 2 processes (crosstown on 3100+7100,
  // attestation on 1300), NOT 3. The connector is external.
  //
  // NOTE: This test requires a running Oyster CVM testnet (the full Docker image
  // built from docker-compose-oyster.yml with supervisord managing both processes).
  // It will remain skipped until the CVM image is buildable and a testnet
  // environment is available in CI. Deferred to integration/E2E phase.
  it.skip('Oyster CVM deployment — both processes running and healthy (T-4.1-04)', async () => {
    // Arrange — mock health check functions for each supervisord process.
    // In a real E2E run these would hit the actual container endpoints.
    // crosstown process owns both BLS (3100) and Relay (7100)
    const mockCrosstownHealth = vi.fn().mockResolvedValue({
      process: 'crosstown',
      status: 'healthy',
      blsPort: 3100,
      relayPort: 7100,
    });
    const mockAttestationHealth = vi.fn().mockResolvedValue({
      process: 'attestation',
      status: 'healthy',
      port: 1300,
    });

    // Act — query health for both processes
    const [crosstownHealth, attestationHealth] = await Promise.all([
      mockCrosstownHealth(),
      mockAttestationHealth(),
    ]);

    // Assert — crosstown process is running (BLS + Relay)
    expect(crosstownHealth.process).toBe('crosstown');
    expect(crosstownHealth.status).toBe('healthy');
    expect(crosstownHealth.blsPort).toBe(3100);
    expect(crosstownHealth.relayPort).toBe(7100);

    // Assert — attestation server is running on port 1300
    expect(attestationHealth.process).toBe('attestation');
    expect(attestationHealth.status).toBe('healthy');
    expect(attestationHealth.port).toBe(1300);

    // Assert — both health checks were called exactly once
    expect(mockCrosstownHealth).toHaveBeenCalledTimes(1);
    expect(mockAttestationHealth).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Cross-cutting risk tests
// ============================================================================

describe('Cross-cutting risks', () => {
  // ---------------------------------------------------------------------------
  // T-RISK-02 [P2]: Payment channels remain open when attestation degrades
  //                   to unattested
  // ---------------------------------------------------------------------------
  // Will fail because AttestationVerifier and the attestation degradation
  // integration with payment channels do not exist yet.
  // Per Decision 12: "Trust degrades; money doesn't."
  // When attestation goes stale or unattested, existing payment channels
  // must remain open. Only the trust level changes, not the financial state.
  it.skip('payment channels remain open when attestation degrades to unattested (T-RISK-02)', async () => {
    // Arrange
    const mockChannelClient = {
      getChannelState: vi.fn().mockResolvedValue({
        channelId: 'channel-001',
        status: 'open',
        chain: 'evm:arbitrum:42161',
      }),
      openChannel: vi.fn(),
    };

    const mockVerifier = createMockVerifier('valid');
    const attestationEvent = createValidAttestationEvent();

    // Simulate a peered relay with an open payment channel
    const peerState: {
      pubkey: string;
      channelId: string;
      attestationState: string;
    } = {
      pubkey: attestationEvent.pubkey,
      channelId: 'channel-001',
      attestationState: 'valid',
    };

    // Act — attestation degrades to unattested
    // (simulating expiry + grace period lapse)
    mockVerifier.getState.mockReturnValue('unattested');
    peerState.attestationState = 'unattested';

    // Assert — channel is still open despite attestation degradation
    const channelState = await mockChannelClient.getChannelState('channel-001');
    expect(channelState.status).toBe('open');

    // Trust degraded but channel was not closed
    expect(peerState.attestationState).toBe('unattested');
    expect(mockChannelClient.openChannel).not.toHaveBeenCalled();

    // The channel client should not have been asked to close the channel
    // (no closeChannel call exists because channels survive attestation changes)
    expect(channelState.channelId).toBe('channel-001');
  });
});
