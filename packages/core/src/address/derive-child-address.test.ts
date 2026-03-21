import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// These imports will FAIL until the implementation is created (TDD RED PHASE)
// deriveChildAddress: packages/core/src/address/derive-child-address.ts
// ILP_ROOT_PREFIX: packages/core/src/constants.ts
// ---------------------------------------------------------------------------
import { deriveChildAddress } from './derive-child-address.js';
import { ILP_ROOT_PREFIX } from '../constants.js';
import { ToonError } from '../errors.js';

// ---------------------------------------------------------------------------
// Test data constants (deterministic, no randomness)
// ---------------------------------------------------------------------------

/** Full 64-char lowercase hex pubkey for standard derivation tests. */
const PUBKEY_64_LOWER =
  'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

/** Full 64-char uppercase hex pubkey for case-normalization tests. */
const PUBKEY_64_UPPER =
  'ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234';

/** Full 64-char hex pubkey for nested derivation tests. */
const PUBKEY_64_NESTED =
  '11aabb2233ccdd4455eeff6677889900aabbccdd11223344aabbccdd11223344';

/** Pubkey sharing first 8 chars with PUBKEY_64_LOWER (collision test). */
const PUBKEY_64_COLLISION_A =
  'abcd1234aaaa0000abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

/** Pubkey sharing first 8 chars with PUBKEY_64_LOWER (collision test). */
const PUBKEY_64_COLLISION_B =
  'abcd1234bbbb0000abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

// ---------------------------------------------------------------------------
// T-7.1-01 [P0] Child address derivation from root prefix
// ---------------------------------------------------------------------------
describe('deriveChildAddress -- child address derivation', () => {
  it('T-7.1-01: derives g.toon.abcd1234 from root prefix and 64-char pubkey', () => {
    // Arrange
    const parentPrefix = 'g.toon';
    const childPubkey = PUBKEY_64_LOWER;

    // Act
    const result = deriveChildAddress(parentPrefix, childPubkey);

    // Assert
    expect(result).toBe('g.toon.abcd1234');
  });

  // -------------------------------------------------------------------------
  // T-7.1-02 [P0] Nested derivation at arbitrary depth
  // -------------------------------------------------------------------------
  it('T-7.1-02: derives nested address g.toon.ef567890.11aabb22', () => {
    // Arrange
    const parentPrefix = 'g.toon.ef567890';
    const childPubkey = PUBKEY_64_NESTED;

    // Act
    const result = deriveChildAddress(parentPrefix, childPubkey);

    // Assert
    expect(result).toBe('g.toon.ef567890.11aabb22');
  });
});

// ---------------------------------------------------------------------------
// T-7.1-03 [P0] Root prefix constant
// ---------------------------------------------------------------------------
describe('ILP_ROOT_PREFIX constant', () => {
  it('T-7.1-03: exports g.toon as the ILP root prefix constant', () => {
    // Assert -- constant exists and equals 'g.toon'
    expect(ILP_ROOT_PREFIX).toBe('g.toon');
  });
});

// ---------------------------------------------------------------------------
// T-7.1-04 [P0] Derived segment contains only lowercase hex
// ---------------------------------------------------------------------------
describe('deriveChildAddress -- output format', () => {
  it('T-7.1-04: derived address segment contains only lowercase hex chars', () => {
    // Arrange
    const parentPrefix = 'g.toon';
    const childPubkey = PUBKEY_64_LOWER;

    // Act
    const result = deriveChildAddress(parentPrefix, childPubkey);

    // Assert -- extract child segment and verify lowercase hex only
    const segments = result.split('.');
    const childSegment = segments[segments.length - 1];
    expect(childSegment).toMatch(/^[0-9a-f]+$/);
    expect(childSegment).toHaveLength(8);
  });

  // -------------------------------------------------------------------------
  // T-7.1-05 [P0] Uppercase hex pubkey lowercased in derived address
  // -------------------------------------------------------------------------
  it('T-7.1-05: uppercase hex pubkey is lowercased to g.toon.abcd1234', () => {
    // Arrange
    const parentPrefix = 'g.toon';
    const childPubkey = PUBKEY_64_UPPER;

    // Act
    const result = deriveChildAddress(parentPrefix, childPubkey);

    // Assert
    expect(result).toBe('g.toon.abcd1234');
  });
});

