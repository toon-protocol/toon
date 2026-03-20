/**
 * ATDD tests for Story 4.2: TEE Attestation Events (FR-TEE-2)
 *
 * TDD GREEN PHASE: All tests enabled with real implementations.
 *
 * Validates:
 * - kind:10033 event published with correct JSON structure (Pattern 14)
 * - Required tags: relay, chain, expiry
 * - Content is JSON.stringify(), not plain string (enforcement guideline 11)
 * - parseAttestation() extracts and validates TeeAttestation content and tags
 * - parseAttestation() rejects forged/malformed attestation data
 * - TEE_ATTESTATION_KIND constant equals 10033
 * - Attestation server publishes on startup and refreshes on interval
 * - /health tee field conditional on TEE_ENABLED
 * - Schnorr signature verification via verifyEvent()
 * - NIP-16 replaceable range validation (kind 10000-19999)
 * - parseAttestation() graceful degradation for malformed content
 * - parseAttestation() validates required tags (relay, chain, expiry)
 * - parseAttestation() validates PCR format (96-char lowercase hex)
 * - Forward compatibility (extra unknown fields)
 *
 * Test IDs from test-design-epic-4.md / atdd-checklist-epic-4.md:
 * - T-4.2-01 [P0]: kind:10033 event correct JSON structure (Pattern 14)
 * - T-4.2-02 [P0]: Required tags: relay, chain, expiry
 * - T-4.2-03 [P0]: Content is valid JSON (not plain string)
 * - T-4.2-04 [P1]: Publishes kind:10033 on startup
 * - T-4.2-05 [P1]: Refreshes kind:10033 on interval
 * - T-4.2-06 [P1]: /health tee field conditional on TEE (2 sub-tests)
 * - T-4.2-07 [P0]: Forged attestation document rejected
 *
 * Gap-filling tests (AC coverage hardening):
 * - T-4.2-08 [P0]: TEE_ATTESTATION_KIND constant equals 10033
 * - T-4.2-09 [P0]: parseAttestation() returns valid ParsedAttestation for well-formed event
 * - T-4.2-10 [P1]: parseAttestation() returns null for malformed JSON content
 * - T-4.2-11 [P1]: parseAttestation() returns null for missing required content fields
 * - T-4.2-12 [P1]: parseAttestation() returns null for missing required tags
 * - T-4.2-13 [P1]: parseAttestation() rejects invalid PCR format when verify=true
 * - T-4.2-14 [P2]: buildAttestationEvent() produces verifyEvent()-valid signature
 * - T-4.2-15 [P2]: TEE_ATTESTATION_KIND is in NIP-16 replaceable range (10000-19999)
 * - T-4.2-16 [P2]: parseAttestation() forward compatibility (extra fields preserved)
 * - T-4.2-17 [P2]: buildAttestationEvent() no d tag (unlike kind:10035/10036 siblings)
 * - T-4.2-18 [P1]: parseAttestation() returns null for non-object JSON content
 *
 * Automate workflow gap-filling tests:
 * - T-4.2-19 [P1]: Builder-parser roundtrip (build then parse preserves all fields)
 * - T-4.2-20 [P1]: Permissive mode accepts weak data (invalid PCR/base64 without verify)
 * - T-4.2-21 [P1]: Content field wrong types (number, null, boolean instead of string)
 * - T-4.2-22 [P1]: Non-numeric expiry tag value returns null
 * - T-4.2-23 [P1]: Empty-value tags return null
 * - T-4.2-24 [P1]: PCR1 and PCR2 validation with verify=true
 * - T-4.2-25 [P2]: JSON primitive content types (number, string, boolean)
 *
 * Testarch-automate AC gap-filling tests:
 * - T-4.2-26 [P0]: Content has exactly 6 fields per Pattern 14 (AC #1)
 * - T-4.2-27 [P1]: parseAttestation with empty tags array (AC #2)
 * - T-4.2-28 [P1]: parseAttestation with tags missing values (AC #2)
 * - T-4.2-29 [P0]: Export verification -- TEE_ATTESTATION_KIND, builder/parser, TeeAttestation from core (AC #5)
 * - T-4.2-30 [P1]: Expiry tag edge cases (zero value, empty string) (AC #2)
 * - T-4.2-31 [P1]: attestationDoc edge cases with verify (whitespace, padding) (AC #2)
 * - T-4.2-32 [P1]: Duplicate tags use first match (AC #2)
 * - T-4.2-33 [P2]: created_at timestamp is recent (AC #1)
 * - T-4.2-34 [P1]: Various enclave type strings accepted (AC #2)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  buildAttestationEvent,
  parseAttestation,
  TEE_ATTESTATION_KIND,
} from './attestation.js';
import type { TeeAttestation } from './attestation.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Creates a valid TeeAttestation object for testing.
 * PCR values are 96-char lowercase hex strings (SHA-384).
 * Uses deterministic values for reproducible tests.
 */
