/**
 * Bootstrap service for peer discovery and network initialization.
 *
 * Handles the initial peer discovery and registration process
 * with known peers to bootstrap into the ILP network.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import { getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { AgentSocietyError } from './errors.js';
import { GenesisPeerLoader, ArDrivePeerRegistry } from './discovery/index.js';
import type { GenesisPeer } from './discovery/index.js';
import { ILP_PEER_INFO_KIND } from './constants.js';
import { parseIlpPeerInfo, buildIlpPeerInfoEvent } from './events/index.js';
import type { IlpPeerInfo } from './types.js';

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
  /** Timeout for relay queries in milliseconds (default: 5000) */
  queryTimeout?: number;
  /** Enable ArDrive peer lookup (default: true) */
  ardriveEnabled?: boolean;
  /** Default relay URL for ArDrive-sourced peers that lack relay URLs */
  defaultRelayUrl?: string;
}

/**
 * Result of a successful peer bootstrap.
 */
export interface BootstrapResult {
  /** The known peer that was bootstrapped with */
  knownPeer: KnownPeer;
  /** The peer's ILP info from their kind:10032 event */
  peerInfo: IlpPeerInfo;
  /** The ID used when registering with the connector (e.g., "nostr-aabb11cc22dd33ee") */
  registeredPeerId: string;
}

/**
 * Callback interface for connector Admin API operations.
 * Matches the agent-runtime admin API shape: POST /admin/peers
 */
export interface ConnectorAdminClient {
  /**
   * Add a peer to the connector via the admin API.
   * @param config - Peer configuration matching the agent-runtime API shape
   */
  addPeer(config: {
    id: string;
    url: string;
    authToken: string;
    routes?: { prefix: string; priority?: number }[];
  }): Promise<void>;

  /**
   * Remove a peer from the connector via the admin API.
   * Maps to DELETE /admin/peers/:id in the agent-runtime admin API.
   * Optional — not all callers will implement peer removal.
   * @param peerId - The peer ID to remove
   */
  removePeer?(peerId: string): Promise<void>;
}

