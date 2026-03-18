/**
 * Tests for attestation-first seed relay bootstrap (Story 4.6)
 * and Oyster CVM packaging validation (Story 4.1).
 *
 * Story 4.6: GREEN PHASE -- AttestationBootstrap implementation exists.
 *   T-4.6-01 through T-4.6-13, T-4.6-06b, T-4.6-06c, T-4.6-09b are active and passing.
 *   T-4.6-07 through T-4.6-13 added to fill AC coverage gaps.
 *   T-4.6-06b (top-level barrel export), T-4.6-06c (off() method),
 *   T-4.6-09b (verifier.verify() throw) added during test review.
 *
 * Story 4.1: Oyster CVM Packaging -- RED PHASE (remains skipped).
 *   GREEN tests are in oyster-config.test.ts (Story 4.1 was completed separately).
 *
 * Cross-cutting risk T-RISK-02: remains skipped (deferred to integration).
 *   "Trust degrades; money doesn't." (Decision 12)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

// GREEN phase: AttestationBootstrap implementation exists
import { AttestationBootstrap } from './AttestationBootstrap.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Creates a list of seed relay WebSocket URLs for testing.
 * In production, these would come from kind:10036 events on public Nostr relays.
 */
function createSeedRelayList(): string[] {
  return [
    'wss://seed1.toon.example',
    'wss://seed2.toon.example',
    'wss://seed3.toon.example',
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
      ['relay', 'wss://seed1.toon.example'],
      ['chain', '42161'],
      ['expiry', String(Math.floor(Date.now() / 1000) + 3600)],
    ],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
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
      btpEndpoint: 'wss://peer:3000',
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

  beforeEach(() => {
    vi.clearAllMocks();
    secretKey = generateSecretKey();
  });

  afterEach(() => {
    // Intentionally empty — do not restore mocks that may be module-scoped
  });

  // ---------------------------------------------------------------------------
  // T-4.6-01 [P0]: Seed relay bootstrap verifies kind:10033 before trusting
  //                  peer list
  // ---------------------------------------------------------------------------
  it('verifies kind:10033 attestation before trusting seed relay peer list (T-4.6-01)', async () => {
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
    const result = await bootstrap.bootstrap();

    // Assert — attestation must be queried BEFORE peer subscription
    const attestationCallOrder =
      mockQueryAttestation.mock.invocationCallOrder[0]!;
    const subscribePeersCallOrder =
      mockSubscribePeers.mock.invocationCallOrder[0]!;
    expect(attestationCallOrder).toBeLessThan(subscribePeersCallOrder);
    expect(mockVerifier.verify).toHaveBeenCalledWith(attestationEvent);
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed1.toon.example'
    );
    expect(result.mode).toBe('attested');
  });

  // ---------------------------------------------------------------------------
  // T-4.6-02 [P0]: Seed relay with invalid/missing attestation — fallback to
  //                  next seed relay
  // ---------------------------------------------------------------------------
  it('falls back to next seed relay when first has invalid attestation (T-4.6-02)', async () => {
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
    const result = await bootstrap.bootstrap();

    // Assert — should have tried both seed relays
    expect(mockQueryAttestation).toHaveBeenCalledTimes(2);
    expect(mockQueryAttestation).toHaveBeenCalledWith(
      'wss://seed1.toon.example'
    );
    expect(mockQueryAttestation).toHaveBeenCalledWith(
      'wss://seed2.toon.example'
    );

    // Should only subscribe to peers from the second (valid) relay
    expect(mockSubscribePeers).toHaveBeenCalledTimes(1);
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed2.toon.example'
    );

    // Fallback succeeded — mode is attested via second relay
    expect(result.mode).toBe('attested');
    expect(result.attestedSeedRelay).toBe('wss://seed2.toon.example');
  });

  // ---------------------------------------------------------------------------
  // T-4.6-03 [P1]: Seed relay with valid attestation — proceed to kind:10032
  //                  peer discovery
  // ---------------------------------------------------------------------------
  it('proceeds to kind:10032 peer discovery when attestation is valid (T-4.6-03)', async () => {
    // Arrange
    const seedRelays = ['wss://seed1.toon.example'];
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
      'wss://seed1.toon.example'
    );
    expect(result.discoveredPeers).toHaveLength(1);
    expect(result.attestedSeedRelay).toBe('wss://seed1.toon.example');
    // AC #3: result must include mode: 'attested'
    expect(result.mode).toBe('attested');
  });

  // ---------------------------------------------------------------------------
  // T-4.6-04 [P1]: All seed relays unattested — node starts but logs warning,
  //                  no fatal crash
  // ---------------------------------------------------------------------------
  it('starts in degraded mode when all seed relays are unattested (T-4.6-04)', async () => {
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
  it('completes full attestation-first bootstrap flow (T-4.6-05)', async () => {
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
      'wss://seed1.toon.example'
    );

    // Step 2: Verified attestation
    expect(mockVerifier.verify).toHaveBeenCalledWith(validAttestation);

    // Step 3: Subscribed to kind:10032 peer discovery
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed1.toon.example'
    );

    // Step 4: Found peers
    expect(result.discoveredPeers).toHaveLength(1);
    expect(result.attestedSeedRelay).toBe('wss://seed1.toon.example');
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

  // ---------------------------------------------------------------------------
  // T-4.6-06 [P1]: Barrel exports — AttestationBootstrap importable from
  //   bootstrap/index.ts and top-level core index.ts (AC #6)
  // ---------------------------------------------------------------------------
  it('exports AttestationBootstrap from bootstrap barrel (T-4.6-06)', async () => {
    // Arrange & Act — import from bootstrap barrel index
    const barrel = await import('./index.js');

    // Assert — class is exported and matches direct import
    expect(barrel.AttestationBootstrap).toBeDefined();
    expect(barrel.AttestationBootstrap).toBe(AttestationBootstrap);
  });

  // ---------------------------------------------------------------------------
  // T-4.6-06b [P1]: Top-level barrel re-export — AttestationBootstrap
  //   importable from @toon-protocol/core (AC #6)
  // ---------------------------------------------------------------------------
  it('re-exports AttestationBootstrap from top-level core barrel (T-4.6-06b)', async () => {
    // Arrange & Act — import from top-level core index
    const coreBarrel = await import('../index.js');

    // Assert — class is exported and matches direct import
    expect(coreBarrel.AttestationBootstrap).toBeDefined();
    expect(coreBarrel.AttestationBootstrap).toBe(AttestationBootstrap);
  });

  // ---------------------------------------------------------------------------
  // T-4.6-06c [P1]: off() method unregisters listeners
  // ---------------------------------------------------------------------------
  it('off() unregisters event listener (T-4.6-06c)', async () => {
    // Arrange
    const seedRelays = ['wss://seed1.toon.example'];
    const validEvent = createValidAttestationEvent();

    const mockQueryAttestation = vi.fn().mockResolvedValue(validEvent);
    const mockVerifier = createMockVerifier('valid');
    const mockSubscribePeers = vi.fn().mockResolvedValue([]);

    const events: { type: string }[] = [];
    const listener = (event: { type: string }) => events.push(event);

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    bootstrap.on(listener);
    bootstrap.off(listener);

    // Act
    await bootstrap.bootstrap();

    // Assert — no events captured because listener was removed
    expect(events).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // T-4.6-07 [P0]: queryAttestation throwing an error triggers fallback
  //   (AC #2: "queryAttestation throws an error ... falls back to next")
  // ---------------------------------------------------------------------------
  it('falls back to next seed relay when queryAttestation throws an error (T-4.6-07)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const validEvent = createValidAttestationEvent();

    // First relay throws, second returns valid
    const mockQueryAttestation = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce(validEvent);

    const mockVerifier = createMockVerifier('valid');
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

    // Assert — fell back to second relay
    expect(mockQueryAttestation).toHaveBeenCalledTimes(2);
    expect(mockQueryAttestation).toHaveBeenCalledWith(
      'wss://seed1.toon.example'
    );
    expect(mockQueryAttestation).toHaveBeenCalledWith(
      'wss://seed2.toon.example'
    );

    // Only the second relay should have been subscribed to
    expect(mockSubscribePeers).toHaveBeenCalledTimes(1);
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed2.toon.example'
    );

    // Result is attested (second relay succeeded)
    expect(result.mode).toBe('attested');
    expect(result.attestedSeedRelay).toBe('wss://seed2.toon.example');
  });

  // ---------------------------------------------------------------------------
  // T-4.6-08 [P0]: Verification returning false triggers fallback to next relay
  //   (AC #2: "fails verification ... falls back to next seed relay")
  // ---------------------------------------------------------------------------
  it('falls back to next seed relay when verification returns false (T-4.6-08)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const attestationEvent1 = createValidAttestationEvent();
    const attestationEvent2 = createValidAttestationEvent();

    const mockQueryAttestation = vi
      .fn()
      .mockResolvedValueOnce(attestationEvent1)
      .mockResolvedValueOnce(attestationEvent2);

    // Verifier rejects first, accepts second
    const mockVerifier = {
      verify: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      getState: vi.fn(),
    };

    const mockSubscribePeers = vi.fn().mockResolvedValue([]);

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act
    const result = await bootstrap.bootstrap();

    // Assert — first relay failed verification, fell back to second
    expect(mockVerifier.verify).toHaveBeenCalledTimes(2);
    expect(mockVerifier.verify).toHaveBeenCalledWith(attestationEvent1);
    expect(mockVerifier.verify).toHaveBeenCalledWith(attestationEvent2);

    // Only the second relay was subscribed to
    expect(mockSubscribePeers).toHaveBeenCalledTimes(1);
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed2.toon.example'
    );

    expect(result.mode).toBe('attested');
    expect(result.attestedSeedRelay).toBe('wss://seed2.toon.example');
  });

  // ---------------------------------------------------------------------------
  // T-4.6-09 [P1]: subscribePeers throwing an error is handled gracefully
  //   (AC #2: callback errors caught, treated as failure, fall back)
  // ---------------------------------------------------------------------------
  it('falls back to next seed relay when subscribePeers throws an error (T-4.6-09)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const validEvent = createValidAttestationEvent();
    const peerInfoEvent = createPeerInfoEvent(validEvent.pubkey);

    const mockQueryAttestation = vi.fn().mockResolvedValue(validEvent);
    const mockVerifier = createMockVerifier('valid');

    // First relay's subscribePeers throws, second succeeds
    const mockSubscribePeers = vi
      .fn()
      .mockRejectedValueOnce(new Error('WebSocket timeout'))
      .mockResolvedValueOnce([peerInfoEvent]);

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act — must NOT throw
    const result = await bootstrap.bootstrap();

    // Assert — fell back to second relay after subscribePeers failed on first
    expect(mockQueryAttestation).toHaveBeenCalledTimes(2);
    expect(mockSubscribePeers).toHaveBeenCalledTimes(2);

    // Second relay succeeded
    expect(result.mode).toBe('attested');
    expect(result.attestedSeedRelay).toBe('wss://seed2.toon.example');
    expect(result.discoveredPeers).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // T-4.6-09b [P1]: verifier.verify() throwing an error triggers fallback
  //   (AC #2: callback errors caught, treated as failure, fall back)
  // ---------------------------------------------------------------------------
  it('falls back to next seed relay when verifier.verify() throws (T-4.6-09b)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const attestationEvent = createValidAttestationEvent();
    const peerInfoEvent = createPeerInfoEvent(attestationEvent.pubkey);

    const mockQueryAttestation = vi.fn().mockResolvedValue(attestationEvent);
    const mockSubscribePeers = vi.fn().mockResolvedValue([peerInfoEvent]);

    // Verifier throws on first call, succeeds on second
    const mockVerifier = {
      verify: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('Verification engine unavailable');
        })
        .mockResolvedValueOnce(true),
      getState: vi.fn(),
    };

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act — must NOT throw
    const result = await bootstrap.bootstrap();

    // Assert — first relay failed due to verifier throw, fell back to second
    expect(mockVerifier.verify).toHaveBeenCalledTimes(2);
    expect(mockQueryAttestation).toHaveBeenCalledTimes(2);

    // Only the second relay should have subscribePeers called
    expect(mockSubscribePeers).toHaveBeenCalledTimes(1);
    expect(mockSubscribePeers).toHaveBeenCalledWith(
      'wss://seed2.toon.example'
    );

    expect(result.mode).toBe('attested');
    expect(result.attestedSeedRelay).toBe('wss://seed2.toon.example');
    expect(result.discoveredPeers).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // T-4.6-10 [P1]: Degraded mode emits attestation:degraded event
  //   (AC #4: degraded mode lifecycle event + verification-failed events)
  // ---------------------------------------------------------------------------
  it('emits attestation:degraded and verification-failed events when all relays fail (T-4.6-10)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    const mockQueryAttestation = vi.fn().mockResolvedValue(null);
    const mockVerifier = createMockVerifier('missing');
    const mockSubscribePeers = vi.fn().mockResolvedValue([]);

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
    await bootstrap.bootstrap();

    // Assert — verification-failed emitted for each relay
    const failedEvents = events.filter(
      (e) => e.type === 'attestation:verification-failed'
    );
    expect(failedEvents).toHaveLength(3);
    expect(failedEvents[0]!['relayUrl']).toBe('wss://seed1.toon.example');
    expect(failedEvents[1]!['relayUrl']).toBe('wss://seed2.toon.example');
    expect(failedEvents[2]!['relayUrl']).toBe('wss://seed3.toon.example');

    // Assert — seed-connected emitted for each relay
    const connectedEvents = events.filter(
      (e) => e.type === 'attestation:seed-connected'
    );
    expect(connectedEvents).toHaveLength(3);

    // Assert — attestation:degraded emitted exactly once at the end
    const degradedEvents = events.filter(
      (e) => e.type === 'attestation:degraded'
    );
    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0]!['triedCount']).toBe(3);

    // Assert — no verified or peers-discovered events
    const verifiedEvents = events.filter(
      (e) => e.type === 'attestation:verified'
    );
    expect(verifiedEvents).toHaveLength(0);

    const discoveredEvents = events.filter(
      (e) => e.type === 'attestation:peers-discovered'
    );
    expect(discoveredEvents).toHaveLength(0);

    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // T-4.6-11 [P1]: Verifier returning VerificationResult { valid: true }
  //   works correctly (normalization from VerificationResult to boolean)
  // ---------------------------------------------------------------------------
  it('handles VerificationResult object from verifier (T-4.6-11)', async () => {
    // Arrange
    const seedRelays = ['wss://seed1.toon.example'];
    const validEvent = createValidAttestationEvent();
    const peerInfoEvent = createPeerInfoEvent(validEvent.pubkey);

    const mockQueryAttestation = vi.fn().mockResolvedValue(validEvent);
    const mockSubscribePeers = vi.fn().mockResolvedValue([peerInfoEvent]);

    // Verifier returns VerificationResult { valid: true } (real verifier shape)
    const mockVerifier = {
      verify: vi.fn().mockReturnValue({ valid: true, reason: undefined }),
      getState: vi.fn(),
    };

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act
    const result = await bootstrap.bootstrap();

    // Assert — VerificationResult.valid was normalized correctly
    expect(result.mode).toBe('attested');
    expect(result.attestedSeedRelay).toBe('wss://seed1.toon.example');
    expect(result.discoveredPeers).toHaveLength(1);
    expect(mockSubscribePeers).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // T-4.6-12 [P1]: Verifier returning VerificationResult { valid: false }
  //   triggers fallback (normalization from VerificationResult to boolean)
  // ---------------------------------------------------------------------------
  it('falls back when VerificationResult has valid: false (T-4.6-12)', async () => {
    // Arrange
    const seedRelays = createSeedRelayList();
    const attestationEvent = createValidAttestationEvent();

    const mockQueryAttestation = vi.fn().mockResolvedValue(attestationEvent);
    const mockSubscribePeers = vi.fn().mockResolvedValue([]);

    // Verifier returns VerificationResult { valid: false } for all relays
    const mockVerifier = {
      verify: vi.fn().mockReturnValue({ valid: false, reason: 'PCR mismatch' }),
      getState: vi.fn(),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    const bootstrap = new AttestationBootstrap({
      seedRelays,
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act
    const result = await bootstrap.bootstrap();

    // Assert — all relays failed, degraded mode
    expect(result.mode).toBe('degraded');
    expect(result.attestedSeedRelay).toBeUndefined();
    expect(result.discoveredPeers).toEqual([]);
    expect(mockSubscribePeers).not.toHaveBeenCalled();
    expect(mockVerifier.verify).toHaveBeenCalledTimes(3);

    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // T-4.6-13 [P1]: Empty seed relay list results in degraded mode
  //   (edge case: no relays to try)
  // ---------------------------------------------------------------------------
  it('returns degraded mode when seed relay list is empty (T-4.6-13)', async () => {
    // Arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    const mockQueryAttestation = vi.fn();
    const mockVerifier = createMockVerifier('valid');
    const mockSubscribePeers = vi.fn();

    const bootstrap = new AttestationBootstrap({
      seedRelays: [],
      secretKey,
      verifier: mockVerifier,
      queryAttestation: mockQueryAttestation,
      subscribePeers: mockSubscribePeers,
    });

    // Act
    const result = await bootstrap.bootstrap();

    // Assert — degraded with no attempts
    expect(result.mode).toBe('degraded');
    expect(result.attestedSeedRelay).toBeUndefined();
    expect(result.discoveredPeers).toEqual([]);
    expect(mockQueryAttestation).not.toHaveBeenCalled();
    expect(mockSubscribePeers).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No attested seed relays found')
    );

    warnSpy.mockRestore();
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
  // Corrected from original ATDD stub: 2 services (toon, attestation-server),
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
    expect(serviceNames).toContain('toon');
    expect(serviceNames).toContain('attestation-server');

    // Assert — toon service exposes BLS port 3100 and Relay port 7100
    const toonPorts = compose.services.toon.ports;
    expect(toonPorts).toContainEqual(expect.stringContaining('3100'));
    expect(toonPorts).toContainEqual(expect.stringContaining('7100'));

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
  //                  (toon=10, attestation=20)
  // ---------------------------------------------------------------------------
  // Corrected from original ATDD stub: 2 programs (toon=10, attestation=20),
  // NOT 3 (relay=10, connector=20, attestation=30). The connector is external.
  // The toon program runs the full node (BLS + Relay + Bootstrap).
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
    const toonPriorityMatch = confContent.match(
      /\[program:toon\][\s\S]*?priority=(\d+)/
    );
    const attestationPriorityMatch = confContent.match(
      /\[program:attestation\][\s\S]*?priority=(\d+)/
    );

    // Assert — exactly 2 programs (connector is external)
    const programMatches = confContent.match(/\[program:(\w+)\]/g) || [];
    expect(programMatches).toHaveLength(2);

    // Assert — priorities correct
    expect(toonPriorityMatch).not.toBeNull();
    expect(attestationPriorityMatch).not.toBeNull();

    const toonPriority = Number(toonPriorityMatch![1]);
    const attestationPriority = Number(attestationPriorityMatch![1]);

    expect(toonPriority).toBe(10);
    expect(attestationPriority).toBe(20);

    // Assert — toon starts first (lower priority number)
    expect(toonPriority).toBeLessThan(attestationPriority);
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
  // Corrected from original ATDD stub: 2 processes (toon on 3100+7100,
  // attestation on 1300), NOT 3. The connector is external.
  //
  // NOTE: This test requires a running Oyster CVM testnet (the full Docker image
  // built from docker-compose-oyster.yml with supervisord managing both processes).
  // It will remain skipped until the CVM image is buildable and a testnet
  // environment is available in CI. Deferred to integration/E2E phase.
  it.skip('Oyster CVM deployment — both processes running and healthy (T-4.1-04)', async () => {
    // Arrange — mock health check functions for each supervisord process.
    // In a real E2E run these would hit the actual container endpoints.
    // toon process owns both BLS (3100) and Relay (7100)
    const mockTOONHealth = vi.fn().mockResolvedValue({
      process: 'toon',
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
    const [toonHealth, attestationHealth] = await Promise.all([
      mockTOONHealth(),
      mockAttestationHealth(),
    ]);

    // Assert — toon process is running (BLS + Relay)
    expect(toonHealth.process).toBe('toon');
    expect(toonHealth.status).toBe('healthy');
    expect(toonHealth.blsPort).toBe(3100);
    expect(toonHealth.relayPort).toBe(7100);

    // Assert — attestation server is running on port 1300
    expect(attestationHealth.process).toBe('attestation');
    expect(attestationHealth.status).toBe('healthy');
    expect(attestationHealth.port).toBe(1300);

    // Assert — both health checks were called exactly once
    expect(mockTOONHealth).toHaveBeenCalledTimes(1);
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
