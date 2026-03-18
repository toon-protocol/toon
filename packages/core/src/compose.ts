/**
 * TOON Node composition API.
 *
 * Provides createToonNode() — a single composition function that wires
 * ConnectorNode ↔ BLS ↔ BootstrapService ↔ DiscoveryTracker into one object
 * with start() / stop() lifecycle, enabling zero-latency embedded mode without
 * manually wiring each component.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { IlpPeerInfo, ConnectorChannelClient } from './types.js';
import type {
  KnownPeer,
  BootstrapResult,
  SettlementConfig,
} from './bootstrap/types.js';
import type {
  SendPacketParams,
  SendPacketResult,
} from './bootstrap/direct-ilp-client.js';
import type { RegisterPeerParams } from './bootstrap/direct-connector-admin.js';
import type { IlpClient } from './bootstrap/types.js';
import {
  BootstrapService,
  BootstrapError,
} from './bootstrap/BootstrapService.js';
import { createDiscoveryTracker } from './bootstrap/discovery-tracker.js';
import type { DiscoveryTracker } from './bootstrap/discovery-tracker.js';
import { createDirectIlpClient } from './bootstrap/direct-ilp-client.js';
import { createDirectConnectorAdmin } from './bootstrap/direct-connector-admin.js';
import { createDirectChannelClient } from './bootstrap/direct-channel-client.js';

/**
 * Structural type for incoming ILP packet handler request.
 *
 * Matches the shape of BLS HandlePacketRequest without creating a cross-package
 * dependency from @toon-protocol/core → @toon-protocol/bls.
 */
export interface HandlePacketRequest {
  /** Payment amount as string (parsed to bigint) */
  amount: string;
  /** ILP destination address */
  destination: string;
  /** Base64-encoded TOON Nostr event */
  data: string;
  /** Source ILP address */
  sourceAccount?: string;
}

/**
 * Structural type for ILP packet handler accept response.
 */
