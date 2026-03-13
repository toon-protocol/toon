/**
 * createNode() composition for @crosstown/sdk.
 *
 * Wires the full ILP packet processing pipeline:
 *   shallow TOON parse -> Schnorr signature verification -> pricing validation -> handler dispatch
 *
 * Provides start() / stop() lifecycle management by delegating to
 * the core CrosstownNode composition (embedded mode) or manual HTTP
 * composition (standalone mode).
 *
 * ## Deployment Modes
 *
 * - **Embedded** (`connector`): Pass an EmbeddableConnectorLike directly.
 *   Zero-latency packet delivery via direct function calls.
 * - **Standalone** (`connectorUrl` + `handlerPort`): Connect to an external
 *   connector via HTTP. The SDK starts an HTTP server to receive packets.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { NostrEvent } from 'nostr-tools/pure';
import type {
  EmbeddableConnectorLike,
  HandlePacketRequest,
  HandlePacketResponse,
  ConnectorChannelClient,
} from '@crosstown/core';
import type {
  KnownPeer,
  BootstrapResult,
  BootstrapEventListener,
} from '@crosstown/core';
import type { SettlementConfig } from '@crosstown/core';
import {
  createCrosstownNode,
  BootstrapService,
  createDiscoveryTracker,
  createHttpIlpClient,
  createHttpConnectorAdmin,
  createHttpChannelClient,
} from '@crosstown/core';
import type {
  IlpClient,
  ConnectorAdminClient,
  DiscoveryTracker,
} from '@crosstown/core';
import {
  shallowParseToon,
  decodeEventFromToon,
  encodeEventToToon,
} from '@crosstown/core/toon';

import { fromSecretKey } from './identity.js';
import { HandlerRegistry, type Handler } from './handler-registry.js';
import { createHandlerContext } from './handler-context.js';
import { createVerificationPipeline } from './verification-pipeline.js';
import { createPricingValidator } from './pricing-validator.js';
import { NodeError } from './errors.js';

/**
 * Maximum base64-encoded payload size (in characters) accepted by the pipeline.
 * Defense-in-depth against DoS via oversized payloads. 1MB of base64 decodes
 * to ~750KB of raw TOON data, which is far beyond any legitimate Nostr event.
 * The pay-per-byte pricing model provides an additional economic disincentive.
 */
const MAX_PAYLOAD_BASE64_LENGTH = 1_048_576;

/**
 * Configuration for creating a ServiceNode via createNode().
 *
 * Supports two deployment modes:
 * - **Embedded** (`connector`): Pass an EmbeddableConnectorLike directly for
 *   zero-latency packet delivery.
 * - **Standalone** (`connectorUrl` + `handlerPort`): Connect to an external
 *   connector via HTTP. The SDK starts an HTTP server to receive packets.
 *
 * Provide `connector` OR (`connectorUrl` + `handlerPort`), not both.
 */
export interface NodeConfig {
  /** 32-byte secp256k1 secret key */
  secretKey: Uint8Array;

  // --- Connector (exactly one mode required) ---

  /** Embedded connector instance for zero-latency mode. */
  connector?: EmbeddableConnectorLike;
  /**
   * External connector admin URL for standalone mode (e.g., "http://localhost:8081").
   * Must be provided with `handlerPort`.
   */
  connectorUrl?: string;
  /**
   * Port for the HTTP server that receives ILP packets from the external connector.
   * Must be provided with `connectorUrl`.
   */
  handlerPort?: number;

  // --- Network ---

