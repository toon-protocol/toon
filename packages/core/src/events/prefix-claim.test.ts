/**
 * ATDD tests for Story 7.6: Prefix Claim Event Kind and TOON Roundtrip (AC #7)
 *
 * Tests for prefix claim (kind 10034) and prefix grant (kind 10037)
 * event builders, parsers, and TOON roundtrip behavior.
 *
 * Validates:
 * - PREFIX_CLAIM_KIND = 10034
 * - PREFIX_GRANT_KIND = 10037
 * - buildPrefixClaimEvent creates a signed Kind 10034 event
 * - parsePrefixClaimEvent extracts requestedPrefix
 * - buildPrefixGrantEvent creates a signed Kind 10037 event
 * - parsePrefixGrantEvent extracts grantedPrefix, claimerPubkey, ilpAddress
 * - TOON roundtrip preserves prefix claim content
 * - TOON roundtrip preserves prefix grant content
 * - Malformed content returns null from parsers
 * - Events flow through standard pipeline (kind check, shallow parse)
 *
 * Test IDs from test-design-epic-7.md:
 * - T-7.7-01 [P0]: Prefix claim TOON roundtrip
 * - T-7.7-06 [P0]: Prefix grant TOON roundtrip
 * - T-7.7-15 [P1]: Prefix claim event flows through standard pipeline
 */

import { describe, it, expect } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import {
  buildPrefixClaimEvent,
  parsePrefixClaimEvent,
  buildPrefixGrantEvent,
  parsePrefixGrantEvent,
} from './prefix-claim.js';
import type { PrefixClaimContent, PrefixGrantContent } from './prefix-claim.js';
import {
  encodeEventToToon,
  decodeEventFromToon,
  shallowParseToon,
} from '../toon/index.js';

// ============================================================================
// Deterministic test fixtures
// ============================================================================

/** Fixed secret key for deterministic identity derivation (32 bytes) */
const FIXED_SECRET_KEY = Uint8Array.from(Buffer.from('a'.repeat(64), 'hex'));
const FIXED_PUBKEY = getPublicKey(FIXED_SECRET_KEY);

/** Fixed claimer secret key (different from above) */
const CLAIMER_SECRET_KEY = Uint8Array.from(Buffer.from('b'.repeat(64), 'hex'));
const CLAIMER_PUBKEY = getPublicKey(CLAIMER_SECRET_KEY);

function createPrefixClaimContent(
  overrides: Partial<PrefixClaimContent> = {}
): PrefixClaimContent {
  return {
    requestedPrefix: 'useast',
    ...overrides,
  };
}

function createPrefixGrantContent(
  overrides: Partial<PrefixGrantContent> = {}
): PrefixGrantContent {
  return {
    grantedPrefix: 'useast',
    claimerPubkey: CLAIMER_PUBKEY,
    ilpAddress: 'g.toon.useast',
    ...overrides,
  };
}

// ============================================================================
// Tests: Prefix Claim Event (Kind 10034)
// ============================================================================

