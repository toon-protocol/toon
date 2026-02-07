/**
 * Bootstrap service for peer discovery and network initialization.
 *
 * Handles the initial peer discovery and SPSP handshake process
 * with known peers to bootstrap into the ILP network.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import { getPublicKey } from 'nostr-tools/pure';
import { AgentSocietyError } from './errors.js';
import { ILP_PEER_INFO_KIND } from './constants.js';
import { parseIlpPeerInfo, buildIlpPeerInfoEvent } from './events/index.js';
import { NostrSpspClient } from './spsp/index.js';
import type { IlpPeerInfo, SpspInfo } from './types.js';

/** Regular expression for validating 64-character lowercase hex pubkeys */
const PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/**
 * Error thrown when bootstrap operations fail.
 */
export class BootstrapError extends AgentSocietyError {
  constructor(message: string, cause?: Error) {
    super(message, 'BOOTSTRAP_FAILED', cause);
    this.name = 'BootstrapError';
  }
}

/**
 * Represents a known peer for bootstrap.
 */
export interface KnownPeer {
  /** Nostr pubkey of the peer (64-char hex) */
  pubkey: string;
  /** WebSocket URL of the peer's Nostr relay */
  relayUrl: string;
  /** BTP WebSocket endpoint for direct connection during bootstrap */
  btpEndpoint: string;
}

/**
 * Configuration for the bootstrap service.
 */
export interface BootstrapConfig {
  /** List of known peers to bootstrap with */
  knownPeers: KnownPeer[];
  /** Timeout for SPSP requests in milliseconds (default: 10000) */
  spspTimeout?: number;
  /** Timeout for relay queries in milliseconds (default: 5000) */
  queryTimeout?: number;
}

/**
 * Result of a successful peer bootstrap.
 */
export interface BootstrapResult {
  /** The known peer that was bootstrapped with */
  knownPeer: KnownPeer;
  /** The peer's ILP info from their kind:10032 event */
  peerInfo: IlpPeerInfo;
  /** The SPSP parameters received from the peer */
  spspInfo: SpspInfo;
}

/**
 * Callback interface for connector Admin API operations.
 */
export interface ConnectorAdminClient {
  /**
   * Add a peer to the connector's routing table.
   * @param peerId - Unique identifier for the peer
   * @param btpUrl - BTP WebSocket URL for the peer
   * @param ilpAddress - ILP address prefix for routing
   */
  addPeer(peerId: string, btpUrl: string, ilpAddress: string): Promise<void>;

  /**
   * Add a route to the connector's routing table.
   * @param prefix - ILP address prefix to route
   * @param nextHop - Peer ID to route to
   */
  addRoute(prefix: string, nextHop: string): Promise<void>;
}

/**
 * Service for bootstrapping into the ILP network via known Nostr peers.
 *
 * The bootstrap process:
 * 1. Connect to the known peer's relay
 * 2. Query for their kind:10032 (ILP Peer Info) event
 * 3. Perform a direct SPSP handshake (free, not ILP-routed)
 * 4. Add the peer to the connector's routing table via Admin API
 * 5. Publish our own kind:10032 to the peer's relay
 */
export class BootstrapService {
  private readonly config: Required<BootstrapConfig>;
  private readonly secretKey: Uint8Array;
  private readonly pubkey: string;
  private readonly ownIlpInfo: IlpPeerInfo;
  private readonly pool: SimplePool;
  private connectorAdmin?: ConnectorAdminClient;

  /**
   * Creates a new BootstrapService instance.
   *
   * @param config - Bootstrap configuration with known peers
   * @param secretKey - Our Nostr secret key for signing events
   * @param ownIlpInfo - Our ILP peer info to publish
   * @param pool - Optional SimplePool instance (creates new one if not provided)
   */
  constructor(
    config: BootstrapConfig,
    secretKey: Uint8Array,
    ownIlpInfo: IlpPeerInfo,
    pool?: SimplePool
  ) {
    this.config = {
      knownPeers: config.knownPeers,
      spspTimeout: config.spspTimeout ?? 10000,
      queryTimeout: config.queryTimeout ?? 5000,
    };
    this.secretKey = secretKey;
    this.pubkey = getPublicKey(secretKey);
    this.ownIlpInfo = ownIlpInfo;
    this.pool = pool ?? new SimplePool();
  }

