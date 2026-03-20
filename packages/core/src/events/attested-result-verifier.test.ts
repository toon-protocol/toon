/**
 * Tests for AttestedResultVerifier and hasRequireAttestation (Story 6.3).
 *
 * Test IDs:
 * - T-6.3-01 [P0]: TEE-enabled provider's Kind 6xxx includes attestation tag
 * - T-6.3-02 [P0]: Non-TEE provider's Kind 6xxx has no attestation tag
 * - T-6.3-03 [P0]: Customer verification -- pubkey match
 * - T-6.3-04 [P0]: Customer verification -- PCR validity
 * - T-6.3-05 [P0]: Customer verification -- time validity
 * - T-6.3-06 [P0]: Negative -- pubkey mismatch
 * - T-6.3-07 [P0]: Negative -- PCR mismatch
 * - T-6.3-08 [P1]: Negative -- attestation expired
 * - T-6.3-09 [P1]: require_attestation parameter detection
 * - T-6.3-12 [P0]: Attestation tag TOON roundtrip
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '../toon/index.js';
import {
  buildJobResultEvent,
  buildJobRequestEvent,
  buildJobFeedbackEvent,
  parseJobResult,
  parseJobRequest,
} from './dvm.js';
import type { ParsedJobResult } from './dvm.js';
import type { ParsedAttestation } from './attestation.js';
import {
  AttestedResultVerifier,
  hasRequireAttestation,
} from './attested-result-verifier.js';
import {
  AttestationVerifier,
  AttestationState,
} from '../bootstrap/AttestationVerifier.js';
import { ToonError } from '../errors.js';
import {
  FIXED_BUILDER_SECRET_KEY,
  FIXED_BUILDER_PUBKEY,
  createJobResultParams,
  createJobRequestParams,
} from './dvm-test-helpers.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/** Known-good PCR values for test attestations. */
const GOOD_PCR0 = 'a'.repeat(96);
const GOOD_PCR1 = 'b'.repeat(96);
const GOOD_PCR2 = 'c'.repeat(96);
const BAD_PCR0 = 'd'.repeat(96);

/** Fixed attestation event ID. */
const ATTESTATION_EVENT_ID = 'e'.repeat(64);

/** Creates a known-good AttestationVerifier for tests. */
function createTestVerifier(
  options: { validitySeconds?: number; graceSeconds?: number } = {}
): AttestationVerifier {
  const knownGoodPcrs = new Map<string, boolean>();
  knownGoodPcrs.set(GOOD_PCR0, true);
  knownGoodPcrs.set(GOOD_PCR1, true);
  knownGoodPcrs.set(GOOD_PCR2, true);
  return new AttestationVerifier({
    knownGoodPcrs,
    validitySeconds: options.validitySeconds ?? 300,
    graceSeconds: options.graceSeconds ?? 30,
  });
}

/** Creates a mock attestation event. */
function createAttestationEvent(
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: ATTESTATION_EVENT_ID,
    pubkey: overrides.pubkey ?? FIXED_BUILDER_PUBKEY,
    kind: 10033,
    content: JSON.stringify({
      enclave: 'marlin-oyster',
      pcr0: GOOD_PCR0,
      pcr1: GOOD_PCR1,
      pcr2: GOOD_PCR2,
      attestationDoc: 'dGVzdA==',
      version: '1.0.0',
    }),
    tags: [
      ['relay', 'wss://relay.example.com'],
      ['chain', '421614'],
      ['expiry', String(Math.floor(Date.now() / 1000) + 600)],
    ],
    created_at: overrides.created_at ?? 1000,
    sig: '0'.repeat(128),
  };
}