// ---------------------------------------------------------------------------
// T-7.1-06 [P1] Collision is a documented known property
// ---------------------------------------------------------------------------
describe('deriveChildAddress -- collision properties', () => {
  it('T-7.1-06: two pubkeys sharing 8-char prefix produce same derived address (documented collision)', () => {
    // Arrange -- two different pubkeys with identical first 8 hex chars
    const parentPrefix = 'g.toon';

    // Act
    const resultA = deriveChildAddress(parentPrefix, PUBKEY_64_COLLISION_A);
    const resultB = deriveChildAddress(parentPrefix, PUBKEY_64_COLLISION_B);

    // Assert -- same derived address (collision is expected and documented)
    expect(resultA).toBe(resultB);
    expect(resultA).toBe('g.toon.abcd1234');
  });

  // -------------------------------------------------------------------------
  // T-7.1-07 [P2] Birthday paradox analysis
  // -------------------------------------------------------------------------
  it('T-7.1-07: birthday paradox -- collision probability < 0.001% for < 3000 peers at 8 hex chars', () => {
    // 8 hex characters = 16^8 = 4,294,967,296 possible values
    const addressSpace = Math.pow(16, 8);
    expect(addressSpace).toBe(4_294_967_296);

    // Birthday paradox formula: P(collision) ~ 1 - e^(-n^2 / (2 * N))
    // For n = 3000, N = 4,294,967,296:
    // P ~ 1 - e^(-9,000,000 / 8,589,934,592) ~ 1 - e^(-0.001047) ~ 0.001047 ~ 0.1%
    const n = 3000;
    const probability = 1 - Math.exp(-(n * n) / (2 * addressSpace));

    // Assert collision probability < 0.2% for 3000 peers
    expect(probability).toBeGreaterThan(0);
    expect(probability).toBeLessThan(0.002);
  });
});

