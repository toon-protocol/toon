/**
 * Bootstrap service for peer discovery and network initialization.
 *
 * Handles the initial peer discovery and registration process
 * with known peers to bootstrap into the ILP network.
 *
 * Three-phase bootstrap:
 * 1. Discover: Load peers, query relays for kind:10032, register with connector
 * 2. Handshake: SPSP via ILP (0-amount packets) for settlement negotiation
 * 3. Announce: Publish own kind:10032 as paid ILP PREPARE
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import { getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { CrosstownError } from '../errors.js';
import { GenesisPeerLoader, ArDrivePeerRegistry } from '../discovery/index.js';
import type { GenesisPeer } from '../discovery/index.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { parseIlpPeerInfo, buildIlpPeerInfoEvent, buildSpspRequestEvent, parseSpspResponse } from '../events/index.js';
import type { IlpPeerInfo } from '../types.js';
import type {
  KnownPeer,
  BootstrapResult,
  ConnectorAdminClient,
  BootstrapConfig,
  BootstrapServiceConfig,
  BootstrapPhase,
  BootstrapEvent,
  BootstrapEventListener,
  AgentRuntimeClient,
} from './types.js';

/**
 * Error thrown when bootstrap operations fail.
 */
export class BootstrapError extends CrosstownError {
  constructor(message: string, cause?: Error) {
    super(message, 'BOOTSTRAP_FAILED', cause);
    this.name = 'BootstrapError';
  }
}

/**
 * Service for bootstrapping into the ILP network via known Nostr peers.
 *
 * The bootstrap process:
 * Phase 1: Load peers from genesis config, ArDrive, and env var.
 *          For each peer, query their relay for kind:10032 (ILP Peer Info).
 *          Register peer via connector admin API.
 * Phase 2: (ILP-first) SPSP handshake via 0-amount ILP packets for settlement.
 * Phase 3: (ILP-first) Announce own kind:10032 as paid ILP PREPARE.
 */
export class BootstrapService {
  private readonly config: Required<BootstrapConfig>;
  private readonly secretKey: Uint8Array;
  private readonly pubkey: string;
  private readonly ownIlpInfo: IlpPeerInfo;
  private readonly pool: SimplePool;
  private connectorAdmin?: ConnectorAdminClient;

  // ILP-first flow additions
  private readonly agentRuntimeClient?: AgentRuntimeClient;
  private readonly settlementInfo?: BootstrapServiceConfig['settlementInfo'];
  private readonly ownIlpAddress?: string;
  private readonly toonEncoder?: BootstrapServiceConfig['toonEncoder'];
  private readonly toonDecoder?: BootstrapServiceConfig['toonDecoder'];
  private readonly basePricePerByte: bigint;

  // Event emitter
  private listeners: BootstrapEventListener[] = [];
  private phase: BootstrapPhase = 'discovering';

  /**
   * Creates a new BootstrapService instance.
   *
   * @param config - Bootstrap configuration with known peers and optional ILP-first settings
   * @param secretKey - Our Nostr secret key for signing events
   * @param ownIlpInfo - Our ILP peer info to publish
   * @param pool - Optional SimplePool instance (creates new one if not provided)
   */
  constructor(
    config: BootstrapServiceConfig,
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

    // ILP-first flow config
    this.settlementInfo = config.settlementInfo;
    this.ownIlpAddress = config.ownIlpAddress;
    this.toonEncoder = config.toonEncoder;
    this.toonDecoder = config.toonDecoder;
    this.basePricePerByte = config.basePricePerByte ?? 10n;
  }

  /**
   * Set the agent-runtime client for sending ILP packets.
   * Kept separate from constructor for backward compatibility with existing code
   * that creates the client after construction.
   */
  setAgentRuntimeClient(client: AgentRuntimeClient): void {
    (this as unknown as { agentRuntimeClient?: AgentRuntimeClient }).agentRuntimeClient = client;
  }

  /**
   * Set the connector admin client for adding peers/routes.
   */
  setConnectorAdmin(admin: ConnectorAdminClient): void {
    this.connectorAdmin = admin;
  }