  /**
   * Set the connector admin client for adding peers/routes.
   */
  setConnectorAdmin(admin: ConnectorAdminClient): void {
    this.connectorAdmin = admin;
  }

  /**
   * Bootstrap with all known peers.
   *
   * Attempts to bootstrap with each known peer in order.
   * Returns results for successfully bootstrapped peers.
   * Continues to next peer on failure.
   *
   * @returns Array of successful bootstrap results
   */
  async bootstrap(): Promise<BootstrapResult[]> {
    const results: BootstrapResult[] = [];

    for (const knownPeer of this.config.knownPeers) {
      try {
        const result = await this.bootstrapWithPeer(knownPeer);
        results.push(result);
        console.log(
          `[Bootstrap] Successfully bootstrapped with ${knownPeer.pubkey.slice(0, 16)}...`
        );
      } catch (error) {
        console.warn(
          `[Bootstrap] Failed to bootstrap with ${knownPeer.pubkey.slice(0, 16)}...:`,
          error instanceof Error ? error.message : 'Unknown error'
        );
        // Continue to next peer
      }
    }

    return results;
  }

  /**
   * Bootstrap with a single known peer.
   *
   * @param knownPeer - The known peer to bootstrap with
   * @returns Bootstrap result with peer info and SPSP params
   * @throws BootstrapError if bootstrap fails
   */
  async bootstrapWithPeer(knownPeer: KnownPeer): Promise<BootstrapResult> {
    // Validate pubkey format
    if (!PUBKEY_REGEX.test(knownPeer.pubkey)) {
      throw new BootstrapError(
        `Invalid pubkey format for known peer: ${knownPeer.pubkey}`
      );
    }

    // Step 1: Query peer's relay for their kind:10032
    console.log(`[Bootstrap] Querying ${knownPeer.relayUrl} for peer info...`);
    const peerInfo = await this.queryPeerInfo(knownPeer);

    // Step 2: Perform direct SPSP handshake
    console.log(`[Bootstrap] Performing SPSP handshake with ${knownPeer.pubkey.slice(0, 16)}...`);
    const spspInfo = await this.directSpspHandshake(knownPeer);

    // Step 3: Add peer to connector if admin client is set
    if (this.connectorAdmin) {
      console.log(`[Bootstrap] Adding peer to connector routing table...`);
      await this.addPeerToConnector(knownPeer, peerInfo);
    }

    // Step 4: Publish our own kind:10032 to their relay
    console.log(`[Bootstrap] Publishing our ILP info to ${knownPeer.relayUrl}...`);
    await this.publishOurInfo(knownPeer.relayUrl);

    return {
      knownPeer,
      peerInfo,
      spspInfo,
    };
  }

