/**
 * Deterministic ILP address derivation from Nostr pubkeys.
 *
 * Derives a child ILP address by appending the first 8 hex characters
 * of a Nostr pubkey as a new segment to a parent ILP address prefix.
 *
 * @module
 */

import { ToonError } from '../errors.js';
import { validateIlpAddress } from './ilp-address-validation.js';

/**
 * Hex-only pattern (case-insensitive for input validation).
 */
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * Number of hex characters to extract from the pubkey for the child segment.
 * 8 hex chars = 4,294,967,296 possible values (birthday collision > 1% only at ~9,292 peers).
 */
const PUBKEY_TRUNCATION_LENGTH = 8;

/**
 * Maximum allowed pubkey length. Nostr pubkeys are 64 hex characters
 * (32 bytes). Allow some headroom but reject excessively long strings
 * to prevent unnecessary regex processing (defense-in-depth).
 */
const MAX_PUBKEY_LENGTH = 128;

/**
 * Maximum ILP address length (practical limit).
 */
const MAX_ILP_ADDRESS_LENGTH = 1023;

/**
 * Derives a child ILP address by appending the first 8 hex characters of a
 * Nostr pubkey as a new segment to a parent ILP address prefix.
 *
 * @param parentPrefix - The parent ILP address prefix (e.g., `g.toon` or `g.toon.ef567890`)
 * @param childPubkey - The child's Nostr pubkey (hex string, at least 8 characters)
 * @returns The derived child ILP address (e.g., `g.toon.abcd1234`)
 *
 * @throws {ToonError} With code `ADDRESS_INVALID_PREFIX` if `parentPrefix` is empty or
 *   contains invalid ILP address characters.
 * @throws {ToonError} With code `ADDRESS_INVALID_PUBKEY` if `childPubkey` is shorter than
 *   8 hex characters or contains non-hex characters.
 *
 * @example
 * ```ts
 * deriveChildAddress('g.toon', 'abcd1234abcd1234...') // => 'g.toon.abcd1234'
 * deriveChildAddress('g.toon.ef567890', '11aabb22...') // => 'g.toon.ef567890.11aabb22'
 * ```
 */
export function deriveChildAddress(
  parentPrefix: string,
  childPubkey: string
): string {
  // Validate parent prefix
  if (!parentPrefix) {
    throw new ToonError(
      'Parent prefix must not be empty',
      'ADDRESS_INVALID_PREFIX'
    );
  }
  validateIlpAddress(parentPrefix);

  // Validate pubkey: must be at least 8 hex characters (check length before content)
  if (childPubkey.length < PUBKEY_TRUNCATION_LENGTH) {
    throw new ToonError(
      `Invalid pubkey: must be at least ${PUBKEY_TRUNCATION_LENGTH} hex characters, got ${childPubkey.length}`,
      'ADDRESS_INVALID_PUBKEY'
    );
  }

  // Validate pubkey: reject excessively long strings before regex (defense-in-depth)
  if (childPubkey.length > MAX_PUBKEY_LENGTH) {
    throw new ToonError(
      `Invalid pubkey: exceeds maximum length of ${MAX_PUBKEY_LENGTH} characters`,
      'ADDRESS_INVALID_PUBKEY'
    );
  }

  // Validate pubkey: must be hex-only
  if (!HEX_PATTERN.test(childPubkey)) {
    throw new ToonError(
      `Invalid pubkey: contains non-hex characters`,
      'ADDRESS_INVALID_PUBKEY'
    );
  }

  // Derive child segment: first 8 hex chars, lowercased
  const childSegment = childPubkey
    .slice(0, PUBKEY_TRUNCATION_LENGTH)
    .toLowerCase();

  // Construct the derived address
  const derivedAddress = `${parentPrefix}.${childSegment}`;

  // Validate total address length
  if (derivedAddress.length > MAX_ILP_ADDRESS_LENGTH) {
    throw new ToonError(
      `Derived ILP address exceeds maximum length of ${MAX_ILP_ADDRESS_LENGTH}`,
      'ADDRESS_TOO_LONG'
    );
  }

  return derivedAddress;
}
