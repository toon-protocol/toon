/**
 * Unit tests for reputation scoring system (Story 6.4).
 *
 * Tests:
 * - T-6.4-01: Score formula with known inputs
 * - T-6.4-02: Score components computed correctly from mock data
 * - T-6.4-03: Score edge cases (channel_volume=0, jobs=0, avg_rating=0, trusted_by=0)
 * - T-6.4-04: Kind 31117 TOON encode/decode roundtrip
 * - T-6.4-05: Kind 31117 rating validation
 * - T-6.4-06: Kind 31117 NIP-33 replaceable semantics
 * - T-6.4-07: Kind 30382 TOON encode/decode roundtrip
 * - T-6.4-08: Sybil review defense (non-customer reviews excluded)
 * - T-6.4-10: Sybil WoT defense (zero-volume declarers excluded)
 * - T-6.4-12: Reputation in kind:10035
 * - T-6.4-14: min_reputation parameter detection
 * - T-6.4-17: Job completion count from Kind 6xxx
 * - T-6.4-18: TEE attestation alongside reputation
 * - T-INT-08: New event kinds traverse SDK pipeline
 */

import { describe, it, expect } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import {
  buildJobReviewEvent,
  parseJobReview,
  buildWotDeclarationEvent,
  parseWotDeclaration,
  ReputationScoreCalculator,
  hasMinReputation,
  JOB_REVIEW_KIND,
  WEB_OF_TRUST_KIND,
  encodeEventToToon,
  decodeEventFromToon,
  ToonError,
  buildServiceDiscoveryEvent,
  parseServiceDiscovery,
  buildJobFeedbackEvent,
  shallowParseToon,
} from '../index.js';
import type {
  ReputationSignals,
  ParsedJobReview,
  ParsedWotDeclaration,
  ServiceDiscoveryContent,
  ReputationScore,
} from '../index.js';

// ============================================================================
// Test Helpers
// ============================================================================

const VALID_EVENT_ID = 'a'.repeat(64);
const VALID_PUBKEY = 'b'.repeat(64);
const VALID_PUBKEY_2 = 'c'.repeat(64);
const VALID_PUBKEY_3 = 'd'.repeat(64);

// ============================================================================
// Task 1: Kind 31117 (Job Review) Builder/Parser
// ============================================================================

describe('buildJobReviewEvent()', () => {
  it('builds a valid Kind 31117 event with all tags', () => {
    // Arrange
    const secretKey = generateSecretKey();

    // Act
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 4,
        role: 'customer',
        content: 'Great service!',
      },
      secretKey
    );

    // Assert
    expect(event.kind).toBe(JOB_REVIEW_KIND);
    expect(event.kind).toBe(31117);
    expect(event.content).toBe('Great service!');

    const dTag = event.tags.find((t) => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe(VALID_EVENT_ID);

    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(VALID_PUBKEY);

    const ratingTag = event.tags.find((t) => t[0] === 'rating');
    expect(ratingTag).toBeDefined();
    expect(ratingTag![1]).toBe('4');

    const roleTag = event.tags.find((t) => t[0] === 'role');
    expect(roleTag).toBeDefined();
    expect(roleTag![1]).toBe('customer');
  });

  it('uses empty string content when not provided', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 5,
        role: 'provider',
      },
      secretKey
    );
    expect(event.content).toBe('');
  });
});

describe('parseJobReview()', () => {
  it('parses a valid Kind 31117 event', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 3,
        role: 'customer',
        content: 'Decent work',
      },
      secretKey
    );

    const parsed = parseJobReview(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.jobRequestEventId).toBe(VALID_EVENT_ID);
    expect(parsed!.targetPubkey).toBe(VALID_PUBKEY);
    expect(parsed!.rating).toBe(3);
    expect(parsed!.role).toBe('customer');
    expect(parsed!.content).toBe('Decent work');
  });

  it('returns null for wrong kind', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 5,
        role: 'customer',
      },
      secretKey
    );
    // Mutate kind
    const wrongKindEvent = { ...event, kind: 1 };
    expect(parseJobReview(wrongKindEvent)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// T-6.4-04: Kind 31117 TOON encode/decode roundtrip
// --------------------------------------------------------------------------

describe('Kind 31117 TOON roundtrip (T-6.4-04)', () => {
  it('[P0] preserves d, p, rating, role tags and content through TOON encode/decode', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 5,
        role: 'customer',
        content: 'Excellent provider!',
      },
      secretKey
    );

    // Act: encode -> decode roundtrip
    const encoded = encodeEventToToon(event);
    const decoded = decodeEventFromToon(encoded);

    // Assert: all fields preserved
    expect(decoded.kind).toBe(JOB_REVIEW_KIND);
    expect(decoded.content).toBe('Excellent provider!');

    const parsed = parseJobReview(decoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.jobRequestEventId).toBe(VALID_EVENT_ID);
    expect(parsed!.targetPubkey).toBe(VALID_PUBKEY);
    expect(parsed!.rating).toBe(5);
    expect(parsed!.role).toBe('customer');
  });
});

// --------------------------------------------------------------------------
// T-6.4-05: Kind 31117 rating validation
// --------------------------------------------------------------------------

