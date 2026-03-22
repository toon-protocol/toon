/**
 * BTP handshake prefix exchange utilities.
 *
 * Provides extraction, building, and validation functions for the prefix
 * data exchanged during BTP handshake. This module defines the structural
 * type for prefix extension data but does NOT modify the BTP wire protocol
 * (which lives in @toon-protocol/connector).
 *
 * @module
 */

import { ToonError } from '../errors.js';
import { isValidIlpAddressStructure } from './ilp-address-validation.js';

/**
 * Maximum allowed ILP address length (practical limit, matches derive-child-address.ts).
 * Applied early in extractPrefixFromHandshake to reject oversized untrusted input
 * before string splitting and regex processing (defense-in-depth).
 */
const MAX_PREFIX_LENGTH = 1023;

/**
 * Shape of prefix data in BTP handshake messages.
 * Upstream peers include this in their handshake response so that
 * connecting nodes can derive their own ILP address.
 */
export interface BtpHandshakeExtension {
  prefix: string;
}

/**
 * Extracts and validates the prefix field from BTP handshake response data.
 *
 * Fail-closed behavior: throws if the prefix is absent, empty, or invalid.
 * This is the critical safety contract -- nodes MUST NOT fall back to
 * hardcoded addresses when the upstream peer omits the prefix.
 *
 * @param handshakeData - The handshake response data object
 * @returns The validated prefix string
 *
 * @throws {ToonError} With code `ADDRESS_MISSING_PREFIX` if the `prefix` field
 *   is absent or empty.
 * @throws {ToonError} With code `ADDRESS_INVALID_PREFIX` if the prefix fails
 *   ILP address validation.
 */
export function extractPrefixFromHandshake(
  handshakeData: Record<string, unknown>
): string {
  const prefix = handshakeData['prefix'];

  if (prefix === undefined || prefix === null || prefix === '') {
    throw new ToonError(
      'BTP handshake response missing required prefix field',
      'ADDRESS_MISSING_PREFIX'
    );
  }

  if (typeof prefix !== 'string') {
    throw new ToonError(
      'BTP handshake response missing required prefix field',
      'ADDRESS_MISSING_PREFIX'
    );
  }

  // Reject oversized input before string splitting / regex (defense-in-depth)
  if (prefix.length > MAX_PREFIX_LENGTH) {
    throw new ToonError(
      `BTP handshake prefix exceeds maximum length of ${MAX_PREFIX_LENGTH}`,
      'ADDRESS_INVALID_PREFIX'
    );
  }

  if (!isValidIlpAddressStructure(prefix)) {
    throw new ToonError(
      `BTP handshake prefix is not a valid ILP address: "${prefix}"`,
      'ADDRESS_INVALID_PREFIX'
    );
  }

  return prefix;
}

/**
 * Constructs the prefix extension data that upstream peers include
 * in their handshake response.
 *
 * Validates the address before building the handshake data to ensure
 * upstream peers never send structurally invalid prefixes.
 *
 * @param ownIlpAddress - The upstream peer's own ILP address
 * @returns The handshake extension data containing the prefix
 *
 * @throws {ToonError} With code `ADDRESS_INVALID_PREFIX` if the address
 *   is not a valid ILP address.
 */
export function buildPrefixHandshakeData(
  ownIlpAddress: string
): BtpHandshakeExtension {
  if (ownIlpAddress.length > MAX_PREFIX_LENGTH) {
    throw new ToonError(
      `Cannot build handshake data: address exceeds maximum length of ${MAX_PREFIX_LENGTH}`,
      'ADDRESS_INVALID_PREFIX'
    );
  }
  if (!isValidIlpAddressStructure(ownIlpAddress)) {
    throw new ToonError(
      `Cannot build handshake data: "${ownIlpAddress}" is not a valid ILP address`,
      'ADDRESS_INVALID_PREFIX'
    );
  }
  return { prefix: ownIlpAddress };
}

/**
 * Cross-validates the handshake prefix against the upstream peer's
 * kind:10032 advertised address.
 *
 * When both values are available and they do not match, throws a
 * ToonError indicating potential prefix spoofing. When the advertised
 * prefix is undefined (kind:10032 not yet discovered), validation is
 * deferred (no-op).
 *
 * @param handshakePrefix - The prefix received during BTP handshake
 * @param advertisedPrefix - The upstream peer's kind:10032 advertised address (optional)
 *
 * @throws {ToonError} With code `ADDRESS_PREFIX_MISMATCH` if both values
 *   are available and do not match.
 */
export function validatePrefixConsistency(
  handshakePrefix: string,
  advertisedPrefix?: string
): void {
  if (advertisedPrefix === undefined) {
    return; // Deferred validation -- kind:10032 not yet discovered
  }

  if (handshakePrefix !== advertisedPrefix) {
    throw new ToonError(
      `BTP handshake prefix "${handshakePrefix}" does not match upstream kind:10032 advertised address "${advertisedPrefix}"`,
      'ADDRESS_PREFIX_MISMATCH'
    );
  }
}

/**
 * Checks whether a derived address collides with any known peer addresses.
 *
 * Safety net for the 8-char truncation collision case (exceedingly unlikely
 * at < 9,292 peers, but the check exists per E7-R001).
 *
 * @param derivedAddress - The newly derived ILP address
 * @param knownPeerAddresses - List of existing peer addresses to check against
 *
 * @throws {ToonError} With code `ADDRESS_COLLISION` if the derived address
 *   already exists in the known peer list.
 */
export function checkAddressCollision(
  derivedAddress: string,
  knownPeerAddresses: string[]
): void {
  if (knownPeerAddresses.includes(derivedAddress)) {
    throw new ToonError(
      `Derived ILP address "${derivedAddress}" collides with an existing peer address`,
      'ADDRESS_COLLISION'
    );
  }
}
