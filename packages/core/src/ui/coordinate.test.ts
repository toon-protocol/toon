/**
 * Tests for pure NIP-on-TOON UI renderer resolution helpers.
 *
 * Covers:
 * - parseUiCoordinate: valid parse, malformed/empty/wrong-kind/bad-pubkey
 * - buildUiCoordinate: valid build, invalid inputs, build/parse round-trip
 * - getUiCoordinate: reads the `ui` tag off an event
 * - selectLatestAddressable: latest-wins, created_at tiebreak by id, empty
 */

import { describe, it, expect } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import {
  UI_RENDERER_KIND,
  UI_TAG,
  parseUiCoordinate,
  buildUiCoordinate,
  getUiCoordinate,
  selectLatestAddressable,
} from './coordinate.js';

// ============================================================================
// Fixtures
// ============================================================================

/** Valid 64-hex renderer author pubkey. */
const PUBKEY = 'a'.repeat(64);

/** Build a minimal NostrEvent for selection tests. */
function makeEvent(partial: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'f'.repeat(64),
    pubkey: PUBKEY,
    created_at: 1000,
    kind: UI_RENDERER_KIND,
    tags: [],
    content: '',
    sig: '0'.repeat(128),
    ...partial,
  };
}

// ============================================================================
// parseUiCoordinate
// ============================================================================

describe('parseUiCoordinate', () => {
  it('parses a valid 31036 coordinate', () => {
    const result = parseUiCoordinate(`31036:${PUBKEY}:1`);
    expect(result).toEqual({
      kind: 31036,
      pubkey: PUBKEY,
      targetKind: 1,
    });
  });

  it('parses a multi-digit target kind', () => {
    const result = parseUiCoordinate(`31036:${PUBKEY}:30023`);
    expect(result?.targetKind).toBe(30023);
  });

  it('returns null for an empty string', () => {
    expect(parseUiCoordinate('')).toBeNull();
  });

  it('returns null for the wrong leading kind', () => {
    expect(parseUiCoordinate(`30617:${PUBKEY}:1`)).toBeNull();
  });

  it('returns null for too few segments', () => {
    expect(parseUiCoordinate(`31036:${PUBKEY}`)).toBeNull();
  });

  it('returns null for too many segments', () => {
    expect(parseUiCoordinate(`31036:${PUBKEY}:1:extra`)).toBeNull();
  });

  it('returns null for a non-hex pubkey', () => {
    expect(parseUiCoordinate(`31036:${'z'.repeat(64)}:1`)).toBeNull();
  });

  it('returns null for a too-short pubkey', () => {
    expect(parseUiCoordinate(`31036:${'a'.repeat(63)}:1`)).toBeNull();
  });

  it('returns null for an uppercase pubkey', () => {
    expect(parseUiCoordinate(`31036:${'A'.repeat(64)}:1`)).toBeNull();
  });

  it('returns null for a non-numeric target kind', () => {
    expect(parseUiCoordinate(`31036:${PUBKEY}:abc`)).toBeNull();
  });

  it('returns null for an empty target kind', () => {
    expect(parseUiCoordinate(`31036:${PUBKEY}:`)).toBeNull();
  });
});

// ============================================================================
// buildUiCoordinate
// ============================================================================

describe('buildUiCoordinate', () => {
  it('builds a coordinate string', () => {
    expect(buildUiCoordinate({ pubkey: PUBKEY, targetKind: 1 })).toBe(
      `31036:${PUBKEY}:1`
    );
  });

  it('returns null for a non-hex pubkey', () => {
    expect(buildUiCoordinate({ pubkey: 'not-hex', targetKind: 1 })).toBeNull();
  });

  it('returns null for a negative target kind', () => {
    expect(buildUiCoordinate({ pubkey: PUBKEY, targetKind: -1 })).toBeNull();
  });

  it('returns null for a non-integer target kind', () => {
    expect(buildUiCoordinate({ pubkey: PUBKEY, targetKind: 1.5 })).toBeNull();
  });

  it('round-trips with parseUiCoordinate', () => {
    const coord = buildUiCoordinate({ pubkey: PUBKEY, targetKind: 30023 });
    expect(coord).not.toBeNull();
    expect(parseUiCoordinate(coord as string)).toEqual({
      kind: 31036,
      pubkey: PUBKEY,
      targetKind: 30023,
    });
  });
});

// ============================================================================
// getUiCoordinate
// ============================================================================

describe('getUiCoordinate', () => {
  it('reads and parses the ui tag value off an event', () => {
    const event = makeEvent({
      tags: [
        ['t', 'note'],
        [UI_TAG, `31036:${PUBKEY}:1`],
      ],
    });
    expect(getUiCoordinate(event)).toEqual({
      kind: 31036,
      pubkey: PUBKEY,
      targetKind: 1,
    });
  });

  it('returns null when there is no ui tag', () => {
    const event = makeEvent({ tags: [['t', 'note']] });
    expect(getUiCoordinate(event)).toBeNull();
  });

  it('returns null when the ui tag value is malformed', () => {
    const event = makeEvent({ tags: [[UI_TAG, 'garbage']] });
    expect(getUiCoordinate(event)).toBeNull();
  });
});

// ============================================================================
// selectLatestAddressable
// ============================================================================

describe('selectLatestAddressable', () => {
  it('returns undefined for an empty array', () => {
    expect(selectLatestAddressable([])).toBeUndefined();
  });

  it('returns the only event for a single-element array', () => {
    const only = makeEvent({ id: 'a'.repeat(64), created_at: 5 });
    expect(selectLatestAddressable([only])).toBe(only);
  });

  it('picks the event with the greatest created_at (latest-wins)', () => {
    const older = makeEvent({ id: 'a'.repeat(64), created_at: 100 });
    const newer = makeEvent({ id: 'b'.repeat(64), created_at: 200 });
    expect(selectLatestAddressable([older, newer])).toBe(newer);
    expect(selectLatestAddressable([newer, older])).toBe(newer);
  });

  it('breaks created_at ties by lexicographically lowest id', () => {
    const lowId = makeEvent({ id: '0'.repeat(64), created_at: 100 });
    const highId = makeEvent({ id: 'f'.repeat(64), created_at: 100 });
    expect(selectLatestAddressable([highId, lowId])).toBe(lowId);
    expect(selectLatestAddressable([lowId, highId])).toBe(lowId);
  });

  it('prefers created_at over id when both differ', () => {
    // Newer event has a higher (worse for tiebreak) id but still wins on time.
    const older = makeEvent({ id: '0'.repeat(64), created_at: 100 });
    const newer = makeEvent({ id: 'f'.repeat(64), created_at: 200 });
    expect(selectLatestAddressable([older, newer])).toBe(newer);
  });
});
