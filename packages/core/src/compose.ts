/**
 * Crosstown Node composition API.
 *
 * Provides createCrosstownNode() — a single composition function that wires
 * ConnectorNode ↔ BLS ↔ BootstrapService ↔ RelayMonitor ↔ SPSP into one object
 * with start() / stop() lifecycle, enabling zero-latency embedded mode without
 * manually wiring each component.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { IlpPeerInfo, ConnectorChannelClient, SettlementNegotiationConfig } from './types.js';
import type { SpspRequestSettlementInfo } from './events/builders.js';
import type {
  KnownPeer,
  BootstrapResult,
} from './bootstrap/types.js';
import type { Subscription } from './types.js';
import type { SendPacketParams, SendPacketResult } from './bootstrap/direct-runtime-client.js';
import type { RegisterPeerParams } from './bootstrap/direct-connector-admin.js';
import { BootstrapService, BootstrapError } from './bootstrap/BootstrapService.js';
import { RelayMonitor } from './bootstrap/RelayMonitor.js';
import { createDirectRuntimeClient } from './bootstrap/direct-runtime-client.js';
import { createDirectConnectorAdmin } from './bootstrap/direct-connector-admin.js';
import { createDirectChannelClient } from './bootstrap/direct-channel-client.js';

/**
 * Structural type for incoming ILP packet handler request.
 *
 * Matches the shape of BLS HandlePacketRequest without creating a cross-package
 * dependency from @crosstown/core → @crosstown/bls.
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
  metadata?: {
    eventId: string;
    storedAt: number;
  };
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
  metadata?: {
    required?: string;
    received?: string;
  };
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
 * SPSP handling logic (kind:23194 → settlement negotiation, encrypted response
 * generation, channel opening) currently lives in the caller's entrypoint code,
 * not in BusinessLogicServer. The caller provides the full handler that knows
 * how to process both regular events and SPSP requests.
 */
export type PacketHandler = (
  request: HandlePacketRequest,
) => HandlePacketResponse | Promise<HandlePacketResponse>;