// ---------------------------------------------------------------------------
// T-7.1-08 [P0] Validation: empty parent prefix
// ---------------------------------------------------------------------------
describe('deriveChildAddress -- input validation', () => {
  it('T-7.1-08: throws ToonError with ADDRESS_INVALID_PREFIX for empty parent prefix', () => {
    // Arrange
    const emptyPrefix = '';
    const childPubkey = PUBKEY_64_LOWER;

    // Act & Assert
    expect(() => deriveChildAddress(emptyPrefix, childPubkey)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress(emptyPrefix, childPubkey);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  // -------------------------------------------------------------------------
  // T-2.8a [P1] Validation: parent prefix with invalid ILP characters
  // -------------------------------------------------------------------------
  it('T-2.8a: throws ToonError with ADDRESS_INVALID_PREFIX for uppercase in prefix', () => {
    // Arrange -- uppercase letters are invalid in ILP address segments
    const invalidPrefix = 'g.toon.UPPER';
    const childPubkey = PUBKEY_64_LOWER;

    // Act & Assert
    expect(() => deriveChildAddress(invalidPrefix, childPubkey)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress(invalidPrefix, childPubkey);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  it('T-2.8a-b: throws ToonError with ADDRESS_INVALID_PREFIX for spaces in prefix', () => {
    // Arrange -- spaces are invalid in ILP address segments
    const invalidPrefix = 'g.toon.sp ace';
    const childPubkey = PUBKEY_64_LOWER;

    // Act & Assert
    expect(() => deriveChildAddress(invalidPrefix, childPubkey)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress(invalidPrefix, childPubkey);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  // -------------------------------------------------------------------------
  // T-7.1-09 [P0] Validation: pubkey too short
  // -------------------------------------------------------------------------
  it('T-7.1-09: throws ToonError with ADDRESS_INVALID_PUBKEY for pubkey shorter than 8 hex chars', () => {
    // Arrange
    const parentPrefix = 'g.toon';
    const shortPubkey = 'abcd12'; // only 6 hex chars

    // Act & Assert
    expect(() => deriveChildAddress(parentPrefix, shortPubkey)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress(parentPrefix, shortPubkey);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PUBKEY');
    }
  });

  // -------------------------------------------------------------------------
  // T-7.1-10 [P0] Validation: pubkey with non-hex characters
  // -------------------------------------------------------------------------
  it('T-7.1-10: throws ToonError with ADDRESS_INVALID_PUBKEY for non-hex characters', () => {
    // Arrange
    const parentPrefix = 'g.toon';
    const invalidPubkey =
      'abcd1234xyz00000abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

    // Act & Assert
    expect(() => deriveChildAddress(parentPrefix, invalidPubkey)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress(parentPrefix, invalidPubkey);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PUBKEY');
    }
  });
});

// ---------------------------------------------------------------------------
// T-7.1-11 [P0] Determinism
// ---------------------------------------------------------------------------
describe('deriveChildAddress -- determinism', () => {
  it('T-7.1-11: same inputs always produce same output across multiple calls', () => {
    // Arrange
    const parentPrefix = 'g.toon';
    const childPubkey = PUBKEY_64_LOWER;

    // Act -- call multiple times
    const result1 = deriveChildAddress(parentPrefix, childPubkey);
    const result2 = deriveChildAddress(parentPrefix, childPubkey);
    const result3 = deriveChildAddress(parentPrefix, childPubkey);

    // Assert -- all results identical
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
    expect(result1).toBe('g.toon.abcd1234');
  });
});

// ---------------------------------------------------------------------------
// T-7.1-12 [P1] ILP address structure validation
// ---------------------------------------------------------------------------
describe('deriveChildAddress -- ILP address structure', () => {
  it('T-7.1-12: derived address has valid ILP structure (dot-separated, non-empty segments)', () => {
    // Arrange
    const parentPrefix = 'g.toon';
    const childPubkey = PUBKEY_64_LOWER;

    // Act
    const result = deriveChildAddress(parentPrefix, childPubkey);

    // Assert -- dot-separated segments, each non-empty, valid chars
    const segments = result.split('.');
    expect(segments.length).toBeGreaterThanOrEqual(3); // g, toon, child
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(0); // non-empty
      expect(segment).toMatch(/^[a-z0-9-]+$/); // valid ILP chars
    }

    // Address starts with global allocation prefix
    expect(result).toMatch(/^g\./);

    // Total length is reasonable (ILP addresses have practical limits)
    expect(result.length).toBeLessThanOrEqual(1023);
  });

  it('T-7.1-12b: deeply nested derivation maintains valid ILP structure', () => {
    // Arrange -- 4-level deep prefix
    const parentPrefix = 'g.toon.aaaabbbb.ccccdddd';
    const childPubkey = PUBKEY_64_LOWER;

    // Act
    const result = deriveChildAddress(parentPrefix, childPubkey);

    // Assert
    expect(result).toBe('g.toon.aaaabbbb.ccccdddd.abcd1234');
    const segments = result.split('.');
    expect(segments.length).toBe(5);
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(0);
      expect(segment).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// T-3.1 [P0] Public API export verification (static analysis)
// ---------------------------------------------------------------------------
describe('Public API exports', () => {
  it('T-3.2: @toon-protocol/core exports deriveChildAddress and ILP_ROOT_PREFIX', async () => {
    // Arrange & Act -- dynamic import of the core barrel file
    const core = await import('../index.js');

    // Assert -- both symbols are exported
    expect(core).toHaveProperty('deriveChildAddress');
    expect(core).toHaveProperty('ILP_ROOT_PREFIX');
    expect(typeof core.deriveChildAddress).toBe('function');
    expect(typeof core.ILP_ROOT_PREFIX).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Additional AC coverage: edge cases and boundary conditions
// ---------------------------------------------------------------------------
describe('deriveChildAddress -- AC gap coverage', () => {
  // AC3: "the function lowercases uppercase hex input" -- mixed-case variant
  it('AC3-mixed-case: mixed-case hex pubkey is lowercased in derived segment', () => {
    const result = deriveChildAddress(
      'g.toon',
      'AbCd1234AbCd1234AbCd1234AbCd1234AbCd1234AbCd1234AbCd1234AbCd1234'
    );
    expect(result).toBe('g.toon.abcd1234');
  });

  // AC3 boundary: exactly 8 hex chars (minimum valid length)
  it('AC3-boundary-8: pubkey with exactly 8 hex characters is accepted', () => {
    const result = deriveChildAddress('g.toon', 'abcd1234');
    expect(result).toBe('g.toon.abcd1234');
  });

  // AC3 boundary: 7 hex chars (one below minimum)
  it('AC3-boundary-7: pubkey with 7 hex characters throws ADDRESS_INVALID_PUBKEY', () => {
    expect(() => deriveChildAddress('g.toon', 'abcd123')).toThrow(ToonError);
    try {
      deriveChildAddress('g.toon', 'abcd123');
    } catch (e) {
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PUBKEY');
    }
  });

  // AC3: empty pubkey string (non-hex / too short edge case)
  it('AC3-empty-pubkey: empty pubkey string throws ADDRESS_INVALID_PUBKEY', () => {
    expect(() => deriveChildAddress('g.toon', '')).toThrow(ToonError);
    try {
      deriveChildAddress('g.toon', '');
    } catch (e) {
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PUBKEY');
    }
  });

  // AC3: prefix with trailing dot creates empty segment -- must reject
  it('AC3-trailing-dot: prefix with trailing dot throws ADDRESS_INVALID_PREFIX', () => {
    expect(() => deriveChildAddress('g.toon.', PUBKEY_64_LOWER)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress('g.toon.', PUBKEY_64_LOWER);
    } catch (e) {
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  // AC3: prefix with leading dot creates empty segment -- must reject
  it('AC3-leading-dot: prefix with leading dot throws ADDRESS_INVALID_PREFIX', () => {
    expect(() => deriveChildAddress('.g.toon', PUBKEY_64_LOWER)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress('.g.toon', PUBKEY_64_LOWER);
    } catch (e) {
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  // AC1: different parent prefixes with same pubkey produce different addresses
  it('AC1-different-parents: same pubkey under different parents produces different addresses', () => {
    const resultA = deriveChildAddress('g.toon', PUBKEY_64_LOWER);
    const resultB = deriveChildAddress('g.toon.ef567890', PUBKEY_64_LOWER);
    expect(resultA).not.toBe(resultB);
    expect(resultA).toBe('g.toon.abcd1234');
    expect(resultB).toBe('g.toon.ef567890.abcd1234');
  });

  // AC3: pubkey with special characters (not just letters, but symbols)
  it('AC3-special-chars: pubkey with underscores throws ADDRESS_INVALID_PUBKEY', () => {
    expect(() =>
      deriveChildAddress(
        'g.toon',
        'abcd_234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'
      )
    ).toThrow(ToonError);
    try {
      deriveChildAddress(
        'g.toon',
        'abcd_234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'
      );
    } catch (e) {
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PUBKEY');
    }
  });

  // AC2: ILP_ROOT_PREFIX is usable as a parent prefix in deriveChildAddress
  it('AC2-root-prefix-usable: ILP_ROOT_PREFIX works as parentPrefix argument', () => {
    const result = deriveChildAddress(ILP_ROOT_PREFIX, PUBKEY_64_LOWER);
    expect(result).toBe('g.toon.abcd1234');
  });

  // AC3: prefix with consecutive dots creates empty segment -- must reject
  it('AC3-consecutive-dots: prefix with consecutive dots throws ADDRESS_INVALID_PREFIX', () => {
    expect(() => deriveChildAddress('g..toon', PUBKEY_64_LOWER)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress('g..toon', PUBKEY_64_LOWER);
    } catch (e) {
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  // AC3: prefix with special characters (not alphanumeric or hyphen)
  it('AC3-special-prefix-chars: prefix with @ symbol throws ADDRESS_INVALID_PREFIX', () => {
    expect(() => deriveChildAddress('g.toon.n@de', PUBKEY_64_LOWER)).toThrow(
      ToonError
    );
    try {
      deriveChildAddress('g.toon.n@de', PUBKEY_64_LOWER);
    } catch (e) {
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  // Defense-in-depth: excessively long pubkey rejected before regex (DoS prevention)
  it('AC3-max-length: pubkey exceeding 128 chars throws ADDRESS_INVALID_PUBKEY', () => {
    const longPubkey = 'a'.repeat(129);
    expect(() => deriveChildAddress('g.toon', longPubkey)).toThrow(ToonError);
    try {
      deriveChildAddress('g.toon', longPubkey);
    } catch (e) {
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PUBKEY');
    }
  });

  // Defense-in-depth: pubkey at exactly 128 chars is accepted (boundary)
  it('AC3-max-length-boundary: pubkey at exactly 128 hex chars is accepted', () => {
    const maxPubkey = 'ab'.repeat(64); // 128 hex chars
    const result = deriveChildAddress('g.toon', maxPubkey);
    expect(result).toBe('g.toon.abababab');
  });
});
