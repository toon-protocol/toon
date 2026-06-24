/**
 * Pure helpers for NIP-on-TOON UI renderer resolution.
 *
 * An event may carry a `ui` tag whose value is an addressable coordinate
 * pointing at a `kind:31036` renderer event. The coordinate convention is:
 *
 *     31036:<renderer-author-pubkey>:<target-kind>
 *
 * where the trailing segment (the renderer event's `d` tag value) is the
 * kind of event the renderer knows how to render.
 *
 * These helpers are intentionally PURE: they parse coordinate strings and
 * select the latest addressable event from a set of candidates. The actual
 * resolution (relay query + cache) is client-local and lives outside core.
 *
 * Mirrors the style of `parseRepositoryReference` in `../nip34/types.ts`.
 */

import type { Event as NostrEvent } from 'nostr-tools/pure';

/** The renderer event kind for NIP-on-TOON UI rendering. */
export const UI_RENDERER_KIND = 31036;

/** Tag name carrying the UI renderer coordinate on a rendered event. */
export const UI_TAG = 'ui';

/** Matches a lowercase 64-character hex pubkey. */
const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * A parsed `ui` renderer coordinate.
 * Format: "31036:<pubkey>:<targetKind>"
 */
export interface UiCoordinate {
  /** Always {@link UI_RENDERER_KIND} (31036). */
  kind: typeof UI_RENDERER_KIND;
  /** The renderer author's 64-hex pubkey. */
  pubkey: string;
  /** The kind of event this renderer targets (the renderer's `d` value). */
  targetKind: number;
}

/**
 * Parse a `ui` renderer coordinate string of the form
 * `31036:<pubkey>:<targetKind>`.
 *
 * Returns `null` on any malformed input: wrong segment count, a leading kind
 * other than 31036, a pubkey that is not 64-hex, or a non-integer target kind.
 *
 * Pure: no IO, no relay fetch.
 *
 * @param coord - The coordinate string (e.g. a `ui` tag value).
 * @returns The parsed {@link UiCoordinate}, or `null` if malformed.
 */
export function parseUiCoordinate(coord: string): UiCoordinate | null {
  if (typeof coord !== 'string') {
    return null;
  }
  const parts = coord.split(':');
  if (parts.length !== 3) {
    return null;
  }
  const [kindStr, pubkey, targetKindStr] = parts;
  if (
    kindStr === undefined ||
    pubkey === undefined ||
    targetKindStr === undefined
  ) {
    return null;
  }
  if (kindStr !== String(UI_RENDERER_KIND)) {
    return null;
  }
  if (!HEX64_RE.test(pubkey)) {
    return null;
  }
  if (!/^\d+$/.test(targetKindStr)) {
    return null;
  }
  const targetKind = Number(targetKindStr);
  if (!Number.isInteger(targetKind)) {
    return null;
  }
  return {
    kind: UI_RENDERER_KIND,
    pubkey,
    targetKind,
  };
}

/**
 * Build a `ui` renderer coordinate string of the form
 * `31036:<pubkey>:<targetKind>`.
 *
 * The inverse of {@link parseUiCoordinate}. Returns `null` if the inputs are
 * invalid (pubkey not 64-hex, or target kind not a non-negative integer), so
 * that `build`→`parse` round-trips cleanly.
 *
 * Pure: no IO, no relay fetch.
 *
 * @param ref - The renderer author pubkey and target kind.
 * @returns The coordinate string, or `null` if the inputs are invalid.
 */
export function buildUiCoordinate(ref: {
  pubkey: string;
  targetKind: number;
}): string | null {
  const { pubkey, targetKind } = ref;
  if (typeof pubkey !== 'string' || !HEX64_RE.test(pubkey)) {
    return null;
  }
  if (!Number.isInteger(targetKind) || targetKind < 0) {
    return null;
  }
  return `${UI_RENDERER_KIND}:${pubkey}:${targetKind}`;
}

/**
 * Read the `ui` tag value off an event and parse it into a coordinate.
 *
 * Convenience wrapper around {@link parseUiCoordinate} that pulls the first
 * `ui` tag's value from `event.tags`. Returns `null` if the event has no
 * `ui` tag or the tag value is malformed.
 *
 * Pure: no IO, no relay fetch.
 *
 * @param event - The event that may reference a renderer via a `ui` tag.
 * @returns The parsed {@link UiCoordinate}, or `null`.
 */
export function getUiCoordinate(event: NostrEvent): UiCoordinate | null {
  const value = event.tags.find((t) => t[0] === UI_TAG)?.[1];
  if (value === undefined) {
    return null;
  }
  return parseUiCoordinate(value);
}

/**
 * Select the latest addressable/replaceable event from a set of candidates
 * that share an addressable coordinate.
 *
 * Implements NIP-33 latest-wins: the event with the greatest `created_at`
 * wins. Ties on `created_at` are broken by the lexicographically lowest `id`
 * per the NIP-01 convention.
 *
 * Does not itself group by coordinate — callers pass the candidate set for a
 * single coordinate (e.g. the result of a relay query filtered by author +
 * kind + `#d`). Pure: no IO, no relay fetch.
 *
 * @param events - Candidate events sharing a coordinate.
 * @returns The latest event, or `undefined` for an empty input.
 */
export function selectLatestAddressable<T extends NostrEvent>(
  events: T[]
): T | undefined {
  let latest: T | undefined;
  for (const event of events) {
    if (latest === undefined) {
      latest = event;
      continue;
    }
    if (event.created_at > latest.created_at) {
      latest = event;
    } else if (event.created_at === latest.created_at && event.id < latest.id) {
      latest = event;
    }
  }
  return latest;
}
