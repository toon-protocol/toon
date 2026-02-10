/**
 * Relay monitor for discovering new peers via kind:10032 subscription.
 *
 * Subscribes to a relay for ILP Peer Info events, automatically registers
 * discovered peers, initiates paid SPSP handshakes, and handles deregistration.
 */

import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey, type NostrEvent } from 'nostr-tools/pure';
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
} from './types.js';

/**
 * Monitors a relay for new kind:10032 events and orchestrates
 * reverse registration and SPSP handshakes with discovered peers.
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
   * Start monitoring the relay for kind:10032 events.
   *
   * @param excludePubkeys - Pubkeys to exclude (e.g., already-bootstrapped peers)
   * @returns Subscription handle for stopping the monitor
   */
  start(excludePubkeys: string[] = []): Subscription {
    if (!this.connectorAdmin) {
      throw new BootstrapError('connectorAdmin must be set before calling start()');
    }
    if (!this.agentRuntimeClient) {
      throw new BootstrapError('agentRuntimeClient must be set before calling start()');
    }

    // Create IlpSpspClient lazily here (requires agentRuntimeClient)
    const spspClient = new IlpSpspClient(
      this.agentRuntimeClient,
      this.config.secretKey,
      {
        toonEncoder: this.config.toonEncoder,
        toonDecoder: this.config.toonDecoder,
        defaultTimeout: this.defaultTimeout,
      }
    );

    // Capture reference to connectorAdmin before closure (validated non-null above)
    const connectorAdmin = this.connectorAdmin;

    const excludeSet = new Set([this.pubkey, ...excludePubkeys]);
    const registeredPeers = new Set<string>();
    const peerTimestamps = new Map<string, number>();
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
        const lastSeen = peerTimestamps.get(event.pubkey) ?? 0;
        if (event.created_at <= lastSeen) return;
        peerTimestamps.set(event.pubkey, event.created_at);

        // Process asynchronously (non-blocking)
        this.processEvent(
          event,
          registeredPeers,
          spspClient,
          connectorAdmin
        ).catch((error) => {
          console.warn(
            `[RelayMonitor] Error processing event from ${event.pubkey.slice(0, 16)}...:`,
            error instanceof Error ? error.message : 'Unknown error'
          );
        });
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
   * Process a single kind:10032 event: register, handshake, or deregister.
   */
  private async processEvent(
    event: NostrEvent,
    registeredPeers: Set<string>,
    spspClient: IlpSpspClient,
    connectorAdmin: ConnectorAdminClient
  ): Promise<void> {
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
      if (registeredPeers.has(event.pubkey)) {
        registeredPeers.delete(event.pubkey);

        if (connectorAdmin.removePeer) {
          try {
            await connectorAdmin.removePeer(peerId);
          } catch (error) {
            console.warn(
              `[RelayMonitor] Failed to deregister ${peerId}:`,
              error instanceof Error ? error.message : 'Unknown error'
            );
          }
        }

        this.emit({
          type: 'bootstrap:peer-deregistered',
          peerId,
          peerPubkey: event.pubkey,
          reason: 'empty-content',
        });
      }
      return;
    }

    // Idempotent: skip already-registered peers (AC 6)
    if (registeredPeers.has(event.pubkey)) {
      return;
    }

    // Emit discovery event
    this.emit({
      type: 'bootstrap:peer-discovered',
      peerPubkey: event.pubkey,
      ilpAddress: peerInfo.ilpAddress,
    });

    // Register peer via connector admin
    try {
      await connectorAdmin.addPeer({
        id: peerId,
        url: peerInfo.btpEndpoint,
        authToken: '',
        routes: [{ prefix: peerInfo.ilpAddress }],
      });

      registeredPeers.add(event.pubkey);

      this.emit({
        type: 'bootstrap:peer-registered',
        peerId,
        peerPubkey: event.pubkey,
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
      const amount = this.calculateSpspAmount(event);

      const spspResult = await spspClient.requestSpspInfo(
        event.pubkey,
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
   * Calculate the amount for a paid SPSP handshake.
   * Uses half-price for kind:23194 SPSP requests.
   */
  private calculateSpspAmount(event: NostrEvent): string {
    // Build an SPSP request event to get the TOON byte size
    const { event: spspRequestEvent } = buildSpspRequestEvent(
      event.pubkey,
      this.config.secretKey,
      this.config.settlementInfo
    );

    const toonBytes = this.config.toonEncoder(spspRequestEvent);
    // Half-price for kind:23194 SPSP requests
    const amount = BigInt(toonBytes.length) * (this.basePricePerByte / 2n);
    return String(amount);
  }
}
