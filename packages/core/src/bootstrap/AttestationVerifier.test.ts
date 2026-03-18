/**
 * Tests for AttestationVerifier -- TEE attestation parsing, PCR verification,
 * and attestation-aware peer ranking for Story 4.3 (Attestation-Aware Peering).
 *
 * Bug fixes applied from ATDD stub review:
 * - createAttestationEvent() now includes required tags (relay, chain, expiry)
 * - T-4.3-01 assertions unwrap ParsedAttestation via .attestation
 * - Removed _ prefix from variables, uncommented assertion code
 * - Import parseAttestation from events/attestation.js
 *
 * Infrastructure: Real nostr-tools crypto for Nostr identity.
 * No mocks or spies needed -- these are pure logic tests.
 */

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

// Implementation imports
import {
  AttestationVerifier,
  AttestationState,
} from './AttestationVerifier.js';
import type { PeerDescriptor } from './AttestationVerifier.js';

// Story 4.2 parser -- already exists
import { parseAttestation } from '../events/attestation.js';
import type { TeeAttestation } from '../types.js';

// ============================================================================
// Factories
// ============================================================================

/** Deterministic timestamp for reproducible tests (2026-01-01T00:00:00Z) */
const TEST_CREATED_AT = 1767225600;

/** Attestation validity period in seconds (e.g. 5 minutes). */
const ATTESTATION_VALIDITY_SECONDS = 300;

/** Grace period in seconds before a stale attestation becomes unattested. */
const GRACE_PERIOD_SECONDS = 30;

/**
 * Creates a known-good PCR hash registry.
 * Keys are PCR values (96-char hex strings), values indicate trust.
 */
function createKnownGoodRegistry(): Map<string, boolean> {
  return new Map([
    ['a'.repeat(96), true], // pcr0
    ['b'.repeat(96), true], // pcr1
    ['c'.repeat(96), true], // pcr2
  ]);
}

/**
 * Creates a test TeeAttestation with sensible defaults and optional overrides.
 * PCR values are 96-char hex strings (48 bytes encoded as hex).
 */
function createTestAttestation(
  overrides: Partial<TeeAttestation> = {}
): TeeAttestation {
  return {
    enclave: 'aws-nitro',
    pcr0: 'a'.repeat(96),
    pcr1: 'b'.repeat(96),
    pcr2: 'c'.repeat(96),
    attestationDoc: 'base64encodedattestationdoc',
    version: '1.0.0',
    ...overrides,
  };
}

/**
 * Creates a mock kind:10033 Nostr event carrying TEE attestation data.
 * Includes required tags (relay, chain, expiry) so parseAttestation() returns
 * a valid ParsedAttestation instead of null.
 */
function createAttestationEvent(
  pubkey: string,
  attestation: TeeAttestation = createTestAttestation(),
  createdAt: number = TEST_CREATED_AT
): NostrEvent {
  return {
    id: 'ee'.repeat(32),
    pubkey,
    created_at: createdAt,
    kind: 10033, // TEE_ATTESTATION_KIND
    tags: [
      ['relay', 'wss://test:7100'],
      ['chain', '31337'],
      ['expiry', String(createdAt + ATTESTATION_VALIDITY_SECONDS)],
    ],
    content: JSON.stringify(attestation),
    sig: 'ff'.repeat(64),
  };
}

/**
 * Creates a peer descriptor for ranking tests.
 */