describe('Kind 31117 rating validation (T-6.4-05)', () => {
  const secretKey = generateSecretKey();

  it('[P0] rejects rating=0', () => {
    expect(() =>
      buildJobReviewEvent(
        {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 0,
          role: 'customer',
        },
        secretKey
      )
    ).toThrow(ToonError);
  });

  it('[P0] rejects rating=6', () => {
    expect(() =>
      buildJobReviewEvent(
        {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 6,
          role: 'customer',
        },
        secretKey
      )
    ).toThrow(ToonError);
  });

  it('[P0] rejects rating=3.5 (non-integer)', () => {
    expect(() =>
      buildJobReviewEvent(
        {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 3.5,
          role: 'customer',
        },
        secretKey
      )
    ).toThrow(ToonError);
  });

  it('[P0] rejects non-numeric rating', () => {
    expect(() =>
      buildJobReviewEvent(
        {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 'excellent' as unknown as number,
          role: 'customer',
        },
        secretKey
      )
    ).toThrow(ToonError);
  });

  it('[P0] accepts integer ratings 1-5', () => {
    for (let rating = 1; rating <= 5; rating++) {
      const event = buildJobReviewEvent(
        {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating,
          role: 'customer',
        },
        secretKey
      );
      expect(event.kind).toBe(JOB_REVIEW_KIND);
    }
  });

  it('[P0] error has code REPUTATION_INVALID_RATING', () => {
    let thrown: unknown;
    try {
      buildJobReviewEvent(
        {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 0,
          role: 'customer',
        },
        secretKey
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe('REPUTATION_INVALID_RATING');
  });
});

// --------------------------------------------------------------------------
// T-6.4-06: Kind 31117 NIP-33 replaceable semantics
// --------------------------------------------------------------------------

describe('Kind 31117 NIP-33 replaceable semantics (T-6.4-06)', () => {
  it('[P1] same reviewer, same d tag = replacement enforced by event kind', () => {
    // Arrange: same reviewer creates two reviews for the same job
    const secretKey = generateSecretKey();

    const review1 = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 3,
        role: 'customer',
        content: 'Initial review',
      },
      secretKey
    );

    const review2 = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 5,
        role: 'customer',
        content: 'Updated review',
      },
      secretKey
    );

    // Assert: same kind, same d tag, same pubkey -> NIP-33 replaces
    expect(review1.kind).toBe(review2.kind);
    expect(review1.pubkey).toBe(review2.pubkey);

    const d1 = review1.tags.find((t) => t[0] === 'd');
    const d2 = review2.tags.find((t) => t[0] === 'd');
    expect(d1![1]).toBe(d2![1]);

    // Kind is in 30000-39999 range (NIP-33 parameterized replaceable)
    expect(review1.kind).toBeGreaterThanOrEqual(30000);
    expect(review1.kind).toBeLessThanOrEqual(39999);
  });
});

// --------------------------------------------------------------------------
// Validation error tests (Task 1.8)
// --------------------------------------------------------------------------

describe('Kind 31117 validation errors', () => {
  const secretKey = generateSecretKey();

  it('throws REPUTATION_INVALID_JOB_REQUEST_EVENT_ID for invalid hex', () => {
    let thrown: unknown;
    try {
      buildJobReviewEvent(
        {
          jobRequestEventId: 'not-hex',
          targetPubkey: VALID_PUBKEY,
          rating: 3,
          role: 'customer',
        },
        secretKey
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe(
      'REPUTATION_INVALID_JOB_REQUEST_EVENT_ID'
    );
  });

  it('throws REPUTATION_INVALID_TARGET_PUBKEY for invalid hex', () => {
    let thrown: unknown;
    try {
      buildJobReviewEvent(
        {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: 'bad-pubkey',
          rating: 3,
          role: 'customer',
        },
        secretKey
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe('REPUTATION_INVALID_TARGET_PUBKEY');
  });

  it('throws REPUTATION_INVALID_ROLE for invalid role', () => {
    let thrown: unknown;
    try {
      buildJobReviewEvent(
        {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 3,
          role: 'admin' as 'customer',
        },
        secretKey
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe('REPUTATION_INVALID_ROLE');
  });
});

// ============================================================================
// Task 2: Kind 30382 (Web of Trust) Builder/Parser
// ============================================================================

describe('buildWotDeclarationEvent()', () => {
  it('builds a valid Kind 30382 event with d and p tags', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY, content: 'Trustworthy provider' },
      secretKey
    );

    expect(event.kind).toBe(WEB_OF_TRUST_KIND);
    expect(event.kind).toBe(30382);
    expect(event.content).toBe('Trustworthy provider');

    const dTag = event.tags.find((t) => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe(VALID_PUBKEY);

    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag![1]).toBe(VALID_PUBKEY);
  });

  it('d tag equals p tag (NIP-33 parameterized replaceable)', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY },
      secretKey
    );

    const dTag = event.tags.find((t) => t[0] === 'd');
    const pTag = event.tags.find((t) => t[0] === 'p');
    expect(dTag![1]).toBe(pTag![1]);
  });
});

