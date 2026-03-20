/**
 * Event builder and parser for kind:10036 Seed Relay List events.
 *
 * Kind 10036 is a NIP-16 replaceable event (kind 10000-19999) published to
 * public Nostr relays. Relays store only the latest event per `pubkey + kind`.
 * The `d` tag with value `toon-seed-list` is included as a content marker
 * for filtering.
 *
 * Seed relay list events advertise relay nodes that can serve as bootstrap
 * entry points for new network participants.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { SEED_RELAY_LIST_KIND } from '../constants.js';

// ---------- Types ----------

/** Content payload for a kind:10036 Seed Relay List event. */
export interface SeedRelayEntry {
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- JSDoc documents that dev mode uses ws:// (intentional)
  /** WebSocket URL of the relay (wss:// for production, ws:// for dev). */
  url: string;
  /** Nostr pubkey of the relay operator (64-char lowercase hex). */
  pubkey: string;
  /** Optional metadata. */
  metadata?: {
    region?: string;
    version?: string;
    services?: string[];
  };
}

// ---------- Validation Helpers ----------

/** Regex for valid 64-char lowercase hex pubkey. */
const PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/**
 * Validates that a URL has a WebSocket scheme prefix.
 */
function isValidWsUrl(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- validation check, not a connection
    (url.startsWith('ws://') || url.startsWith('wss://'))
  );
}

/**
 * Validates that a pubkey is a 64-char lowercase hex string.
 */
function isValidPubkey(pubkey: unknown): pubkey is string {
  return typeof pubkey === 'string' && PUBKEY_REGEX.test(pubkey);
}

// ---------- Builder ----------

/**
 * Builds a kind:10036 Seed Relay List event (NIP-16 replaceable).
 * Uses 'd' tag with value 'toon-seed-list' for replaceable event pattern.
 *
 * @param secretKey - The secret key to sign the event with.
 * @param entries - The seed relay entries to include.
 * @returns A signed Nostr event.
 */
export function buildSeedRelayListEvent(
  secretKey: Uint8Array,
  entries: SeedRelayEntry[]
): NostrEvent {
  return finalizeEvent(
    {
      kind: SEED_RELAY_LIST_KIND,
      content: JSON.stringify(entries),
      tags: [['d', 'toon-seed-list']],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

// ---------- Parser ----------

/**
 * Parses a kind:10036 event content into SeedRelayEntry[].
 * Validates URLs (WebSocket scheme prefix) and pubkeys (64-char hex).
 * Malformed entries are silently skipped (graceful degradation).
 *
 * @param event - The Nostr event to parse.
 * @returns An array of valid SeedRelayEntry objects.
 */
export function parseSeedRelayList(event: NostrEvent): SeedRelayEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const results: SeedRelayEntry[] = [];

  for (const item of parsed) {
    // Skip non-object entries
    if (typeof item !== 'object' || item === null) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const url = record['url'];
    const pubkey = record['pubkey'];

    // Validate required fields
    if (!isValidWsUrl(url)) {
      continue;
    }
    if (!isValidPubkey(pubkey)) {
      continue;
    }

    const entry: SeedRelayEntry = { url, pubkey };

    // Preserve metadata if present
    const metadata = record['metadata'];
    if (typeof metadata === 'object' && metadata !== null) {
      const meta = metadata as Record<string, unknown>;
      const entryMeta: SeedRelayEntry['metadata'] = {};
      if (typeof meta['region'] === 'string') {
        entryMeta.region = meta['region'];
      }
      if (typeof meta['version'] === 'string') {
        entryMeta.version = meta['version'];
      }
      if (Array.isArray(meta['services'])) {
        entryMeta.services = (meta['services'] as unknown[]).filter(
          (s): s is string => typeof s === 'string'
        );
      }
      if (Object.keys(entryMeta).length > 0) {
        entry.metadata = entryMeta;
      }
    }

    results.push(entry);
  }

  return results;
}