describe('Prefix Claim Events (Story 7.6, AC #7)', () => {
  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------

  describe('PREFIX_CLAIM_KIND constant', () => {
    it('[P0] PREFIX_CLAIM_KIND equals 10034', async () => {
      // Arrange -- import the constant
      const { PREFIX_CLAIM_KIND } = await import('../constants.js');

      // Assert
      expect(PREFIX_CLAIM_KIND).toBe(10034);
    });
  });

  describe('PREFIX_GRANT_KIND constant', () => {
    it('[P0] PREFIX_GRANT_KIND equals 10037', async () => {
      // Arrange -- import the constant
      const { PREFIX_GRANT_KIND } = await import('../constants.js');

      // Assert
      expect(PREFIX_GRANT_KIND).toBe(10037);
    });
  });

  // --------------------------------------------------------------------------
  // buildPrefixClaimEvent
  // --------------------------------------------------------------------------

  describe('buildPrefixClaimEvent()', () => {
    it('[P0] creates a signed Kind 10034 event with requestedPrefix in content', () => {
      // Arrange
      const content = createPrefixClaimContent();

      // Act
      const event = buildPrefixClaimEvent(content, CLAIMER_SECRET_KEY);

      // Assert
      expect(event.kind).toBe(10034);
      expect(event.pubkey).toBe(CLAIMER_PUBKEY);
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(event.created_at).toBeGreaterThan(0);

      // Verify content contains requestedPrefix
      const parsed = JSON.parse(event.content);
      expect(parsed.requestedPrefix).toBe('useast');
    });
  });

  // --------------------------------------------------------------------------
  // parsePrefixClaimEvent
  // --------------------------------------------------------------------------

  describe('parsePrefixClaimEvent()', () => {
    it('[P0] extracts requestedPrefix from a valid prefix claim event', () => {
      // Arrange
      const content = createPrefixClaimContent({ requestedPrefix: 'euwest' });
      const event = buildPrefixClaimEvent(content, CLAIMER_SECRET_KEY);

      // Act
      const parsed = parsePrefixClaimEvent(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed?.requestedPrefix).toBe('euwest');
    });

    it('[P1] returns null for malformed content (not valid JSON)', () => {
      // Arrange -- construct a fake event with invalid content
      const event = buildPrefixClaimEvent(
        createPrefixClaimContent(),
        CLAIMER_SECRET_KEY
      );
      const malformed = { ...event, content: 'not-json' };

      // Act
      const parsed = parsePrefixClaimEvent(malformed);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P1] returns null for content missing requestedPrefix field', () => {
      // Arrange -- construct event with empty object content
      const event = buildPrefixClaimEvent(
        createPrefixClaimContent(),
        CLAIMER_SECRET_KEY
      );
      const malformed = { ...event, content: JSON.stringify({}) };

      // Act
      const parsed = parsePrefixClaimEvent(malformed);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P1] returns null for event with wrong kind', () => {
      // Arrange -- build a claim event, then change the kind
      const event = buildPrefixClaimEvent(
        createPrefixClaimContent(),
        CLAIMER_SECRET_KEY
      );
      const wrongKind = { ...event, kind: 1 };

      // Act
      const parsed = parsePrefixClaimEvent(wrongKind);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P2] returns null for content where requestedPrefix is not a string', () => {
      // Arrange
      const event = buildPrefixClaimEvent(
        createPrefixClaimContent(),
        CLAIMER_SECRET_KEY
      );
      const malformed = {
        ...event,
        content: JSON.stringify({ requestedPrefix: 42 }),
      };

      // Act
      const parsed = parsePrefixClaimEvent(malformed);

      // Assert
      expect(parsed).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-7.7-01: TOON roundtrip for prefix claim
  // --------------------------------------------------------------------------

  describe('TOON roundtrip (T-7.7-01)', () => {
    it('[P0] prefix claim event survives TOON encode -> decode -> parse roundtrip', () => {
      // Arrange
      const content = createPrefixClaimContent({ requestedPrefix: 'apnorth' });
      const event = buildPrefixClaimEvent(content, CLAIMER_SECRET_KEY);

      // Act -- TOON encode -> decode
      const toonEncoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonEncoded);
      const parsed = parsePrefixClaimEvent(decoded);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed?.requestedPrefix).toBe('apnorth');
      expect(decoded.kind).toBe(10034);
      expect(decoded.pubkey).toBe(CLAIMER_PUBKEY);
    });
  });

  // --------------------------------------------------------------------------
  // buildPrefixGrantEvent
  // --------------------------------------------------------------------------

  describe('buildPrefixGrantEvent()', () => {
    it('[P0] creates a signed Kind 10037 event with grant content', () => {
      // Arrange
      const content = createPrefixGrantContent();

      // Act
      const event = buildPrefixGrantEvent(content, FIXED_SECRET_KEY);

      // Assert
      expect(event.kind).toBe(10037);
      expect(event.pubkey).toBe(FIXED_PUBKEY);
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);

      // Verify content
      const parsed = JSON.parse(event.content);
      expect(parsed.grantedPrefix).toBe('useast');
      expect(parsed.claimerPubkey).toBe(CLAIMER_PUBKEY);
      expect(parsed.ilpAddress).toBe('g.toon.useast');
    });
  });

  // --------------------------------------------------------------------------
  // parsePrefixGrantEvent
  // --------------------------------------------------------------------------

  describe('parsePrefixGrantEvent()', () => {
    it('[P0] extracts all fields from a valid prefix grant event', () => {
      // Arrange
      const content = createPrefixGrantContent({
        grantedPrefix: 'euwest',
        ilpAddress: 'g.toon.euwest',
      });
      const event = buildPrefixGrantEvent(content, FIXED_SECRET_KEY);

      // Act
      const parsed = parsePrefixGrantEvent(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed?.grantedPrefix).toBe('euwest');
      expect(parsed?.claimerPubkey).toBe(CLAIMER_PUBKEY);
      expect(parsed?.ilpAddress).toBe('g.toon.euwest');
    });

    it('[P1] returns null for event with wrong kind', () => {
      // Arrange -- build a grant event, then change the kind
      const event = buildPrefixGrantEvent(
        createPrefixGrantContent(),
        FIXED_SECRET_KEY
      );
      const wrongKind = { ...event, kind: 1 };

      // Act
      const parsed = parsePrefixGrantEvent(wrongKind);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P1] returns null for malformed grant content', () => {
      // Arrange
      const event = buildPrefixGrantEvent(
        createPrefixGrantContent(),
        FIXED_SECRET_KEY
      );
      const malformed = { ...event, content: 'not-json' };

      // Act
      const parsed = parsePrefixGrantEvent(malformed);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P1] returns null when required fields are missing from grant', () => {
      // Arrange -- missing claimerPubkey
      const event = buildPrefixGrantEvent(
        createPrefixGrantContent(),
        FIXED_SECRET_KEY
      );
      const malformed = {
        ...event,
        content: JSON.stringify({ grantedPrefix: 'useast' }),
      };

      // Act
      const parsed = parsePrefixGrantEvent(malformed);

      // Assert
      expect(parsed).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-7.7-06: TOON roundtrip for prefix grant
  // --------------------------------------------------------------------------

  describe('TOON roundtrip for prefix grant (T-7.7-06)', () => {
    it('[P0] prefix grant event survives TOON encode -> decode -> parse roundtrip', () => {
      // Arrange
      const content = createPrefixGrantContent({
        grantedPrefix: 'saeast',
        ilpAddress: 'g.toon.saeast',
      });
      const event = buildPrefixGrantEvent(content, FIXED_SECRET_KEY);

      // Act -- TOON encode -> decode
      const toonEncoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonEncoded);
      const parsed = parsePrefixGrantEvent(decoded);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed?.grantedPrefix).toBe('saeast');
      expect(parsed?.claimerPubkey).toBe(CLAIMER_PUBKEY);
      expect(parsed?.ilpAddress).toBe('g.toon.saeast');
      expect(decoded.kind).toBe(10037);
    });
  });

  // --------------------------------------------------------------------------
  // T-7.7-15: Prefix claim flows through standard pipeline
  // --------------------------------------------------------------------------

  describe('standard pipeline flow (T-7.7-15)', () => {
    it('[P1] prefix claim event kind is extractable via shallowParseToon', () => {
      // Arrange
      const content = createPrefixClaimContent();
      const event = buildPrefixClaimEvent(content, CLAIMER_SECRET_KEY);
      const toonEncoded = encodeEventToToon(event);

      // Act -- shallow parse extracts kind without full decode
      const meta = shallowParseToon(toonEncoded);

      // Assert
      expect(meta.kind).toBe(10034);
      expect(meta.pubkey).toBe(CLAIMER_PUBKEY);
    });

    it('[P1] prefix grant event kind is extractable via shallowParseToon', () => {
      // Arrange
      const content = createPrefixGrantContent();
      const event = buildPrefixGrantEvent(content, FIXED_SECRET_KEY);
      const toonEncoded = encodeEventToToon(event);

      // Act
      const meta = shallowParseToon(toonEncoded);

      // Assert
      expect(meta.kind).toBe(10037);
    });
  });
});
