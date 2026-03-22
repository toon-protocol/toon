/**
 * Builders for ILP-related Nostr events.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { ToonError } from '../errors.js';
import { isValidIlpAddressStructure } from '../address/ilp-address-validation.js';
import type { IlpPeerInfo } from '../types.js';

/**
 * Builds and signs a kind:10032 Nostr event from IlpPeerInfo data.
 *
 * When `ilpAddresses` is present, validates that the array is non-empty and
 * that all elements are structurally valid ILP addresses. Normalizes
 * `ilpAddress` (singular) to equal `ilpAddresses[0]` for backward compatibility.
 *
 * @param info - The ILP peer info to serialize into the event
 * @param secretKey - The secret key to sign the event with
 * @returns A signed Nostr event
 *
 * @throws {ToonError} With code `ADDRESS_EMPTY_ADDRESSES` if `ilpAddresses` is an empty array
 * @throws {ToonError} With code `ADDRESS_INVALID_PREFIX` if any element of `ilpAddresses` is invalid
 */
export function buildIlpPeerInfoEvent(
  info: IlpPeerInfo,
  secretKey: Uint8Array
): NostrEvent {
  let effectiveInfo = info;

  if (info.ilpAddresses !== undefined) {
    const addresses = info.ilpAddresses;
    if (addresses.length === 0) {
      throw new ToonError(
        'ilpAddresses must be a non-empty array: a node must have at least one address',
        'ADDRESS_EMPTY_ADDRESSES'
      );
    }

    for (const addr of addresses) {
      if (!isValidIlpAddressStructure(addr)) {
        throw new ToonError(
          `Invalid ILP address in ilpAddresses: "${addr}"`,
          'ADDRESS_INVALID_PREFIX'
        );
      }
    }

    // Normalize ilpAddress to ilpAddresses[0] for backward compatibility
    // Safe: length > 0 guaranteed by the check above
    const primaryAddress = addresses[0] as string;
    effectiveInfo = {
      ...info,
      ilpAddress: primaryAddress,
    };
  }

  return finalizeEvent(
    {
      kind: ILP_PEER_INFO_KIND,
      content: JSON.stringify(effectiveInfo),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}
