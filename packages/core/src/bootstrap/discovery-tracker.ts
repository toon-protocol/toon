/**
 * Discovery tracker for processing kind:10032 events and managing peer discovery.
 *
 * Unlike RelayMonitor, the tracker does NOT own a subscription — callers feed
 * events in via processEvent(). This enables use from any event source:
 * relay subscriptions, ILP handlers, or test harnesses.
 */

import { getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { parseIlpPeerInfo } from '../events/index.js';
import {
  negotiateSettlementChain,
  resolveTokenForChain,
} from '../settlement/index.js';
import type { ConnectorChannelClient } from '../types.js';
import { BootstrapError } from './BootstrapService.js';
import type {
  ConnectorAdminClient,
  BootstrapEvent,
  BootstrapEventListener,
  DiscoveredPeer,
  SettlementConfig,
} from './types.js';

/**
 * Configuration for creating a DiscoveryTracker.
 */
export interface DiscoveryTrackerConfig {
  /** Nostr secret key for deriving own pubkey (excluded from discovery) */
  secretKey: Uint8Array;
  /** Own settlement preferences for local chain negotiation */
  settlementInfo?: SettlementConfig;
}

/**
 * Discovery tracker interface — processes kind:10032 events and manages
 * peer discovery state without owning a subscription.
 */
export interface DiscoveryTracker {
  /** Process a kind:10032 event for discovery. Called by relay subscription or ILP handler. */
  processEvent(event: NostrEvent): void;
  /** Explicitly peer with a discovered peer (register + open channel). */
  peerWith(pubkey: string): Promise<void>;
  /** Get discovered peers not yet peered with. */
  getDiscoveredPeers(): DiscoveredPeer[];
  /** Get all discovered peers regardless of peering status (for fee calculation). */
  getAllDiscoveredPeers(): DiscoveredPeer[];
  /** Check if a pubkey has been actively peered with. */
  isPeered(pubkey: string): boolean;
  /** Count of registered (peered) peers. */
  getPeerCount(): number;
  /** Count of all discovered peers (including peered). */
  getDiscoveredCount(): number;
  /** Register an event listener. */
  on(listener: BootstrapEventListener): void;
  /** Unregister an event listener. */
  off(listener: BootstrapEventListener): void;
  /** Set connector admin for peer registration (required before peerWith). */
  setConnectorAdmin(admin: ConnectorAdminClient): void;
  /** Set channel client for payment channel opening (optional). */
  setChannelClient(client: ConnectorChannelClient): void;
  /** Mark pubkeys as already-peered (e.g., from bootstrap phase). */
  addExcludedPubkeys(pubkeys: string[]): void;
}

/**
 * Create a discovery tracker that processes kind:10032 events.
 *
 * The tracker does not own a subscription — callers feed events in via
 * processEvent(). It handles discovery, stale-event filtering,
 * deregistration, and explicit peering via peerWith().
 */
export function createDiscoveryTracker(
  config: DiscoveryTrackerConfig
): DiscoveryTracker {
  const pubkey = getPublicKey(config.secretKey);
  const excludedPubkeys = new Set<string>([pubkey]);

  let connectorAdmin: ConnectorAdminClient | undefined;
  let channelClient: ConnectorChannelClient | undefined;
  let listeners: BootstrapEventListener[] = [];

  /** Peers discovered via kind:10032 events (keyed by pubkey). */
  const discoveredPeers = new Map<string, DiscoveredPeer>();
  /** Pubkeys that have been actively peered with via peerWith(). */
  const peeredPubkeys = new Set<string>();
  /** Timestamps of the latest kind:10032 event per pubkey (stale-event filtering). */
  const peerTimestamps = new Map<string, number>();

  function emit(event: BootstrapEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break tracking
      }
    }
  }

  function handleDeregistration(peerPubkey: string, peerId: string): void {
    discoveredPeers.delete(peerPubkey);

    if (peeredPubkeys.has(peerPubkey)) {
      peeredPubkeys.delete(peerPubkey);

      if (connectorAdmin?.removePeer) {
        connectorAdmin
          .removePeer(peerId)
          .then(() => {
            emit({
              type: 'bootstrap:peer-deregistered',
              peerId,
              peerPubkey,
              reason: 'empty-content',
            });
          })
          .catch((error) => {
            console.warn(
              '[DiscoveryTracker] Failed to deregister %s: %s',
              peerId,
              error instanceof Error ? error.message : 'Unknown error'
            );
          });
      } else {
        emit({
          type: 'bootstrap:peer-deregistered',
          peerId,
          peerPubkey,
          reason: 'empty-content',
        });
      }
    }
  }

  function processDiscovery(event: NostrEvent): void {
    const peerId = `nostr-${event.pubkey.slice(0, 16)}`;

    let peerInfo;
    try {
      peerInfo = parseIlpPeerInfo(event);
    } catch {
      // Parse failure — treat as empty content
    }

    // Deregistration: empty content or missing ilpAddress
    if (
      !peerInfo ||
      !peerInfo.ilpAddress ||
      !event.content ||
      event.content.trim() === ''
    ) {
      handleDeregistration(event.pubkey, peerId);
      return;
    }

    // Track discovered peer (update if already known — newer timestamp)
    discoveredPeers.set(event.pubkey, {
      pubkey: event.pubkey,
      peerId,
      peerInfo,
      discoveredAt: event.created_at,
    });

    emit({
      type: 'bootstrap:peer-discovered',
      peerPubkey: event.pubkey,
      ilpAddress: peerInfo.ilpAddress,
    });
  }

  const tracker: DiscoveryTracker = {
    processEvent(event: NostrEvent): void {
      // Only process kind:10032 events
      if (event.kind !== ILP_PEER_INFO_KIND) return;

      // Exclude own pubkey and specified pubkeys
      if (excludedPubkeys.has(event.pubkey)) return;

      // Replaceable event semantics: skip stale events
      const lastSeen = peerTimestamps.get(event.pubkey) ?? 0;
      if (event.created_at <= lastSeen) return;
      peerTimestamps.set(event.pubkey, event.created_at);

      processDiscovery(event);
    },

    async peerWith(targetPubkey: string): Promise<void> {
      // Idempotent: skip if already peered
      if (peeredPubkeys.has(targetPubkey)) {
        return;
      }

      const discovered = discoveredPeers.get(targetPubkey);
      if (!discovered) {
        throw new BootstrapError(
          `Peer ${targetPubkey.slice(0, 16)}... not discovered yet`
        );
      }

      if (!connectorAdmin) {
        throw new BootstrapError(
          'connectorAdmin must be set before calling peerWith()'
        );
      }

      const { peerId, peerInfo } = discovered;
      const admin = connectorAdmin;

      // Mark as peered immediately to prevent concurrent peerWith() calls
      // from double-registering the same peer.
      peeredPubkeys.add(targetPubkey);

      // Register peer via connector admin
      try {
        await admin.addPeer({
          id: peerId,
          url: peerInfo.btpEndpoint,
          authToken: '',
          routes: [{ prefix: peerInfo.ilpAddress }],
        });

        emit({
          type: 'bootstrap:peer-registered',
          peerId,
          peerPubkey: targetPubkey,
          ilpAddress: peerInfo.ilpAddress,
        });
      } catch (error) {
        // Rollback peered state on registration failure
        peeredPubkeys.delete(targetPubkey);
        const reason = error instanceof Error ? error.message : 'Unknown error';
        console.warn(
          '[DiscoveryTracker] Failed to register %s: %s',
          peerId,
          reason
        );
        emit({
          type: 'bootstrap:settlement-failed',
          peerId,
          reason: `Registration failed: ${reason}`,
        });
        return;
      }

      // Local chain selection + unilateral channel opening
      if (
        channelClient &&
        config.settlementInfo?.supportedChains?.length &&
        peerInfo.supportedChains?.length &&
        peerInfo.settlementAddresses
      ) {
        try {
          const negotiatedChain = negotiateSettlementChain(
            config.settlementInfo.supportedChains,
            peerInfo.supportedChains,
            config.settlementInfo.preferredTokens,
            peerInfo.preferredTokens
          );

          if (negotiatedChain) {
            const peerAddress = peerInfo.settlementAddresses[negotiatedChain];
            const tokenAddress = resolveTokenForChain(
              negotiatedChain,
              config.settlementInfo.preferredTokens,
              peerInfo.preferredTokens
            );
            const tokenNetwork = peerInfo.tokenNetworks?.[negotiatedChain];

            if (peerAddress) {
              const channelResult = await channelClient.openChannel({
                peerId,
                chain: negotiatedChain,
                token: tokenAddress,
                tokenNetwork,
                peerAddress,
                initialDeposit: '100000',
                settlementTimeout: 86400,
              });

              // Update registration with settlement info
              await admin.addPeer({
                id: peerId,
                url: peerInfo.btpEndpoint,
                authToken: '',
                routes: [{ prefix: peerInfo.ilpAddress }],
                settlement: {
                  preference: negotiatedChain,
                  ...(peerAddress && { evmAddress: peerAddress }),
                  ...(tokenAddress && { tokenAddress }),
                  ...(tokenNetwork && {
                    tokenNetworkAddress: tokenNetwork,
                  }),
                  ...(channelResult.channelId && {
                    channelId: channelResult.channelId,
                  }),
                },
              });

              emit({
                type: 'bootstrap:channel-opened',
                peerId,
                channelId: channelResult.channelId,
                negotiatedChain,
              });
            }
          }
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : 'Unknown error';
          console.warn(
            '[DiscoveryTracker] Settlement failed for %s: %s',
            peerId,
            reason
          );
          emit({
            type: 'bootstrap:settlement-failed',
            peerId,
            reason,
          });
          // Non-fatal: peer remains registered
        }
      }
    },

    getDiscoveredPeers(): DiscoveredPeer[] {
      return [...discoveredPeers.values()].filter(
        (p) => !peeredPubkeys.has(p.pubkey)
      );
    },

    getAllDiscoveredPeers(): DiscoveredPeer[] {
      return [...discoveredPeers.values()];
    },

    isPeered(targetPubkey: string): boolean {
      return peeredPubkeys.has(targetPubkey);
    },

    getPeerCount(): number {
      return peeredPubkeys.size;
    },

    getDiscoveredCount(): number {
      return discoveredPeers.size;
    },

    on(listener: BootstrapEventListener): void {
      listeners.push(listener);
    },

    off(listener: BootstrapEventListener): void {
      listeners = listeners.filter((l) => l !== listener);
    },

    setConnectorAdmin(admin: ConnectorAdminClient): void {
      connectorAdmin = admin;
    },

    setChannelClient(client: ConnectorChannelClient): void {
      channelClient = client;
    },

    addExcludedPubkeys(pubkeys: string[]): void {
      for (const pk of pubkeys) {
        excludedPubkeys.add(pk);
      }
    },
  };

  return tracker;
}