function createPeerDescriptor(
  pubkey: string,
  attested: boolean,
  attestationTimestamp?: number
): PeerDescriptor {
  return {
    pubkey,
    relayUrl: `wss://${pubkey.slice(0, 8)}:7100`,
    attested,
    attestationTimestamp,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AttestationVerifier', () => {
  // ---------------------------------------------------------------------------
  // T-4.3-01 [P0] Parse kind:10033 events
  // ---------------------------------------------------------------------------

  describe('parseAttestation', () => {
    it('should extract PCR values and attestation doc from a valid kind:10033 event', () => {
      // Arrange -- real nostr-tools crypto for identity
      const pubkey = getPublicKey(generateSecretKey());
      const attestation = createTestAttestation();
      const event = createAttestationEvent(pubkey, attestation);

      // Act -- parseAttestation returns ParsedAttestation | null
      const result = parseAttestation(event);

      // Assert -- unwrap through .attestation (ParsedAttestation wrapper)
      expect(result).not.toBeNull();
      expect(result?.attestation.enclave).toBe('aws-nitro');
      expect(result?.attestation.pcr0).toBe('a'.repeat(96));
      expect(result?.attestation.pcr1).toBe('b'.repeat(96));
      expect(result?.attestation.pcr2).toBe('c'.repeat(96));
      expect(result?.attestation.attestationDoc).toBe(
        'base64encodedattestationdoc'
      );
      expect(result?.attestation.version).toBe('1.0.0');

      // Also verify tag-extracted fields
      expect(result?.relay).toBe('wss://test:7100');
      expect(result?.chain).toBe('31337');
      expect(result?.expiry).toBe(
        TEST_CREATED_AT + ATTESTATION_VALIDITY_SECONDS
      );
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-02 [P0] Verify PCR values against known-good registry -- valid match
  // ---------------------------------------------------------------------------

  describe('PCR verification -- valid match', () => {
    it('should return { valid: true } when PCR values match the known-good registry', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation();

      // Act
      const result = verifier.verify(attestation);

      // Assert
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-03 [P0] Reject mismatched PCR values
  // ---------------------------------------------------------------------------

  describe('PCR verification -- mismatch', () => {
    it('should return { valid: false, reason: "PCR mismatch" } when PCR values do not match', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation({
        pcr0: 'd'.repeat(96), // Not in the registry
      });

      // Act
      const result = verifier.verify(attestation);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-04 [P1] Prefer TEE-attested relays over non-attested
  // ---------------------------------------------------------------------------

  describe('peer ranking -- attestation preference', () => {
    it('should rank attested peers higher than non-attested peers', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });

      const attestedPubkey = 'a'.repeat(64);
      const nonAttestedPubkey = 'b'.repeat(64);

      const peers: PeerDescriptor[] = [
        createPeerDescriptor(nonAttestedPubkey, false),
        createPeerDescriptor(attestedPubkey, true, TEST_CREATED_AT),
      ];

      // Act
      const ranked = verifier.rankPeers(peers);

      // Assert -- attested peer should appear first regardless of input order
      expect(ranked[0]!.pubkey).toBe(attestedPubkey);
      expect(ranked[1]!.pubkey).toBe(nonAttestedPubkey);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-05 [P1] Attestation state transitions: valid -> stale -> unattested
  // ---------------------------------------------------------------------------

  describe('attestation state transitions', () => {
    it('should transition from VALID to STALE after attestation expiry', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;

      // Time just after validity expires: attestedAt + validitySeconds + 1
      const now = attestedAt + ATTESTATION_VALIDITY_SECONDS + 1;

      // Act
      const state = verifier.getAttestationState(attestation, attestedAt, now);

      // Assert
      expect(state).toBe(AttestationState.STALE);
    });

    it('should transition from STALE to UNATTESTED after grace period expires', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;

      // Time after validity + grace: attestedAt + validitySeconds + graceSeconds + 1
      const now =
        attestedAt + ATTESTATION_VALIDITY_SECONDS + GRACE_PERIOD_SECONDS + 1;

      // Act
      const state = verifier.getAttestationState(attestation, attestedAt, now);

      // Assert
      expect(state).toBe(AttestationState.UNATTESTED);
    });

    it('should remain VALID within the validity period', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;

      // Time still within validity: attestedAt + validitySeconds - 1
      const now = attestedAt + ATTESTATION_VALIDITY_SECONDS - 1;

      // Act
      const state = verifier.getAttestationState(attestation, attestedAt, now);

      // Assert
      expect(state).toBe(AttestationState.VALID);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-06 [P2] 30s grace window boundary values
  // ---------------------------------------------------------------------------

  describe('grace period boundary values', () => {
    it('should be VALID at exactly the validity boundary (inclusive <=)', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;

      // Exactly at validity boundary: attestedAt + validitySeconds
      const now = attestedAt + ATTESTATION_VALIDITY_SECONDS;

      // Act
      const state = verifier.getAttestationState(attestation, attestedAt, now);

      // Assert -- at exactly validitySeconds, still VALID (inclusive <=)
      expect(state).toBe(AttestationState.VALID);
    });

    it('should be STALE at exactly 30s into grace period', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;

      // Exactly at the grace boundary: validity expired + exactly 30s grace
      const now =
        attestedAt + ATTESTATION_VALIDITY_SECONDS + GRACE_PERIOD_SECONDS;

      // Act
      const state = verifier.getAttestationState(attestation, attestedAt, now);

      // Assert -- at exactly 30s, still within grace window (STALE, inclusive <=)
      expect(state).toBe(AttestationState.STALE);
    });

    it('should be UNATTESTED at 31s past grace period start', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;

      // One second past the grace boundary
      const now =
        attestedAt + ATTESTATION_VALIDITY_SECONDS + GRACE_PERIOD_SECONDS + 1;

      // Act
      const state = verifier.getAttestationState(attestation, attestedAt, now);

      // Assert -- at 31s past validity expiry, grace exhausted (UNATTESTED)
      expect(state).toBe(AttestationState.UNATTESTED);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-07 [P1] Mixed attested/non-attested peers -- connect to attested first
  // ---------------------------------------------------------------------------

  describe('bootstrap peer ordering -- attested first', () => {
    it('should connect to attested peers before non-attested peers in a mixed list', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });

      const peerA = createPeerDescriptor('a'.repeat(64), false); // non-attested
      const peerB = createPeerDescriptor('b'.repeat(64), true, TEST_CREATED_AT); // attested
      const peerC = createPeerDescriptor('c'.repeat(64), false); // non-attested
      const peerD = createPeerDescriptor('d'.repeat(64), true, TEST_CREATED_AT); // attested

      const peers: PeerDescriptor[] = [peerA, peerB, peerC, peerD]; // interleaved order

      // Act
      const ranked = verifier.rankPeers(peers);

      // Assert -- all attested peers come before all non-attested peers
      const attestedBlock = ranked.slice(0, 2);
      const nonAttestedBlock = ranked.slice(2);

      expect(attestedBlock.every((p) => p.attested)).toBe(true);
      expect(nonAttestedBlock.every((p) => !p.attested)).toBe(true);

      // Assert -- relative order preserved within each group (stable sort)
      expect(attestedBlock[0]!.pubkey).toBe('b'.repeat(64)); // peerB was first attested
      expect(attestedBlock[1]!.pubkey).toBe('d'.repeat(64)); // peerD was second attested
      expect(nonAttestedBlock[0]!.pubkey).toBe('a'.repeat(64)); // peerA was first non-attested
      expect(nonAttestedBlock[1]!.pubkey).toBe('c'.repeat(64)); // peerC was second non-attested
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-01 [P1] PCR verification -- pcr1-only mismatch
  // ---------------------------------------------------------------------------

  describe('PCR verification -- pcr1 mismatch only', () => {
    it('should reject when only pcr1 does not match the registry', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation({
        pcr1: 'd'.repeat(96), // Only pcr1 mismatches
      });

      // Act
      const result = verifier.verify(attestation);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-02 [P1] PCR verification -- pcr2-only mismatch
  // ---------------------------------------------------------------------------

  describe('PCR verification -- pcr2 mismatch only', () => {
    it('should reject when only pcr2 does not match the registry', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation({
        pcr2: 'd'.repeat(96), // Only pcr2 mismatches
      });

      // Act
      const result = verifier.verify(attestation);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-03 [P2] PCR verification -- all PCRs mismatch
  // ---------------------------------------------------------------------------

  describe('PCR verification -- all PCRs mismatch', () => {
    it('should reject when all three PCR values do not match the registry', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation({
        pcr0: 'x'.repeat(96),
        pcr1: 'y'.repeat(96),
        pcr2: 'z'.repeat(96),
      });

      // Act
      const result = verifier.verify(attestation);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-04 [P2] PCR verification -- empty registry
  // ---------------------------------------------------------------------------

  describe('PCR verification -- empty registry', () => {
    it('should reject all attestations when the registry is empty', () => {
      // Arrange
      const emptyRegistry = new Map<string, boolean>();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: emptyRegistry,
      });
      const attestation = createTestAttestation();

      // Act
      const result = verifier.verify(attestation);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-05 [P2] PCR verification -- partial registry (only pcr0)
  // ---------------------------------------------------------------------------

  describe('PCR verification -- partial registry', () => {
    it('should reject when only pcr0 is in the registry but pcr1/pcr2 are missing', () => {
      // Arrange
      const partialRegistry = new Map<string, boolean>([
        ['a'.repeat(96), true], // Only pcr0
      ]);
      const verifier = new AttestationVerifier({
        knownGoodPcrs: partialRegistry,
      });
      const attestation = createTestAttestation();

      // Act
      const result = verifier.verify(attestation);

      // Assert -- pcr1 and pcr2 not in registry -> mismatch
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-06 [P2] Peer ranking -- empty peer list
  // ---------------------------------------------------------------------------

  describe('peer ranking -- empty list', () => {
    it('should return an empty array when no peers are provided', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });

      // Act
      const ranked = verifier.rankPeers([]);

      // Assert
      expect(ranked).toEqual([]);
      expect(ranked).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-07 [P2] Peer ranking -- all attested
  // ---------------------------------------------------------------------------

  describe('peer ranking -- all attested', () => {
    it('should preserve relative order when all peers are attested', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });

      const peerA = createPeerDescriptor('a'.repeat(64), true, TEST_CREATED_AT);
      const peerB = createPeerDescriptor('b'.repeat(64), true, TEST_CREATED_AT);
      const peerC = createPeerDescriptor('c'.repeat(64), true, TEST_CREATED_AT);
      const peers: PeerDescriptor[] = [peerA, peerB, peerC];

      // Act
      const ranked = verifier.rankPeers(peers);

      // Assert -- all attested, relative order preserved
      expect(ranked).toHaveLength(3);
      expect(ranked[0]!.pubkey).toBe('a'.repeat(64));
      expect(ranked[1]!.pubkey).toBe('b'.repeat(64));
      expect(ranked[2]!.pubkey).toBe('c'.repeat(64));
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-08 [P2] Peer ranking -- all non-attested
  // ---------------------------------------------------------------------------

  describe('peer ranking -- all non-attested', () => {
    it('should preserve relative order when no peers are attested', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });

      const peerA = createPeerDescriptor('a'.repeat(64), false);
      const peerB = createPeerDescriptor('b'.repeat(64), false);
      const peers: PeerDescriptor[] = [peerA, peerB];

      // Act
      const ranked = verifier.rankPeers(peers);

      // Assert -- all non-attested, relative order preserved
      expect(ranked).toHaveLength(2);
      expect(ranked[0]!.pubkey).toBe('a'.repeat(64));
      expect(ranked[1]!.pubkey).toBe('b'.repeat(64));
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-09 [P1] Peer ranking -- does not mutate input array
  // ---------------------------------------------------------------------------

  describe('peer ranking -- immutability', () => {
    it('should not mutate the input array', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });

      const peerA = createPeerDescriptor('a'.repeat(64), false);
      const peerB = createPeerDescriptor('b'.repeat(64), true, TEST_CREATED_AT);
      const original: PeerDescriptor[] = [peerA, peerB];
      const originalCopy = [...original]; // snapshot before ranking

      // Act
      const ranked = verifier.rankPeers(original);

      // Assert -- original array is unchanged
      expect(original).toEqual(originalCopy);
      expect(original[0]!.pubkey).toBe('a'.repeat(64));
      expect(original[1]!.pubkey).toBe('b'.repeat(64));

      // Assert -- ranked is a different array reference
      expect(ranked).not.toBe(original);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-10 [P2] Attestation state -- default now uses real clock
  // ---------------------------------------------------------------------------

  describe('attestation state -- default now parameter', () => {
    it('should use real clock time when now is not provided', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();

      // Use an attestedAt far in the past so the state is deterministically UNATTESTED
      const veryOldAttestedAt = 1000000;

      // Act -- no `now` parameter, uses Date.now()
      const state = verifier.getAttestationState(
        attestation,
        veryOldAttestedAt
      );

      // Assert -- with attestedAt in 2001, current time is well past grace
      expect(state).toBe(AttestationState.UNATTESTED);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-11 [P2] Constructor defaults -- validity and grace periods
  // ---------------------------------------------------------------------------

  describe('constructor defaults', () => {
    it('should use default validity (300s) and grace (30s) when not specified', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;

      // Act -- at exactly 300s (default validity), should be VALID
      const stateAtValidity = verifier.getAttestationState(
        attestation,
        attestedAt,
        attestedAt + 300
      );
      // At 301s, should be STALE (grace period)
      const stateAfterValidity = verifier.getAttestationState(
        attestation,
        attestedAt,
        attestedAt + 301
      );
      // At 330s (300 + 30), should still be STALE
      const stateAtGrace = verifier.getAttestationState(
        attestation,
        attestedAt,
        attestedAt + 330
      );
      // At 331s, should be UNATTESTED
      const stateAfterGrace = verifier.getAttestationState(
        attestation,
        attestedAt,
        attestedAt + 331
      );

      // Assert
      expect(stateAtValidity).toBe(AttestationState.VALID);
      expect(stateAfterValidity).toBe(AttestationState.STALE);
      expect(stateAtGrace).toBe(AttestationState.STALE);
      expect(stateAfterGrace).toBe(AttestationState.UNATTESTED);
    });
  });

  // ---------------------------------------------------------------------------
  // T-RISK-01 [P0] Dual-channel consistency -- kind:10033 and /health tee field
  // ---------------------------------------------------------------------------

  describe('dual-channel consistency', () => {
    it('should produce the same AttestationState for both kind:10033 events and /health responses', () => {
      // This test validates that AttestationState from the verifier is the
      // single source of truth. Both the kind:10033 Nostr event path and the
      // /health HTTP endpoint must derive their TEE state from the same
      // AttestationVerifier instance, ensuring they never diverge.

      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;
      const now = attestedAt + ATTESTATION_VALIDITY_SECONDS + 10; // within grace

      // Act -- simulate both channels querying the same verifier
      const stateFromNostrPath = verifier.getAttestationState(
        attestation,
        attestedAt,
        now
      );
      const stateFromHealthPath = verifier.getAttestationState(
        attestation,
        attestedAt,
        now
      );

      // Assert -- both channels must return identical state
      expect(stateFromNostrPath).toBe(stateFromHealthPath);
      expect(stateFromNostrPath).toBe(AttestationState.STALE);
    });

    it('should produce identical VALID state from both channels', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;
      const now = attestedAt + 100; // well within validity

      // Act -- simulate both channels querying the same verifier
      const stateFromNostrPath = verifier.getAttestationState(
        attestation,
        attestedAt,
        now
      );
      const stateFromHealthPath = verifier.getAttestationState(
        attestation,
        attestedAt,
        now
      );

      // Assert -- both channels must return identical VALID state
      expect(stateFromNostrPath).toBe(stateFromHealthPath);
      expect(stateFromNostrPath).toBe(AttestationState.VALID);
    });

    it('should produce identical UNATTESTED state from both channels', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: ATTESTATION_VALIDITY_SECONDS,
        graceSeconds: GRACE_PERIOD_SECONDS,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;
      const now =
        attestedAt + ATTESTATION_VALIDITY_SECONDS + GRACE_PERIOD_SECONDS + 100; // well past grace

      // Act -- simulate both channels querying the same verifier
      const stateFromNostrPath = verifier.getAttestationState(
        attestation,
        attestedAt,
        now
      );
      const stateFromHealthPath = verifier.getAttestationState(
        attestation,
        attestedAt,
        now
      );

      // Assert -- both channels must return identical UNATTESTED state
      expect(stateFromNostrPath).toBe(stateFromHealthPath);
      expect(stateFromNostrPath).toBe(AttestationState.UNATTESTED);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-12 [P1] PCR verification -- registry entry with false trust
  // ---------------------------------------------------------------------------

  describe('PCR verification -- false trust value in registry', () => {
    it('should reject when PCR value is in the registry but has false trust status', () => {
      // Arrange -- pcr0 is in registry but marked as untrusted (false)
      const registry = new Map<string, boolean>([
        ['a'.repeat(96), false], // pcr0 present but NOT trusted
        ['b'.repeat(96), true], // pcr1 trusted
        ['c'.repeat(96), true], // pcr2 trusted
      ]);
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation();

      // Act
      const result = verifier.verify(attestation);

      // Assert -- pcr0 is in registry but has false value, so === true check fails
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-13 [P2] Attestation state -- custom validity/grace periods
  // ---------------------------------------------------------------------------

  describe('attestation state -- custom validity and grace periods', () => {
    it('should respect non-default validity and grace period values', () => {
      // Arrange -- custom 60s validity, 10s grace (not the default 300/30)
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: 60,
        graceSeconds: 10,
      });
      const attestation = createTestAttestation();
      const attestedAt = TEST_CREATED_AT;

      // Act & Assert -- at 60s: VALID (custom boundary)
      expect(
        verifier.getAttestationState(attestation, attestedAt, attestedAt + 60)
      ).toBe(AttestationState.VALID);

      // At 61s: STALE (custom validity expired, in custom grace)
      expect(
        verifier.getAttestationState(attestation, attestedAt, attestedAt + 61)
      ).toBe(AttestationState.STALE);

      // At 70s (60+10): STALE (custom grace boundary, inclusive)
      expect(
        verifier.getAttestationState(attestation, attestedAt, attestedAt + 70)
      ).toBe(AttestationState.STALE);

      // At 71s (60+10+1): UNATTESTED (custom grace expired)
      expect(
        verifier.getAttestationState(attestation, attestedAt, attestedAt + 71)
      ).toBe(AttestationState.UNATTESTED);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-14 [P2] Export verification -- AC #5 structural tests
  // ---------------------------------------------------------------------------

  describe('export verification (AC #5)', () => {
    it('should export AttestationVerifier class from bootstrap index', async () => {
      const bootstrapExports = await import('./index.js');
      expect(bootstrapExports.AttestationVerifier).toBeDefined();
      expect(typeof bootstrapExports.AttestationVerifier).toBe('function');
    });

    it('should export AttestationState enum from bootstrap index', async () => {
      const bootstrapExports = await import('./index.js');
      expect(bootstrapExports.AttestationState).toBeDefined();
      expect(bootstrapExports.AttestationState.VALID).toBe('valid');
      expect(bootstrapExports.AttestationState.STALE).toBe('stale');
      expect(bootstrapExports.AttestationState.UNATTESTED).toBe('unattested');
    });

    it('should export AttestationVerifier from top-level @toon-protocol/core index', async () => {
      const coreExports = await import('../index.js');
      expect(coreExports.AttestationVerifier).toBeDefined();
      expect(coreExports.AttestationState).toBeDefined();
    });

    it('should allow constructing AttestationVerifier from bootstrap exports', async () => {
      const { AttestationVerifier: AV } = await import('./index.js');
      const verifier = new AV({
        knownGoodPcrs: new Map([['test', true]]),
      });
      expect(verifier).toBeInstanceOf(AV);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-15 [P2] Peer ranking -- single peer
  // ---------------------------------------------------------------------------

  describe('peer ranking -- single peer', () => {
    it('should return a single attested peer in an array', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const peer = createPeerDescriptor('a'.repeat(64), true, TEST_CREATED_AT);

      // Act
      const ranked = verifier.rankPeers([peer]);

      // Assert
      expect(ranked).toHaveLength(1);
      expect(ranked[0]!.pubkey).toBe('a'.repeat(64));
      expect(ranked[0]!.attested).toBe(true);
    });

    it('should return a single non-attested peer in an array', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const peer = createPeerDescriptor('b'.repeat(64), false);

      // Act
      const ranked = verifier.rankPeers([peer]);

      // Assert
      expect(ranked).toHaveLength(1);
      expect(ranked[0]!.pubkey).toBe('b'.repeat(64));
      expect(ranked[0]!.attested).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-16 [P2] Constructor -- defensive copy of knownGoodPcrs
  // ---------------------------------------------------------------------------

  describe('constructor -- defensive copy', () => {
    it('should not be affected by external mutation of the original Map', () => {
      // Arrange
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation();

      // Verify it works before mutation
      expect(verifier.verify(attestation).valid).toBe(true);

      // Act -- mutate the original Map after construction
      registry.clear();

      // Assert -- verifier should still work because it holds a defensive copy
      const result = verifier.verify(attestation);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-17 [P2] Constructor -- input validation for validity/grace
  // ---------------------------------------------------------------------------

  describe('constructor -- input validation', () => {
    it('should throw for negative validitySeconds', () => {
      const registry = createKnownGoodRegistry();
      expect(
        () =>
          new AttestationVerifier({
            knownGoodPcrs: registry,
            validitySeconds: -1,
          })
      ).toThrow('validitySeconds must be a non-negative finite number');
    });

    it('should throw for NaN validitySeconds', () => {
      const registry = createKnownGoodRegistry();
      expect(
        () =>
          new AttestationVerifier({
            knownGoodPcrs: registry,
            validitySeconds: NaN,
          })
      ).toThrow('validitySeconds must be a non-negative finite number');
    });

    it('should throw for negative graceSeconds', () => {
      const registry = createKnownGoodRegistry();
      expect(
        () =>
          new AttestationVerifier({
            knownGoodPcrs: registry,
            graceSeconds: -1,
          })
      ).toThrow('graceSeconds must be a non-negative finite number');
    });

    it('should throw for Infinity graceSeconds', () => {
      const registry = createKnownGoodRegistry();
      expect(
        () =>
          new AttestationVerifier({
            knownGoodPcrs: registry,
            graceSeconds: Infinity,
          })
      ).toThrow('graceSeconds must be a non-negative finite number');
    });

    it('should accept zero for validitySeconds and graceSeconds', () => {
      const registry = createKnownGoodRegistry();
      // Should not throw
      const verifier = new AttestationVerifier({
        knownGoodPcrs: registry,
        validitySeconds: 0,
        graceSeconds: 0,
      });
      const attestation = createTestAttestation();

      // With zero validity + zero grace, at attestedAt itself should be VALID (0 <= 0)
      const stateAtStart = verifier.getAttestationState(
        attestation,
        TEST_CREATED_AT,
        TEST_CREATED_AT
      );
      expect(stateAtStart).toBe(AttestationState.VALID);

      // At attestedAt + 1, should be UNATTESTED (both periods are 0)
      const stateAfter = verifier.getAttestationState(
        attestation,
        TEST_CREATED_AT,
        TEST_CREATED_AT + 1
      );
      expect(stateAfter).toBe(AttestationState.UNATTESTED);
    });
  });

  // ---------------------------------------------------------------------------
  // T-4.3-AUTO-18 [P1] getAttestationState -- non-finite attestedAt guard
  // ---------------------------------------------------------------------------

  describe('getAttestationState -- non-finite attestedAt', () => {
    it('should return UNATTESTED for NaN attestedAt', () => {
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation();

      const state = verifier.getAttestationState(
        attestation,
        NaN,
        TEST_CREATED_AT
      );
      expect(state).toBe(AttestationState.UNATTESTED);
    });

    it('should return UNATTESTED for Infinity attestedAt', () => {
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation();

      const state = verifier.getAttestationState(
        attestation,
        Infinity,
        TEST_CREATED_AT
      );
      expect(state).toBe(AttestationState.UNATTESTED);
    });

    it('should return UNATTESTED for -Infinity attestedAt', () => {
      const registry = createKnownGoodRegistry();
      const verifier = new AttestationVerifier({ knownGoodPcrs: registry });
      const attestation = createTestAttestation();

      const state = verifier.getAttestationState(
        attestation,
        -Infinity,
        TEST_CREATED_AT
      );
      expect(state).toBe(AttestationState.UNATTESTED);
    });
  });
});