  /**
   * Get the current bootstrap phase.
   */
  getPhase(): BootstrapPhase {
    return this.phase;
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
        // Don't let listener errors break bootstrap
      }
    }
  }

  /**
   * Transition to a new phase, emitting phase change event.
   */
  private setPhase(newPhase: BootstrapPhase): void {
    const previousPhase = this.phase;
    this.phase = newPhase;
    this.emit({ type: 'bootstrap:phase', phase: newPhase, previousPhase });
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

    try {
      // Phase 1: Discover and register
      this.setPhase('discovering');

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

      this.setPhase('registering');

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

      // Phase 2: SPSP handshake via ILP (if agentRuntimeClient is configured)
      if (this.agentRuntimeClient && results.length > 0) {
        this.setPhase('handshaking');

        for (const result of results) {
          try {
            await this.performSpspHandshake(result);
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'Unknown error';
            console.warn(
              `[Bootstrap] SPSP handshake failed for ${result.registeredPeerId}:`,
              reason
            );
            this.emit({
              type: 'bootstrap:handshake-failed',
              peerId: result.registeredPeerId,
              reason,
            });
          }
        }

        // Phase 3: Announce own kind:10032 as paid ILP PREPARE
        this.setPhase('announcing');

        for (const result of results) {
          try {
            await this.announceViaIlp(result);
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'Unknown error';
            this.emit({
              type: 'bootstrap:announce-failed',
              peerId: result.registeredPeerId,
              reason,
            });
            console.warn(
              `[Bootstrap] Announce failed for ${result.registeredPeerId}:`,
              reason
            );
            // Non-fatal
          }
        }
      }

      const channelCount = results.filter((r) => r.channelId).length;
      this.setPhase('ready');
      this.emit({
        type: 'bootstrap:ready',
        peerCount: results.length,
        channelCount,
      });
    } catch (error) {
      this.setPhase('failed');
      console.error(
        '[Bootstrap] Bootstrap failed:',
        error instanceof Error ? error.message : 'Unknown error'
      );
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
    const PUBKEY_REGEX = /^[0-9a-f]{64}$/;
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
        this.emit({
          type: 'bootstrap:peer-registered',
          peerId: registeredPeerId,
          peerPubkey: knownPeer.pubkey,
          ilpAddress: peerInfo.ilpAddress,
        });
      } catch (error) {
        console.warn(
          `[Bootstrap] Failed to register peer ${registeredPeerId} with connector:`,
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    // Step 3: Publish our own kind:10032 to their relay (non-fatal)
    // Only do direct publish if NOT using ILP-first flow (Phase 3 handles it via ILP)
    if (!this.agentRuntimeClient) {
      try {
        console.log(`[Bootstrap] Publishing our ILP info to ${knownPeer.relayUrl}...`);
        await this.publishOurInfo(knownPeer.relayUrl);
      } catch (error) {
        console.warn(
          `[Bootstrap] Failed to publish ILP info to ${knownPeer.relayUrl}:`,
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    return {
      knownPeer,
      peerInfo,
      registeredPeerId,
    };
  }

  /**
   * Perform SPSP handshake via ILP for a bootstrapped peer (Phase 2).
   */
  private async performSpspHandshake(result: BootstrapResult): Promise<void> {
    if (!this.agentRuntimeClient || !this.toonEncoder || !this.toonDecoder) {
      return;
    }

    // Build kind:23194 SPSP request event
    const { event: spspRequestEvent } = buildSpspRequestEvent(
      result.knownPeer.pubkey,
      this.secretKey,
      this.settlementInfo
    );

    // TOON-encode the event
    const toonBytes = this.toonEncoder(spspRequestEvent);
    const base64Toon = Buffer.from(toonBytes).toString('base64');

    // Send 0-amount ILP packet
    const ilpResult = await this.agentRuntimeClient.sendIlpPacket({
      destination: result.peerInfo.ilpAddress,
      amount: '0',
      data: base64Toon,
      timeout: this.config.queryTimeout,
    });

    if (!ilpResult.accepted) {
      throw new BootstrapError(
        `SPSP handshake rejected: ${ilpResult.code} ${ilpResult.message}`
      );
    }

    // Decode response data (base64 -> TOON -> Nostr event -> parseSpspResponse)
    if (ilpResult.data) {
      try {
        const responseBytes = Uint8Array.from(Buffer.from(ilpResult.data, 'base64'));
        const responseEvent = this.toonDecoder(responseBytes);
        const spspResponse = parseSpspResponse(
          responseEvent,
          this.secretKey,
          result.knownPeer.pubkey
        );

        // Update result with settlement info
        if (spspResponse.channelId) {
          result.channelId = spspResponse.channelId;
        }
        if (spspResponse.negotiatedChain) {
          result.negotiatedChain = spspResponse.negotiatedChain;
        }
        if (spspResponse.settlementAddress) {
          result.settlementAddress = spspResponse.settlementAddress;
        }

        // Update peer registration with settlement config if we have channel info
        if (spspResponse.channelId && this.connectorAdmin) {
          await this.connectorAdmin.addPeer({
            id: result.registeredPeerId,
            url: result.peerInfo.btpEndpoint,
            authToken: '',
            routes: [{ prefix: result.peerInfo.ilpAddress }],
            settlement: {
              preference: spspResponse.negotiatedChain || 'evm',
              ...(spspResponse.settlementAddress && {
                evmAddress: spspResponse.settlementAddress,
              }),
              ...(spspResponse.tokenAddress && {
                tokenAddress: spspResponse.tokenAddress,
              }),
              ...(spspResponse.tokenNetworkAddress && {
                tokenNetworkAddress: spspResponse.tokenNetworkAddress,
              }),
              ...(spspResponse.channelId && {
                channelId: spspResponse.channelId,
              }),
            },
          });
        }

        if (spspResponse.channelId) {
          this.emit({
            type: 'bootstrap:channel-opened',
            peerId: result.registeredPeerId,
            channelId: spspResponse.channelId,
            negotiatedChain: spspResponse.negotiatedChain || 'unknown',
          });
        }
      } catch (error) {
        throw new BootstrapError(
          `Failed to parse SPSP response: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Announce own kind:10032 as paid ILP PREPARE (Phase 3).
   */
  private async announceViaIlp(result: BootstrapResult): Promise<void> {
    if (!this.agentRuntimeClient || !this.toonEncoder) {
      return;
    }

    // Build kind:10032 event
    const ilpInfoEvent = buildIlpPeerInfoEvent(this.ownIlpInfo, this.secretKey);

    // TOON-encode the event
    const toonBytes = this.toonEncoder(ilpInfoEvent);
    const base64Toon = Buffer.from(toonBytes).toString('base64');

    // Calculate amount: base price per byte * TOON byte length
    const amount = String(BigInt(toonBytes.length) * this.basePricePerByte);

    // Send as paid ILP PREPARE
    const ilpResult = await this.agentRuntimeClient.sendIlpPacket({
      destination: result.peerInfo.ilpAddress,
      amount,
      data: base64Toon,
    });

    if (ilpResult.accepted) {
      console.log(
        `[Bootstrap] Announced to ${result.registeredPeerId} via ILP (fulfillment: ${ilpResult.fulfillment}, eventId: ${ilpInfoEvent.id})`
      );
      this.emit({
        type: 'bootstrap:announced',
        peerId: result.registeredPeerId,
        eventId: ilpInfoEvent.id,
        amount,
      });
    } else {
      const reason = `${ilpResult.code} ${ilpResult.message}`;
      this.emit({
        type: 'bootstrap:announce-failed',
        peerId: result.registeredPeerId,
        reason,
      });
      console.warn(
        `[Bootstrap] Announce rejected by ${result.registeredPeerId}: ${reason}`
      );
    }
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
      const events: unknown[] = [];
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
          let event = msg[2];

          // Handle TOON format events (string) by parsing them
          if (typeof event === 'string') {
            try {
              // Simple TOON parser for bootstrap events
              const lines = event.trim().split('\n');
              const parsed: any = {};
              for (const line of lines) {
                const colonIndex = line.indexOf(':');
                if (colonIndex > 0) {
                  const key = line.substring(0, colonIndex).trim();
                  const value = line.substring(colonIndex + 1).trim();
                  if (key.startsWith('tags[')) {
                    // Skip tags for now
                    continue;
                  }
                  if (value.startsWith('"') && value.endsWith('"')) {
                    parsed[key] = JSON.parse(value);
                  } else if (!isNaN(Number(value))) {
                    parsed[key] = Number(value);
                  } else {
                    parsed[key] = value;
                  }
                }
              }
              event = parsed;
            } catch (error) {
              console.warn(`[Bootstrap] Failed to parse TOON event:`, error);
              return;
            }
          }

          if (event && event.id) {
            console.log(`[Bootstrap] Received event: ${event.id.slice(0, 16)}...`);
            events.push(event);
          } else {
            console.warn(`[Bootstrap] Received EVENT message with invalid event data:`, msg);
          }
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
          const sortedEvents = (events as { created_at: number }[]).sort(
            (a, b) => b.created_at - a.created_at
          );
          const mostRecent = sortedEvents[0];

          try {
            const peerInfo = parseIlpPeerInfo(mostRecent as Parameters<typeof parseIlpPeerInfo>[0]);
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
          const sortedEvents = (events as { created_at: number }[]).sort(
            (a, b) => b.created_at - a.created_at
          );
          const mostRecent = sortedEvents[0];

          try {
            const peerInfo = parseIlpPeerInfo(mostRecent as Parameters<typeof parseIlpPeerInfo>[0]);
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
  async publishToRelay(relayUrl = 'ws://localhost:7100'): Promise<void> {
    await this.publishOurInfo(relayUrl);
  }
}