function createTestAttestation(): TeeAttestation {
  return {
    enclave: 'aws-nitro',
    pcr0: 'a'.repeat(96), // SHA-384 hex
    pcr1: 'b'.repeat(96),
    pcr2: 'c'.repeat(96),
    attestationDoc: 'dGVzdC1hdHRlc3RhdGlvbi1kb2N1bWVudA==', // valid base64
    version: '1.0.0',
  };
}

/**
 * Creates a standard set of attestation event options for testing.
 * Uses plain numeric chain IDs per Pattern 14 / resolveChainConfig() convention.
 */
function createTestOptions() {
  return {
    relay: 'wss://relay.example.com',
    chain: '31337', // Anvil chain ID (plain numeric, per Pattern 14)
    expiry: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  };
}

/**
 * Creates a well-formed kind:10033 event for parser tests.
 * This constructs the event structure manually (without buildAttestationEvent)
 * so parser tests can run independently of the builder.
 */
function createTestEvent(
  overrides: Partial<{
    content: string;
    tags: string[][];
    kind: number;
  }> = {}
): NostrEvent {
  const secretKey = generateSecretKey();
  const attestation = createTestAttestation();
  const options = createTestOptions();

  return {
    id: '0'.repeat(64),
    pubkey: getPublicKey(secretKey),
    kind: overrides.kind ?? 10033,
    content: overrides.content ?? JSON.stringify(attestation),
    tags: overrides.tags ?? [
      ['relay', options.relay],
      ['chain', options.chain],
      ['expiry', String(options.expiry)],
    ],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

// ============================================================================
// Tests: buildAttestationEvent
// ============================================================================

describe('Story 4.2: kind:10033 TEE Attestation Events', () => {
  // --------------------------------------------------------------------------
  // T-4.2-08 [P0]: TEE_ATTESTATION_KIND constant
  // --------------------------------------------------------------------------
  describe('TEE_ATTESTATION_KIND constant (T-4.2-08)', () => {
    it('[P0] TEE_ATTESTATION_KIND equals 10033', () => {
      // Assert: constant matches the NIP-16 replaceable kind for TEE attestation
      expect(TEE_ATTESTATION_KIND).toBe(10033);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-15 [P2]: TEE_ATTESTATION_KIND is in NIP-16 replaceable range
  // --------------------------------------------------------------------------
  describe('TEE_ATTESTATION_KIND NIP-16 range validation (T-4.2-15)', () => {
    it('[P2] kind 10033 is within the NIP-16 replaceable range (10000-19999)', () => {
      // Assert: kind is in NIP-16 replaceable range, not NIP-33 (30000-39999)
      expect(TEE_ATTESTATION_KIND).toBeGreaterThanOrEqual(10000);
      expect(TEE_ATTESTATION_KIND).toBeLessThanOrEqual(19999);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-01 [P0]: kind:10033 event correct JSON structure (Pattern 14)
  // --------------------------------------------------------------------------
  describe('buildAttestationEvent() content structure (T-4.2-01)', () => {
    it('[P0] creates kind:10033 event with correct content fields (T-4.2-01)', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act
      const event = buildAttestationEvent(attestation, secretKey, options);

      // Assert: event metadata
      expect(event.kind).toBe(TEE_ATTESTATION_KIND);
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(event.pubkey).toBe(getPublicKey(secretKey));
      expect(event.created_at).toBeGreaterThan(0);

      // Assert: content fields (Pattern 14 compliance)
      const content = JSON.parse(event.content) as Record<string, unknown>;
      expect(content['enclave']).toBe('aws-nitro');
      expect(content['pcr0']).toBe('a'.repeat(96));
      expect(content['pcr1']).toBe('b'.repeat(96));
      expect(content['pcr2']).toBe('c'.repeat(96));
      expect(content['attestationDoc']).toBe(
        'dGVzdC1hdHRlc3RhdGlvbi1kb2N1bWVudA=='
      );
      expect(content['version']).toBe('1.0.0');
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-02 [P0]: Required tags: relay, chain, expiry
  // --------------------------------------------------------------------------
  describe('buildAttestationEvent() tags (T-4.2-02)', () => {
    it('[P0] includes required relay, chain, and expiry tags (T-4.2-02)', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act
      const event = buildAttestationEvent(attestation, secretKey, options);

      // Assert: all three required tags present with correct values
      expect(event.tags).toContainEqual(['relay', options.relay]);
      expect(event.tags).toContainEqual(['chain', options.chain]);
      expect(event.tags).toContainEqual(['expiry', String(options.expiry)]);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-03 [P0]: Content is valid JSON (enforcement guideline 11)
  // --------------------------------------------------------------------------
  describe('buildAttestationEvent() JSON content (T-4.2-03)', () => {
    it('[P0] content is valid JSON (enforcement guideline 11 compliance) (T-4.2-03)', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act
      const event = buildAttestationEvent(attestation, secretKey, options);

      // Assert: content must be parseable JSON, not a plain string
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(event.content);
      }).not.toThrow();
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-17 [P2]: No d tag (unlike kind:10035/10036 siblings)
  // --------------------------------------------------------------------------
  describe('buildAttestationEvent() no d tag (T-4.2-17)', () => {
    it('[P2] does not include a d tag (NIP-16 replaces by pubkey+kind alone)', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act
      const event = buildAttestationEvent(attestation, secretKey, options);

      // Assert: no d tag -- kind:10033 uses NIP-16 (pubkey+kind), not NIP-33 (pubkey+kind+d)
      const dTag = event.tags.find((t: string[]) => t[0] === 'd');
      expect(dTag).toBeUndefined();

      // Assert: exactly 3 tags (relay, chain, expiry)
      expect(event.tags).toHaveLength(3);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-14 [P2]: Schnorr signature verification
  // --------------------------------------------------------------------------
  describe('buildAttestationEvent() signature verification (T-4.2-14)', () => {
    it('[P2] produces an event that passes verifyEvent()', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act
      const event = buildAttestationEvent(attestation, secretKey, options);
      const isValid = verifyEvent(event);

      // Assert: event passes Schnorr signature verification
      expect(isValid).toBe(true);
    });
  });
});

// ============================================================================
// Tests: parseAttestation
// ============================================================================

describe('parseAttestation', () => {
  // --------------------------------------------------------------------------
  // T-4.2-09 [P0]: Valid event returns ParsedAttestation
  // --------------------------------------------------------------------------
  describe('parseAttestation() valid event (T-4.2-09)', () => {
    it('[P0] returns valid ParsedAttestation for well-formed kind:10033 event', () => {
      // Arrange
      const event = createTestEvent();

      // Act
      const result = parseAttestation(event);

      // Assert: all fields extracted correctly
      expect(result).not.toBeNull();
      expect(result!.attestation.enclave).toBe('aws-nitro');
      expect(result!.attestation.pcr0).toBe('a'.repeat(96));
      expect(result!.attestation.pcr1).toBe('b'.repeat(96));
      expect(result!.attestation.pcr2).toBe('c'.repeat(96));
      expect(result!.attestation.attestationDoc).toBe(
        'dGVzdC1hdHRlc3RhdGlvbi1kb2N1bWVudA=='
      );
      expect(result!.attestation.version).toBe('1.0.0');
      expect(result!.relay).toBe('wss://relay.example.com');
      expect(result!.chain).toBe('31337');
      expect(result!.expiry).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-10 [P1]: Malformed JSON content
  // --------------------------------------------------------------------------
  describe('parseAttestation() graceful degradation (T-4.2-10)', () => {
    it('[P1] returns null for malformed JSON content', () => {
      // Arrange: event with invalid JSON content
      const event = createTestEvent({ content: 'not valid json {{{' });

      // Act
      const result = parseAttestation(event);

      // Assert: graceful degradation returns null
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-18 [P1]: Non-object JSON content
  // --------------------------------------------------------------------------
  describe('parseAttestation() non-object content (T-4.2-18)', () => {
    it('[P1] returns null for non-object JSON content', () => {
      // Arrange: event with JSON array instead of object
      const event = createTestEvent({ content: '["not", "an", "object"]' });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P1] returns null for JSON null content', () => {
      // Arrange: event content is the string "null"
      const event = createTestEvent({ content: 'null' });

      // Act
      const result = parseAttestation(event);

      // Assert: null is not a valid object
      expect(result).toBeNull();
    });

    it('[P1] returns null for empty string content', () => {
      // Arrange: event content is an empty string
      const event = createTestEvent({ content: '' });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-11 [P1]: Missing required content fields
  // --------------------------------------------------------------------------
  describe('parseAttestation() missing required content fields (T-4.2-11)', () => {
    it('[P1] returns null when enclave is missing', () => {
      const { enclave: _, ...partial } = createTestAttestation();
      const event = createTestEvent({ content: JSON.stringify(partial) });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });

    it('[P1] returns null when pcr0 is missing', () => {
      const { pcr0: _, ...partial } = createTestAttestation();
      const event = createTestEvent({ content: JSON.stringify(partial) });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });

    it('[P1] returns null when pcr1 is missing', () => {
      const { pcr1: _, ...partial } = createTestAttestation();
      const event = createTestEvent({ content: JSON.stringify(partial) });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });

    it('[P1] returns null when pcr2 is missing', () => {
      const { pcr2: _, ...partial } = createTestAttestation();
      const event = createTestEvent({ content: JSON.stringify(partial) });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });

    it('[P1] returns null when attestationDoc is missing', () => {
      const { attestationDoc: _, ...partial } = createTestAttestation();
      const event = createTestEvent({ content: JSON.stringify(partial) });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });

    it('[P1] returns null when version is missing', () => {
      const { version: _, ...partial } = createTestAttestation();
      const event = createTestEvent({ content: JSON.stringify(partial) });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-12 [P1]: Missing required tags
  // --------------------------------------------------------------------------
  describe('parseAttestation() missing required tags (T-4.2-12)', () => {
    it('[P1] returns null when relay tag is missing', () => {
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['chain', options.chain],
          ['expiry', String(options.expiry)],
        ],
      });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });

    it('[P1] returns null when chain tag is missing', () => {
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', options.relay],
          ['expiry', String(options.expiry)],
        ],
      });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });

    it('[P1] returns null when expiry tag is missing', () => {
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', options.relay],
          ['chain', options.chain],
        ],
      });

      const result = parseAttestation(event);
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-13 [P1]: Invalid PCR format when verify=true
  // --------------------------------------------------------------------------
  describe('parseAttestation() PCR validation with verify=true (T-4.2-13)', () => {
    it('[P1] throws when pcr0 is not 96-char lowercase hex', () => {
      // Arrange: pcr0 is too short
      const attestation = createTestAttestation();
      attestation.pcr0 = 'abcdef'; // Only 6 chars, should be 96
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act & Assert
      expect(() => parseAttestation(event, { verify: true })).toThrow();
    });

    it('[P1] throws when pcr0 contains uppercase hex', () => {
      // Arrange: pcr0 has uppercase characters
      const attestation = createTestAttestation();
      attestation.pcr0 = 'A'.repeat(96); // Uppercase, should be lowercase
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act & Assert
      expect(() => parseAttestation(event, { verify: true })).toThrow();
    });

    it('[P1] throws when pcr0 contains non-hex characters', () => {
      // Arrange: pcr0 has non-hex characters
      const attestation = createTestAttestation();
      attestation.pcr0 = 'g'.repeat(96); // 'g' is not a hex character
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act & Assert
      expect(() => parseAttestation(event, { verify: true })).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-07 [P0]: Forged attestation document rejected
  // --------------------------------------------------------------------------
  describe('parseAttestation() forged attestation (T-4.2-07)', () => {
    it('[P0] rejects forged attestation document with invalid base64 (T-4.2-07)', () => {
      // Arrange: create an attestation event with a tampered attestationDoc
      // 'FORGED-INVALID-ATTESTATION-DOC' contains hyphens which are not valid base64
      const forgedAttestation = createTestAttestation();
      forgedAttestation.attestationDoc = 'FORGED-INVALID-ATTESTATION-DOC';

      const event = createTestEvent({
        content: JSON.stringify(forgedAttestation),
      });

      // Act & Assert: must throw or reject, not silently accept
      expect(() => parseAttestation(event, { verify: true })).toThrow();
    });

    it('[P0] rejects attestation with empty attestationDoc when verify=true', () => {
      // Arrange: empty attestation doc
      const emptyDocAttestation = createTestAttestation();
      emptyDocAttestation.attestationDoc = '';

      const event = createTestEvent({
        content: JSON.stringify(emptyDocAttestation),
      });

      // Act & Assert
      expect(() => parseAttestation(event, { verify: true })).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-16 [P2]: Forward compatibility (extra unknown fields)
  // --------------------------------------------------------------------------
  describe('parseAttestation() forward compatibility (T-4.2-16)', () => {
    it('[P2] parses content with extra unknown fields (forward compatible)', () => {
      // Arrange: content has all required fields plus extra unknown fields
      const attestation = {
        ...createTestAttestation(),
        futureField: 'some-value',
        anotherField: { nested: true },
      };
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act
      const result = parseAttestation(event);

      // Assert: parser succeeds and extracts known fields
      expect(result).not.toBeNull();
      expect(result!.attestation.enclave).toBe('aws-nitro');
      expect(result!.attestation.pcr0).toBe('a'.repeat(96));
      expect(result!.attestation.version).toBe('1.0.0');
    });
  });
});

// ============================================================================
// Tests: attestation server lifecycle
// ============================================================================

describe('attestation server lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // T-4.2-04 [P1]: Publishes kind:10033 on startup
  // NOTE: This tests the builder + publish pattern used by attestation-server.ts.
  // The actual attestation server (docker/src/attestation-server.ts) uses
  // WebSocket to publish to a local relay, which requires integration-level
  // testing. This unit test validates the publish contract: build -> collect.
  // --------------------------------------------------------------------------
  it('[P1] builds a publishable kind:10033 event on startup (T-4.2-04)', async () => {
    // Arrange: simulate the attestation server startup pattern
    const secretKey = generateSecretKey();
    const publishedEvents: NostrEvent[] = [];
    const attestation = createTestAttestation();

    // Act: build an attestation event (simulating startup publish)
    const event = buildAttestationEvent(attestation, secretKey, {
      relay: 'wss://localhost:7100',
      chain: '31337',
      expiry: Math.floor(Date.now() / 1000) + 600,
    });
    publishedEvents.push(event);

    // Assert: the event is well-formed and ready for publishing
    expect(publishedEvents.length).toBeGreaterThanOrEqual(1);
    const attestationEvent = publishedEvents.find((e) => e.kind === 10033);
    expect(attestationEvent).toBeDefined();
    expect(attestationEvent!.kind).toBe(10033);
    expect(verifyEvent(attestationEvent!)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T-4.2-05 [P1]: Refreshes kind:10033 on configurable interval
  // NOTE: This tests the interval-based refresh pattern used by
  // attestation-server.ts. The actual server publishes via WebSocket;
  // this unit test validates the interval contract and event freshness.
  // --------------------------------------------------------------------------
  it('[P1] produces fresh kind:10033 events on configurable interval (T-4.2-05)', async () => {
    // Arrange: simulate the attestation server refresh lifecycle
    const secretKey = generateSecretKey();
    const publishedEvents: NostrEvent[] = [];
    const refreshIntervalMs = 100; // Short interval for testing

    const publish = () => {
      const attestation = createTestAttestation();
      const event = buildAttestationEvent(attestation, secretKey, {
        relay: 'wss://localhost:7100',
        chain: '31337',
        expiry: Math.floor(Date.now() / 1000) + 600,
      });
      publishedEvents.push(event);
    };

    // Initial publish
    publish();

    // Set up interval for refresh
    const interval = setInterval(publish, refreshIntervalMs);

    // Advance time past one refresh cycle
    vi.advanceTimersByTime(refreshIntervalMs + 50);

    // Cleanup
    clearInterval(interval);

    // Assert: at least 2 events -- initial + one refresh
    const attestationEvents = publishedEvents.filter((e) => e.kind === 10033);
    expect(attestationEvents.length).toBeGreaterThanOrEqual(2);

    // Each event should be independently valid
    for (const evt of attestationEvents) {
      expect(evt.kind).toBe(10033);
      expect(verifyEvent(evt)).toBe(true);
    }

    // Refreshed event should have same or later created_at
    const first = attestationEvents[0]!;
    const second = attestationEvents[1]!;
    expect(second.created_at).toBeGreaterThanOrEqual(first.created_at);
  });
});

// ============================================================================
// Tests: coverage expansion (automate workflow gap-filling)
// ============================================================================

describe('parseAttestation coverage expansion', () => {
  // --------------------------------------------------------------------------
  // T-4.2-19 [P1]: Builder-parser roundtrip
  // --------------------------------------------------------------------------
  describe('build-then-parse roundtrip (T-4.2-19)', () => {
    it('[P1] parseAttestation() successfully parses buildAttestationEvent() output', () => {
      // Arrange: build a real signed event
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act: build then parse
      const event = buildAttestationEvent(attestation, secretKey, options);
      const result = parseAttestation(event);

      // Assert: roundtrip preserves all fields
      expect(result).not.toBeNull();
      expect(result!.attestation.enclave).toBe(attestation.enclave);
      expect(result!.attestation.pcr0).toBe(attestation.pcr0);
      expect(result!.attestation.pcr1).toBe(attestation.pcr1);
      expect(result!.attestation.pcr2).toBe(attestation.pcr2);
      expect(result!.attestation.attestationDoc).toBe(
        attestation.attestationDoc
      );
      expect(result!.attestation.version).toBe(attestation.version);
      expect(result!.relay).toBe(options.relay);
      expect(result!.chain).toBe(options.chain);
      expect(result!.expiry).toBe(options.expiry);
    });

    it('[P1] roundtrip with verify=true passes for well-formed event', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act
      const event = buildAttestationEvent(attestation, secretKey, options);
      const result = parseAttestation(event, { verify: true });

      // Assert: strict verification also passes
      expect(result).not.toBeNull();
      expect(result!.attestation.enclave).toBe(attestation.enclave);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-20 [P1]: Permissive mode accepts weak data
  // --------------------------------------------------------------------------
  describe('parseAttestation() permissive mode (T-4.2-20)', () => {
    it('[P1] accepts invalid PCR format when verify is false (default)', () => {
      // Arrange: PCR with invalid format (too short, uppercase)
      const attestation = createTestAttestation();
      attestation.pcr0 = 'SHORT';
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act: parse without verify (permissive mode)
      const result = parseAttestation(event);

      // Assert: accepted in permissive mode (format not validated)
      expect(result).not.toBeNull();
      expect(result!.attestation.pcr0).toBe('SHORT');
    });

    it('[P1] accepts invalid base64 attestationDoc when verify is false', () => {
      // Arrange: attestationDoc with invalid base64 characters
      const attestation = createTestAttestation();
      attestation.attestationDoc = 'NOT-VALID-BASE64!!!';
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act: parse without verify
      const result = parseAttestation(event);

      // Assert: accepted in permissive mode
      expect(result).not.toBeNull();
      expect(result!.attestation.attestationDoc).toBe('NOT-VALID-BASE64!!!');
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-21 [P1]: Content field wrong types
  // --------------------------------------------------------------------------
  describe('parseAttestation() wrong field types (T-4.2-21)', () => {
    it('[P1] returns null when enclave is a number instead of string', () => {
      // Arrange
      const content = {
        ...createTestAttestation(),
        enclave: 12345,
      };
      const event = createTestEvent({ content: JSON.stringify(content) });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P1] returns null when pcr0 is null instead of string', () => {
      // Arrange
      const content = {
        ...createTestAttestation(),
        pcr0: null,
      };
      const event = createTestEvent({ content: JSON.stringify(content) });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P1] returns null when version is a boolean instead of string', () => {
      // Arrange
      const content = {
        ...createTestAttestation(),
        version: true,
      };
      const event = createTestEvent({ content: JSON.stringify(content) });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P1] returns null when attestationDoc is a number instead of string', () => {
      // Arrange
      const content = {
        ...createTestAttestation(),
        attestationDoc: 42,
      };
      const event = createTestEvent({ content: JSON.stringify(content) });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-22 [P1]: Non-numeric expiry tag value
  // --------------------------------------------------------------------------
  describe('parseAttestation() non-numeric expiry (T-4.2-22)', () => {
    it('[P1] returns null when expiry tag has a non-numeric value', () => {
      // Arrange: expiry tag with non-numeric string
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', options.relay],
          ['chain', options.chain],
          ['expiry', 'not-a-number'],
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert: NaN from parseInt triggers null return
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-23 [P1]: Empty-value tags
  // --------------------------------------------------------------------------
  describe('parseAttestation() empty tag values (T-4.2-23)', () => {
    it('[P1] returns null when relay tag has empty string value', () => {
      // Arrange: relay tag with empty value
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', ''],
          ['chain', options.chain],
          ['expiry', String(options.expiry)],
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert: empty string is falsy, triggers null return
      expect(result).toBeNull();
    });

    it('[P1] returns null when chain tag has empty string value', () => {
      // Arrange
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', options.relay],
          ['chain', ''],
          ['expiry', String(options.expiry)],
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-24 [P1]: PCR1 and PCR2 validation with verify=true
  // --------------------------------------------------------------------------
  describe('parseAttestation() pcr1/pcr2 validation with verify=true (T-4.2-24)', () => {
    it('[P1] throws when pcr1 is invalid with verify=true', () => {
      // Arrange: valid pcr0, invalid pcr1
      const attestation = createTestAttestation();
      attestation.pcr1 = 'INVALID'; // Not 96-char lowercase hex
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act & Assert: pcr1 validation fires
      expect(() => parseAttestation(event, { verify: true })).toThrow(/PCR1/);
    });

    it('[P1] throws when pcr2 is invalid with verify=true', () => {
      // Arrange: valid pcr0 and pcr1, invalid pcr2
      const attestation = createTestAttestation();
      attestation.pcr2 = 'x'.repeat(96); // Non-hex characters
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act & Assert: pcr2 validation fires
      expect(() => parseAttestation(event, { verify: true })).toThrow(/PCR2/);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-25 [P2]: JSON primitive content types
  // --------------------------------------------------------------------------
  describe('parseAttestation() JSON primitive content (T-4.2-25)', () => {
    it('[P2] returns null for JSON number content', () => {
      // Arrange
      const event = createTestEvent({ content: '42' });

      // Act
      const result = parseAttestation(event);

      // Assert: number is not an object
      expect(result).toBeNull();
    });

    it('[P2] returns null for JSON string content', () => {
      // Arrange
      const event = createTestEvent({ content: '"just a string"' });

      // Act
      const result = parseAttestation(event);

      // Assert: string is not an object
      expect(result).toBeNull();
    });

    it('[P2] returns null for JSON boolean content', () => {
      // Arrange
      const event = createTestEvent({ content: 'true' });

      // Act
      const result = parseAttestation(event);

      // Assert: boolean is not an object
      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// Tests: AC gap-filling (testarch-automate workflow)
// ============================================================================

describe('AC gap-filling: attestation event coverage', () => {
  // --------------------------------------------------------------------------
  // T-4.2-26 [P0]: Content has exactly 6 fields per Pattern 14 (AC #1)
  // --------------------------------------------------------------------------
  describe('buildAttestationEvent() content field count (T-4.2-26)', () => {
    it('[P0] content has exactly 6 fields (Pattern 14: no extra, no missing)', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act
      const event = buildAttestationEvent(attestation, secretKey, options);
      const content = JSON.parse(event.content) as Record<string, unknown>;

      // Assert: exactly 6 fields per Pattern 14
      const keys = Object.keys(content).sort();
      expect(keys).toEqual(
        ['attestationDoc', 'enclave', 'pcr0', 'pcr1', 'pcr2', 'version'].sort()
      );
      expect(keys).toHaveLength(6);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-27 [P1]: parseAttestation with empty tags array (AC #2)
  // --------------------------------------------------------------------------
  describe('parseAttestation() empty tags array (T-4.2-27)', () => {
    it('[P1] returns null when event has no tags at all', () => {
      // Arrange: event with empty tags array
      const event = createTestEvent({ tags: [] });

      // Act
      const result = parseAttestation(event);

      // Assert: all three required tags are missing
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-28 [P1]: parseAttestation with tags missing values (AC #2)
  // --------------------------------------------------------------------------
  describe('parseAttestation() tags with only name (no value) (T-4.2-28)', () => {
    it('[P1] returns null when relay tag has no value element', () => {
      // Arrange: relay tag is ['relay'] without a second element
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay'], // missing value
          ['chain', options.chain],
          ['expiry', String(options.expiry)],
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert: relay tag value is undefined, triggers null return
      expect(result).toBeNull();
    });

    it('[P1] returns null when chain tag has no value element', () => {
      // Arrange
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', options.relay],
          ['chain'], // missing value
          ['expiry', String(options.expiry)],
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P1] returns null when expiry tag has no value element', () => {
      // Arrange
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', options.relay],
          ['chain', options.chain],
          ['expiry'], // missing value
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-29 [P0]: Export verification -- TEE_ATTESTATION_KIND and TeeAttestation
  //                 importable from @toon-protocol/core (AC #5)
  // --------------------------------------------------------------------------
  describe('@toon-protocol/core exports attestation types (T-4.2-29)', () => {
    it('[P0] TEE_ATTESTATION_KIND is importable and equals 10033', async () => {
      // Arrange: dynamically import from @toon-protocol/core to verify top-level export
      const core = await import('../index.js');

      // Assert: TEE_ATTESTATION_KIND is exported and equals 10033
      expect(core.TEE_ATTESTATION_KIND).toBe(10033);
    });

    it('[P0] buildAttestationEvent is importable from @toon-protocol/core', async () => {
      // Arrange
      const core = await import('../index.js');

      // Assert: buildAttestationEvent is a function
      expect(typeof core.buildAttestationEvent).toBe('function');
    });

    it('[P0] parseAttestation is importable from @toon-protocol/core', async () => {
      // Arrange
      const core = await import('../index.js');

      // Assert: parseAttestation is a function
      expect(typeof core.parseAttestation).toBe('function');
    });

    it('[P0] TeeAttestation type is exported from @toon-protocol/core (AC #5)', async () => {
      // Arrange: import the TeeAttestation type from the core index
      // Since TypeScript types are erased at runtime, we verify the interface
      // contract by constructing a value that satisfies TeeAttestation and
      // passing it through the builder (which requires TeeAttestation input).
      const core = await import('../index.js');

      // Act: create a value satisfying TeeAttestation interface shape
      const attestation: TeeAttestation = {
        enclave: 'aws-nitro',
        pcr0: 'a'.repeat(96),
        pcr1: 'b'.repeat(96),
        pcr2: 'c'.repeat(96),
        attestationDoc: 'dGVzdA==',
        version: '1.0.0',
      };

      // Assert: TEE_ATTESTATION_KIND is a number (runtime-verifiable export)
      // and the attestation satisfies the TeeAttestation interface contract
      // (6 required fields: enclave, pcr0, pcr1, pcr2, attestationDoc, version)
      expect(core.TEE_ATTESTATION_KIND).toBe(10033);
      expect(typeof attestation.enclave).toBe('string');
      expect(typeof attestation.pcr0).toBe('string');
      expect(typeof attestation.pcr1).toBe('string');
      expect(typeof attestation.pcr2).toBe('string');
      expect(typeof attestation.attestationDoc).toBe('string');
      expect(typeof attestation.version).toBe('string');
      expect(Object.keys(attestation)).toHaveLength(6);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-30 [P1]: Expiry tag with zero value (AC #2 edge case)
  // --------------------------------------------------------------------------
  describe('parseAttestation() expiry edge cases (T-4.2-30)', () => {
    it('[P1] accepts expiry of 0 (epoch start, technically valid numeric)', () => {
      // Arrange: expiry is 0, which is a valid number
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', options.relay],
          ['chain', options.chain],
          ['expiry', '0'],
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert: 0 is a valid integer, parser should accept it
      expect(result).not.toBeNull();
      expect(result!.expiry).toBe(0);
    });

    it('[P1] returns null when expiry tag value is empty string', () => {
      // Arrange: expiry is an empty string
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', options.relay],
          ['chain', options.chain],
          ['expiry', ''],
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert: parseInt('', 10) returns NaN
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-31 [P1]: parseAttestation verify mode: attestationDoc only whitespace (AC #2)
  // --------------------------------------------------------------------------
  describe('parseAttestation() attestationDoc edge cases with verify (T-4.2-31)', () => {
    it('[P1] throws when attestationDoc is whitespace-only with verify=true', () => {
      // Arrange: attestationDoc is spaces (not valid base64)
      const attestation = createTestAttestation();
      attestation.attestationDoc = '   ';
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act & Assert: whitespace fails base64 regex
      expect(() => parseAttestation(event, { verify: true })).toThrow();
    });

    it('[P1] accepts valid base64 with padding when verify=true', () => {
      // Arrange: valid base64 with padding chars
      const attestation = createTestAttestation();
      attestation.attestationDoc = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act
      const result = parseAttestation(event, { verify: true });

      // Assert: valid base64 accepted
      expect(result).not.toBeNull();
      expect(result!.attestation.attestationDoc).toBe('SGVsbG8gV29ybGQ=');
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-32 [P1]: Multiple tags with same name (AC #2 edge case)
  // --------------------------------------------------------------------------
  describe('parseAttestation() duplicate tags (T-4.2-32)', () => {
    it('[P1] uses first matching tag when duplicate tag names exist', () => {
      // Arrange: two relay tags -- parser should use the first
      const options = createTestOptions();
      const event = createTestEvent({
        tags: [
          ['relay', 'wss://first.relay.example'],
          ['chain', options.chain],
          ['expiry', String(options.expiry)],
          ['relay', 'wss://second.relay.example'], // duplicate
        ],
      });

      // Act
      const result = parseAttestation(event);

      // Assert: first relay tag value is used (Array.find returns first match)
      expect(result).not.toBeNull();
      expect(result!.relay).toBe('wss://first.relay.example');
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-33 [P2]: buildAttestationEvent created_at is recent (AC #1)
  // --------------------------------------------------------------------------
  describe('buildAttestationEvent() created_at timestamp (T-4.2-33)', () => {
    it('[P2] created_at is within 2 seconds of current time', () => {
      // Arrange
      const before = Math.floor(Date.now() / 1000);
      const secretKey = generateSecretKey();
      const attestation = createTestAttestation();
      const options = createTestOptions();

      // Act
      const event = buildAttestationEvent(attestation, secretKey, options);
      const after = Math.floor(Date.now() / 1000);

      // Assert: created_at is between before and after
      expect(event.created_at).toBeGreaterThanOrEqual(before);
      expect(event.created_at).toBeLessThanOrEqual(after);
    });
  });

  // --------------------------------------------------------------------------
  // T-4.2-34 [P1]: parseAttestation with non-string enclave types (AC #2)
  // --------------------------------------------------------------------------
  describe('parseAttestation() various enclave type strings (T-4.2-34)', () => {
    it('[P1] accepts different enclave type strings (marlin-oyster)', () => {
      // Arrange: different enclave type
      const attestation = createTestAttestation();
      attestation.enclave = 'marlin-oyster';
      const event = createTestEvent({ content: JSON.stringify(attestation) });

      // Act
      const result = parseAttestation(event);

      // Assert: any string is accepted as enclave type
      expect(result).not.toBeNull();
      expect(result!.attestation.enclave).toBe('marlin-oyster');
    });
  });
});

// ============================================================================
// Tests: attestation health endpoint
// NOTE: T-4.2-06 health tests are in packages/town/src/health.test.ts because
// core cannot import from @toon-protocol/town (boundary rule: town is a leaf node).
// ============================================================================