describe('parseWotDeclaration()', () => {
  it('parses a valid Kind 30382 event', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY, content: 'Endorsed' },
      secretKey
    );

    const parsed = parseWotDeclaration(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.targetPubkey).toBe(VALID_PUBKEY);
    expect(parsed!.declarerPubkey).toBe(event.pubkey);
    expect(parsed!.content).toBe('Endorsed');
  });

  it('returns null for wrong kind', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY },
      secretKey
    );
    const wrongKind = { ...event, kind: 1 };
    expect(parseWotDeclaration(wrongKind)).toBeNull();
  });

  it('returns null when d tag does not match p tag', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY },
      secretKey
    );
    // Mutate d tag to mismatch
    const mutated = {
      ...event,
      tags: event.tags.map((t) => (t[0] === 'd' ? ['d', VALID_PUBKEY_2] : t)),
    };
    expect(parseWotDeclaration(mutated)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// T-6.4-07: Kind 30382 TOON encode/decode roundtrip
// --------------------------------------------------------------------------

describe('Kind 30382 TOON roundtrip (T-6.4-07)', () => {
  it('[P1] preserves d, p tags and content through TOON encode/decode', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY, content: 'Trusted provider' },
      secretKey
    );

    // Act
    const encoded = encodeEventToToon(event);
    const decoded = decodeEventFromToon(encoded);

    // Assert
    expect(decoded.kind).toBe(WEB_OF_TRUST_KIND);
    expect(decoded.content).toBe('Trusted provider');

    const parsed = parseWotDeclaration(decoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.targetPubkey).toBe(VALID_PUBKEY);
  });
});

// --------------------------------------------------------------------------
// WoT validation tests (Task 2.6)
// --------------------------------------------------------------------------