/**
 * Structural interface for the full embedded connector API.
 *
 * Combines:
 * 1. ConnectorNodeLike (sendPacket) — for outbound ILP packets
 * 2. ConnectorAdminLike (registerPeer, removePeer) — for peer management
 * 3. setPacketHandler(handler) — for registering the incoming packet callback
 *
 * This structural interface allows @agent-runtime/connector's ConnectorNode to
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
   */
  setPacketHandler(
    handler: (request: HandlePacketRequest) => HandlePacketResponse | Promise<HandlePacketResponse>,
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
 * Configuration for creating an Crosstown Node.
 */
export interface CrosstownNodeConfig {
  /** The ConnectorNode instance (embeddable connector) */
  connector: EmbeddableConnectorLike;
  /**
   * Callback for incoming ILP packets.
   *
   * **NOTE:** Provided as a **function** (not a BLS instance) because SPSP
   * handling logic lives in the caller's entrypoint code.
   */
  handlePacket: PacketHandler;
  /** Nostr secret key (32 bytes) */
  secretKey: Uint8Array;
  /** Own ILP peer info (ilpAddress, btpEndpoint, assetCode, assetScale) */
  ilpInfo: IlpPeerInfo;
  /**
   * TOON encoder — **required** for encoding Nostr events to binary.
   * Used by RelayMonitor and BootstrapService.
   */
  toonEncoder: (event: NostrEvent) => Uint8Array;
  /**
   * TOON decoder — **required** for decoding binary to Nostr events.
   * Used by RelayMonitor, BootstrapService, and DirectRuntimeClient.
   */
  toonDecoder: (bytes: Uint8Array) => NostrEvent;
  /** Relay WebSocket URL for monitoring (default: 'ws://localhost:7100') */
  relayUrl?: string;
  /** Initial bootstrap peers (default: []) */
  knownPeers?: KnownPeer[];
  /** Optional settlement preferences for SPSP handshakes */
  settlementInfo?: SpspRequestSettlementInfo;
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
  /**
   * Optional settlement negotiation config for opening payment channels
   * during SPSP handshakes. When provided along with a connector that has
   * openChannel()/getChannelState() methods, a DirectChannelClient is created
   * and exposed on the node.
   */
  settlementNegotiationConfig?: SettlementNegotiationConfig;
}

/**
 * Result returned by CrosstownNode.start().
 */
export interface CrosstownNodeStartResult {
  /** Results from the bootstrap phase */
  bootstrapResults: BootstrapResult[];
  /** Number of peers successfully bootstrapped */
  peerCount: number;
  /** Number of payment channels opened */
  channelCount: number;
}

/**
 * Crosstown Node instance with lifecycle methods.
 */
export interface CrosstownNode {
  /**
   * Wire components and run bootstrap.
   * Throws BootstrapError if already started or on bootstrap failure.
   */
  start(): Promise<CrosstownNodeStartResult>;
  /**
   * Tear down subscriptions and clean up.
   * Safe to call when not started (no-op).
   */
  stop(): Promise<void>;
  /**
   * Read-only access to the bootstrap service.
   * Allows attaching event listeners before calling start().
   */
  readonly bootstrapService: BootstrapService;
  /**
   * Read-only access to the relay monitor.
   * Allows attaching event listeners before calling start().
   */
  readonly relayMonitor: RelayMonitor;
  /**
   * Channel client for payment channel operations.
   * Null if the connector does not expose openChannel()/getChannelState().
   * Available when using @crosstown/connector >=1.2.0.
   */
  readonly channelClient: ConnectorChannelClient | null;
  /**
   * Initiate peering with a discovered peer.
   * The peer must have been discovered by the RelayMonitor first.
   * Registers the peer with the connector and performs an SPSP handshake.
   */
  peerWith(pubkey: string): Promise<void>;
}

/**
 * Create an Crosstown Node with integrated bootstrap and relay monitoring.
 *
 * This composition function wires ConnectorNode ↔ DirectRuntimeClient ↔
 * DirectConnectorAdmin ↔ BootstrapService ↔ RelayMonitor into a single object
 * with start() / stop() lifecycle, enabling zero-latency embedded mode without
 * manually wiring each component.
 *
 * @param config - Configuration for the node
 * @returns CrosstownNode instance with start() / stop() methods
 *
 * @example
 * ```typescript
 * import { ConnectorNode } from '@agent-runtime/connector';
 * import { createCrosstownNode } from '@crosstown/core/compose';
 * import { encodeEvent, decodeEvent } from '@crosstown/relay';
 *
 * const connector = new ConnectorNode({ ... });
 *
 * const node = createCrosstownNode({
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
 * node.relayMonitor.on((event) => console.log('relay:', event));
 *
 * // Start the node
 * const result = await node.start();
 * console.log(`Bootstrapped ${result.peerCount} peers`);
 *
 * // Clean up
 * await node.stop();
 * ```
 */
export function createCrosstownNode(
  config: CrosstownNodeConfig,
): CrosstownNode {
  // Create direct clients for zero-latency embedded mode
  const directRuntimeClient = createDirectRuntimeClient(config.connector, {
    toonDecoder: config.toonDecoder,
  });

  const directAdminClient = createDirectConnectorAdmin(config.connector);

  // Create direct channel client if connector supports channel methods
  const channelClient: ConnectorChannelClient | null =
    config.connector.openChannel && config.connector.getChannelState
      ? createDirectChannelClient(
          config.connector as Required<Pick<EmbeddableConnectorLike, 'openChannel' | 'getChannelState'>>,
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
    config.ilpInfo,
  );

  // Wire clients to bootstrap service
  bootstrapService.setAgentRuntimeClient(directRuntimeClient);
  bootstrapService.setConnectorAdmin(directAdminClient);

  // Create RelayMonitor with mapped config
  const relayMonitor = new RelayMonitor({
    relayUrl: config.relayUrl ?? 'ws://localhost:7100',
    secretKey: config.secretKey,
    toonEncoder: config.toonEncoder,
    toonDecoder: config.toonDecoder,
    basePricePerByte: config.basePricePerByte,
    settlementInfo: config.settlementInfo,
  });

  // Wire clients to relay monitor
  relayMonitor.setAgentRuntimeClient(directRuntimeClient);
  relayMonitor.setConnectorAdmin(directAdminClient);

  // Track lifecycle state
  let started = false;
  let relayMonitorSubscription: Subscription | null = null;

  return {
    bootstrapService,
    relayMonitor,
    channelClient,

    peerWith(pubkey: string): Promise<void> {
      return relayMonitor.peerWith(pubkey);
    },

    async start(): Promise<CrosstownNodeStartResult> {
      // Guard against double-start
      if (started) {
        throw new BootstrapError('CrosstownNode already started');
      }

      try {
        // Wire the handlePacket callback to the connector
        config.connector.setPacketHandler(config.handlePacket);

        // Run bootstrap to discover and register peers
        const results = await bootstrapService.bootstrap(
          config.additionalPeersJson,
        );

        // Extract bootstrapped peer pubkeys for relay monitor exclusion
        const bootstrapPeerPubkeys = results.map((r) => r.knownPeer.pubkey);

        // Start relay monitor, excluding already-bootstrapped peers
        relayMonitorSubscription = relayMonitor.start(bootstrapPeerPubkeys);

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
          `Failed to start CrosstownNode: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async stop(): Promise<void> {
      if (!started) {
        return; // No-op if not started
      }

      // Unsubscribe relay monitor
      if (relayMonitorSubscription) {
        relayMonitorSubscription.unsubscribe();
        relayMonitorSubscription = null;
      }

      started = false;
    },
  };
}
