/**
 * Social graph-based peer discovery with active peering.
 *
 * Subscribes to NIP-02 follow list changes and automatically
 * negotiates peering via SPSP handshake + connector admin API.
 */

import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { PeerDiscoveryError } from '../errors.js';
import { parseIlpPeerInfo } from '../events/index.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { NostrSpspClient } from '../spsp/index.js';
import type { IlpPeerInfo, Subscription } from '../types.js';
import type { ConnectorAdminClient } from '../bootstrap.js';

/**
 * Configuration for SocialPeerDiscovery.
 */
export interface SocialPeerDiscoveryConfig {
  /** Relays to subscribe to for kind:3 events */
  relayUrls: string[];
  /** Minimum delay between peer processing attempts in ms (default: 5000) */
  cooldownMs?: number;
  /** Timeout for SPSP handshake in ms (default: 10000) */
  spspTimeout?: number;
  /** Whether to remove peers on unfollow (default: false) */
  removePeersOnUnfollow?: boolean;
}

/**
 * Real-time social graph peer discovery with active peering.
 *
 * Subscribes to NIP-02 kind:3 follow list events and automatically:
 * 1. Queries kind:10032 for new follows' ILP info
 * 2. Performs SPSP handshake as a liveness check
 * 3. Registers peer via connector admin API
 * 4. Optionally removes peers on unfollow
 */
export class SocialPeerDiscovery {
  private readonly config: Required<SocialPeerDiscoveryConfig>;
  private readonly secretKey: Uint8Array;
  private readonly pubkey: string;
  private readonly pool: SimplePool;
  private readonly spspClient: NostrSpspClient;
  private connectorAdmin?: ConnectorAdminClient;
  private readonly peeredPubkeys = new Set<string>();
  private previousFollows = new Set<string>();
  private started = false;

  /**
   * Creates a new SocialPeerDiscovery instance.
   *
   * @param config - Discovery configuration
   * @param secretKey - Our Nostr secret key for signing events
   * @param _ownIlpInfo - Our ILP peer info (reserved for future use)
   * @param pool - Optional SimplePool instance (creates new one if not provided)
   * @param spspClient - Optional NostrSpspClient instance (creates new one if not provided)
   */
  constructor(
    config: SocialPeerDiscoveryConfig,
    secretKey: Uint8Array,
    _ownIlpInfo: IlpPeerInfo,
    pool?: SimplePool,
    spspClient?: NostrSpspClient
  ) {
    this.config = {
      relayUrls: config.relayUrls,
      cooldownMs: config.cooldownMs ?? 5000,
      spspTimeout: config.spspTimeout ?? 10000,
      removePeersOnUnfollow: config.removePeersOnUnfollow ?? false,
    };
    this.secretKey = secretKey;
    this.pubkey = getPublicKey(secretKey);
    this.pool = pool ?? new SimplePool();
    this.spspClient = spspClient ?? new NostrSpspClient(
      config.relayUrls,
      this.pool,
      secretKey
    );
  }

  /**
   * Set the connector admin client for adding/removing peers.
   */
  setConnectorAdmin(admin: ConnectorAdminClient): void {
    this.connectorAdmin = admin;
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
      [{ kinds: [3], authors: [this.pubkey] }],
      {
        onevent: (event) => {
          const followedPubkeys = event.tags
            .filter(
              (tag): tag is [string, string, ...string[]] =>
                tag[0] === 'p' && typeof tag[1] === 'string'
            )
            .map((tag) => tag[1]);

          // Fire and forget — errors handled internally
          this.processFollowListUpdate(followedPubkeys).catch((err) => {
            console.warn(
              '[SocialDiscovery] Error processing follow list update:',
              err instanceof Error ? err.message : 'Unknown error'
            );
          });
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
  private async processFollowListUpdate(
    followedPubkeys: string[]
  ): Promise<void> {
    const currentFollows = new Set(followedPubkeys);

    // Compute new follows (not previously followed and not already peered)
    const newFollows: string[] = [];
    for (const pubkey of currentFollows) {
      if (!this.previousFollows.has(pubkey) && !this.peeredPubkeys.has(pubkey)) {
        newFollows.push(pubkey);
      }
    }

    // Compute unfollows (previously followed but not in current list)
    const unfollows: string[] = [];
    for (const pubkey of this.previousFollows) {
      if (!currentFollows.has(pubkey)) {
        unfollows.push(pubkey);
      }
    }

    // Update previous follows to current
    this.previousFollows = currentFollows;

    // Process new follows with cooldown between each
    for (let i = 0; i < newFollows.length; i++) {
      const pubkey = newFollows[i];
      if (pubkey) await this.handleNewFollow(pubkey);
      if (i < newFollows.length - 1) {
        await this.sleep(this.config.cooldownMs);
      }
    }

    // Process unfollows if enabled
    if (this.config.removePeersOnUnfollow) {
      for (const pubkey of unfollows) {
        await this.handleUnfollow(pubkey);
      }
    }
  }

  /**
   * Handle a new follow: query kind:10032, SPSP handshake, register peer.
   */
  private async handleNewFollow(pubkey: string): Promise<void> {
    try {
      // Query kind:10032 for the new follow's ILP peer info
      const events = await this.pool.querySync(this.config.relayUrls, {
        kinds: [ILP_PEER_INFO_KIND],
        authors: [pubkey],
        limit: 1,
      });

      if (events.length === 0) {
        console.warn(
          `[SocialDiscovery] No kind:10032 found for ${pubkey.slice(0, 16)}..., skipping`
        );
        return;
      }

      // Use the most recent event
      const sortedEvents = events.sort(
        (a, b) => b.created_at - a.created_at
      );
      const mostRecent = sortedEvents[0];
      if (!mostRecent) return;
      const peerInfo = parseIlpPeerInfo(mostRecent);

      // Perform SPSP handshake as liveness check
      await this.spspClient.requestSpspInfo(pubkey, {
        timeout: this.config.spspTimeout,
      });

      // Register peer via connector admin API
      if (this.connectorAdmin) {
        const peerId = `nostr-${pubkey.slice(0, 16)}`;
        await this.connectorAdmin.addPeer({
          id: peerId,
          url: peerInfo.btpEndpoint,
          authToken: '',
          routes: [{ prefix: peerInfo.ilpAddress }],
        });
      }

      // Mark as peered
      this.peeredPubkeys.add(pubkey);
      console.log(
        `[SocialDiscovery] Peered with ${pubkey.slice(0, 16)}...`
      );
    } catch (error) {
      console.warn(
        `[SocialDiscovery] Failed to peer with ${pubkey.slice(0, 16)}...:`,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Handle an unfollow: remove peer from connector.
   */
  private async handleUnfollow(pubkey: string): Promise<void> {
    try {
      const peerId = `nostr-${pubkey.slice(0, 16)}`;

      if (this.connectorAdmin?.removePeer) {
        await this.connectorAdmin.removePeer(peerId);
      }

      this.peeredPubkeys.delete(pubkey);
      console.log(
        `[SocialDiscovery] Removed peer ${pubkey.slice(0, 16)}...`
      );
    } catch (error) {
      console.warn(
        `[SocialDiscovery] Failed to remove peer ${pubkey.slice(0, 16)}...:`,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Sleep for a given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
