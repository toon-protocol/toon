/**
 * Address assignment orchestration layer.
 *
 * Combines BTP prefix extraction with deterministic address derivation
 * to assign ILP addresses during the handshake process.
 *
 * @module
 */

import { ILP_ROOT_PREFIX } from '../constants.js';
import { deriveChildAddress } from './derive-child-address.js';
import { extractPrefixFromHandshake } from './btp-prefix-exchange.js';

/**
 * Orchestrates address assignment from BTP handshake data:
 * 1. Extracts and validates the prefix from handshake data
 * 2. Derives the child address using `deriveChildAddress(prefix, ownPubkey)`
 *
 * @param handshakeData - The BTP handshake response data object
 * @param ownPubkey - The connecting node's Nostr pubkey (hex string)
 * @returns The derived ILP address
 *
 * @throws {ToonError} With code `ADDRESS_MISSING_PREFIX` if the handshake
 *   data lacks a prefix field (fail-closed behavior).
 * @throws {ToonError} With code `ADDRESS_INVALID_PREFIX` if the prefix is
 *   not a valid ILP address.
 * @throws {ToonError} With code `ADDRESS_INVALID_PUBKEY` if the pubkey is
 *   shorter than 8 hex characters or contains non-hex characters.
 */
export function assignAddressFromHandshake(
  handshakeData: Record<string, unknown>,
  ownPubkey: string
): string {
  const prefix = extractPrefixFromHandshake(handshakeData);
  return deriveChildAddress(prefix, ownPubkey);
}

/**
 * Determines whether a node configuration represents a genesis node.
 *
 * Genesis nodes use `ILP_ROOT_PREFIX` (`g.toon`) directly without
 * derivation -- they are the root of the address hierarchy and do
 * not need a handshake to learn their prefix.
 *
 * @param config - Node configuration with optional ilpAddress
 * @returns `true` if the node's configured address equals `ILP_ROOT_PREFIX`
 */
export function isGenesisNode(config: { ilpAddress?: string }): boolean {
  return config.ilpAddress === ILP_ROOT_PREFIX;
}