  /**
   * Query a peer's relay for their kind:10032 ILP Peer Info event.
   */
  private async queryPeerInfo(knownPeer: KnownPeer): Promise<IlpPeerInfo> {
    const filter: Filter = {
      kinds: [ILP_PEER_INFO_KIND],
      authors: [knownPeer.pubkey],
      limit: 1,
    };

    try {
      console.log(`[Bootstrap] Query filter:`, JSON.stringify(filter));
      const events = await this.pool.querySync([knownPeer.relayUrl], filter);
      console.log(`[Bootstrap] Query returned ${events.length} events`);

      if (events.length === 0) {
        throw new BootstrapError(
          `No kind:${ILP_PEER_INFO_KIND} event found for peer ${knownPeer.pubkey.slice(0, 16)}...`
        );
      }

      // Sort by created_at descending and use most recent
      const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
      const mostRecent = sortedEvents[0];

      if (!mostRecent) {
        throw new BootstrapError('No events found after sorting');
      }

      return parseIlpPeerInfo(mostRecent);
    } catch (error) {
      if (error instanceof BootstrapError) {
        throw error;
      }
      throw new BootstrapError(
        `Failed to query peer info from ${knownPeer.relayUrl}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Perform a direct SPSP handshake with a known peer.
   *
   * This uses the peer's relay for the SPSP request/response exchange.
   * During bootstrap, this is "free" (not routed through ILP).
   */
  private async directSpspHandshake(knownPeer: KnownPeer): Promise<SpspInfo> {
    // Use the peer's relay for the SPSP handshake
    const spspClient = new NostrSpspClient(
      [knownPeer.relayUrl],
      this.pool,
      this.secretKey
    );

    try {
      return await spspClient.requestSpspInfo(knownPeer.pubkey, {
        timeout: this.config.spspTimeout,
      });
    } catch (error) {
      throw new BootstrapError(
        `SPSP handshake failed with ${knownPeer.pubkey.slice(0, 16)}...`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Add a peer to the connector's routing table via Admin API.
   */
  private async addPeerToConnector(
    knownPeer: KnownPeer,
    peerInfo: IlpPeerInfo
  ): Promise<void> {
    if (!this.connectorAdmin) {
      throw new BootstrapError('Connector admin client not set');
    }

    try {
      // Generate a peer ID from the pubkey (first 16 chars)
      const peerId = `nostr-${knownPeer.pubkey.slice(0, 16)}`;

      // Add the peer
      await this.connectorAdmin.addPeer(
        peerId,
        peerInfo.btpEndpoint,
        peerInfo.ilpAddress
      );

      // Add a route for the peer's ILP address prefix
      await this.connectorAdmin.addRoute(peerInfo.ilpAddress, peerId);
    } catch (error) {
      throw new BootstrapError(
        `Failed to add peer to connector`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Publish our own kind:10032 ILP Peer Info to a relay.
   */
  private async publishOurInfo(relayUrl: string): Promise<void> {
    const event = buildIlpPeerInfoEvent(this.ownIlpInfo, this.secretKey);

    try {
      await this.pool.publish([relayUrl], event);
    } catch (error) {
      throw new BootstrapError(
        `Failed to publish ILP info to ${relayUrl}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Query a peer's relay for other peers' kind:10032 events.
   *
   * Used after bootstrapping to discover additional peers
   * that have also published to the bootstrap node's relay.
   *
   * @param relayUrl - The relay URL to query
   * @param excludePubkeys - Pubkeys to exclude from results (e.g., our own, known peers)
   * @returns Map of pubkey to IlpPeerInfo for discovered peers
   */
  async discoverPeersViaRelay(
    relayUrl: string,
    excludePubkeys: string[] = []
  ): Promise<Map<string, IlpPeerInfo>> {
    const excludeSet = new Set([this.pubkey, ...excludePubkeys]);

    const filter: Filter = {
      kinds: [ILP_PEER_INFO_KIND],
    };

    try {
      const events = await this.pool.querySync([relayUrl], filter);

      // Group by pubkey, keeping most recent
      const eventsByPubkey = new Map<string, (typeof events)[0]>();
      for (const event of events) {
        if (excludeSet.has(event.pubkey)) continue;

        const existing = eventsByPubkey.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
          eventsByPubkey.set(event.pubkey, event);
        }
      }

      // Parse events
      const result = new Map<string, IlpPeerInfo>();
      for (const [pubkey, event] of eventsByPubkey) {
        try {
          const info = parseIlpPeerInfo(event);
          result.set(pubkey, info);
        } catch {
          // Skip malformed events
        }
      }

      return result;
    } catch (error) {
      throw new BootstrapError(
        `Failed to discover peers from ${relayUrl}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get our pubkey.
   */
  getPubkey(): string {
    return this.pubkey;
  }

  /**
   * Publish our ILP info to a specific relay.
   *
   * @param relayUrl - The relay URL to publish to (defaults to 'ws://localhost:7100')
   */
  async publishToRelay(relayUrl: string = 'ws://localhost:7100'): Promise<void> {
    await this.publishOurInfo(relayUrl);
  }
}
