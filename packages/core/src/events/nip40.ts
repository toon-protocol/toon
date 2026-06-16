/**
 * NIP-40 expiration-timestamp helpers.
 *
 * A kind:10032 announcement (`ILP_PEER_INFO_KIND`) is a replaceable event: a
 * relay keeps only the latest per author, so a stale announcement from an apex
 * that has since gone offline lingers forever and clients faithfully dial its
 * dead BTP endpoint (issue #261). Stamping the announcement with a NIP-40
 * `["expiration", <unix-seconds>]` tag turns it into a liveness signal: a live
 * apex re-publishes before the tag elapses, and once it stops, NIP-40-aware
 * relays drop the event and discovery skips it.
 */

import type { NostrEvent } from 'nostr-tools/pure';

/** Tag name carrying the NIP-40 expiration timestamp (unix seconds). */
export const EXPIRATION_TAG = 'expiration';

/**
 * Read the NIP-40 expiration timestamp (unix seconds) from an event's tags.
 *
 * @returns The timestamp, or `undefined` when the event carries no valid
 *   `expiration` tag (no tag, non-numeric, or negative value).
 */
export function getEventExpiration(event: NostrEvent): number | undefined {
  const tag = event.tags.find((t) => t[0] === EXPIRATION_TAG);
  if (!tag || tag[1] === undefined) return undefined;
  const ts = Number(tag[1]);
  if (!Number.isFinite(ts) || ts < 0) return undefined;
  return ts;
}

/**
 * Whether an event has expired per its NIP-40 `expiration` tag.
 *
 * Events with no (or malformed) expiration tag never expire — they return
 * `false`, preserving backward compatibility with announcements published
 * before TTLs existed.
 *
 * @param event - The event to test.
 * @param nowSeconds - Reference time in unix seconds (defaults to now).
 *   Injectable for deterministic tests.
 */
export function isEventExpired(
  event: NostrEvent,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  const exp = getEventExpiration(event);
  return exp !== undefined && exp <= nowSeconds;
}
