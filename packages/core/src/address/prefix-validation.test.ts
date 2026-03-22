/**
 * ATDD tests for Story 7.6: Prefix Validation Utility (AC #12)
 *
 * Tests for the prefix validation utility used by the prefix claim
 * marketplace.
 *
 * Validates:
 * - Valid prefixes pass validation
 * - Minimum length (2 chars) enforcement
 * - Maximum length (16 chars) enforcement
 * - Uppercase characters rejected
 * - Special characters rejected
 * - Reserved words rejected (toon, ilp, local, peer, test)
 * - Empty string rejected
 * - Numeric-only prefixes accepted
 *
 * Test IDs from test-design-epic-7.md:
 * - T-7.7-10 [P1]: Prefix validation rules
 */

import { describe, it, expect } from 'vitest';
import { validatePrefix } from './prefix-validation.js';

describe('validatePrefix() (Story 7.6, AC #12)', () => {
  // ==========================================================================
  // Valid prefixes
  // ==========================================================================

  describe('valid prefixes', () => {
    it('[P0] accepts a valid lowercase alphanumeric prefix', () => {
      // Arrange
      const prefix = 'useast';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('[P0] accepts a 2-character prefix (minimum length)', () => {
      // Arrange
      const prefix = 'ab';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(true);
    });

    it('[P0] accepts a 16-character prefix (maximum length)', () => {
      // Arrange
      const prefix = 'abcdefghijklmnop'; // 16 chars

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(true);
    });

    it('[P1] accepts a numeric-only prefix', () => {
      // Arrange
      const prefix = '12345';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(true);
    });

    it('[P1] accepts a mixed alphanumeric prefix', () => {
      // Arrange
      const prefix = 'node42west';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(true);
    });
  });

  // ==========================================================================
  // Invalid: too short
  // ==========================================================================

  describe('too short', () => {
    it('[P0] rejects a 1-character prefix', () => {
      // Arrange
      const prefix = 'a';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/minimum.*2/i);
    });

    it('[P0] rejects an empty string', () => {
      // Arrange
      const prefix = '';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  // ==========================================================================
  // Invalid: too long
  // ==========================================================================

  describe('too long', () => {
    it('[P0] rejects a 17-character prefix', () => {
      // Arrange
      const prefix = 'abcdefghijklmnopq'; // 17 chars

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/maximum.*16/i);
    });
  });

  // ==========================================================================
  // Invalid: uppercase characters
  // ==========================================================================

  describe('uppercase characters', () => {
    it('[P0] rejects a prefix with uppercase letters', () => {
      // Arrange
      const prefix = 'UsEast';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/lowercase.*alphanumeric/i);
    });
  });

  // ==========================================================================
  // Invalid: special characters
  // ==========================================================================

  describe('special characters', () => {
    it('[P0] rejects a prefix with hyphens', () => {
      // Arrange
      const prefix = 'us-east';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/lowercase.*alphanumeric/i);
    });

    it('[P0] rejects a prefix with underscores', () => {
      // Arrange
      const prefix = 'us_east';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/lowercase.*alphanumeric/i);
    });

    it('[P1] rejects a prefix with dots', () => {
      // Arrange
      const prefix = 'us.east';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/lowercase.*alphanumeric/i);
    });

    it('[P1] rejects a prefix with spaces', () => {
      // Arrange
      const prefix = 'us east';

      // Act
      const result = validatePrefix(prefix);

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/lowercase.*alphanumeric/i);
    });
  });

  // ==========================================================================
  // Invalid: reserved words
  // ==========================================================================

  describe('reserved words', () => {
    it('[P0] rejects "toon" as a reserved word', () => {
      // Arrange & Act
      const result = validatePrefix('toon');

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/reserved/i);
    });

    it('[P0] rejects "ilp" as a reserved word', () => {
      // Arrange & Act
      const result = validatePrefix('ilp');

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/reserved/i);
    });

    it('[P0] rejects "local" as a reserved word', () => {
      // Arrange & Act
      const result = validatePrefix('local');

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/reserved/i);
    });

    it('[P0] rejects "peer" as a reserved word', () => {
      // Arrange & Act
      const result = validatePrefix('peer');

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/reserved/i);
    });

    it('[P0] rejects "test" as a reserved word', () => {
      // Arrange & Act
      const result = validatePrefix('test');

      // Assert
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/reserved/i);
    });
  });
});