/** Creates a parsed attestation with known-good PCR values. */
function createParsedAttestation(
  overrides: Partial<{ pcr0: string; pcr1: string; pcr2: string }> = {}
): ParsedAttestation {
  return {
    attestation: {
      enclave: 'marlin-oyster',
      pcr0: overrides.pcr0 ?? GOOD_PCR0,
      pcr1: overrides.pcr1 ?? GOOD_PCR1,
      pcr2: overrides.pcr2 ?? GOOD_PCR2,
      attestationDoc: 'dGVzdA==',
      version: '1.0.0',
    },
    relay: 'wss://relay.example.com',
    chain: '421614',
    expiry: Math.floor(Date.now() / 1000) + 600,
  };
}

/** Creates a mock Kind 6xxx result event. */
function createResultEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: '1'.repeat(64),
    pubkey: overrides.pubkey ?? FIXED_BUILDER_PUBKEY,
    kind: 6100,
    content: 'Result text',
    tags: [
      ['e', 'a'.repeat(64)],
      ['p', 'b'.repeat(64)],
      ['amount', '500000', 'usdc'],
      ['attestation', ATTESTATION_EVENT_ID],
    ],
    created_at: overrides.created_at ?? 1100,
    sig: '0'.repeat(128),
  };
}

/** Creates a mock ParsedJobResult. */
function createParsedResult(
  overrides: Partial<ParsedJobResult> = {}
): ParsedJobResult {
  return {
    kind: 6100,
    requestEventId: 'a'.repeat(64),
    customerPubkey: 'b'.repeat(64),
    amount: '500000',
    content: 'Result text',
    attestationEventId: ATTESTATION_EVENT_ID,
    ...overrides,
  };
}

// ============================================================================
// Task 1: Kind 6xxx attestation tag injection/parsing
// ============================================================================

