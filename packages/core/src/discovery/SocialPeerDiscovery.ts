/**
 * Social graph-based peer discovery (passive).
 *
 * Subscribes to NIP-02 follow list changes and emits events
 * for new follows and unfollows. Does NOT auto-peer — the caller
 * decides when and whether to initiate peering.
 */

import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { PeerDiscoveryError } from '../errors.js';
import type { Subscription } from '../types.js';

/**
 * Events emitted by SocialPeerDiscovery.
 */
export type SocialDiscoveryEvent =
  | { type: 'social:follow-discovered'; pubkey: string }
  | { type: 'social:follow-removed'; pubkey: string };

/**
 * Listener callback for social discovery events.
 */
export type SocialDiscoveryEventListener = (event: SocialDiscoveryEvent) => void;

/**
 * Configuration for SocialPeerDiscovery.
 */
export interface SocialPeerDiscoveryConfig {
  /** Relays to subscribe to for kind:3 events */
  relayUrls: string[];
}

/**
 * Passive social graph peer discovery.
 *
 * Subscribes to NIP-02 kind:3 follow list events and emits:
 * - `social:follow-discovered` when a new pubkey appears in the follow list
 * - `social:follow-removed` when a pubkey disappears from the follow list
 *
 * The caller decides when to peer via `on()` listener.
 */
export class SocialPeerDiscovery {
  private readonly config: SocialPeerDiscoveryConfig;
  private readonly pubkey: string;
  private readonly pool: SimplePool;
  private readonly listeners: SocialDiscoveryEventListener[] = [];
  private previousFollows = new Set<string>();
  private started = false;

  /**
   * Creates a new SocialPeerDiscovery instance.
   *
   * @param config - Discovery configuration
   * @param secretKey - Our Nostr secret key (used to derive pubkey)
   * @param pool - Optional SimplePool instance (creates new one if not provided)
   */
  constructor(
    config: SocialPeerDiscoveryConfig,
    secretKey: Uint8Array,
    pool?: SimplePool
  ) {
    this.config = config;
    this.pubkey = getPublicKey(secretKey);
    this.pool = pool ?? new SimplePool();
  }

  /**
   * Register a listener for social discovery events.
   */
  on(listener: SocialDiscoveryEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove a previously registered listener.
   */
  off(listener: SocialDiscoveryEventListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) {
      this.listeners.splice(idx, 1);
    }
  }

  /**
   * Start subscribing to kind:3 follow list events for the node's pubkey.
   *
   * @returns Subscription with unsubscribe() to stop discovery
   * @throws PeerDiscoveryError if already started
   */
  start(): Subscription {
    if (this.started) {
      throw new PeerDiscoveryError('SocialPeerDiscovery already started');
    }
    this.started = true;

    const subCloser = this.pool.subscribeMany(
      this.config.relayUrls,
      { kinds: [3], authors: [this.pubkey] },
      {
        onevent: (event) => {
          const followedPubkeys = event.tags
            .filter(
              (tag): tag is [string, string, ...string[]] =>
                tag[0] === 'p' && typeof tag[1] === 'string'
            )
            .map((tag) => tag[1]);

          this.processFollowListUpdate(followedPubkeys);
        },
      }
    );

    return {
      unsubscribe: () => {
        subCloser.close();
        this.started = false;
      },
    };
  }

  /**
   * Process a follow list update by diffing against previous state.
   */
  private processFollowListUpdate(followedPubkeys: string[]): void {
    const currentFollows = new Set(followedPubkeys);

    // Emit events for new follows
    for (const pubkey of currentFollows) {
      if (!this.previousFollows.has(pubkey)) {
        this.emit({ type: 'social:follow-discovered', pubkey });
      }
    }

    // Emit events for unfollows
    for (const pubkey of this.previousFollows) {
      if (!currentFollows.has(pubkey)) {
        this.emit({ type: 'social:follow-removed', pubkey });
      }
    }

    // Update previous follows to current
    this.previousFollows = currentFollows;
  }

  /**
   * Emit an event to all registered listeners.
   */
  private emit(event: SocialDiscoveryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn(
          '[SocialDiscovery] Listener error:',
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }
  }
}