export interface HandlePacketAcceptResponse {
  accept: true;
  /** Base64-encoded fulfillment (SHA-256 of event.id) */
  fulfillment: string;
  /** Base64-encoded response data (e.g., TOON-encoded response for relay back in ILP FULFILL) */
  data?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Structural type for ILP packet handler reject response.
 */
export interface HandlePacketRejectResponse {
  accept: false;
  /** ILP error code (F00, F06, T00) */
  code: string;
  /** Human-readable error message */
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Union type for ILP packet handler response.
 */
export type HandlePacketResponse =
  | HandlePacketAcceptResponse
  | HandlePacketRejectResponse;

/**
 * Callback invoked by the connector for incoming ILP packets.
 *
 * **NOTE:** This is a **function** (not a BusinessLogicServer instance) because
 * packet handling logic lives in the caller's entrypoint code, not in
 * BusinessLogicServer. The caller provides the full handler that knows how to
 * process incoming events.
 */
export type PacketHandler = (
  request: HandlePacketRequest
) => HandlePacketResponse | Promise<HandlePacketResponse>;

/**
 * Structural interface for the full embedded connector API.
 *
 * Combines:
 * 1. ConnectorNodeLike (sendPacket) — for outbound ILP packets
 * 2. ConnectorAdminLike (registerPeer, removePeer) — for peer management
 * 3. setPacketHandler(handler) — for registering the incoming packet callback
 *
 * This structural interface allows @toon-protocol/connector's ConnectorNode to
 * be passed directly without importing it as a dependency.
 */
export interface EmbeddableConnectorLike {
  /** Send an outbound ILP packet */
  sendPacket(params: SendPacketParams): Promise<SendPacketResult>;
  /** Register a peer with the connector */
  registerPeer(params: RegisterPeerParams): Promise<void>;
  /** Remove a peer from the connector */
  removePeer(peerId: string): Promise<void>;
  /**
   * Register the incoming packet handler callback.
   * The connector invokes this handler for each incoming ILP packet.
   * Optional in HTTP mode where packets are delivered via local delivery HTTP endpoint.
   */
  setPacketHandler?(
    handler: (
      request: HandlePacketRequest
    ) => HandlePacketResponse | Promise<HandlePacketResponse>
  ): void;
  /**
   * Open a payment channel via the connector's settlement layer.
   * Optional — only available on ConnectorNode >=1.2.0.
   */
  openChannel?(params: {
    peerId: string;
    chain: string;
    token?: string;
    tokenNetwork?: string;
    peerAddress: string;
    initialDeposit?: string;
    settlementTimeout?: number;
  }): Promise<{ channelId: string; status: string }>;
  /**
   * Get the state of a payment channel.
   * Optional — only available on ConnectorNode >=1.2.0.
   */
  getChannelState?(channelId: string): Promise<{
    channelId: string;
    status: 'opening' | 'open' | 'closed' | 'settled';
    chain: string;
  }>;
}

/**
 * Configuration for creating an TOON Node.
 */
export interface ToonNodeConfig {
  /** The ConnectorNode instance (embeddable connector) */
  connector: EmbeddableConnectorLike;
  /**
   * Callback for incoming ILP packets.
   *
   * **NOTE:** Provided as a **function** (not a BLS instance) because packet
   * handling logic lives in the caller's entrypoint code.
   */
  handlePacket: PacketHandler;
  /** Nostr secret key (32 bytes) */
  secretKey: Uint8Array;
  /** Own ILP peer info (ilpAddress, btpEndpoint, assetCode, assetScale) */
  ilpInfo: IlpPeerInfo;
  /**
   * TOON encoder — **required** for encoding Nostr events to binary.
   * Used by BootstrapService.
   */
  toonEncoder: (event: NostrEvent) => Uint8Array;
  /**
   * TOON decoder — **required** for decoding binary to Nostr events.
   * Used by BootstrapService and DirectRuntimeClient.
   */
  toonDecoder: (bytes: Uint8Array) => NostrEvent;
  /** Relay WebSocket URL for monitoring (default: 'ws://localhost:7100') */
  relayUrl?: string;
  /** Initial bootstrap peers (default: []) */
  knownPeers?: KnownPeer[];
  /** Optional settlement preferences for peer registration */
  settlementInfo?: SettlementConfig;
  /** Base price per byte for ILP packet pricing (default: 10n) */
  basePricePerByte?: bigint;
  /** Enable ArDrive peer lookup (default: true) */
  ardriveEnabled?: boolean;
  /** Default relay URL for ArDrive-sourced peers that lack relay URLs (default: '') */
  defaultRelayUrl?: string;
  /** Timeout for relay queries in milliseconds (default: 5000) */
  queryTimeout?: number;
  /** Optional extra peers JSON for bootstrap */
  additionalPeersJson?: string;
}

/**
 * Result returned by ToonNode.start().
 */
export interface ToonNodeStartResult {
  /** Results from the bootstrap phase */
  bootstrapResults: BootstrapResult[];
  /** Number of peers successfully bootstrapped */
  peerCount: number;
  /** Number of payment channels opened */
  channelCount: number;
}

/**
 * TOON Node instance with lifecycle methods.
 */
export interface ToonNode {
  /**
   * Wire components and run bootstrap.
   * Throws BootstrapError if already started or on bootstrap failure.
   */
  start(): Promise<ToonNodeStartResult>;
  /**
   * Tear down and clean up.
   * Safe to call when not started (no-op).
   */
  stop(): Promise<void>;
  /**
   * Read-only access to the bootstrap service.
   * Allows attaching event listeners before calling start().
   */
  readonly bootstrapService: BootstrapService;
  /**
   * Read-only access to the discovery tracker.
   * Allows attaching event listeners before calling start().
   */
  readonly discoveryTracker: DiscoveryTracker;
  /**
   * Channel client for payment channel operations.
   * Null if the connector does not expose openChannel()/getChannelState().
   * Available when using @toon-protocol/connector >=1.2.0.
   */
  readonly channelClient: ConnectorChannelClient | null;
  /**
   * Read-only access to the ILP client for sending packets.
   * Used by ServiceNode.publishEvent() to send outbound events.
   */
  readonly ilpClient: IlpClient;
  /**
   * Initiate peering with a discovered peer.
   * The peer must have been discovered by the discovery tracker first.
   * Registers the peer with the connector and attempts settlement.
   */
  peerWith(pubkey: string): Promise<void>;
}

/**
 * Create a TOON Node with integrated bootstrap and discovery tracking.
 *
 * This composition function wires ConnectorNode ↔ DirectRuntimeClient ↔
 * DirectConnectorAdmin ↔ BootstrapService ↔ DiscoveryTracker into a single
 * object with start() / stop() lifecycle, enabling zero-latency embedded mode
 * without manually wiring each component.
 *
 * @param config - Configuration for the node
 * @returns ToonNode instance with start() / stop() methods
 *
 * @example
 * ```typescript
 * import { ConnectorNode } from '@toon-protocol/connector';
 * import { createToonNode } from '@toon-protocol/core/compose';
 * import { encodeEvent, decodeEvent } from '@toon-protocol/relay';
 *
 * const connector = new ConnectorNode({ ... });
 *
 * const node = createToonNode({
 *   connector,
 *   handlePacket: async (req) => { ... },
 *   secretKey: new Uint8Array(32),
 *   ilpInfo: { ilpAddress: 'g.example', ... },
 *   toonEncoder: encodeEvent,
 *   toonDecoder: decodeEvent,
 * });
 *
 * // Attach event listeners before start
 * node.bootstrapService.on((event) => console.log('bootstrap:', event));
 * node.discoveryTracker.on((event) => console.log('discovery:', event));
 *
 * // Start the node
 * const result = await node.start();
 * console.log(`Bootstrapped ${result.peerCount} peers`);
 *
 * // Clean up
 * await node.stop();
 * ```
 */
export function createToonNode(
  config: ToonNodeConfig
): ToonNode {
  // Create direct clients for zero-latency embedded mode
  const directIlpClient = createDirectIlpClient(config.connector, {
    toonDecoder: config.toonDecoder,
  });

  const directAdminClient = createDirectConnectorAdmin(config.connector);

  // Create direct channel client if connector supports channel methods
  const channelClient: ConnectorChannelClient | null =
    config.connector.openChannel && config.connector.getChannelState
      ? createDirectChannelClient(
          config.connector as Required<
            Pick<EmbeddableConnectorLike, 'openChannel' | 'getChannelState'>
          >
        )
      : null;

  // Create BootstrapService with mapped config
  const bootstrapService = new BootstrapService(
    {
      knownPeers: config.knownPeers ?? [],
      ardriveEnabled: config.ardriveEnabled ?? true,
      defaultRelayUrl: config.defaultRelayUrl ?? '',
      queryTimeout: config.queryTimeout ?? 5000,
      settlementInfo: config.settlementInfo,
      ownIlpAddress: config.ilpInfo.ilpAddress,
      toonEncoder: config.toonEncoder,
      toonDecoder: config.toonDecoder,
      basePricePerByte: config.basePricePerByte ?? 10n,
    },
    config.secretKey,
    config.ilpInfo
  );

  // Wire clients to bootstrap service
  bootstrapService.setIlpClient(directIlpClient);
  bootstrapService.setConnectorAdmin(directAdminClient);
  if (channelClient) {
    bootstrapService.setChannelClient(channelClient);
  }

  // Create DiscoveryTracker
  const discoveryTracker = createDiscoveryTracker({
    secretKey: config.secretKey,
    settlementInfo: config.settlementInfo,
  });

  // Wire clients to discovery tracker
  discoveryTracker.setConnectorAdmin(directAdminClient);
  if (channelClient) {
    discoveryTracker.setChannelClient(channelClient);
  }

  // Track lifecycle state
  let started = false;

  return {
    bootstrapService,
    discoveryTracker,
    channelClient,
    ilpClient: directIlpClient,

    peerWith(pubkey: string): Promise<void> {
      return discoveryTracker.peerWith(pubkey);
    },

    async start(): Promise<ToonNodeStartResult> {
      // Guard against double-start
      if (started) {
        throw new BootstrapError('ToonNode already started');
      }

      try {
        // Wire the handlePacket callback to the connector (if supported)
        // HTTP mode uses local delivery instead of callback
        if (config.connector.setPacketHandler) {
          config.connector.setPacketHandler(config.handlePacket);
        }

        // Run bootstrap to discover and register peers
        const results = await bootstrapService.bootstrap(
          config.additionalPeersJson
        );

        // Extract bootstrapped peer pubkeys for discovery tracker exclusion
        const bootstrapPeerPubkeys = results.map((r) => r.knownPeer.pubkey);

        // Exclude already-bootstrapped peers from discovery
        discoveryTracker.addExcludedPubkeys(bootstrapPeerPubkeys);

        started = true;

        // Return bootstrap results summary
        const channelCount = results.filter((r) => r.channelId).length;
        return {
          bootstrapResults: results,
          peerCount: results.length,
          channelCount,
        };
      } catch (error) {
        throw new BootstrapError(
          `Failed to start ToonNode: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },

    async stop(): Promise<void> {
      if (!started) {
        return; // No-op if not started
      }

      started = false;
    },
  };
}