describe('Kind 30382 validation', () => {
  it('throws REPUTATION_INVALID_TARGET_PUBKEY for invalid hex', () => {
    const secretKey = generateSecretKey();
    let thrown: unknown;
    try {
      buildWotDeclarationEvent({ targetPubkey: 'invalid' }, secretKey);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe('REPUTATION_INVALID_TARGET_PUBKEY');
  });
});

// ============================================================================
// Task 3: Reputation Score Calculator
// ============================================================================

describe('ReputationScoreCalculator', () => {
  const calculator = new ReputationScoreCalculator();

  // --------------------------------------------------------------------------
  // T-6.4-01: Score formula with known inputs
  // --------------------------------------------------------------------------
  describe('calculateScore() (T-6.4-01)', () => {
    it('[P0] computes correct score with known inputs', () => {
      // Arrange: known signal values
      const signals: ReputationSignals = {
        trustedBy: 3,
        channelVolumeUsdc: 1000,
        jobsCompleted: 20,
        avgRating: 4.5,
      };

      // Act
      const result = calculator.calculateScore(signals);

      // Assert: score = (3*100) + (log10(1000)*10) + (20*5) + (4.5*20)
      //              = 300 + (3*10) + 100 + 90
      //              = 300 + 30 + 100 + 90 = 520
      expect(result.score).toBe(520);
      expect(result.signals).toEqual(signals);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.4-02: Score components computed correctly
  // --------------------------------------------------------------------------
  describe('score components (T-6.4-02)', () => {
    it('[P0] trustedBy component: 3 * 100 = 300', () => {
      const result = calculator.calculateScore({
        trustedBy: 3,
        channelVolumeUsdc: 1,
        jobsCompleted: 0,
        avgRating: 0,
      });
      // log10(1) = 0, so only trustedBy contributes
      expect(result.score).toBe(300);
    });

    it('[P0] channelVolumeUsdc component: log10(10000) * 10 = 40', () => {
      const result = calculator.calculateScore({
        trustedBy: 0,
        channelVolumeUsdc: 10000,
        jobsCompleted: 0,
        avgRating: 0,
      });
      expect(result.score).toBe(40);
    });

    it('[P0] jobsCompleted component: 10 * 5 = 50', () => {
      const result = calculator.calculateScore({
        trustedBy: 0,
        channelVolumeUsdc: 1,
        jobsCompleted: 10,
        avgRating: 0,
      });
      expect(result.score).toBe(50);
    });

    it('[P0] avgRating component: 4.0 * 20 = 80', () => {
      const result = calculator.calculateScore({
        trustedBy: 0,
        channelVolumeUsdc: 1,
        jobsCompleted: 0,
        avgRating: 4.0,
      });
      expect(result.score).toBe(80);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.4-03: Edge cases
  // --------------------------------------------------------------------------
  describe('edge cases (T-6.4-03)', () => {
    it('[P0] channel_volume=0: log10 guard produces 0 (not -Infinity)', () => {
      const result = calculator.calculateScore({
        trustedBy: 0,
        channelVolumeUsdc: 0,
        jobsCompleted: 0,
        avgRating: 0,
      });
      expect(result.score).toBe(0);
      expect(isFinite(result.score)).toBe(true);
    });

    it('[P0] all zeros produce finite score of 0', () => {
      const result = calculator.calculateScore({
        trustedBy: 0,
        channelVolumeUsdc: 0,
        jobsCompleted: 0,
        avgRating: 0,
      });
      expect(result.score).toBe(0);
      expect(isFinite(result.score)).toBe(true);
      expect(isNaN(result.score)).toBe(false);
    });

    it('[P0] channel_volume=1: log10(1) = 0', () => {
      const result = calculator.calculateScore({
        trustedBy: 0,
        channelVolumeUsdc: 1,
        jobsCompleted: 0,
        avgRating: 0,
      });
      expect(result.score).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.4-10: Sybil WoT defense
  // --------------------------------------------------------------------------
  describe('computeTrustedBy() sybil defense (T-6.4-10)', () => {
    it('[P0] zero-volume declarers contribute 0 to trusted_by', () => {
      // Arrange: 3 WoT declarations, only 1 from non-zero-volume declarer
      const wotDeclarations: ParsedWotDeclaration[] = [
        {
          targetPubkey: VALID_PUBKEY,
          declarerPubkey: VALID_PUBKEY_2,
          content: '',
        },
        {
          targetPubkey: VALID_PUBKEY,
          declarerPubkey: VALID_PUBKEY_3,
          content: '',
        },
        {
          targetPubkey: VALID_PUBKEY,
          declarerPubkey: 'e'.repeat(64),
          content: '',
        },
      ];

      const volumeLookup = (pubkey: string): number => {
        if (pubkey === VALID_PUBKEY_2) return 1000; // has volume
        return 0; // zero volume (sybil)
      };

      // Act
      const trustedBy = calculator.computeTrustedBy(
        wotDeclarations,
        volumeLookup
      );

      // Assert: only 1 declaration from non-zero-volume declarer
      expect(trustedBy).toBe(1);
    });

    it('[P0] all zero-volume declarers result in trustedBy=0', () => {
      const wotDeclarations: ParsedWotDeclaration[] = [
        {
          targetPubkey: VALID_PUBKEY,
          declarerPubkey: VALID_PUBKEY_2,
          content: '',
        },
        {
          targetPubkey: VALID_PUBKEY,
          declarerPubkey: VALID_PUBKEY_3,
          content: '',
        },
      ];

      const trustedBy = calculator.computeTrustedBy(wotDeclarations, () => 0);
      expect(trustedBy).toBe(0);
    });

    it('[P0] all non-zero-volume declarers counted', () => {
      const wotDeclarations: ParsedWotDeclaration[] = [
        {
          targetPubkey: VALID_PUBKEY,
          declarerPubkey: VALID_PUBKEY_2,
          content: '',
        },
        {
          targetPubkey: VALID_PUBKEY,
          declarerPubkey: VALID_PUBKEY_3,
          content: '',
        },
      ];

      const trustedBy = calculator.computeTrustedBy(wotDeclarations, () => 500);
      expect(trustedBy).toBe(2);
    });

    it('[P0] empty declarations array returns 0', () => {
      const trustedBy = calculator.computeTrustedBy([], () => 1000);
      expect(trustedBy).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.4-08: Sybil review defense
  // --------------------------------------------------------------------------
  describe('computeAvgRating() sybil defense (T-6.4-08)', () => {
    it('[P0] reviews from non-customer pubkeys excluded from avg_rating', () => {
      // Arrange: 3 reviews, only 2 from verified customers
      const reviews: { review: ParsedJobReview; reviewerPubkey: string }[] = [
        {
          review: {
            jobRequestEventId: VALID_EVENT_ID,
            targetPubkey: VALID_PUBKEY,
            rating: 5,
            role: 'customer',
            content: '',
          },
          reviewerPubkey: VALID_PUBKEY_2,
        },
        {
          review: {
            jobRequestEventId: VALID_EVENT_ID,
            targetPubkey: VALID_PUBKEY,
            rating: 3,
            role: 'customer',
            content: '',
          },
          reviewerPubkey: VALID_PUBKEY_3,
        },
        {
          review: {
            jobRequestEventId: VALID_EVENT_ID,
            targetPubkey: VALID_PUBKEY,
            rating: 5,
            role: 'customer',
            content: '',
          },
          reviewerPubkey: 'e'.repeat(64), // NOT a verified customer
        },
      ];

      const verifiedCustomers = new Set([VALID_PUBKEY_2, VALID_PUBKEY_3]);

      // Act
      const avg = calculator.computeAvgRating(reviews, verifiedCustomers);

      // Assert: only ratings 5 and 3 counted -> (5+3)/2 = 4
      expect(avg).toBe(4);
    });

    it('[P0] returns 0 when no verified reviews exist', () => {
      const reviews: { review: ParsedJobReview; reviewerPubkey: string }[] = [
        {
          review: {
            jobRequestEventId: VALID_EVENT_ID,
            targetPubkey: VALID_PUBKEY,
            rating: 5,
            role: 'customer',
            content: '',
          },
          reviewerPubkey: 'e'.repeat(64), // NOT a verified customer
        },
      ];

      const avg = calculator.computeAvgRating(reviews, new Set());
      expect(avg).toBe(0);
    });

    it('[P0] returns 0 for empty reviews array', () => {
      const avg = calculator.computeAvgRating([], new Set([VALID_PUBKEY_2]));
      expect(avg).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-6.4-17: Job completion count from Kind 6xxx events
  // --------------------------------------------------------------------------
  describe('job completion count (T-6.4-17)', () => {
    it('[P2] jobsCompleted signal is used directly in score formula', () => {
      // The calculator receives pre-computed jobsCompleted count.
      // The caller counts Kind 6xxx events from the relay.
      const result = calculator.calculateScore({
        trustedBy: 0,
        channelVolumeUsdc: 1,
        jobsCompleted: 42,
        avgRating: 0,
      });

      // 42 * 5 = 210
      expect(result.score).toBe(210);
      expect(result.signals.jobsCompleted).toBe(42);
    });
  });
});

// ============================================================================
// Task 4: Reputation in kind:10035 Service Discovery
// ============================================================================

describe('Reputation in kind:10035 (T-6.4-12)', () => {
  function createContentWithReputation(
    reputation: ReputationScore
  ): ServiceDiscoveryContent {
    return {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1, 5100, 10032, 10035],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
      skill: {
        name: 'toon-dvm',
        version: '1.0',
        kinds: [5100],
        features: ['text-generation'],
        inputSchema: { type: 'object', properties: {} },
        pricing: { '5100': '1000000' },
        reputation,
      },
    };
  }

  it('[P1] kind:10035 includes reputation field with score and signals', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const reputation: ReputationScore = {
      score: 520,
      signals: {
        trustedBy: 3,
        channelVolumeUsdc: 1000,
        jobsCompleted: 20,
        avgRating: 4.5,
      },
    };

    const content = createContentWithReputation(reputation);
    const event = buildServiceDiscoveryEvent(content, secretKey);

    // Act
    const parsed = parseServiceDiscovery(event);

    // Assert
    expect(parsed).not.toBeNull();
    expect(parsed!.skill).toBeDefined();
    expect(parsed!.skill!.reputation).toBeDefined();
    expect(parsed!.skill!.reputation!.score).toBe(520);
    expect(parsed!.skill!.reputation!.signals.trustedBy).toBe(3);
    expect(parsed!.skill!.reputation!.signals.channelVolumeUsdc).toBe(1000);
    expect(parsed!.skill!.reputation!.signals.jobsCompleted).toBe(20);
    expect(parsed!.skill!.reputation!.signals.avgRating).toBe(4.5);
  });

  // --------------------------------------------------------------------------
  // T-6.4-18: TEE attestation alongside reputation
  // --------------------------------------------------------------------------
  it('[P1] TEE attestation displayed alongside reputation as separate signal (T-6.4-18)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const reputation: ReputationScore = {
      score: 400,
      signals: {
        trustedBy: 2,
        channelVolumeUsdc: 500,
        jobsCompleted: 10,
        avgRating: 4.0,
      },
    };

    const content: ServiceDiscoveryContent = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1, 5100],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
      skill: {
        name: 'toon-dvm',
        version: '1.0',
        kinds: [5100],
        features: ['text-generation'],
        inputSchema: { type: 'object', properties: {} },
        pricing: { '5100': '1000000' },
        attestation: {
          eventId: 'e'.repeat(64),
          enclaveImageHash: 'abc123',
        },
        reputation,
      },
    };

    const event = buildServiceDiscoveryEvent(content, secretKey);
    const parsed = parseServiceDiscovery(event);

    // Assert: both attestation and reputation present as independent fields
    expect(parsed).not.toBeNull();
    expect(parsed!.skill!.attestation).toBeDefined();
    expect(parsed!.skill!.attestation!['eventId']).toBe('e'.repeat(64));
    expect(parsed!.skill!.reputation).toBeDefined();
    expect(parsed!.skill!.reputation!.score).toBe(400);

    // TEE attestation is NOT factored into the reputation score
    // (attestation is binary, reputation is numeric -- independent signals)
    expect(parsed!.skill!.reputation!.score).toBe(400);
  });

  // --------------------------------------------------------------------------
  // Backward compatibility: events without reputation parse correctly
  // --------------------------------------------------------------------------
  it('[P0] kind:10035 without reputation field parses correctly (backward compat)', () => {
    const secretKey = generateSecretKey();
    const content: ServiceDiscoveryContent = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1, 10032],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
      skill: {
        name: 'toon-dvm',
        version: '1.0',
        kinds: [5100],
        features: [],
        inputSchema: { type: 'object', properties: {} },
        pricing: { '5100': '10' },
      },
    };

    const event = buildServiceDiscoveryEvent(content, secretKey);
    const parsed = parseServiceDiscovery(event);

    expect(parsed).not.toBeNull();
    expect(parsed!.skill).toBeDefined();
    expect(parsed!.skill!.reputation).toBeUndefined();
  });

  it('returns null for malformed reputation field (non-object)', () => {
    const content = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
      skill: {
        name: 'toon-dvm',
        version: '1.0',
        kinds: [5100],
        features: [],
        inputSchema: { type: 'object', properties: {} },
        pricing: { '5100': '10' },
        reputation: 'invalid',
      },
    };

    // Build raw event to bypass type checking
    const event = {
      kind: 10035,
      content: JSON.stringify(content),
      tags: [['d', 'toon-service-discovery']],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: 'a'.repeat(64),
      id: 'b'.repeat(64),
      sig: 'c'.repeat(128),
    };

    const parsed = parseServiceDiscovery(event);
    expect(parsed).toBeNull();
  });

  it('returns null for reputation with non-finite score', () => {
    const content = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
      skill: {
        name: 'toon-dvm',
        version: '1.0',
        kinds: [5100],
        features: [],
        inputSchema: { type: 'object', properties: {} },
        pricing: { '5100': '10' },
        reputation: {
          score: Infinity,
          signals: {
            trustedBy: 0,
            channelVolumeUsdc: 0,
            jobsCompleted: 0,
            avgRating: 0,
          },
        },
      },
    };

    const event = {
      kind: 10035,
      content: JSON.stringify(content),
      tags: [['d', 'toon-service-discovery']],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: 'a'.repeat(64),
      id: 'b'.repeat(64),
      sig: 'c'.repeat(128),
    };

    const parsed = parseServiceDiscovery(event);
    expect(parsed).toBeNull();
  });
});

// ============================================================================
// Task 5: min_reputation Parameter
// ============================================================================

describe('hasMinReputation() (T-6.4-14)', () => {
  it('[P1] returns 500 for min_reputation=500 param', () => {
    const params = [{ key: 'min_reputation', value: '500' }];
    expect(hasMinReputation(params)).toBe(500);
  });

  it('[P1] returns null when min_reputation param not present', () => {
    const params = [{ key: 'model', value: 'gpt-4' }];
    expect(hasMinReputation(params)).toBeNull();
  });

  it('[P1] returns null for empty params array', () => {
    expect(hasMinReputation([])).toBeNull();
  });

  it('[P1] throws REPUTATION_INVALID_MIN_REPUTATION for non-numeric value', () => {
    const params = [{ key: 'min_reputation', value: 'high' }];
    let thrown: unknown;
    try {
      hasMinReputation(params);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe(
      'REPUTATION_INVALID_MIN_REPUTATION'
    );
  });

  it('[P1] throws REPUTATION_INVALID_MIN_REPUTATION for empty string value', () => {
    const params = [{ key: 'min_reputation', value: '' }];
    let thrown: unknown;
    try {
      hasMinReputation(params);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe(
      'REPUTATION_INVALID_MIN_REPUTATION'
    );
  });

  it('[P1] throws REPUTATION_INVALID_MIN_REPUTATION for whitespace-only value', () => {
    const params = [{ key: 'min_reputation', value: '   ' }];
    let thrown: unknown;
    try {
      hasMinReputation(params);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe(
      'REPUTATION_INVALID_MIN_REPUTATION'
    );
  });

  it('[P1] throws REPUTATION_INVALID_MIN_REPUTATION for Infinity value', () => {
    const params = [{ key: 'min_reputation', value: 'Infinity' }];
    let thrown: unknown;
    try {
      hasMinReputation(params);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe(
      'REPUTATION_INVALID_MIN_REPUTATION'
    );
  });

  it('[P1] throws REPUTATION_INVALID_MIN_REPUTATION for -Infinity value', () => {
    const params = [{ key: 'min_reputation', value: '-Infinity' }];
    let thrown: unknown;
    try {
      hasMinReputation(params);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe(
      'REPUTATION_INVALID_MIN_REPUTATION'
    );
  });

  it('[P1] provider self-rejects when score below threshold', () => {
    // Arrange: provider has score 400, customer requires 500
    const providerScore = 400;
    const params = [{ key: 'min_reputation', value: '500' }];
    const threshold = hasMinReputation(params);

    // Assert: threshold detected
    expect(threshold).toBe(500);
    expect(providerScore < threshold!).toBe(true);

    // Demonstrate integration: provider builds rejection feedback
    const secretKey = generateSecretKey();
    const feedbackEvent = buildJobFeedbackEvent(
      {
        requestEventId: VALID_EVENT_ID,
        customerPubkey: VALID_PUBKEY,
        status: 'error',
        content: `min_reputation: provider score ${providerScore} below threshold ${threshold}`,
      },
      secretKey
    );
    expect(feedbackEvent.kind).toBe(7000);
    expect(feedbackEvent.content).toContain('min_reputation');
    expect(feedbackEvent.content).toContain('400');
    expect(feedbackEvent.content).toContain('500');
  });
});

// ============================================================================
// Task 6: Pipeline Integration
// ============================================================================

describe('Pipeline integration (T-INT-08)', () => {
  it('[P1] Kind 31117 traverses shallow parse pipeline', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 4,
        role: 'customer',
        content: 'Good job',
      },
      secretKey
    );

    // Act: TOON encode -> shallow parse -> full decode
    const encoded = encodeEventToToon(event);
    const shallow = shallowParseToon(encoded);
    const decoded = decodeEventFromToon(encoded);

    // Assert: pipeline traversal succeeds
    expect(shallow).not.toBeNull();
    expect(decoded.kind).toBe(JOB_REVIEW_KIND);
    expect(parseJobReview(decoded)).not.toBeNull();
  });

  it('[P1] Kind 30382 traverses shallow parse pipeline', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY, content: 'Endorsed' },
      secretKey
    );

    // Act: TOON encode -> shallow parse -> full decode
    const encoded = encodeEventToToon(event);
    const shallow = shallowParseToon(encoded);
    const decoded = decodeEventFromToon(encoded);

    // Assert: pipeline traversal succeeds
    expect(shallow).not.toBeNull();
    expect(decoded.kind).toBe(WEB_OF_TRUST_KIND);
    expect(parseWotDeclaration(decoded)).not.toBeNull();
  });
});

// ============================================================================
// Gap-filling tests: additional AC coverage
// ============================================================================

// --------------------------------------------------------------------------
// AC #2: parseJobReview with provider role
// --------------------------------------------------------------------------

describe('parseJobReview() provider role', () => {
  it('parses a valid Kind 31117 event with provider role', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 2,
        role: 'provider',
        content: 'Customer was cooperative',
      },
      secretKey
    );

    const parsed = parseJobReview(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe('provider');
    expect(parsed!.rating).toBe(2);
    expect(parsed!.content).toBe('Customer was cooperative');
  });
});

// --------------------------------------------------------------------------
// AC #2: parseJobReview returns null for invalid rating on parse
// --------------------------------------------------------------------------

describe('parseJobReview() rejects invalid ratings on parse', () => {
  it('returns null when rating tag is non-integer (3.5)', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 4,
        role: 'customer',
      },
      secretKey
    );
    // Mutate rating tag to non-integer value
    const mutated = {
      ...event,
      tags: event.tags.map((t) => (t[0] === 'rating' ? ['rating', '3.5'] : t)),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });

  it('returns null when rating tag is non-numeric', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 4,
        role: 'customer',
      },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.map((t) =>
        t[0] === 'rating' ? ['rating', 'excellent'] : t
      ),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });

  it('returns null when rating tag is 0', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 4,
        role: 'customer',
      },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.map((t) => (t[0] === 'rating' ? ['rating', '0'] : t)),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });

  it('returns null when rating tag is 6', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 4,
        role: 'customer',
      },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.map((t) => (t[0] === 'rating' ? ['rating', '6'] : t)),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// AC #2: parseJobReview returns null for missing tags
// --------------------------------------------------------------------------

describe('parseJobReview() returns null for missing tags', () => {
  it('returns null when d tag is missing', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 3,
        role: 'customer',
      },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.filter((t) => t[0] !== 'd'),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });

  it('returns null when p tag is missing', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 3,
        role: 'customer',
      },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.filter((t) => t[0] !== 'p'),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });

  it('returns null when rating tag is missing', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 3,
        role: 'customer',
      },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.filter((t) => t[0] !== 'rating'),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });

  it('returns null when role tag is missing', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 3,
        role: 'customer',
      },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.filter((t) => t[0] !== 'role'),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });

  it('returns null when role tag has invalid value', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 3,
        role: 'customer',
      },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.map((t) => (t[0] === 'role' ? ['role', 'admin'] : t)),
    };
    expect(parseJobReview(mutated)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// AC #2: Kind 31117 with provider role TOON roundtrip
// --------------------------------------------------------------------------

describe('Kind 31117 provider role TOON roundtrip', () => {
  it('preserves provider role through TOON encode/decode', () => {
    const secretKey = generateSecretKey();
    const event = buildJobReviewEvent(
      {
        jobRequestEventId: VALID_EVENT_ID,
        targetPubkey: VALID_PUBKEY,
        rating: 2,
        role: 'provider',
        content: 'Good customer',
      },
      secretKey
    );

    const encoded = encodeEventToToon(event);
    const decoded = decodeEventFromToon(encoded);
    const parsed = parseJobReview(decoded);

    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe('provider');
    expect(parsed!.rating).toBe(2);
    expect(parsed!.content).toBe('Good customer');
  });
});

// --------------------------------------------------------------------------
// AC #3: Kind 30382 with empty content
// --------------------------------------------------------------------------

describe('Kind 30382 empty content', () => {
  it('builds and parses WoT declaration with empty content', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY },
      secretKey
    );

    expect(event.content).toBe('');

    const parsed = parseWotDeclaration(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.content).toBe('');
    expect(parsed!.targetPubkey).toBe(VALID_PUBKEY);
  });

  it('TOON roundtrips WoT declaration with empty content', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY },
      secretKey
    );

    const encoded = encodeEventToToon(event);
    const decoded = decodeEventFromToon(encoded);
    const parsed = parseWotDeclaration(decoded);

    expect(parsed).not.toBeNull();
    expect(parsed!.content).toBe('');
    expect(parsed!.targetPubkey).toBe(VALID_PUBKEY);
  });
});

