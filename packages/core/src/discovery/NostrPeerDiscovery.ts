/**
 * Peer discovery using Nostr NIP-02 follow lists.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import { PeerDiscoveryError } from '../errors.js';
import { parseIlpPeerInfo } from '../events/index.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import type { IlpPeerInfo, Subscription } from '../types.js';

/** Regular expression for validating 64-character lowercase hex pubkeys */
const PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/**
 * Discovers ILP peers by querying Nostr relays for NIP-02 follow lists.
 */
export class NostrPeerDiscovery {
  private readonly relayUrls: string[];
  private readonly pool: SimplePool;

  /**
   * Creates a new NostrPeerDiscovery instance.
   *
   * @param relayUrls - Array of relay WebSocket URLs to query
   * @param pool - Optional SimplePool instance (creates new one if not provided)
   */
  constructor(relayUrls: string[], pool?: SimplePool) {
    this.relayUrls = relayUrls;
    this.pool = pool ?? new SimplePool();
  }

  /**
   * Retrieves the list of pubkeys that a given pubkey follows.
   *
   * Queries NIP-02 kind:3 events from configured relays and returns
   * the followed pubkeys from the most recent event.
   *
   * @param pubkey - The 64-character hex pubkey to get follows for
   * @returns Array of followed pubkeys (deduplicated)
   * @throws PeerDiscoveryError if pubkey format is invalid
   */
  async getFollows(pubkey: string): Promise<string[]> {
    if (!PUBKEY_REGEX.test(pubkey)) {
      throw new PeerDiscoveryError(
        `Invalid pubkey format: must be 64-character lowercase hex string`
      );
    }

    const filter: Filter = {
      kinds: [3],
      authors: [pubkey],
      limit: 1,
    };

    try {
      const events = await this.pool.querySync(this.relayUrls, filter);

      if (events.length === 0) {
        return [];
      }

      // Sort by created_at descending and use the most recent
      const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
      const mostRecent = sortedEvents[0];

      // This should never happen since we check length above, but TypeScript needs it
      if (!mostRecent) {
        return [];
      }

      // Extract pubkeys from 'p' tags and deduplicate
      const pubkeys = mostRecent.tags
        .filter((tag): tag is [string, string, ...string[]] => tag[0] === 'p' && typeof tag[1] === 'string')
        .map((tag) => tag[1]);

      return [...new Set(pubkeys)];
    } catch (error) {
      // querySync handles individual relay failures internally
      // If we get here, something else went wrong
      throw new PeerDiscoveryError(
        'Failed to query relays for follow list',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Discovers ILP peers by querying follow list and their ILP peer info events.
   *
   * For each followed pubkey, queries kind:10032 events to retrieve ILP connection info.
   * Peers without kind:10032 events or with malformed events are silently excluded.
   *
   * @param pubkey - The 64-character hex pubkey to discover peers for
   * @returns Map of pubkey → IlpPeerInfo for peers with valid ILP info
   * @throws PeerDiscoveryError if pubkey format is invalid
   */
  async discoverPeers(pubkey: string): Promise<Map<string, IlpPeerInfo>> {
    if (!PUBKEY_REGEX.test(pubkey)) {
      throw new PeerDiscoveryError(
        `Invalid pubkey format: must be 64-character lowercase hex string`
      );
    }

    // Get list of followed pubkeys
    const follows = await this.getFollows(pubkey);

    // Return empty map if no follows
    if (follows.length === 0) {
      return new Map();
    }

    // Query kind:10032 events for all followed pubkeys in a single request
    const filter: Filter = {
      kinds: [ILP_PEER_INFO_KIND],
      authors: follows,
    };

    const events = await this.pool.querySync(this.relayUrls, filter);

    // Group events by pubkey, keeping only the most recent for each (replaceable event semantics)
    const eventsByPubkey = new Map<string, (typeof events)[0]>();
    for (const event of events) {
      const existing = eventsByPubkey.get(event.pubkey);
      if (!existing || event.created_at > existing.created_at) {
        eventsByPubkey.set(event.pubkey, event);
      }
    }

    // Parse events and build result map, silently skipping parse failures
    const result = new Map<string, IlpPeerInfo>();
    for (const [peerPubkey, event] of eventsByPubkey) {
      try {
        const info = parseIlpPeerInfo(event);
        result.set(peerPubkey, info);
      } catch {
        // Silently skip events that fail to parse (AC: 4)
      }
    }

    return result;
  }

  /**
   * Subscribes to ILP peer info updates from followed pubkeys.
   *
   * Sets up a real-time subscription for kind:10032 events from all pubkeys
   * that the given pubkey follows. The callback is invoked whenever a new
   * or updated ILP peer info event is received.
   *
   * @param pubkey - The 64-character hex pubkey whose follows to monitor
   * @param callback - Function called with (peerPubkey, parsedInfo) for each update
   * @returns Subscription object with unsubscribe() method
   * @throws PeerDiscoveryError if pubkey format is invalid
   */
  async subscribeToPeerUpdates(
    pubkey: string,
    callback: (pubkey: string, info: IlpPeerInfo) => void
  ): Promise<Subscription> {
    if (!PUBKEY_REGEX.test(pubkey)) {
      throw new PeerDiscoveryError(
        `Invalid pubkey format: must be 64-character lowercase hex string`
      );
    }

    // Get list of followed pubkeys at subscription time
    const follows = await this.getFollows(pubkey);

    // Return no-op subscription for empty follow list
    if (follows.length === 0) {
      return {
        unsubscribe: () => {
          // No-op for empty follow list
        },
      };
    }

    // Per-subscription tracking of latest event timestamps (replaceable event semantics)
    const peerTimestamps = new Map<string, number>();

    // Track subscription state to prevent double-unsubscribe
    let isUnsubscribed = false;

    // Set up subscription for kind:10032 events from followed pubkeys
    const filter = {
      kinds: [ILP_PEER_INFO_KIND],
      authors: follows,
    };

    const subCloser = this.pool.subscribeMany(this.relayUrls, filter, {
      onevent: (event) => {
        // Skip if already unsubscribed
        if (isUnsubscribed) return;

        // Check replaceable event timestamp
        const lastSeen = peerTimestamps.get(event.pubkey) ?? 0;
        if (event.created_at <= lastSeen) {
          // Stale event, skip
          return;
        }
        peerTimestamps.set(event.pubkey, event.created_at);

        // Try to parse and invoke callback
        try {
          const info = parseIlpPeerInfo(event);
          callback(event.pubkey, info);
        } catch {
          // Silently skip malformed events
        }
      },
    });

    return {
      unsubscribe: () => {
        if (!isUnsubscribed) {
          isUnsubscribed = true;
          subCloser.close();
        }
      },
    };
  }
}
