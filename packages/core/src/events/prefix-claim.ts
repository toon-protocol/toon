/**
 * Event builders and parsers for prefix claim (kind 10034) and
 * prefix grant (kind 10037) events.
 *
 * Prefix claims are part of the TOON prefix marketplace: a node sends a
 * kind 10034 event with payment to claim a prefix from an upstream peer.
 * The upstream responds with a kind 10037 grant confirmation.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { PREFIX_CLAIM_KIND, PREFIX_GRANT_KIND } from '../constants.js';

// Re-export for convenient co-located imports
export { PREFIX_CLAIM_KIND, PREFIX_GRANT_KIND };

// ---------- Types ----------

/** Content payload for a kind 10034 prefix claim event. */
export interface PrefixClaimContent {
  /** The prefix string being requested (e.g., 'useast'). */
  requestedPrefix: string;
}

/** Content payload for a kind 10037 prefix grant event. */
export interface PrefixGrantContent {
  /** The prefix that was granted. */
  grantedPrefix: string;
  /** Pubkey of the node that received the prefix. */
  claimerPubkey: string;
  /** The ILP address derived from the granted prefix. */
  ilpAddress: string;
}

// ---------- Builders ----------

/**
 * Builds and signs a kind 10034 prefix claim event.
 *
 * @param content - The prefix claim content with the requested prefix
 * @param secretKey - The 32-byte secret key to sign the event with
 * @returns A signed Nostr event of kind 10034
 */
export function buildPrefixClaimEvent(
  content: PrefixClaimContent,
  secretKey: Uint8Array
): NostrEvent {
  return finalizeEvent(
    {
      kind: PREFIX_CLAIM_KIND,
      content: JSON.stringify(content),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

/**
 * Parses a kind 10034 prefix claim event into PrefixClaimContent.
 *
 * Returns null for malformed events. Follows the lenient parse pattern.
 *
 * @param event - The Nostr event to parse
 * @returns The parsed prefix claim content, or null if invalid
 */
export function parsePrefixClaimEvent(
  event: NostrEvent
): PrefixClaimContent | null {
  if (event.kind !== PREFIX_CLAIM_KIND) {
    return null;
  }

  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const requestedPrefix = obj['requestedPrefix'];
    if (typeof requestedPrefix !== 'string' || requestedPrefix.length === 0) {
      return null;
    }
    return { requestedPrefix };
  } catch {
    return null;
  }
}

/**
 * Builds and signs a kind 10037 prefix grant event.
 *
 * @param content - The prefix grant content with granted prefix details
 * @param secretKey - The 32-byte secret key to sign the event with
 * @returns A signed Nostr event of kind 10037
 */
export function buildPrefixGrantEvent(
  content: PrefixGrantContent,
  secretKey: Uint8Array
): NostrEvent {
  return finalizeEvent(
    {
      kind: PREFIX_GRANT_KIND,
      content: JSON.stringify(content),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

/**
 * Parses a kind 10037 prefix grant event into PrefixGrantContent.
 *
 * Returns null for malformed events. Follows the lenient parse pattern.
 *
 * @param event - The Nostr event to parse
 * @returns The parsed prefix grant content, or null if invalid
 */
export function parsePrefixGrantEvent(
  event: NostrEvent
): PrefixGrantContent | null {
  if (event.kind !== PREFIX_GRANT_KIND) {
    return null;
  }

  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const grantedPrefix = obj['grantedPrefix'];
    const claimerPubkey = obj['claimerPubkey'];
    const ilpAddress = obj['ilpAddress'];
    if (typeof grantedPrefix !== 'string' || grantedPrefix.length === 0) {
      return null;
    }
    if (typeof claimerPubkey !== 'string' || claimerPubkey.length === 0) {
      return null;
    }
    if (typeof ilpAddress !== 'string' || ilpAddress.length === 0) {
      return null;
    }
    return {
      grantedPrefix,
      claimerPubkey,
      ilpAddress,
    };
  } catch {
    return null;
  }
}