// --------------------------------------------------------------------------
// AC #3: parseWotDeclaration returns null for missing tags
// --------------------------------------------------------------------------

describe('parseWotDeclaration() returns null for missing tags', () => {
  it('returns null when d tag is missing', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.filter((t) => t[0] !== 'd'),
    };
    expect(parseWotDeclaration(mutated)).toBeNull();
  });

  it('returns null when p tag is missing', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.filter((t) => t[0] !== 'p'),
    };
    expect(parseWotDeclaration(mutated)).toBeNull();
  });

  it('returns null when p tag has invalid hex', () => {
    const secretKey = generateSecretKey();
    const event = buildWotDeclarationEvent(
      { targetPubkey: VALID_PUBKEY },
      secretKey
    );
    const mutated = {
      ...event,
      tags: event.tags.map((t) => {
        if (t[0] === 'p') return ['p', 'invalid-hex'];
        if (t[0] === 'd') return ['d', 'invalid-hex'];
        return t;
      }),
    };
    expect(parseWotDeclaration(mutated)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// AC #1: Score formula finite for large and edge-case inputs
// --------------------------------------------------------------------------

describe('Score formula finiteness (AC #1)', () => {
  it('produces finite score for very large inputs', () => {
    const result = new ReputationScoreCalculator().calculateScore({
      trustedBy: 10000,
      channelVolumeUsdc: 1_000_000_000,
      jobsCompleted: 100000,
      avgRating: 5,
    });
    expect(isFinite(result.score)).toBe(true);
    expect(isNaN(result.score)).toBe(false);
  });

  it('produces finite score for negative channel volume (Math.max guard)', () => {
    const result = new ReputationScoreCalculator().calculateScore({
      trustedBy: 0,
      channelVolumeUsdc: -100,
      jobsCompleted: 0,
      avgRating: 0,
    });
    // Math.max(1, -100) = 1, log10(1) = 0
    expect(result.score).toBe(0);
    expect(isFinite(result.score)).toBe(true);
  });

  it('returns score 0 when NaN signal would produce NaN score', () => {
    const result = new ReputationScoreCalculator().calculateScore({
      trustedBy: NaN,
      channelVolumeUsdc: 0,
      jobsCompleted: 0,
      avgRating: 0,
    });
    // NaN guard: non-finite score falls back to 0
    expect(result.score).toBe(0);
    expect(isFinite(result.score)).toBe(true);
    expect(isNaN(result.score)).toBe(false);
  });

  it('returns score 0 when Infinity signal would produce Infinity score', () => {
    const result = new ReputationScoreCalculator().calculateScore({
      trustedBy: Infinity,
      channelVolumeUsdc: 0,
      jobsCompleted: 0,
      avgRating: 0,
    });
    // Infinity guard: non-finite score falls back to 0
    expect(result.score).toBe(0);
    expect(isFinite(result.score)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// AC #5: Provider score >= threshold should NOT self-reject
// --------------------------------------------------------------------------

describe('min_reputation positive case (AC #5)', () => {
  it('provider with score >= threshold should proceed (not self-reject)', () => {
    const providerScore = 600;
    const params = [{ key: 'min_reputation', value: '500' }];
    const threshold = hasMinReputation(params);

    expect(threshold).toBe(500);
    expect(providerScore >= threshold!).toBe(true);
    // Provider should NOT build rejection feedback -- they meet the threshold
  });

  it('provider with score exactly equal to threshold should proceed', () => {
    const providerScore = 500;
    const params = [{ key: 'min_reputation', value: '500' }];
    const threshold = hasMinReputation(params);

    expect(threshold).toBe(500);
    expect(providerScore >= threshold!).toBe(true);
  });

  it('handles zero threshold', () => {
    const params = [{ key: 'min_reputation', value: '0' }];
    const threshold = hasMinReputation(params);
    expect(threshold).toBe(0);
  });

  it('handles negative threshold', () => {
    const params = [{ key: 'min_reputation', value: '-100' }];
    const threshold = hasMinReputation(params);
    expect(threshold).toBe(-100);
  });

  it('handles decimal threshold', () => {
    const params = [{ key: 'min_reputation', value: '250.5' }];
    const threshold = hasMinReputation(params);
    expect(threshold).toBe(250.5);
  });
});

// ============================================================================
// Gap-filling: parseServiceDiscovery reputation validation edge cases
// ============================================================================

describe('parseServiceDiscovery() reputation validation edge cases', () => {
  function buildRawEvent(skillOverrides: Record<string, unknown>) {
    const content = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
      skill: {
        name: 'toon-dvm',
        version: '1.0',
        kinds: [5100],
        features: [],
        inputSchema: { type: 'object', properties: {} },
        pricing: { '5100': '10' },
        ...skillOverrides,
      },
    };

    return {
      kind: 10035,
      content: JSON.stringify(content),
      tags: [['d', 'toon-service-discovery']],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: 'a'.repeat(64),
      id: 'b'.repeat(64),
      sig: 'c'.repeat(128),
    };
  }

  it('returns null for reputation as array', () => {
    const event = buildRawEvent({ reputation: [1, 2, 3] });
    expect(parseServiceDiscovery(event)).toBeNull();
  });

  it('returns null for reputation with NaN score', () => {
    const event = buildRawEvent({
      reputation: {
        score: NaN,
        signals: {
          trustedBy: 0,
          channelVolumeUsdc: 0,
          jobsCompleted: 0,
          avgRating: 0,
        },
      },
    });
    expect(parseServiceDiscovery(event)).toBeNull();
  });

  it('returns null for signals as array', () => {
    const event = buildRawEvent({
      reputation: {
        score: 100,
        signals: [1, 2, 3, 4],
      },
    });
    expect(parseServiceDiscovery(event)).toBeNull();
  });

  it('returns null for missing signal fields', () => {
    const event = buildRawEvent({
      reputation: {
        score: 100,
        signals: { trustedBy: 1 }, // missing channelVolumeUsdc, jobsCompleted, avgRating
      },
    });
    expect(parseServiceDiscovery(event)).toBeNull();
  });

  it('returns null for NaN signal field (channelVolumeUsdc)', () => {
    const event = buildRawEvent({
      reputation: {
        score: 100,
        signals: {
          trustedBy: 1,
          channelVolumeUsdc: NaN,
          jobsCompleted: 5,
          avgRating: 4.0,
        },
      },
    });
    expect(parseServiceDiscovery(event)).toBeNull();
  });

  it('returns null for Infinity signal field (avgRating)', () => {
    const event = buildRawEvent({
      reputation: {
        score: 100,
        signals: {
          trustedBy: 1,
          channelVolumeUsdc: 500,
          jobsCompleted: 5,
          avgRating: Infinity,
        },
      },
    });
    expect(parseServiceDiscovery(event)).toBeNull();
  });
});

// ============================================================================
// Gap-filling: computeAvgRating all-verified case
// ============================================================================

describe('computeAvgRating() all-verified reviews', () => {
  it('computes correct average when all reviews are from verified customers', () => {
    const calculator = new ReputationScoreCalculator();
    const reviews: { review: ParsedJobReview; reviewerPubkey: string }[] = [
      {
        review: {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 5,
          role: 'customer',
          content: '',
        },
        reviewerPubkey: VALID_PUBKEY_2,
      },
      {
        review: {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 3,
          role: 'customer',
          content: '',
        },
        reviewerPubkey: VALID_PUBKEY_3,
      },
      {
        review: {
          jobRequestEventId: VALID_EVENT_ID,
          targetPubkey: VALID_PUBKEY,
          rating: 4,
          role: 'customer',
          content: '',
        },
        reviewerPubkey: 'e'.repeat(64),
      },
    ];

    const verifiedCustomers = new Set([
      VALID_PUBKEY_2,
      VALID_PUBKEY_3,
      'e'.repeat(64),
    ]);

    const avg = calculator.computeAvgRating(reviews, verifiedCustomers);
    // (5 + 3 + 4) / 3 = 4
    expect(avg).toBe(4);
  });
});
