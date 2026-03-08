/**
 * Relay monitor for discovering new peers via kind:10032 subscription.
 *
 * Discovery is passive (automatic via start()) -- peers are tracked but no
 * registration or channel opening occurs until peerWith() is called explicitly.
 */

import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { parseIlpPeerInfo } from '../events/index.js';
import {
  negotiateSettlementChain,
  resolveTokenForChain,
} from '../settlement/index.js';
import type { Subscription, ConnectorChannelClient } from '../types.js';
import { BootstrapError } from './BootstrapService.js';
import type {
  RelayMonitorConfig,
  ConnectorAdminClient,
  AgentRuntimeClient,
  BootstrapEvent,
  BootstrapEventListener,
  DiscoveredPeer,
} from './types.js';

/**
 * Monitors a relay for new kind:10032 events. Discovery is passive --
 * peering (registration + channel opening) is triggered explicitly via peerWith().
 */
export class RelayMonitor {
  private readonly config: RelayMonitorConfig;
  private readonly pubkey: string;
  private readonly pool: SimplePool;
  private readonly basePricePerByte: bigint;
  private readonly defaultTimeout: number;

  private connectorAdmin?: ConnectorAdminClient;
  private agentRuntimeClient?: AgentRuntimeClient;
  private channelClient?: ConnectorChannelClient;
  private listeners: BootstrapEventListener[] = [];

  /** Peers discovered via kind:10032 events (keyed by pubkey). */
  private readonly discoveredPeers = new Map<string, DiscoveredPeer>();
  /** Pubkeys that have been actively peered with via peerWith(). */
  private readonly peeredPubkeys = new Set<string>();
  /** Timestamps of the latest kind:10032 event per pubkey (for stale-event filtering). */
  private readonly peerTimestamps = new Map<string, number>();

  constructor(config: RelayMonitorConfig, pool?: SimplePool) {
    this.config = config;
    this.pubkey = getPublicKey(config.secretKey);
    this.pool = pool ?? new SimplePool();
    this.basePricePerByte = config.basePricePerByte ?? 10n;
    this.defaultTimeout = config.defaultTimeout ?? 30000;
  }

  /**
   * Set the connector admin client for peer registration.
   */
  setConnectorAdmin(admin: ConnectorAdminClient): void {
    this.connectorAdmin = admin;
  }

  /**
   * Set the agent-runtime client for sending ILP packets.
   */
  setAgentRuntimeClient(client: AgentRuntimeClient): void {
    this.agentRuntimeClient = client;
  }

  /**
   * Set the channel client for opening payment channels.
   */
  setChannelClient(client: ConnectorChannelClient): void {
    this.channelClient = client;
  }

  /**
   * Register an event listener.
   */
  on(listener: BootstrapEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Unregister an event listener.
   */
  off(listener: BootstrapEventListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /**
   * Emit a bootstrap event to all listeners.
   */
  private emit(event: BootstrapEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break monitoring
      }
    }
  }

