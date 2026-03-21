/**
 * Shared ILP address validation utilities.
 *
 * Centralizes ILP address structure validation used by both
 * `derive-child-address.ts` and `btp-prefix-exchange.ts`.
 *
 * @module
 */

import { ToonError } from '../errors.js';

/**
 * Valid ILP address segment pattern: lowercase alphanumeric + hyphen.
 * Each dot-separated segment must match this pattern and be non-empty.
 */
const ILP_SEGMENT_PATTERN = /^[a-z0-9-]+$/;

/**
 * Maximum allowed ILP address length (practical limit).
 * Rejects oversized input before splitting and regex processing.
 */
const MAX_ILP_ADDRESS_LENGTH = 1023;

/**
 * Returns `true` if the string is a structurally valid ILP address
 * (dot-separated, non-empty segments, valid characters only).
 */
export function isValidIlpAddressStructure(address: string): boolean {
  if (!address) return false;
  if (address.length > MAX_ILP_ADDRESS_LENGTH) return false;
  const segments = address.split('.');
  for (const segment of segments) {
    if (segment.length === 0) return false;
    if (!ILP_SEGMENT_PATTERN.test(segment)) return false;
  }
  return true;
}

/**
 * Validates that a string is a valid ILP address. Throws a `ToonError`
 * with code `ADDRESS_INVALID_PREFIX` on any structural violation.
 *
 * @throws {ToonError} With code `ADDRESS_INVALID_PREFIX` if the address
 *   contains empty segments or invalid characters.
 */
export function validateIlpAddress(address: string): void {
  if (address.length > MAX_ILP_ADDRESS_LENGTH) {
    throw new ToonError(
      `Invalid ILP address: exceeds maximum length of ${MAX_ILP_ADDRESS_LENGTH}`,
      'ADDRESS_INVALID_PREFIX'
    );
  }
  const segments = address.split('.');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new ToonError(
        `Invalid ILP address: empty segment in "${address}"`,
        'ADDRESS_INVALID_PREFIX'
      );
    }
    if (!ILP_SEGMENT_PATTERN.test(segment)) {
      throw new ToonError(
        `Invalid ILP address: segment "${segment}" contains invalid characters`,
        'ADDRESS_INVALID_PREFIX'
      );
    }
  }
}
