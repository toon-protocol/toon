/**
 * Relay monitor for discovering new peers via kind:10032 subscription.
 *
 * Discovery is passive (automatic via start()) — peers are tracked but no
 * registration or paid handshakes occur until peerWith() is called explicitly.
 */

import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { parseIlpPeerInfo, buildSpspRequestEvent } from '../events/index.js';
import type { Subscription } from '../types.js';
import { BootstrapError } from './BootstrapService.js';
import { IlpSpspClient } from '../spsp/IlpSpspClient.js';
import type {
  RelayMonitorConfig,
  ConnectorAdminClient,
  AgentRuntimeClient,
  BootstrapEvent,
  BootstrapEventListener,
  DiscoveredPeer,
} from './types.js';

/**
 * Monitors a relay for new kind:10032 events. Discovery is passive —
 * peering (registration + SPSP handshake) is triggered explicitly via peerWith().
 */
export class RelayMonitor {
  private readonly config: RelayMonitorConfig;
  private readonly pubkey: string;
  private readonly pool: SimplePool;
  private readonly basePricePerByte: bigint;
  private readonly defaultTimeout: number;

  private connectorAdmin?: ConnectorAdminClient;
  private agentRuntimeClient?: AgentRuntimeClient;
  private listeners: BootstrapEventListener[] = [];

  /** Peers discovered via kind:10032 events (keyed by pubkey). */
  private readonly discoveredPeers = new Map<string, DiscoveredPeer>();
  /** Pubkeys that have been actively peered with via peerWith(). */
  private readonly peeredPubkeys = new Set<string>();
  /** Timestamps of the latest kind:10032 event per pubkey (for stale-event filtering). */
  private readonly peerTimestamps = new Map<string, number>();

  /** Memoized IlpSpspClient instance (created lazily on first peerWith() call). */
  private spspClient?: IlpSpspClient;

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
   * agentRuntimeClient — it only discovers peers passively. Use peerWith()
   * to initiate registration and SPSP handshakes.
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
      // Parse failure — treat as empty content
    }

    // Deregistration: empty content or missing ilpAddress (AC 7)
    if (!peerInfo || !peerInfo.ilpAddress || !event.content || event.content.trim() === '') {
      this.handleDeregistration(event.pubkey, peerId);
      return;
    }

    // Track discovered peer (update if already known — newer timestamp)
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
   * and initiate a paid SPSP handshake.
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
      throw new BootstrapError(`Peer ${pubkey.slice(0, 16)}... not discovered yet`);
    }

    if (!this.connectorAdmin) {
      throw new BootstrapError('connectorAdmin must be set before calling peerWith()');
    }
    if (!this.agentRuntimeClient) {
      throw new BootstrapError('agentRuntimeClient must be set before calling peerWith()');
    }

    const { peerId, peerInfo } = discovered;
    const connectorAdmin = this.connectorAdmin;
    const spspClient = this.getOrCreateSpspClient();

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
        type: 'bootstrap:handshake-failed',
        peerId,
        reason: `Registration failed: ${reason}`,
      });
      return;
    }

    // Send paid SPSP handshake
    try {
      const amount = this.calculateSpspAmount(pubkey);

      const spspResult = await spspClient.requestSpspInfo(
        pubkey,
        peerInfo.ilpAddress,
        {
          amount,
          timeout: this.defaultTimeout,
          settlementInfo: this.config.settlementInfo,
        }
      );

      // Update registration with settlement info if channel was opened
      if (spspResult.settlement?.channelId) {
        await connectorAdmin.addPeer({
          id: peerId,
          url: peerInfo.btpEndpoint,
          authToken: '',
          routes: [{ prefix: peerInfo.ilpAddress }],
          settlement: {
            preference: spspResult.settlement.negotiatedChain || 'evm',
            ...(spspResult.settlement.settlementAddress && {
              evmAddress: spspResult.settlement.settlementAddress,
            }),
            ...(spspResult.settlement.tokenAddress && {
              tokenAddress: spspResult.settlement.tokenAddress,
            }),
            ...(spspResult.settlement.tokenNetworkAddress && {
              tokenNetworkAddress: spspResult.settlement.tokenNetworkAddress,
            }),
            ...(spspResult.settlement.channelId && {
              channelId: spspResult.settlement.channelId,
            }),
          },
        });

        this.emit({
          type: 'bootstrap:channel-opened',
          peerId,
          channelId: spspResult.settlement.channelId,
          negotiatedChain: spspResult.settlement.negotiatedChain || 'unknown',
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`[RelayMonitor] SPSP handshake failed for ${peerId}:`, reason);
      this.emit({
        type: 'bootstrap:handshake-failed',
        peerId,
        reason,
      });
      // Non-fatal: peer remains registered, monitoring continues
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

  /**
   * Lazily create and memoize the IlpSpspClient.
   * Requires agentRuntimeClient to be set.
   */
  private getOrCreateSpspClient(): IlpSpspClient {
    if (!this.spspClient) {
      if (!this.agentRuntimeClient) {
        throw new BootstrapError('agentRuntimeClient must be set before SPSP handshake');
      }
      this.spspClient = new IlpSpspClient(
        this.agentRuntimeClient,
        this.config.secretKey,
        {
          toonEncoder: this.config.toonEncoder,
          toonDecoder: this.config.toonDecoder,
          defaultTimeout: this.defaultTimeout,
        }
      );
    }
    return this.spspClient;
  }

  /**
   * Calculate the amount for a paid SPSP handshake.
   * Uses half-price for kind:23194 SPSP requests.
   */
  private calculateSpspAmount(pubkey: string): string {
    // Build an SPSP request event to get the TOON byte size
    const { event: spspRequestEvent } = buildSpspRequestEvent(
      pubkey,
      this.config.secretKey,
      this.config.settlementInfo
    );

    const toonBytes = this.config.toonEncoder(spspRequestEvent);
    // Half-price for kind:23194 SPSP requests
    const amount = BigInt(toonBytes.length) * (this.basePricePerByte / 2n);
    return String(amount);
  }
}
