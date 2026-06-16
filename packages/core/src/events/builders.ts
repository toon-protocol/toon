/**
 * Builders for ILP-related Nostr events.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { ToonError } from '../errors.js';
import { isValidIlpAddressStructure } from '../address/ilp-address-validation.js';
import { assertSwapPairForBuild } from './swap-pair-validation.js';
import { EXPIRATION_TAG } from './nip40.js';
import type { IlpPeerInfo } from '../types.js';

/** Options controlling how a kind:10032 announcement event is built. */
export interface BuildIlpPeerInfoOptions {
  /**
   * NIP-40 time-to-live, in seconds. When set to a positive value, the event
   * carries an `["expiration", created_at + ttlSeconds]` tag so a stale
   * announcement from an offline apex expires instead of lingering forever
   * (issue #261). Omit (or pass a non-positive value) for a non-expiring event.
   */
  ttlSeconds?: number;
}

/**
 * Builds and signs a kind:10032 Nostr event from IlpPeerInfo data.
 *
 * When `ilpAddresses` is present, validates that the array is non-empty and
 * that all elements are structurally valid ILP addresses. Normalizes
 * `ilpAddress` (singular) to equal `ilpAddresses[0]` for backward compatibility.
 *
 * @param info - The ILP peer info to serialize into the event
 * @param secretKey - The secret key to sign the event with
 * @param options - Optional build options (e.g. a NIP-40 `ttlSeconds`)
 * @returns A signed Nostr event
 *
 * @throws {ToonError} With code `INVALID_FEE` if `feePerByte` is not a non-negative integer string
 * @throws {ToonError} With code `ADDRESS_EMPTY_ADDRESSES` if `ilpAddresses` is an empty array
 * @throws {ToonError} With code `ADDRESS_INVALID_PREFIX` if any element of `ilpAddresses` is invalid
 * @throws {ToonError} With code `INVALID_SWAP_PAIR` if any element of `swapPairs` is structurally invalid
 */
export function buildIlpPeerInfoEvent(
  info: IlpPeerInfo,
  secretKey: Uint8Array,
  options: BuildIlpPeerInfoOptions = {}
): NostrEvent {
  // Validate feePerByte if provided
  if (info.feePerByte !== undefined) {
    if (typeof info.feePerByte !== 'string' || !/^\d+$/.test(info.feePerByte)) {
      throw new ToonError(
        `Invalid feePerByte: "${String(info.feePerByte)}" must be a non-negative integer string`,
        'INVALID_FEE'
      );
    }
  }

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

  // Validate swapPairs (Story 12.1). Empty array is legal (swap peer with no
  // currently active pairs); undefined means "no swap support" and is omitted
  // from the serialized JSON via JSON.stringify's default undefined handling.
  // Defensive runtime check: the TypeScript signature forbids non-array values,
  // but a JS caller (or any untyped boundary) could still pass garbage — reject
  // that with a typed `ToonError` rather than a generic `TypeError` from
  // `.forEach` on a non-array.
  if (info.swapPairs !== undefined) {
    if (!Array.isArray(info.swapPairs)) {
      throw new ToonError(
        'swapPairs must be an array when provided',
        'INVALID_SWAP_PAIR'
      );
    }
    info.swapPairs.forEach((pair, index) => {
      assertSwapPairForBuild(pair, index);
    });
  }

  const createdAt = Math.floor(Date.now() / 1000);

  // NIP-40 expiration: a positive ttlSeconds turns the announcement into a
  // liveness signal — a live apex re-publishes before it elapses, and a dead
  // one expires so clients stop dialing its unreachable BTP endpoint (#261).
  const tags: string[][] = [];
  if (options.ttlSeconds !== undefined && options.ttlSeconds > 0) {
    tags.push([
      EXPIRATION_TAG,
      String(createdAt + Math.floor(options.ttlSeconds)),
    ]);
  }

  return finalizeEvent(
    {
      kind: ILP_PEER_INFO_KIND,
      content: JSON.stringify(effectiveInfo),
      tags,
      created_at: createdAt,
    },
    secretKey
  );
}