  /** ILP address (default: 'g.crosstown.local') */
  ilpAddress?: string;
  /** BTP endpoint URL advertised in kind:10032 announcements */
  btpEndpoint?: string;
  /** Asset code (default: 'USD') */
  assetCode?: string;
  /** Asset scale (default: 6) */
  assetScale?: number;
  /** Base price per byte for pricing validation (default: 10n) */
  basePricePerByte?: bigint;
  /** Dev mode skips signature verification (default: false) */
  devMode?: boolean;
  /** TOON encoder function */
  toonEncoder?: (event: NostrEvent) => Uint8Array;
  /** TOON decoder function */
  toonDecoder?: (bytes: Uint8Array) => NostrEvent;
  /** Initial known peers for bootstrap */
  knownPeers?: KnownPeer[];
  /** Relay WebSocket URL */
  relayUrl?: string;
  /** Settlement info for peer registration */
  settlementInfo?: SettlementConfig;
  /** Enable ArDrive peer lookup */
  ardriveEnabled?: boolean;
  /** Per-kind pricing overrides */
  kindPricing?: Record<number, bigint>;
  /** Config-based handler registration (alternative to post-creation .on()) */
  handlers?: Record<number, Handler>;
  /** Config-based default handler (alternative to post-creation .onDefault()) */
  defaultHandler?: Handler;
}

/**
 * Result returned by ServiceNode.start().
 */
export interface StartResult {
  /** Number of peers successfully bootstrapped */
  peerCount: number;
  /** Number of payment channels opened */
  channelCount: number;
  /** Detailed results from the bootstrap phase */
  bootstrapResults: BootstrapResult[];
}

/**
 * Result returned by ServiceNode.publishEvent().
 */
export interface PublishEventResult {
  success: boolean;
  eventId: string;
  fulfillment?: string;
  code?: string;
  message?: string;
}

/**
 * A fully wired Crosstown node with lifecycle management.
 */
export interface ServiceNode {
  /** Nostr x-only public key (32 bytes, 64 hex chars) */
  readonly pubkey: string;
  /** EVM address derived from the same secp256k1 key */
  readonly evmAddress: string;
  /** Pass-through to the underlying connector (null in standalone mode) */
  readonly connector: EmbeddableConnectorLike | null;
  /** Channel client (null if connector lacks channel support or in standalone mode) */
  readonly channelClient: ConnectorChannelClient | null;
  /** Register a handler for a specific event kind (builder pattern) */
  on(kind: number, handler: Handler): ServiceNode;
  /** Register a lifecycle event listener */
  on(event: 'bootstrap', listener: BootstrapEventListener): ServiceNode;
  /** Register a default handler for unrecognized kinds (builder pattern) */
  onDefault(handler: Handler): ServiceNode;
  /** Start the node: wire packet handler, run bootstrap, start discovery */
  start(): Promise<StartResult>;
  /** Stop the node: clean up lifecycle state */
  stop(): Promise<void>;
  /** Initiate peering with a discovered peer (register + settlement) */
  peerWith(pubkey: string): Promise<void>;
  /**
   * Publish a Nostr event to a remote peer via the embedded connector.
   *
   * TOON-encodes the event, computes payment amount, and sends as an
   * ILP PREPARE packet via the runtime client.
   *
   * @param event - The Nostr event to publish
   * @param options - Must include destination ILP address
   * @returns Result with success/failure info and event ID
   */
  publishEvent(
    event: NostrEvent,
    options?: { destination: string }
  ): Promise<PublishEventResult>;
}

/**
 * Creates a fully wired ServiceNode from configuration.
 *
 * The returned node has the full ILP packet processing pipeline wired in the
 * correct order:
 *   1. Shallow TOON parse (extract routing metadata)
 *   2. Schnorr signature verification (reject with F06 if invalid)
 *   3. Pricing validation (reject with F04 if underpaid)
 *   4. Handler dispatch (route to kind-specific or default handler)
 *
 * Supports two deployment modes:
 * - **Embedded** (`connector`): Uses createCrosstownNode for zero-latency
 *   packet delivery via direct function calls.
 * - **Standalone** (`connectorUrl` + `handlerPort`): Starts an HTTP server
 *   to receive packets and uses HTTP clients for the connector API.
 *
 * Handlers can be registered via config or post-creation .on()/.onDefault().
 */
