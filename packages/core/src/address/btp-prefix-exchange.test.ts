import { describe, it, expect } from 'vitest';

import {
  buildPrefixHandshakeData,
  extractPrefixFromHandshake,
  validatePrefixConsistency,
  checkAddressCollision,
} from './btp-prefix-exchange.js';
import { ToonError } from '../errors.js';

// ---------------------------------------------------------------------------
// T-7.2-01 [P0] buildPrefixHandshakeData
// ---------------------------------------------------------------------------
describe('buildPrefixHandshakeData', () => {
  it('T-7.2-01: returns { prefix: "g.toon.useast" } for input "g.toon.useast"', () => {
    const result = buildPrefixHandshakeData('g.toon.useast');
    expect(result).toEqual({ prefix: 'g.toon.useast' });
  });

  it('throws ADDRESS_INVALID_PREFIX when given an invalid ILP address (defense-in-depth)', () => {
    expect(() => buildPrefixHandshakeData('INVALID PREFIX')).toThrow(ToonError);
    try {
      buildPrefixHandshakeData('INVALID PREFIX');
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  it('throws ADDRESS_INVALID_PREFIX when given an empty string', () => {
    expect(() => buildPrefixHandshakeData('')).toThrow(ToonError);
    try {
      buildPrefixHandshakeData('');
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  it('throws ADDRESS_INVALID_PREFIX when address exceeds max length (defense-in-depth)', () => {
    const oversized = 'a'.repeat(1024);
    expect(() => buildPrefixHandshakeData(oversized)).toThrow(ToonError);
    try {
      buildPrefixHandshakeData(oversized);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });
});

// ---------------------------------------------------------------------------
// T-7.2-07 [P1] extractPrefixFromHandshake -- happy path
// ---------------------------------------------------------------------------
describe('extractPrefixFromHandshake -- happy path', () => {
  it('T-7.2-07: extracts "g.toon.useast" from valid handshake data', () => {
    const result = extractPrefixFromHandshake({ prefix: 'g.toon.useast' });
    expect(result).toBe('g.toon.useast');
  });

  it('extracts non-g.toon prefix (any valid ILP address accepted) (AC #1)', () => {
    const result = extractPrefixFromHandshake({ prefix: 'test.prefix.node1' });
    expect(result).toBe('test.prefix.node1');
  });

  it('round-trips with buildPrefixHandshakeData (AC #1)', () => {
    const handshakeData = buildPrefixHandshakeData('g.toon.region-a');
    const extracted = extractPrefixFromHandshake(handshakeData);
    expect(extracted).toBe('g.toon.region-a');
  });
});

// ---------------------------------------------------------------------------
// T-7.2-05 [P0] extractPrefixFromHandshake -- fail-closed behavior
// ---------------------------------------------------------------------------
describe('extractPrefixFromHandshake -- fail-closed', () => {
  it('T-7.2-05: throws ADDRESS_MISSING_PREFIX when prefix field is absent', () => {
    expect(() => extractPrefixFromHandshake({})).toThrow(ToonError);
    try {
      extractPrefixFromHandshake({});
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_MISSING_PREFIX');
    }
  });

  it('throws ADDRESS_MISSING_PREFIX when prefix is empty string', () => {
    expect(() => extractPrefixFromHandshake({ prefix: '' })).toThrow(ToonError);
    try {
      extractPrefixFromHandshake({ prefix: '' });
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_MISSING_PREFIX');
    }
  });

  it('throws ADDRESS_INVALID_PREFIX when prefix has invalid ILP characters', () => {
    expect(() =>
      extractPrefixFromHandshake({ prefix: 'INVALID PREFIX' })
    ).toThrow(ToonError);
    try {
      extractPrefixFromHandshake({ prefix: 'INVALID PREFIX' });
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });

  it('throws ADDRESS_MISSING_PREFIX when prefix is null (AC #3: fail-closed)', () => {
    expect(() => extractPrefixFromHandshake({ prefix: null })).toThrow(
      ToonError
    );
    try {
      extractPrefixFromHandshake({ prefix: null });
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_MISSING_PREFIX');
    }
  });

  it('throws ADDRESS_MISSING_PREFIX when prefix is a number (AC #3: type safety)', () => {
    expect(() => extractPrefixFromHandshake({ prefix: 123 })).toThrow(
      ToonError
    );
    try {
      extractPrefixFromHandshake({ prefix: 123 });
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_MISSING_PREFIX');
    }
  });

  it('throws ADDRESS_MISSING_PREFIX when prefix is explicitly undefined (AC #3)', () => {
    expect(() => extractPrefixFromHandshake({ prefix: undefined })).toThrow(
      ToonError
    );
    try {
      extractPrefixFromHandshake({ prefix: undefined });
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_MISSING_PREFIX');
    }
  });

  it('throws ADDRESS_INVALID_PREFIX when prefix exceeds max length (defense-in-depth)', () => {
    const oversized = 'a'.repeat(1024);
    expect(() => extractPrefixFromHandshake({ prefix: oversized })).toThrow(
      ToonError
    );
    try {
      extractPrefixFromHandshake({ prefix: oversized });
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_INVALID_PREFIX');
    }
  });
});

// ---------------------------------------------------------------------------
// T-7.2-06 [P0] validatePrefixConsistency -- spoofing detection
// ---------------------------------------------------------------------------
describe('validatePrefixConsistency', () => {
  it('does not throw when handshake prefix matches advertised prefix', () => {
    expect(() =>
      validatePrefixConsistency('g.toon.useast', 'g.toon.useast')
    ).not.toThrow();
  });

  it('T-7.2-06: throws ADDRESS_PREFIX_MISMATCH when prefixes differ', () => {
    expect(() => validatePrefixConsistency('g.toon', 'g.toon.useast')).toThrow(
      ToonError
    );
    try {
      validatePrefixConsistency('g.toon', 'g.toon.useast');
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_PREFIX_MISMATCH');
    }
  });

  it('does not throw when advertisedPrefix is undefined (deferred validation)', () => {
    expect(() =>
      validatePrefixConsistency('g.toon.useast', undefined)
    ).not.toThrow();
  });

  it('throws ADDRESS_PREFIX_MISMATCH when advertisedPrefix is empty string (AC #4: edge case)', () => {
    expect(() => validatePrefixConsistency('g.toon.useast', '')).toThrow(
      ToonError
    );
    try {
      validatePrefixConsistency('g.toon.useast', '');
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_PREFIX_MISMATCH');
    }
  });
});

// ---------------------------------------------------------------------------
// checkAddressCollision
// ---------------------------------------------------------------------------
describe('checkAddressCollision', () => {
  it('throws ADDRESS_COLLISION when derived address exists in known peers', () => {
    expect(() =>
      checkAddressCollision('g.toon.abcd1234', ['g.toon.abcd1234'])
    ).toThrow(ToonError);
    try {
      checkAddressCollision('g.toon.abcd1234', ['g.toon.abcd1234']);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_COLLISION');
    }
  });

  it('does not throw when derived address is not in known peers', () => {
    expect(() =>
      checkAddressCollision('g.toon.abcd1234', ['g.toon.ef567890'])
    ).not.toThrow();
  });

  it('does not throw when known peers list is empty', () => {
    expect(() => checkAddressCollision('g.toon.abcd1234', [])).not.toThrow();
  });

  it('throws ADDRESS_COLLISION when derived address is among multiple known peers', () => {
    expect(() =>
      checkAddressCollision('g.toon.abcd1234', [
        'g.toon.ef567890',
        'g.toon.abcd1234',
        'g.toon.11223344',
      ])
    ).toThrow(ToonError);
    try {
      checkAddressCollision('g.toon.abcd1234', [
        'g.toon.ef567890',
        'g.toon.abcd1234',
        'g.toon.11223344',
      ]);
    } catch (e) {
      expect(e).toBeInstanceOf(ToonError);
      expect((e as ToonError).code).toBe('ADDRESS_COLLISION');
    }
  });
});

// ---------------------------------------------------------------------------
// Export verification (Task 7.1)
// ---------------------------------------------------------------------------
describe('Public API exports -- Story 7.2 functions', () => {
  it('T-7.2-exports: @toon-protocol/core exports all Story 7.2 symbols', async () => {
    const core = await import('../index.js');

    expect(core).toHaveProperty('extractPrefixFromHandshake');
    expect(core).toHaveProperty('buildPrefixHandshakeData');
    expect(core).toHaveProperty('validatePrefixConsistency');
    expect(core).toHaveProperty('checkAddressCollision');
    expect(core).toHaveProperty('assignAddressFromHandshake');
    expect(core).toHaveProperty('isGenesisNode');

    expect(typeof core.extractPrefixFromHandshake).toBe('function');
    expect(typeof core.buildPrefixHandshakeData).toBe('function');
    expect(typeof core.validatePrefixConsistency).toBe('function');
    expect(typeof core.checkAddressCollision).toBe('function');
    expect(typeof core.assignAddressFromHandshake).toBe('function');
    expect(typeof core.isGenesisNode).toBe('function');

    // Shared ILP validation utilities (fixed: were missing from core index)
    expect(core).toHaveProperty('isValidIlpAddressStructure');
    expect(core).toHaveProperty('validateIlpAddress');
    expect(typeof core.isValidIlpAddressStructure).toBe('function');
    expect(typeof core.validateIlpAddress).toBe('function');
  });
});