describe('Kind 6xxx attestation tag (Task 1)', () => {
  // --------------------------------------------------------------------------
  // T-6.3-01 [P0]: TEE-enabled provider includes attestation tag
  // --------------------------------------------------------------------------
  describe('attestation tag injection (T-6.3-01)', () => {
    it("[P0] TEE-enabled provider's Kind 6xxx builder includes attestation tag referencing kind:10033 event ID", () => {
      // Arrange
      const params = createJobResultParams({
        attestationEventId: ATTESTATION_EVENT_ID,
      });

      // Act
      const event = buildJobResultEvent(params, FIXED_BUILDER_SECRET_KEY);

      // Assert
      const attestationTag = event.tags.find(
        (t: string[]) => t[0] === 'attestation'
      );
      expect(attestationTag).toBeDefined();
      expect(attestationTag).toEqual(['attestation', ATTESTATION_EVENT_ID]);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.3-02 [P0]: Non-TEE provider has no attestation tag
  // --------------------------------------------------------------------------
  describe('no attestation tag for non-TEE (T-6.3-02)', () => {
    it('[P0] Kind 6xxx from non-TEE node has no attestation tag when attestationEventId not provided', () => {
      // Arrange
      const params = createJobResultParams();

      // Act
      const event = buildJobResultEvent(params, FIXED_BUILDER_SECRET_KEY);

      // Assert
      const attestationTag = event.tags.find(
        (t: string[]) => t[0] === 'attestation'
      );
      expect(attestationTag).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Task 1.8: Validation error for invalid attestationEventId
  // --------------------------------------------------------------------------
  describe('attestationEventId validation', () => {
    it('throws ToonError with DVM_INVALID_ATTESTATION_EVENT_ID for invalid hex', () => {
      // Arrange
      const params = createJobResultParams({
        attestationEventId: 'not-valid-hex',
      });

      // Act & Assert
      let thrown: unknown;
      try {
        buildJobResultEvent(params, FIXED_BUILDER_SECRET_KEY);
        expect.unreachable('Expected buildJobResultEvent to throw');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ToonError);
      expect((thrown as ToonError).code).toBe(
        'DVM_INVALID_ATTESTATION_EVENT_ID'
      );
    });

    it('throws for uppercase hex attestationEventId', () => {
      // Arrange
      const params = createJobResultParams({
        attestationEventId: 'E'.repeat(64),
      });

      // Act & Assert
      expect(() =>
        buildJobResultEvent(params, FIXED_BUILDER_SECRET_KEY)
      ).toThrow(ToonError);
    });

    it('throws for too-short attestationEventId', () => {
      // Arrange
      const params = createJobResultParams({
        attestationEventId: 'e'.repeat(63),
      });

      // Act & Assert
      expect(() =>
        buildJobResultEvent(params, FIXED_BUILDER_SECRET_KEY)
      ).toThrow(ToonError);
    });
  });

  // --------------------------------------------------------------------------
  // Task 1.9 / AC #5: Backward compatibility
  // --------------------------------------------------------------------------
  describe('backward compatibility (AC #5)', () => {
    it('[P0] existing Kind 6xxx events without attestation tag parse with attestationEventId undefined', () => {
      // Arrange: event without attestation tag
      const event: NostrEvent = {
        id: '0'.repeat(64),
        pubkey: FIXED_BUILDER_PUBKEY,
        kind: 6100,
        content: 'Result text',
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '500000', 'usdc'],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.attestationEventId).toBeUndefined();
      expect(parsed!.kind).toBe(6100);
      expect(parsed!.requestEventId).toBe('a'.repeat(64));
      expect(parsed!.amount).toBe('500000');
    });
  });

  // --------------------------------------------------------------------------
  // Task 1.4: parseJobResult extracts attestation tag
  // --------------------------------------------------------------------------
  describe('parseJobResult attestation extraction', () => {
    it('extracts attestationEventId from attestation tag', () => {
      // Arrange: event with attestation tag
      const event: NostrEvent = {
        id: '0'.repeat(64),
        pubkey: FIXED_BUILDER_PUBKEY,
        kind: 6100,
        content: 'Result text',
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '500000', 'usdc'],
          ['attestation', ATTESTATION_EVENT_ID],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.attestationEventId).toBe(ATTESTATION_EVENT_ID);
    });

    it('ignores invalid attestation tag value (non-hex)', () => {
      // Arrange: event with malformed attestation tag
      const event: NostrEvent = {
        id: '0'.repeat(64),
        pubkey: FIXED_BUILDER_PUBKEY,
        kind: 6100,
        content: 'Result text',
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '500000', 'usdc'],
          ['attestation', 'not-valid'],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseJobResult(event);

      // Assert: parses successfully but attestationEventId is undefined
      expect(parsed).not.toBeNull();
      expect(parsed!.attestationEventId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // T-6.3-12 [P0]: TOON roundtrip
  // --------------------------------------------------------------------------
  describe('attestation tag TOON roundtrip (T-6.3-12)', () => {
    it('[P0] attestation tag in Kind 6xxx survives TOON encode -> decode with event ID preserved', () => {
      // Arrange
      const params = createJobResultParams({
        attestationEventId: ATTESTATION_EVENT_ID,
      });
      const event = buildJobResultEvent(params, FIXED_BUILDER_SECRET_KEY);

      // Act: TOON roundtrip
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert: attestation tag survives
      const attestationTag = decoded.tags.find(
        (t: string[]) => t[0] === 'attestation'
      );
      expect(attestationTag).toEqual(['attestation', ATTESTATION_EVENT_ID]);

      // Assert: full parse roundtrip
      const parsed = parseJobResult(decoded);
      expect(parsed).not.toBeNull();
      expect(parsed!.attestationEventId).toBe(ATTESTATION_EVENT_ID);
    });
  });
});

// ============================================================================
// Task 2: Customer-side attestation result verifier
// ============================================================================

describe('AttestedResultVerifier (Task 2)', () => {
  // --------------------------------------------------------------------------
  // T-6.3-03 [P0]: Pubkey match verification succeeds
  // --------------------------------------------------------------------------
  describe('pubkey match (T-6.3-03)', () => {
    it('[P0] verification succeeds when kind:10033 pubkey matches Kind 6xxx author pubkey', () => {
      // Arrange
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier(),
      });
      const resultEvent = createResultEvent({ created_at: 1100 });
      const parsedResult = createParsedResult();
      const attestationEvent = createAttestationEvent({ created_at: 1000 });
      const parsedAttestation = createParsedAttestation();

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert
      expect(result.valid).toBe(true);
      expect(result.attestationState).toBe(AttestationState.VALID);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.3-04 [P0]: PCR validity
  // --------------------------------------------------------------------------
  describe('PCR validity (T-6.3-04)', () => {
    it('[P0] verification succeeds when PCR values match known-good registry', () => {
      // Arrange
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier(),
      });
      const resultEvent = createResultEvent({ created_at: 1100 });
      const parsedResult = createParsedResult();
      const attestationEvent = createAttestationEvent({ created_at: 1000 });
      const parsedAttestation = createParsedAttestation();

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert
      expect(result.valid).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.3-05 [P0]: Time validity
  // --------------------------------------------------------------------------
  describe('time validity (T-6.3-05)', () => {
    it('[P0] verification uses resultEvent.created_at as now parameter, not wall-clock time', () => {
      // Arrange: attestation at t=1000, result at t=1100, validity=300s
      // At t=1100, attestation is within validity window (1000+300=1300 > 1100)
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier({ validitySeconds: 300 }),
      });
      const attestationEvent = createAttestationEvent({ created_at: 1000 });
      const resultEvent = createResultEvent({ created_at: 1100 });
      const parsedResult = createParsedResult();
      const parsedAttestation = createParsedAttestation();

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert
      expect(result.valid).toBe(true);
      expect(result.attestationState).toBe(AttestationState.VALID);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.3-06 [P0]: Negative -- pubkey mismatch
  // --------------------------------------------------------------------------
  describe('pubkey mismatch (T-6.3-06)', () => {
    it('[P0] verification fails with "pubkey mismatch" when kind:10033 pubkey differs from Kind 6xxx author', () => {
      // Arrange: different pubkeys
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier(),
      });
      const resultEvent = createResultEvent({
        pubkey: FIXED_BUILDER_PUBKEY,
        created_at: 1100,
      });
      const parsedResult = createParsedResult();
      const differentPubkey = 'f'.repeat(64);
      const attestationEvent = createAttestationEvent({
        pubkey: differentPubkey,
        created_at: 1000,
      });
      const parsedAttestation = createParsedAttestation();

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('pubkey mismatch');
    });
  });

  // --------------------------------------------------------------------------
  // T-6.3-07 [P0]: Negative -- PCR mismatch
  // --------------------------------------------------------------------------
  describe('PCR mismatch (T-6.3-07)', () => {
    it('[P0] verification fails with "PCR mismatch" when PCR values are unknown', () => {
      // Arrange: unknown PCR0
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier(),
      });
      const resultEvent = createResultEvent({ created_at: 1100 });
      const parsedResult = createParsedResult();
      const attestationEvent = createAttestationEvent({ created_at: 1000 });
      const parsedAttestation = createParsedAttestation({
        pcr0: BAD_PCR0,
      });

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });

  // --------------------------------------------------------------------------
  // T-6.3-08 [P1]: Negative -- attestation expired at result creation time
  // --------------------------------------------------------------------------
  describe('attestation expired (T-6.3-08)', () => {
    it('[P1] verification fails when attestation expired at result creation time', () => {
      // Arrange: attestation at t=1000, validity=300, grace=30
      // Result at t=1500 -> past validity (1300) and grace (1330)
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier({
          validitySeconds: 300,
          graceSeconds: 30,
        }),
      });
      const attestationEvent = createAttestationEvent({ created_at: 1000 });
      const resultEvent = createResultEvent({ created_at: 1500 });
      const parsedResult = createParsedResult();
      const parsedAttestation = createParsedAttestation();

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('attestation expired at result creation time');
      expect(result.attestationState).toBe(AttestationState.UNATTESTED);
    });

    it('[P0] verification succeeds at exact validity boundary (inclusive)', () => {
      // Arrange: attestation at t=1000, validity=300s
      // Result at t=1300 -> exactly at validity boundary (1000+300=1300, inclusive <=)
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier({ validitySeconds: 300 }),
      });
      const attestationEvent = createAttestationEvent({ created_at: 1000 });
      const resultEvent = createResultEvent({ created_at: 1300 });
      const parsedResult = createParsedResult();
      const parsedAttestation = createParsedAttestation();

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert: boundary is inclusive, so VALID at exactly validityEnd
      expect(result.valid).toBe(true);
      expect(result.attestationState).toBe(AttestationState.VALID);
    });

    it('[P1] verification fails one second past validity boundary', () => {
      // Arrange: attestation at t=1000, validity=300s, grace=30s
      // Result at t=1301 -> one second past validity (1000+300=1300)
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier({
          validitySeconds: 300,
          graceSeconds: 30,
        }),
      });
      const attestationEvent = createAttestationEvent({ created_at: 1000 });
      const resultEvent = createResultEvent({ created_at: 1301 });
      const parsedResult = createParsedResult();
      const parsedAttestation = createParsedAttestation();

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert: past validity -> STALE (within grace period)
      expect(result.valid).toBe(false);
      expect(result.attestationState).toBe(AttestationState.STALE);
    });

    it('[P1] verification fails with STALE state during grace period', () => {
      // Arrange: attestation at t=1000, validity=300, grace=30
      // Result at t=1310 -> past validity (1300) but within grace (1330)
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier({
          validitySeconds: 300,
          graceSeconds: 30,
        }),
      });
      const attestationEvent = createAttestationEvent({ created_at: 1000 });
      const resultEvent = createResultEvent({ created_at: 1310 });
      const parsedResult = createParsedResult();
      const parsedAttestation = createParsedAttestation();

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('attestation expired at result creation time');
      expect(result.attestationState).toBe(AttestationState.STALE);
    });
  });

  // --------------------------------------------------------------------------
  // NFR-6-SEC-01: Fabricated attestation defense
  // --------------------------------------------------------------------------
  describe('fabricated attestation defense (NFR-6-SEC-01)', () => {
    it('[P0] provider with matching pubkey but fabricated PCR values is rejected', () => {
      // Arrange: provider creates a fake attestation event with their own pubkey
      // but uses PCR values not in the known-good registry
      const verifier = new AttestedResultVerifier({
        attestationVerifier: createTestVerifier(),
      });
      const resultEvent = createResultEvent({
        pubkey: FIXED_BUILDER_PUBKEY,
        created_at: 1100,
      });
      const parsedResult = createParsedResult();
      // Attestation event has matching pubkey (same provider authored both)
      const attestationEvent = createAttestationEvent({
        pubkey: FIXED_BUILDER_PUBKEY,
        created_at: 1000,
      });
      // But the PCR values are fabricated (not in known-good registry)
      const parsedAttestation = createParsedAttestation({
        pcr0: BAD_PCR0,
        pcr1: 'e'.repeat(96),
        pcr2: 'f'.repeat(96),
      });

      // Act
      const result = verifier.verifyAttestedResult(
        resultEvent,
        parsedResult,
        attestationEvent,
        parsedAttestation
      );

      // Assert: pubkey matches but PCR check catches the fabrication
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PCR mismatch');
    });
  });
});

// ============================================================================
// Parser edge cases for attestation tag
// ============================================================================

describe('parseJobResult attestation tag edge cases', () => {
  it('handles attestation tag with empty string value', () => {
    // Arrange: attestation tag with empty value
    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: FIXED_BUILDER_PUBKEY,
      kind: 6100,
      content: 'Result text',
      tags: [
        ['e', 'a'.repeat(64)],
        ['p', 'b'.repeat(64)],
        ['amount', '500000', 'usdc'],
        ['attestation', ''],
      ],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act
    const parsed = parseJobResult(event);

    // Assert: parses successfully, empty string fails hex regex -> undefined
    expect(parsed).not.toBeNull();
    expect(parsed!.attestationEventId).toBeUndefined();
  });

  it('handles attestation tag with no value element', () => {
    // Arrange: attestation tag with only the tag name
    const event: NostrEvent = {
      id: '0'.repeat(64),
      pubkey: FIXED_BUILDER_PUBKEY,
      kind: 6100,
      content: 'Result text',
      tags: [
        ['e', 'a'.repeat(64)],
        ['p', 'b'.repeat(64)],
        ['amount', '500000', 'usdc'],
        ['attestation'],
      ],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    };

    // Act
    const parsed = parseJobResult(event);

    // Assert: parses successfully, undefined value -> attestationEventId undefined
    expect(parsed).not.toBeNull();
    expect(parsed!.attestationEventId).toBeUndefined();
  });
});

// ============================================================================
// Task 3: require_attestation parameter
// ============================================================================

describe('hasRequireAttestation (Task 3)', () => {
  // --------------------------------------------------------------------------
  // T-6.3-09 [P1]: require_attestation parameter detection
  // --------------------------------------------------------------------------
  describe('require_attestation detection (T-6.3-09)', () => {
    it('[P1] returns true when params include require_attestation=true', () => {
      // Arrange
      const params = [
        { key: 'temperature', value: '0.7' },
        { key: 'require_attestation', value: 'true' },
      ];

      // Act
      const result = hasRequireAttestation(params);

      // Assert
      expect(result).toBe(true);
    });

    it('[P1] returns false when params do not include require_attestation', () => {
      // Arrange
      const params = [
        { key: 'temperature', value: '0.7' },
        { key: 'max_tokens', value: '2048' },
      ];

      // Act
      const result = hasRequireAttestation(params);

      // Assert
      expect(result).toBe(false);
    });

    it('[P1] returns false when require_attestation is not "true"', () => {
      // Arrange
      const params = [{ key: 'require_attestation', value: 'false' }];

      // Act
      const result = hasRequireAttestation(params);

      // Assert
      expect(result).toBe(false);
    });

    it('[P1] returns false for empty params array', () => {
      // Act
      const result = hasRequireAttestation([]);

      // Assert
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.3-09 part 2: Provider-side pattern demonstration
  // --------------------------------------------------------------------------
  describe('provider-side rejection pattern (T-6.3-09 part 2)', () => {
    it('[P1] non-TEE provider builds Kind 7000 error feedback when require_attestation detected', () => {
      // Arrange: job request params with require_attestation
      const jobParams = [
        { key: 'require_attestation', value: 'true' },
        { key: 'prompt', value: 'Hello' },
      ];

      // Act: provider detects require_attestation
      const requiresAttestation = hasRequireAttestation(jobParams);
      expect(requiresAttestation).toBe(true);

      // Provider builds error feedback (integration pattern)
      const feedbackEvent = buildJobFeedbackEvent(
        {
          requestEventId: 'a'.repeat(64),
          customerPubkey: 'b'.repeat(64),
          status: 'error',
          content: 'require_attestation: provider has no TEE attestation',
        },
        FIXED_BUILDER_SECRET_KEY
      );

      // Assert: feedback event has correct structure
      const statusTag = feedbackEvent.tags.find(
        (t: string[]) => t[0] === 'status'
      );
      expect(statusTag).toEqual(['status', 'error']);
      expect(feedbackEvent.content).toBe(
        'require_attestation: provider has no TEE attestation'
      );
    });
  });

  // --------------------------------------------------------------------------
  // AC #3 edge case: require_attestation case sensitivity
  // --------------------------------------------------------------------------
  describe('require_attestation case sensitivity', () => {
    it('returns false when require_attestation value is uppercase "TRUE"', () => {
      // Arrange
      const params = [{ key: 'require_attestation', value: 'TRUE' }];

      // Act
      const result = hasRequireAttestation(params);

      // Assert: only lowercase 'true' is accepted
      expect(result).toBe(false);
    });

    it('returns false when require_attestation value is mixed case "True"', () => {
      // Arrange
      const params = [{ key: 'require_attestation', value: 'True' }];

      // Act
      const result = hasRequireAttestation(params);

      // Assert
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // AC #3 roundtrip: require_attestation through Kind 5xxx build/parse chain
  // --------------------------------------------------------------------------
  describe('require_attestation Kind 5xxx roundtrip (AC #3)', () => {
    it('require_attestation param survives buildJobRequestEvent -> parseJobRequest -> hasRequireAttestation', () => {
      // Arrange: build Kind 5xxx with require_attestation param
      const requestParams = createJobRequestParams({
        params: [
          { key: 'prompt', value: 'Hello' },
          { key: 'require_attestation', value: 'true' },
        ],
      });
      const event = buildJobRequestEvent(
        requestParams,
        FIXED_BUILDER_SECRET_KEY
      );

      // Act: parse the event and check require_attestation
      const parsed = parseJobRequest(event);
      expect(parsed).not.toBeNull();
      const detected = hasRequireAttestation(parsed!.params);

      // Assert
      expect(detected).toBe(true);
    });

    it('Kind 5xxx without require_attestation param -> hasRequireAttestation returns false after roundtrip', () => {
      // Arrange: build Kind 5xxx without require_attestation
      const requestParams = createJobRequestParams({
        params: [{ key: 'prompt', value: 'Hello' }],
      });
      const event = buildJobRequestEvent(
        requestParams,
        FIXED_BUILDER_SECRET_KEY
      );

      // Act
      const parsed = parseJobRequest(event);
      expect(parsed).not.toBeNull();
      const detected = hasRequireAttestation(parsed!.params);

      // Assert
      expect(detected).toBe(false);
    });
  });
});

// ============================================================================
// AC #2 integration: build result -> parse -> verify attestation chain
// ============================================================================

describe('AttestedResultVerifier integration with builder/parser (AC #2)', () => {
  it('end-to-end: buildJobResultEvent with attestation -> parseJobResult -> verifyAttestedResult succeeds', () => {
    // Arrange: build a Kind 6xxx result with attestation tag
    const attestationEventId = ATTESTATION_EVENT_ID;
    const resultParams = createJobResultParams({
      attestationEventId,
    });
    const resultEvent = buildJobResultEvent(
      resultParams,
      FIXED_BUILDER_SECRET_KEY
    );

    // Parse the result
    const parsedResult = parseJobResult(resultEvent);
    expect(parsedResult).not.toBeNull();
    expect(parsedResult!.attestationEventId).toBe(attestationEventId);

    // Create matching attestation event and verifier
    const attestationEvent = createAttestationEvent({
      pubkey: FIXED_BUILDER_PUBKEY,
      created_at: resultEvent.created_at - 100,
    });
    const parsedAttestation = createParsedAttestation();
    const verifier = new AttestedResultVerifier({
      attestationVerifier: createTestVerifier({ validitySeconds: 300 }),
    });

    // Act: verify the attested result
    const verification = verifier.verifyAttestedResult(
      resultEvent,
      parsedResult!,
      attestationEvent,
      parsedAttestation
    );

    // Assert
    expect(verification.valid).toBe(true);
    expect(verification.attestationState).toBe(AttestationState.VALID);
  });

  it('end-to-end: buildJobResultEvent without attestation -> parseJobResult -> attestationEventId undefined', () => {
    // Arrange: build a Kind 6xxx result without attestation tag
    const resultParams = createJobResultParams();
    const resultEvent = buildJobResultEvent(
      resultParams,
      FIXED_BUILDER_SECRET_KEY
    );

    // Act: parse the result
    const parsedResult = parseJobResult(resultEvent);

    // Assert: no attestation -> no verification needed
    expect(parsedResult).not.toBeNull();
    expect(parsedResult!.attestationEventId).toBeUndefined();
  });
});
