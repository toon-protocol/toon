/**
 * Prefix validation utility for the TOON prefix claim marketplace.
 *
 * Validates requested prefix strings against naming rules:
 * lowercase alphanumeric only, length constraints, no reserved words.
 */

/** Reserved words that cannot be used as prefixes. */
const RESERVED_WORDS = new Set(['toon', 'ilp', 'local', 'peer', 'test']);

/** Prefix pattern: lowercase alphanumeric only. */
const PREFIX_PATTERN = /^[a-z0-9]+$/;

/** Minimum prefix length. */
const MIN_LENGTH = 2;

/** Maximum prefix length. */
const MAX_LENGTH = 16;

/**
 * Result of prefix validation.
 */
export interface PrefixValidationResult {
  /** Whether the prefix is valid. */
  valid: boolean;
  /** Reason for rejection (only present when valid is false). */
  reason?: string;
}

/**
 * Validates a prefix string for use in the prefix claim marketplace.
 *
 * Rules:
 * - Lowercase alphanumeric only (`[a-z0-9]`)
 * - Minimum 2 characters
 * - Maximum 16 characters
 * - No reserved words (`toon`, `ilp`, `local`, `peer`, `test`)
 *
 * @param prefix - The prefix string to validate
 * @returns Validation result with valid flag and optional reason
 */
export function validatePrefix(prefix: string): PrefixValidationResult {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return { valid: false, reason: 'Prefix must be a non-empty string' };
  }

  if (prefix.length < MIN_LENGTH) {
    return {
      valid: false,
      reason: `Prefix must have a minimum of ${MIN_LENGTH} characters, got ${prefix.length}`,
    };
  }

  if (prefix.length > MAX_LENGTH) {
    return {
      valid: false,
      reason: `Prefix must have a maximum of ${MAX_LENGTH} characters, got ${prefix.length}`,
    };
  }

  if (!PREFIX_PATTERN.test(prefix)) {
    return {
      valid: false,
      reason:
        'Prefix must contain only lowercase alphanumeric characters [a-z0-9]',
    };
  }

  if (RESERVED_WORDS.has(prefix)) {
    return {
      valid: false,
      reason: `Prefix "${prefix}" is a reserved word`,
    };
  }

  return { valid: true };
}