  /**
   * Start monitoring the relay for kind:10032 events (discovery only).
   *
   * Unlike the previous version, this does NOT require connectorAdmin or
   * agentRuntimeClient -- it only discovers peers passively. Use peerWith()
   * to initiate registration and channel opening.
   *
   * @param excludePubkeys - Pubkeys to exclude (e.g., already-bootstrapped peers)
   * @returns Subscription handle for stopping the monitor
   */
  start(excludePubkeys: string[] = []): Subscription {
    const excludeSet = new Set([this.pubkey, ...excludePubkeys]);
    let isUnsubscribed = false;

    const filter = {
      kinds: [ILP_PEER_INFO_KIND],
    };

    const subCloser = this.pool.subscribeMany([this.config.relayUrl], filter, {
      onevent: (event) => {
        if (isUnsubscribed) return;

        // Exclude own pubkey and specified pubkeys
        if (excludeSet.has(event.pubkey)) return;

        // Replaceable event semantics: skip stale events
        const lastSeen = this.peerTimestamps.get(event.pubkey) ?? 0;
        if (event.created_at <= lastSeen) return;
        this.peerTimestamps.set(event.pubkey, event.created_at);

        // Process discovery synchronously
        this.processDiscovery(event);
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

  /**
   * Process a kind:10032 event for discovery: parse, track, emit.
   * Handles deregistration for empty/malformed content.
   */
  private processDiscovery(event: NostrEvent): void {
    const peerId = `nostr-${event.pubkey.slice(0, 16)}`;

    // Try to parse peer info; empty/malformed content means deregistration
    let peerInfo;
    try {
      peerInfo = parseIlpPeerInfo(event);
    } catch {
      // Parse failure -- treat as empty content
    }

    // Deregistration: empty content or missing ilpAddress (AC 7)
    if (
      !peerInfo ||
      !peerInfo.ilpAddress ||
      !event.content ||
      event.content.trim() === ''
    ) {
      this.handleDeregistration(event.pubkey, peerId);
      return;
    }

    // Track discovered peer (update if already known -- newer timestamp)
    this.discoveredPeers.set(event.pubkey, {
      pubkey: event.pubkey,
      peerId,
      peerInfo,
      discoveredAt: event.created_at,
    });

    // Emit discovery event
    this.emit({
      type: 'bootstrap:peer-discovered',
      peerPubkey: event.pubkey,
      ilpAddress: peerInfo.ilpAddress,
    });
  }

  /**
   * Handle deregistration for a peer that published empty content.
   * If the peer was previously peered with, removes them from the connector.
   */
  private handleDeregistration(pubkey: string, peerId: string): void {
    // Remove from discovered peers
    this.discoveredPeers.delete(pubkey);

    if (this.peeredPubkeys.has(pubkey)) {
      this.peeredPubkeys.delete(pubkey);

      if (this.connectorAdmin?.removePeer) {
        this.connectorAdmin.removePeer(peerId).catch((error) => {
          console.warn(
            `[RelayMonitor] Failed to deregister ${peerId}:`,
            error instanceof Error ? error.message : 'Unknown error'
          );
        });
      }

      this.emit({
        type: 'bootstrap:peer-deregistered',
        peerId,
        peerPubkey: pubkey,
        reason: 'empty-content',
      });
    }
  }

  /**
   * Explicitly peer with a discovered peer: register via connector admin
   * and open a payment channel unilaterally using kind:10032 settlement data.
   *
   * @param pubkey - Nostr pubkey of a previously discovered peer
   * @throws BootstrapError if peer not discovered, or admin/runtime not set
   */
  async peerWith(pubkey: string): Promise<void> {
    // Idempotent: skip if already peered
    if (this.peeredPubkeys.has(pubkey)) {
      return;
    }

    const discovered = this.discoveredPeers.get(pubkey);
    if (!discovered) {
      throw new BootstrapError(
        `Peer ${pubkey.slice(0, 16)}... not discovered yet`
      );
    }

    if (!this.connectorAdmin) {
      throw new BootstrapError(
        'connectorAdmin must be set before calling peerWith()'
      );
    }
    if (!this.agentRuntimeClient) {
      throw new BootstrapError(
        'agentRuntimeClient must be set before calling peerWith()'
      );
    }

    const { peerId, peerInfo } = discovered;
    const connectorAdmin = this.connectorAdmin;

    // Register peer via connector admin
    try {
      await connectorAdmin.addPeer({
        id: peerId,
        url: peerInfo.btpEndpoint,
        authToken: '',
        routes: [{ prefix: peerInfo.ilpAddress }],
      });

      this.peeredPubkeys.add(pubkey);

      this.emit({
        type: 'bootstrap:peer-registered',
        peerId,
        peerPubkey: pubkey,
        ilpAddress: peerInfo.ilpAddress,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`[RelayMonitor] Failed to register ${peerId}:`, reason);
      this.emit({
        type: 'bootstrap:settlement-failed',
        peerId,
        reason: `Registration failed: ${reason}`,
      });
      return;
    }

    // Local chain selection + unilateral channel opening
    if (
      this.channelClient &&
      this.config.settlementInfo?.supportedChains?.length &&
      peerInfo.supportedChains?.length &&
      peerInfo.settlementAddresses
    ) {
      try {
        const negotiatedChain = negotiateSettlementChain(
          this.config.settlementInfo.supportedChains,
          peerInfo.supportedChains,
          this.config.settlementInfo.preferredTokens,
          peerInfo.preferredTokens
        );

        if (negotiatedChain) {
          const peerAddress = peerInfo.settlementAddresses[negotiatedChain];
          const tokenAddress = resolveTokenForChain(
            negotiatedChain,
            this.config.settlementInfo.preferredTokens,
            peerInfo.preferredTokens
          );
          const tokenNetwork = peerInfo.tokenNetworks?.[negotiatedChain];

          if (peerAddress) {
            const channelResult = await this.channelClient.openChannel({
              peerId,
              chain: negotiatedChain,
              token: tokenAddress,
              tokenNetwork,
              peerAddress,
              initialDeposit: '100000',
              settlementTimeout: 86400,
            });

            // Update registration with settlement info
            await connectorAdmin.addPeer({
              id: peerId,
              url: peerInfo.btpEndpoint,
              authToken: '',
              routes: [{ prefix: peerInfo.ilpAddress }],
              settlement: {
                preference: negotiatedChain,
                ...(peerAddress && { evmAddress: peerAddress }),
                ...(tokenAddress && { tokenAddress }),
                ...(tokenNetwork && { tokenNetworkAddress: tokenNetwork }),
                ...(channelResult.channelId && {
                  channelId: channelResult.channelId,
                }),
              },
            });

            this.emit({
              type: 'bootstrap:channel-opened',
              peerId,
              channelId: channelResult.channelId,
              negotiatedChain,
            });
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        console.warn(`[RelayMonitor] Settlement failed for ${peerId}:`, reason);
        this.emit({
          type: 'bootstrap:settlement-failed',
          peerId,
          reason,
        });
        // Non-fatal: peer remains registered, monitoring continues
      }
    }
  }

  /**
   * Get all discovered peers that have not yet been peered with.
   */
  getDiscoveredPeers(): DiscoveredPeer[] {
    return [...this.discoveredPeers.values()].filter(
      (p) => !this.peeredPubkeys.has(p.pubkey)
    );
  }

  /**
   * Check whether a pubkey has been actively peered with.
   */
  isPeered(pubkey: string): boolean {
    return this.peeredPubkeys.has(pubkey);
  }
}