/**
 * Service for bootstrapping into the ILP network via known Nostr peers.
 *
 * The bootstrap process:
 * 1. Load peers from genesis config, ArDrive, and env var
 * 2. For each peer, query their relay for kind:10032 (ILP Peer Info)
 * 3. Register peer via connector admin API
 * 4. Publish our own kind:10032 to the peer's relay
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
      queryTimeout: config.queryTimeout ?? 5000,
      ardriveEnabled: config.ardriveEnabled ?? true,
      defaultRelayUrl: config.defaultRelayUrl ?? '',
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
   * Load peers from genesis config, ArDrive, and optional env var JSON.
   * Merges all sources, deduplicating by pubkey (ArDrive overrides genesis for matching pubkeys).
   */
  async loadPeers(additionalPeersJson?: string): Promise<GenesisPeer[]> {
    const genesisPeers = GenesisPeerLoader.loadAllPeers(additionalPeersJson);

    const ardrivePeers: GenesisPeer[] = [];
    if (this.config.ardriveEnabled) {
      try {
        const ardriveMap = await ArDrivePeerRegistry.fetchPeers();
        for (const [pubkey, info] of ardriveMap) {
          if (!this.config.defaultRelayUrl) continue;
          ardrivePeers.push({
            pubkey,
            relayUrl: this.config.defaultRelayUrl,
            ilpAddress: info.ilpAddress,
            btpEndpoint: info.btpEndpoint,
          });
        }
      } catch (error) {
        console.warn(
          '[Bootstrap] ArDrive peer fetch failed, using genesis peers only:',
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    // Merge: ArDrive overrides genesis for matching pubkeys
    const merged = new Map<string, GenesisPeer>();
    for (const peer of genesisPeers) {
      merged.set(peer.pubkey, peer);
    }
    for (const peer of ardrivePeers) {
      merged.set(peer.pubkey, peer);
    }

    return [...merged.values()];
  }

  /**
   * Bootstrap with all known peers.
   *
   * Loads peers from genesis config, ArDrive, and optional env var JSON,
   * then attempts to bootstrap with each peer in order.
   * Returns results for successfully bootstrapped peers.
   * Continues to next peer on failure.
   *
   * @param additionalPeersJson - Optional JSON string of additional peers to merge
   * @returns Array of successful bootstrap results
   */
  async bootstrap(additionalPeersJson?: string): Promise<BootstrapResult[]> {
    const results: BootstrapResult[] = [];

    // Load and merge peers from all sources
    const allPeers = await this.loadPeers(additionalPeersJson);

    // Convert GenesisPeers to KnownPeers and merge with config peers
    const knownPeersMap = new Map<string, KnownPeer>();
    for (const peer of this.config.knownPeers) {
      knownPeersMap.set(peer.pubkey, peer);
    }
    for (const peer of allPeers) {
      if (!knownPeersMap.has(peer.pubkey)) {
        knownPeersMap.set(peer.pubkey, {
          pubkey: peer.pubkey,
          relayUrl: peer.relayUrl,
          btpEndpoint: peer.btpEndpoint,
        });
      }
    }

    for (const knownPeer of knownPeersMap.values()) {
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
   * @returns Bootstrap result with peer info and registered peer ID
   * @throws BootstrapError if pubkey is invalid or peer info query fails
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

    // Step 2: Add peer to connector if admin client is set (non-fatal)
    const registeredPeerId = `nostr-${knownPeer.pubkey.slice(0, 16)}`;
    if (this.connectorAdmin) {
      try {
        console.log(`[Bootstrap] Adding peer to connector routing table...`);
        await this.addPeerToConnector(knownPeer, peerInfo);
      } catch (error) {
        console.warn(
          `[Bootstrap] Failed to register peer ${registeredPeerId} with connector:`,
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    // Step 3: Publish our own kind:10032 to their relay (non-fatal)
    try {
      console.log(`[Bootstrap] Publishing our ILP info to ${knownPeer.relayUrl}...`);
      await this.publishOurInfo(knownPeer.relayUrl);
    } catch (error) {
      console.warn(
        `[Bootstrap] Failed to publish ILP info to ${knownPeer.relayUrl}:`,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }

    return {
      knownPeer,
      peerInfo,
      registeredPeerId,
    };
  }

  /**
   * Query a peer's relay for their kind:10032 ILP Peer Info event.
   * Uses direct WebSocket connection for reliable container-to-container communication.
   */
  private async queryPeerInfo(knownPeer: KnownPeer): Promise<IlpPeerInfo> {
    const filter: Filter = {
      kinds: [ILP_PEER_INFO_KIND],
      authors: [knownPeer.pubkey],
      limit: 1,
    };

    console.log(`[Bootstrap] Query filter:`, JSON.stringify(filter));
    console.log(`[Bootstrap] Connecting to ${knownPeer.relayUrl}...`);

    return new Promise((resolve, reject) => {
      const events: any[] = [];
      const timeout = this.config.queryTimeout ?? 5000;
      const ws = new WebSocket(knownPeer.relayUrl);
      const subId = `bootstrap-${Date.now()}`;
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          try {
            ws.close();
          } catch {
            // Ignore close errors
          }
        }
      };

      ws.on('open', () => {
        console.log(`[Bootstrap] Connected to ${knownPeer.relayUrl}, sending REQ`);
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(data.toString());
        console.log(`[Bootstrap] Received message type: ${msg[0]}`);

        if (msg[0] === 'EVENT' && msg[1] === subId) {
          console.log(`[Bootstrap] Received event: ${msg[2].id.slice(0, 16)}...`);
          events.push(msg[2]);
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          console.log(`[Bootstrap] EOSE received, found ${events.length} events`);
          cleanup();

          if (events.length === 0) {
            reject(
              new BootstrapError(
                `No kind:${ILP_PEER_INFO_KIND} event found for peer ${knownPeer.pubkey.slice(0, 16)}...`
              )
            );
            return;
          }

          // Sort by created_at descending and use most recent
          const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
          const mostRecent = sortedEvents[0];

          try {
            const peerInfo = parseIlpPeerInfo(mostRecent);
            resolve(peerInfo);
          } catch (error) {
            reject(
              new BootstrapError(
                `Failed to parse peer info`,
                error instanceof Error ? error : undefined
              )
            );
          }
        } else if (msg[0] === 'NOTICE') {
          console.log(`[Bootstrap] Notice from relay: ${msg[1]}`);
        }
      });

      ws.on('error', (error: Error) => {
        console.error(`[Bootstrap] WebSocket error:`, error.message);
        cleanup();
        reject(
          new BootstrapError(
            `Failed to connect to ${knownPeer.relayUrl}: ${error.message}`,
            error
          )
        );
      });

      ws.on('close', () => {
        console.log(`[Bootstrap] Connection closed`);
        if (!resolved) {
          cleanup();
          reject(
            new BootstrapError(
              `Connection closed before receiving events from ${knownPeer.relayUrl}`
            )
          );
        }
      });

      // Set timeout
      setTimeout(() => {
        if (resolved) return;
        console.log(`[Bootstrap] Query timeout after ${timeout}ms`);
        cleanup();

        if (events.length > 0) {
          const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
          const mostRecent = sortedEvents[0];

          try {
            const peerInfo = parseIlpPeerInfo(mostRecent);
            resolve(peerInfo);
          } catch (error) {
            reject(
              new BootstrapError(
                `Failed to parse peer info`,
                error instanceof Error ? error : undefined
              )
            );
          }
        } else {
          reject(
            new BootstrapError(
              `Query timeout: No events received from ${knownPeer.relayUrl} after ${timeout}ms`
            )
          );
        }
      }, timeout);
    });
  }

  /**
   * Add a peer to the connector via Admin API.
   */
  private async addPeerToConnector(
    knownPeer: KnownPeer,
    peerInfo: IlpPeerInfo
  ): Promise<void> {
    if (!this.connectorAdmin) {
      throw new BootstrapError('Connector admin client not set');
    }

    const peerId = `nostr-${knownPeer.pubkey.slice(0, 16)}`;

    await this.connectorAdmin.addPeer({
      id: peerId,
      url: peerInfo.btpEndpoint,
      authToken: '',
      routes: [{ prefix: peerInfo.ilpAddress }],
    });
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