export function createNode(config: NodeConfig): ServiceNode {
  // 0. Validate connector mode
  const hasConnector = config.connector !== undefined;
  const hasConnectorUrl = config.connectorUrl !== undefined;

  if (hasConnector && hasConnectorUrl) {
    throw new NodeError(
      'NodeConfig: provide either connector or connectorUrl, not both'
    );
  }
  if (!hasConnector && !hasConnectorUrl) {
    throw new NodeError(
      'NodeConfig: one of connector or connectorUrl is required'
    );
  }
  if (hasConnectorUrl && config.handlerPort === undefined) {
    throw new NodeError(
      'NodeConfig: handlerPort is required when using connectorUrl (standalone mode)'
    );
  }
  const embeddedMode = hasConnector;

  // 1. Derive identity from secretKey
  let identity;
  try {
    identity = fromSecretKey(config.secretKey);
  } catch (error: unknown) {
    throw new NodeError(
      `Invalid secretKey: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
  const { pubkey, evmAddress } = identity;

  // 2. Create handler registry
  const registry = new HandlerRegistry();

  // 3. Register config-based handlers (with kind validation matching node.on())
  if (config.handlers) {
    for (const [kind, handler] of Object.entries(config.handlers)) {
      const kindNum = Number(kind);
      if (!Number.isInteger(kindNum) || kindNum < 0) {
        throw new NodeError(
          `Invalid event kind in handlers config: expected a non-negative integer, got '${kind}'`
        );
      }
      registry.on(kindNum, handler);
    }
  }

  // 4. Register config-based default handler
  if (config.defaultHandler) {
    registry.onDefault(config.defaultHandler);
  }

  // 5. Create verification pipeline
  const verifier = createVerificationPipeline({
    devMode: config.devMode ?? false,
  });

  // 6. Create pricing validator
  const pricer = createPricingValidator({
    basePricePerByte: config.basePricePerByte ?? 10n,
    ownPubkey: pubkey,
    kindPricing: config.kindPricing,
  });

  // 7. Set up TOON codec with defaults
  const encoder = config.toonEncoder ?? encodeEventToToon;
  const decoder = config.toonDecoder ?? decodeEventFromToon;

  // Context decoder: converts base64 TOON string to NostrEvent
  const contextDecoder = (toon: string): NostrEvent => {
    const bytes = Buffer.from(toon, 'base64');
    return decoder(bytes);
  };

  // Mutable ref so the packet handler closure can access the tracker after it's created.
  const trackerRef: { current?: { processEvent(event: NostrEvent): void } } =
    {};

  // 8. Build the pipelined packet handler (Option A: directly on HandlePacketRequest)
  const pipelinedHandler = async (
    request: HandlePacketRequest
  ): Promise<HandlePacketResponse> => {
    // Step 0: Reject oversized payloads before allocating memory (DoS mitigation)
    if (request.data.length > MAX_PAYLOAD_BASE64_LENGTH) {
      return {
        accept: false,
        code: 'F06',
        message: `Payload too large: ${request.data.length} bytes exceeds maximum ${MAX_PAYLOAD_BASE64_LENGTH}`,
      };
    }

    // Step 1: Shallow TOON parse
    const toonBytes = Buffer.from(request.data, 'base64');
    let meta;
    try {
      meta = shallowParseToon(toonBytes);
    } catch {
      // Corrupted TOON data cannot be parsed -- reject as invalid payload
      return {
        accept: false,
        code: 'F06',
        message: 'Invalid TOON payload: failed to parse routing metadata',
      };
    }

    // Dev mode: log packet details
    // Sanitize user-controlled fields (amount, destination) to prevent log injection
    // via newlines or control characters. meta.kind (integer) and meta.pubkey (validated
    // hex) are safe; request.data preview is base64 (safe character set).
    if (config.devMode ?? false) {
      const toonPreview =
        request.data.length > 80
          ? request.data.substring(0, 80) + '...'
          : request.data;
      // eslint-disable-next-line no-control-regex
      const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '');
      console.log(
        '[crosstown:dev]',
        `kind=${meta.kind}`,
        `pubkey=${meta.pubkey.substring(0, 16)}...`,
        `amount=${sanitize(request.amount)}`,
        `dest=${sanitize(request.destination)}`,
        `toon=${toonPreview}`
      );
    }

    // Step 2: Verify signature
    const verifyResult = await verifier.verify(meta, request.data);
    if (!verifyResult.verified) {
      // VerificationResult.rejection is always set when verified=false per
      // createVerificationPipeline contract. Guard defensively anyway.
      if (verifyResult.rejection) {
        return verifyResult.rejection;
      }
      return { accept: false, code: 'F06', message: 'Verification failed' };
    }

    // Step 3: Validate pricing (skip in dev mode)
    let amount: bigint;
    try {
      amount = BigInt(request.amount);
    } catch {
      if (config.devMode ?? false) {
        amount = 0n;
      } else {
        return {
          accept: false,
          code: 'T00',
          message: 'Invalid payment amount',
        };
      }
    }
    if (!(config.devMode ?? false)) {
      const priceResult = pricer.validate(meta, amount);
      if (!priceResult.accepted) {
        // PricingValidationResult.rejection is always set when accepted=false per
        // createPricingValidator contract. Guard defensively anyway.
        if (priceResult.rejection) {
          return priceResult.rejection;
        }
        return {
          accept: false,
          code: 'F04',
          message: 'Pricing validation failed',
        };
      }
    }

    // Step 4: Build HandlerContext with real metadata
    const ctx = createHandlerContext({
      toon: request.data,
      meta,
      amount,
      destination: request.destination,
      toonDecoder: contextDecoder,
    });

    // Step 5: Dispatch to handler (T00 error boundary)
    try {
      const result = await registry.dispatch(ctx);

      // Feed accepted kind:10032 events to discovery tracker for peer discovery.
      // Uses late-binding reference since the tracker is created after this handler.
      if (result.accept && meta.kind === 10032 && trackerRef.current) {
        const decoded = ctx.decode();
        if (decoded) {
          trackerRef.current.processEvent(decoded);
        }
      }

      return result;
    } catch (err: unknown) {
      // Log only the error message, not the full error object (which may contain payload data)
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Handler dispatch failed:', errMsg);
      return { accept: false, code: 'T00', message: 'Internal error' };
    }
  };

  // ILP info shared between both modes
  const ilpInfo = {
    ilpAddress: config.ilpAddress ?? 'g.crosstown.local',
    btpEndpoint: config.btpEndpoint ?? '',
    assetCode: config.assetCode ?? 'USD',
    assetScale: config.assetScale ?? 6,
  };

  // 9. Branch: embedded mode vs standalone mode
  let ilpClient: IlpClient;
  let adminClient: ConnectorAdminClient;
  let channelClient: ConnectorChannelClient | null = null;
  let bootstrapServiceInstance: BootstrapService;
  let discoveryTrackerInstance: DiscoveryTracker;
  let httpServer: HttpServer | null = null;

  // Lifecycle delegates (start/stop differ per mode)
  let doStart: () => Promise<{
    bootstrapResults: BootstrapResult[];
    peerCount: number;
    channelCount: number;
  }>;
  let doStop: () => Promise<void>;

  if (embeddedMode) {
    // --- EMBEDDED MODE: delegate to createCrosstownNode ---
    const crosstownNode = createCrosstownNode({
      connector: config.connector as NonNullable<typeof config.connector>,
      handlePacket: pipelinedHandler,
      secretKey: config.secretKey,
      ilpInfo,
      toonEncoder: encoder,
      toonDecoder: decoder,
      relayUrl: config.relayUrl,
      knownPeers: config.knownPeers,
      settlementInfo: config.settlementInfo,
      basePricePerByte: config.basePricePerByte,
      ardriveEnabled: config.ardriveEnabled,
    });

    ilpClient = crosstownNode.ilpClient;
    channelClient = crosstownNode.channelClient;
    bootstrapServiceInstance = crosstownNode.bootstrapService;
    discoveryTrackerInstance = crosstownNode.discoveryTracker;
    adminClient = {
      addPeer: () => Promise.resolve(),
      removePeer: () => Promise.resolve(),
    };

    trackerRef.current = discoveryTrackerInstance;

    doStart = async () => crosstownNode.start();
    doStop = async () => crosstownNode.stop();
  } else {
    // --- STANDALONE MODE: manual composition with HTTP clients ---
    const connectorUrl = config.connectorUrl as string;
    const handlerPort = config.handlerPort as number;

    ilpClient = createHttpIlpClient(connectorUrl);
    adminClient = createHttpConnectorAdmin(connectorUrl, '');

    // Channel client via HTTP if settlement is configured
    if (config.settlementInfo) {
      channelClient = createHttpChannelClient(connectorUrl);
    }

    // Create BootstrapService
    bootstrapServiceInstance = new BootstrapService(
      {
        knownPeers: config.knownPeers ?? [],
        ardriveEnabled: config.ardriveEnabled ?? false,
        defaultRelayUrl: config.relayUrl ?? '',
        settlementInfo: config.settlementInfo,
        ownIlpAddress: ilpInfo.ilpAddress,
        toonEncoder: encoder,
        toonDecoder: decoder,
        basePricePerByte: config.basePricePerByte ?? 10n,
      },
      config.secretKey,
      ilpInfo
    );

    bootstrapServiceInstance.setIlpClient(ilpClient);
    bootstrapServiceInstance.setConnectorAdmin(adminClient);
    if (channelClient) {
      bootstrapServiceInstance.setChannelClient(channelClient);
    }

    // Create DiscoveryTracker
    discoveryTrackerInstance = createDiscoveryTracker({
      secretKey: config.secretKey,
      settlementInfo: config.settlementInfo,
    });
    discoveryTrackerInstance.setConnectorAdmin(adminClient);
    if (channelClient) {
      discoveryTrackerInstance.setChannelClient(channelClient);
    }

    trackerRef.current = discoveryTrackerInstance;

    doStart = async () => {
      // Start HTTP server for receiving ILP packets
      httpServer = createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy', pubkey }));
          return;
        }

        if (req.method === 'POST' && req.url === '/handle-packet') {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', async () => {
            try {
              const request = JSON.parse(body) as HandlePacketRequest;
              if (!request.amount || !request.destination || !request.data) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    accept: false,
                    code: 'F00',
                    message: 'Missing required fields',
                  })
                );
                return;
              }
              const result = await pipelinedHandler(request);
              res.writeHead(result.accept ? 200 : 400, {
                'Content-Type': 'application/json',
              });
              res.end(JSON.stringify(result));
            } catch (err: unknown) {
              console.error('[SDK] handle-packet error:', err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  accept: false,
                  code: 'T00',
                  message: 'Internal server error',
                })
              );
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => {
        httpServer?.listen(handlerPort, () => resolve());
      });

      // Run bootstrap
      const results = await bootstrapServiceInstance.bootstrap();
      const bootstrapPeerPubkeys = results.map((r) => r.knownPeer.pubkey);
      discoveryTrackerInstance.addExcludedPubkeys(bootstrapPeerPubkeys);

      return {
        bootstrapResults: results,
        peerCount: results.length,
        channelCount: results.filter((r) => r.channelId).length,
      };
    };

    doStop = async () => {
      const server = httpServer;
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        httpServer = null;
      }
    };
  }

  // 10. Track SDK-level lifecycle state
  let started = false;

  // 11. Build and return ServiceNode
  const node: ServiceNode = {
    get pubkey() {
      return pubkey;
    },
    get evmAddress() {
      return evmAddress;
    },
    get connector() {
      return config.connector ?? null;
    },
    get channelClient() {
      return channelClient;
    },

    on(
      kindOrEvent: number | string,
      handlerOrListener: Handler | BootstrapEventListener
    ): ServiceNode {
      if (typeof kindOrEvent === 'number') {
        // Handler registration (existing behavior)
        if (!Number.isInteger(kindOrEvent) || kindOrEvent < 0) {
          throw new NodeError(
            `Invalid event kind: expected a non-negative integer, got ${String(kindOrEvent)}`
          );
        }
        registry.on(kindOrEvent, handlerOrListener as Handler);
      } else if (kindOrEvent === 'bootstrap') {
        // Lifecycle event listener -- forward to bootstrapService AND discoveryTracker
        const listener = handlerOrListener as BootstrapEventListener;
        bootstrapServiceInstance.on(listener);
        discoveryTrackerInstance.on(listener);
      } else {
        // Sanitize event name to prevent log injection via control characters
        // eslint-disable-next-line no-control-regex
        const sanitized = String(kindOrEvent).replace(/[\x00-\x1f\x7f]/g, '');
        throw new NodeError(
          `Unknown lifecycle event: '${sanitized}'. Supported: 'bootstrap'`
        );
      }
      return node;
    },

    onDefault(handler: Handler): ServiceNode {
      registry.onDefault(handler);
      return node;
    },

    async start(): Promise<StartResult> {
      if (started) {
        throw new NodeError('Node already started');
      }

      try {
        const result = await doStart();
        started = true;
        return {
          peerCount: result.peerCount,
          channelCount: result.channelCount,
          bootstrapResults: result.bootstrapResults,
        };
      } catch (error: unknown) {
        if (error instanceof NodeError) {
          throw error;
        }
        throw new NodeError(
          `Failed to start node: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined
        );
      }
    },

    async stop(): Promise<void> {
      if (!started) {
        return; // No-op if not started
      }

      await doStop();
      started = false;
    },

    async peerWith(targetPubkey: string): Promise<void> {
      if (!started) {
        throw new NodeError(
          'Cannot peer: node not started. Call start() first.'
        );
      }
      // Defense-in-depth: validate pubkey format before delegating to core
      if (
        typeof targetPubkey !== 'string' ||
        targetPubkey.length !== 64 ||
        !/^[0-9a-f]{64}$/.test(targetPubkey)
      ) {
        throw new NodeError(
          'Invalid pubkey: expected a 64-character lowercase hex string'
        );
      }
      return discoveryTrackerInstance.peerWith(targetPubkey);
    },

    async publishEvent(
      event: NostrEvent,
      options?: { destination: string }
    ): Promise<PublishEventResult> {
      // Guard: node must be started
      if (!started) {
        throw new NodeError(
          'Cannot publish: node not started. Call start() first.'
        );
      }

      // Guard: destination is required
      if (!options?.destination) {
        throw new NodeError(
          "Cannot publish: destination is required. Pass { destination: 'g.peer.address' }."
        );
      }

      try {
        // TOON-encode the event
        const toonData = encoder(event);

        // Compute amount: basePricePerByte * toonData.length
        const amount =
          (config.basePricePerByte ?? 10n) * BigInt(toonData.length);

        // Convert to base64
        const base64Data = Buffer.from(toonData).toString('base64');

        // Send via ILP client
        const result = await ilpClient.sendIlpPacket({
          destination: options.destination,
          amount: String(amount),
          data: base64Data,
        });

        // Map IlpSendResult to PublishEventResult
        if (result.accepted) {
          return {
            success: true,
            eventId: event.id,
            fulfillment: result.fulfillment ?? '',
          };
        }

        return {
          success: false,
          eventId: event.id,
          code: result.code ?? 'T00',
          message: result.message ?? 'Unknown error',
        };
      } catch (error: unknown) {
        // Propagate NodeError directly
        if (error instanceof NodeError) {
          throw error;
        }
        throw new NodeError(
          `Failed to publish event: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined
        );
      }
    },
  };

  return node;
}
