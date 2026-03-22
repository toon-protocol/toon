/**
 * createNode() composition for @toon-protocol/sdk.
 *
 * Wires the full ILP packet processing pipeline:
 *   shallow TOON parse -> Schnorr signature verification -> pricing validation -> handler dispatch
 *
 * Provides start() / stop() lifecycle management by delegating to
 * the core ToonNode composition (embedded mode) or manual HTTP
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
} from '@toon-protocol/core';
import type {
  KnownPeer,
  BootstrapResult,
  BootstrapEventListener,
} from '@toon-protocol/core';
import type { SettlementConfig } from '@toon-protocol/core';
import {
  createToonNode,
  BootstrapService,
  createDiscoveryTracker,
  createHttpIlpClient,
  createHttpConnectorAdmin,
  createHttpChannelClient,
  resolveChainConfig,
  buildIlpPrepare,
  buildJobFeedbackEvent,
  buildJobResultEvent,
  parseJobResult,
  deriveChildAddress,
  checkAddressCollision,
  AddressRegistry,
  ILP_ROOT_PREFIX,
  calculateRouteAmount,
  resolveRouteFees,
  buildPrefixClaimEvent,
  validatePrefix,
} from '@toon-protocol/core';
import type { DvmJobStatus, IlpSendResult } from '@toon-protocol/core';
import type {
  IlpClient,
  ConnectorAdminClient,
  DiscoveryTracker,
} from '@toon-protocol/core';
import {
  shallowParseToon,
  decodeEventFromToon,
  encodeEventToToon,
} from '@toon-protocol/core/toon';

import type { SkillDescriptor } from '@toon-protocol/core';
import { fromSecretKey } from './identity.js';
import { HandlerRegistry, type Handler } from './handler-registry.js';
import { createHandlerContext } from './handler-context.js';
import { createVerificationPipeline } from './verification-pipeline.js';
import { createPricingValidator } from './pricing-validator.js';
import {
  buildSkillDescriptor,
  type BuildSkillDescriptorConfig,
} from './skill-descriptor.js';
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
 * Supports three deployment modes:
 * - **Default** (no connector args): Auto-creates an embedded ConnectorNode via
 *   dynamic import. Requires `@toon-protocol/connector` as peer dependency.
 * - **Embedded** (`connector`): Pass a pre-configured EmbeddableConnectorLike.
 * - **Standalone** (`connectorUrl` + `handlerPort`): Connect to an external
 *   connector via HTTP. The SDK starts an HTTP server to receive packets.
 *
 * Provide `connector` OR (`connectorUrl` + `handlerPort`), or neither (auto-create).
 */
export interface NodeConfig {
  /** 32-byte secp256k1 secret key */
  secretKey: Uint8Array;

  /** Chain preset name (default: 'anvil'). See resolveChainConfig(). */
  chain?: string;

  // --- Connector (optional — defaults to auto-created embedded connector) ---

  /**
   * Embedded connector instance for zero-latency mode.
   * If neither `connector` nor `connectorUrl` is provided, an embedded
   * ConnectorNode is auto-created (requires @toon-protocol/connector peer dep).
   */
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

  /**
   * BTP server port for the auto-created embedded connector (default: 3000).
   * Only used when neither `connector` nor `connectorUrl` is provided.
   */
  btpServerPort?: number;

  /**
   * EVM private key for settlement infrastructure.
   * Only used when auto-creating an embedded connector.
   * If not set, the identity's secp256k1 key is used.
   */
  settlementPrivateKey?: string;

  // --- Network ---

  /**
   * Upstream peer's ILP address prefix for address derivation.
   * When set, the node derives its ILP address as
   * `deriveChildAddress(upstreamPrefix, pubkey)` and ignores `ilpAddress`.
   */
  upstreamPrefix?: string;
  /**
   * Multiple upstream peer prefixes for multi-peered nodes (Story 7.3).
   * When set, derives one ILP address per upstream prefix. Takes priority
   * over `upstreamPrefix` (singular) when both are set.
   */
  upstreamPrefixes?: string[];
  /** ILP address (default: derived from pubkey under ILP_ROOT_PREFIX) */
  ilpAddress?: string;
  /** BTP endpoint URL advertised in kind:10032 announcements */
  btpEndpoint?: string;
  /** Asset code (default: 'USD') */
  assetCode?: string;
  /** Asset scale (default: 6) */
  assetScale?: number;
  /**
   * Base price per byte for pricing validation (default: 10n).
   *
   * Amounts are in USDC micro-units (6 decimals) for production.
   * Default 10n = 10 micro-USDC per byte = $0.00001/byte.
   * A 1KB event costs 10,240 micro-USDC = ~$0.01.
   */
  basePricePerByte?: bigint;
  /**
   * Routing fee per byte charged by this node as an intermediary (default: 0n = free routing).
   * Advertised in kind:10032 peer info events as a non-negative integer string.
   */
  feePerByte?: bigint;
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
  /**
   * Optional skill descriptor configuration overrides.
   * When DVM handlers are registered, these values override the auto-derived
   * defaults in the skill descriptor. See buildSkillDescriptor().
   */
  skillConfig?: Omit<
    BuildSkillDescriptorConfig,
    'basePricePerByte' | 'kindPricing'
  >;
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
  /** Response data from the ILP FULFILL packet (e.g., Arweave tx ID for kind:5094). */
  data?: string;
  code?: string;
  message?: string;
}

/**
 * A fully wired TOON node with lifecycle management.
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
   * @param options - Must include destination ILP address. Optional `amount`
   *   overrides the default basePricePerByte * toonData.length calculation
   *   (prepaid model: send exact destination amount). Optional `bid` is a
   *   client-side safety cap: if the destination amount exceeds `bid`, the
   *   SDK throws before sending any ILP packet.
   * @returns Result with success/failure info and event ID
   */
  publishEvent(
    event: NostrEvent,
    options?: { destination: string; amount?: bigint; bid?: bigint }
  ): Promise<PublishEventResult>;

  /**
   * Publish a Kind 7000 DVM job feedback event via ILP PREPARE.
   *
   * Builds a signed Kind 7000 feedback event with NIP-90 tags (e, p, status)
   * and delegates to publishEvent() for TOON encoding and ILP delivery.
   * Standard relay write fee applies: basePricePerByte * toonData.length.
   *
   * @param requestEventId - 64-char hex event ID of the original Kind 5xxx request
   * @param customerPubkey - 64-char hex pubkey of the customer who posted the request
   * @param status - Job status value ('processing', 'error', 'success', 'partial')
   * @param content - Optional status details or error message
   * @param options - Must include destination ILP address
   * @returns Result with success/failure info and event ID
   */
  publishFeedback(
    requestEventId: string,
    customerPubkey: string,
    status: DvmJobStatus,
    content?: string,
    options?: { destination: string }
  ): Promise<PublishEventResult>;

  /**
   * Publish a Kind 6xxx DVM job result event via ILP PREPARE.
   *
   * Builds a signed Kind 6xxx result event with NIP-90 tags (e, p, amount)
   * and delegates to publishEvent() for TOON encoding and ILP delivery.
   * Standard relay write fee applies: basePricePerByte * toonData.length.
   *
   * @param requestEventId - 64-char hex event ID of the original Kind 5xxx request
   * @param customerPubkey - 64-char hex pubkey of the customer who posted the request
   * @param amount - Compute cost in USDC micro-units as string
   * @param content - Result data (text, URL, etc.)
   * @param options - Must include destination; optional kind (default: 6100)
   * @returns Result with success/failure info and event ID
   */
  publishResult(
    requestEventId: string,
    customerPubkey: string,
    amount: string,
    content: string,
    options?: { destination: string; kind?: number }
  ): Promise<PublishEventResult>;

  /**
   * Returns the computed skill descriptor for this node's DVM capabilities.
   * Returns `undefined` if no DVM handlers (kinds 5000-5999) are registered.
   * The descriptor is computed from the handler registry and node config.
   */
  getSkillDescriptor(): SkillDescriptor | undefined;

  /**
   * Send an ILP payment to a provider for compute settlement.
   *
   * Extracts the compute cost from the result event's `amount` tag via
   * parseJobResult(), optionally validates against the original bid amount
   * (E5-R005 bid validation), and sends a pure ILP value transfer
   * (empty data field) to the provider's ILP address.
   *
   * This is a payment-only operation -- no TOON encoding, no relay write.
   * The payment routes through the ILP mesh using the same infrastructure
   * as relay write fees.
   *
   * @deprecated Use publishEvent() with amount option instead. Prepaid model:
   * send job request + payment in one packet via
   * `publishEvent(event, { destination, amount: computePrice })`.
   *
   * @param resultEvent - Kind 6xxx result event with amount tag
   * @param providerIlpAddress - Provider's ILP address from kind:10035
   * @param options - Optional originalBid for bid validation (E5-R005)
   * @returns ILP send result with accepted/rejected status
   */
  settleCompute(
    resultEvent: NostrEvent,
    providerIlpAddress: string,
    options?: { originalBid?: string }
  ): Promise<IlpSendResult>;

  /**
   * Add a new upstream peer, deriving and registering its ILP address.
   *
   * Updates the AddressRegistry, registers a self-route in the embedded
   * connector, and triggers kind:10032 republication via BootstrapService.
   *
   * @param upstreamPrefix - The upstream peer's ILP address prefix
   */
  addUpstreamPeer(upstreamPrefix: string): void;

  /**
   * Remove an upstream peer, unregistering its derived ILP address.
   *
   * Updates the AddressRegistry, removes the self-route from the embedded
   * connector, and triggers kind:10032 republication via BootstrapService.
   *
   * @param upstreamPrefix - The upstream prefix to remove
   */
  removeUpstreamPeer(upstreamPrefix: string): void;

  /**
   * Claim a prefix from an upstream peer by sending a prefix claim event
   * with payment via ILP.
   *
   * Builds a Kind 10034 prefix claim event, reads the upstream's prefix
   * pricing from its kind:10032 advertisement, and calls publishEvent()
   * with the appropriate amount.
   *
   * @param prefix - The prefix string to claim (e.g., 'useast')
   * @param upstreamDestination - ILP address of the upstream node
   * @param options - Optional prefixPrice override (defaults to upstream's prefixPricing.basePrice from discovery)
   * @returns Result with success/failure info and event ID
   */
  claimPrefix(
    prefix: string,
    upstreamDestination: string,
    options?: { prefixPrice?: bigint }
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
 * - **Embedded** (`connector`): Uses createToonNode for zero-latency
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
  if (hasConnectorUrl && config.handlerPort === undefined) {
    throw new NodeError(
      'NodeConfig: handlerPort is required when using connectorUrl (standalone mode)'
    );
  }
  const autoCreateConnector = !hasConnector && !hasConnectorUrl;
  const embeddedMode = hasConnector || autoCreateConnector;

  // 0b. Resolve chain config and auto-populate settlementInfo if not set
  const chainConfig = resolveChainConfig(config.chain);
  let effectiveSettlementInfo = config.settlementInfo;
  if (!effectiveSettlementInfo) {
    const chainKey = `evm:base:${chainConfig.chainId}`;
    const supportedChains = [chainKey];
    const preferredTokens: Record<string, string> = {
      [chainKey]: chainConfig.usdcAddress,
    };
    const tokenNetworks: Record<string, string> | undefined =
      chainConfig.tokenNetworkAddress
        ? { [chainKey]: chainConfig.tokenNetworkAddress }
        : undefined;

    effectiveSettlementInfo = {
      supportedChains,
      preferredTokens,
      ...(tokenNetworks && { tokenNetworks }),
    };
  }

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
        '[toon:dev]',
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
  // Address resolution priority (Story 7.3 extends with upstreamPrefixes):
  // 1. upstreamPrefixes set -> derive one address per prefix, primary = first
  // 2. upstreamPrefix set -> derive single address (ignore ilpAddress)
  // 3. ilpAddress set -> use directly (includes genesis node with 'g.toon')
  // 4. neither set -> derive from ILP_ROOT_PREFIX + pubkey (default)
  let resolvedIlpAddress: string;
  let resolvedIlpAddresses: string[];

  if (
    config.upstreamPrefixes !== undefined &&
    config.upstreamPrefixes.length > 0
  ) {
    // upstreamPrefixes takes priority over upstreamPrefix (singular)
    if (config.upstreamPrefix !== undefined) {
      console.warn(
        '[toon:warn] Both upstreamPrefixes and upstreamPrefix set; upstreamPrefixes takes priority'
      );
    }
    resolvedIlpAddresses = config.upstreamPrefixes.map((p) =>
      deriveChildAddress(p, pubkey)
    );
    // Task 4.4: Check for truncation collisions across upstream prefixes
    for (let i = 0; i < resolvedIlpAddresses.length; i++) {
      const others = resolvedIlpAddresses.filter((_, j) => j !== i);
      checkAddressCollision(resolvedIlpAddresses[i] as string, others);
    }
    resolvedIlpAddress = resolvedIlpAddresses[0] as string;
  } else if (config.upstreamPrefix !== undefined) {
    resolvedIlpAddress = deriveChildAddress(config.upstreamPrefix, pubkey);
    resolvedIlpAddresses = [resolvedIlpAddress];
  } else if (config.ilpAddress !== undefined) {
    resolvedIlpAddress = config.ilpAddress;
    resolvedIlpAddresses = [resolvedIlpAddress];
  } else {
    resolvedIlpAddress = deriveChildAddress(ILP_ROOT_PREFIX, pubkey);
    resolvedIlpAddresses = [resolvedIlpAddress];
  }

  // Task 6.2: Initialize AddressRegistry with initial upstream prefixes
  const addressRegistry = new AddressRegistry();
  if (
    config.upstreamPrefixes !== undefined &&
    config.upstreamPrefixes.length > 0
  ) {
    for (let i = 0; i < config.upstreamPrefixes.length; i++) {
      addressRegistry.addAddress(
        config.upstreamPrefixes[i] as string,
        resolvedIlpAddresses[i] as string
      );
    }
  } else if (config.upstreamPrefix !== undefined) {
    addressRegistry.addAddress(config.upstreamPrefix, resolvedIlpAddress);
  } else if (config.ilpAddress !== undefined) {
    addressRegistry.addAddress('explicit', resolvedIlpAddress);
  } else {
    addressRegistry.addAddress(ILP_ROOT_PREFIX, resolvedIlpAddress);
  }

  const ilpInfo = {
    ilpAddress: resolvedIlpAddress,
    ilpAddresses: resolvedIlpAddresses,
    btpEndpoint: config.btpEndpoint ?? '',
    assetCode: config.assetCode ?? 'USD',
    assetScale: config.assetScale ?? 6,
    feePerByte: String(config.feePerByte ?? 0n),
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

  // Track auto-created connector for cleanup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let autoCreatedConnector: any = null;

  if (embeddedMode && hasConnector) {
    // --- EMBEDDED MODE (user-provided connector): delegate to createToonNode ---
    const toonNode = createToonNode({
      connector: config.connector as NonNullable<typeof config.connector>,
      handlePacket: pipelinedHandler,
      secretKey: config.secretKey,
      ilpInfo,
      toonEncoder: encoder,
      toonDecoder: decoder,
      relayUrl: config.relayUrl,
      knownPeers: config.knownPeers,
      settlementInfo: effectiveSettlementInfo,
      basePricePerByte: config.basePricePerByte,
      ardriveEnabled: config.ardriveEnabled,
    });

    ilpClient = toonNode.ilpClient;
    channelClient = toonNode.channelClient;
    bootstrapServiceInstance = toonNode.bootstrapService;
    discoveryTrackerInstance = toonNode.discoveryTracker;
    adminClient = {
      addPeer: () => Promise.resolve(),
      removePeer: () => Promise.resolve(),
    };

    trackerRef.current = discoveryTrackerInstance;

    doStart = async () => toonNode.start();
    doStop = async () => toonNode.stop();
  } else if (autoCreateConnector) {
    // --- AUTO-CREATE EMBEDDED MODE: deferred ConnectorNode creation in doStart() ---

    // Create placeholder bootstrap/discovery instances (wired during start)
    bootstrapServiceInstance = new BootstrapService(
      {
        knownPeers: config.knownPeers ?? [],
        ardriveEnabled: config.ardriveEnabled ?? false,
        defaultRelayUrl: config.relayUrl ?? '',
        settlementInfo: effectiveSettlementInfo,
        ownIlpAddress: ilpInfo.ilpAddress,
        toonEncoder: encoder,
        toonDecoder: decoder,
        basePricePerByte: config.basePricePerByte ?? 10n,
      },
      config.secretKey,
      ilpInfo
    );

    discoveryTrackerInstance = createDiscoveryTracker({
      secretKey: config.secretKey,
      settlementInfo: effectiveSettlementInfo,
    });

    // Placeholder clients (replaced during start)
    ilpClient = {
      sendIlpPacket: () =>
        Promise.reject(new NodeError('Node not started. Call start() first.')),
    };
    adminClient = {
      addPeer: () => Promise.resolve(),
      removePeer: () => Promise.resolve(),
    };

    trackerRef.current = discoveryTrackerInstance;

    doStart = async () => {
      // Dynamic import to keep @toon-protocol/connector as optional peer dep
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      let ConnectorNodeClass: typeof import('@toon-protocol/connector').ConnectorNode;
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      let createConnectorLogger: typeof import('@toon-protocol/connector').createLogger;
      try {
        const mod = await import('@toon-protocol/connector');
        ConnectorNodeClass = mod.ConnectorNode;
        createConnectorLogger = mod.createLogger;
      } catch {
        throw new NodeError(
          'Auto-create connector requires @toon-protocol/connector as a peer dependency. ' +
            'Install it with: pnpm add @toon-protocol/connector'
        );
      }

      const nodeId = `toon-${pubkey.slice(0, 16)}`;
      const btpServerPort = config.btpServerPort ?? 3000;
      const connectorLogger = createConnectorLogger(nodeId, 'warn');

      // Derive settlement private key from identity if not explicitly set
      let settlementPrivateKey = config.settlementPrivateKey;
      if (!settlementPrivateKey) {
        const keyBuffer = Buffer.from(config.secretKey);
        settlementPrivateKey = `0x${keyBuffer.toString('hex')}`;
        keyBuffer.fill(0);
      }

      const hasSettlementAddresses =
        chainConfig.registryAddress && chainConfig.tokenNetworkAddress;

      autoCreatedConnector = new ConnectorNodeClass(
        {
          nodeId,
          btpServerPort,
          environment: 'development' as const,
          deploymentMode: 'embedded' as const,
          peers: [],
          routes: [],
          localDelivery: { enabled: false },
          ...(hasSettlementAddresses && {
            settlementInfra: {
              enabled: true,
              rpcUrl: chainConfig.rpcUrl,
              registryAddress: chainConfig.registryAddress,
              tokenAddress: chainConfig.usdcAddress,
              privateKey: settlementPrivateKey,
            },
          }),
        },
        connectorLogger
      );

      await autoCreatedConnector.start();

      // Now wire the real connector into createToonNode
      const connector =
        autoCreatedConnector as unknown as EmbeddableConnectorLike;
      const toonNode = createToonNode({
        connector,
        handlePacket: pipelinedHandler,
        secretKey: config.secretKey,
        ilpInfo,
        toonEncoder: encoder,
        toonDecoder: decoder,
        relayUrl: config.relayUrl,
        knownPeers: config.knownPeers,
        settlementInfo: effectiveSettlementInfo,
        basePricePerByte: config.basePricePerByte,
        ardriveEnabled: config.ardriveEnabled,
      });

      // Replace placeholder clients with real ones
      ilpClient = toonNode.ilpClient;
      channelClient = toonNode.channelClient;

      // Wire bootstrap and discovery with the real admin client
      bootstrapServiceInstance.setIlpClient(toonNode.ilpClient);
      bootstrapServiceInstance.setConnectorAdmin({
        addPeer: () => Promise.resolve(),
        removePeer: () => Promise.resolve(),
      });
      if (toonNode.channelClient) {
        bootstrapServiceInstance.setChannelClient(toonNode.channelClient);
      }

      discoveryTrackerInstance.setConnectorAdmin({
        addPeer: () => Promise.resolve(),
        removePeer: () => Promise.resolve(),
      });
      if (toonNode.channelClient) {
        discoveryTrackerInstance.setChannelClient(toonNode.channelClient);
      }

      trackerRef.current = discoveryTrackerInstance;

      // Add self-routes for all addresses (Task 5.3)
      for (const addr of ilpInfo.ilpAddresses) {
        autoCreatedConnector.addRoute({
          prefix: addr,
          nextHop: nodeId,
          priority: 100,
        });
      }

      // Start the toonNode (wires packet handler, runs bootstrap)
      const result = await toonNode.start();
      return result;
    };

    doStop = async () => {
      if (autoCreatedConnector) {
        await autoCreatedConnector.stop();
        autoCreatedConnector = null;
      }
    };
  } else {
    // --- STANDALONE MODE: manual composition with HTTP clients ---
    const connectorUrl = config.connectorUrl as string;
    const handlerPort = config.handlerPort as number;

    ilpClient = createHttpIlpClient(connectorUrl);
    adminClient = createHttpConnectorAdmin(connectorUrl, '');

    // Channel client via HTTP if settlement is configured
    if (effectiveSettlementInfo) {
      channelClient = createHttpChannelClient(connectorUrl);
    }

    // Create BootstrapService
    bootstrapServiceInstance = new BootstrapService(
      {
        knownPeers: config.knownPeers ?? [],
        ardriveEnabled: config.ardriveEnabled ?? false,
        defaultRelayUrl: config.relayUrl ?? '',
        settlementInfo: effectiveSettlementInfo,
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
      settlementInfo: effectiveSettlementInfo,
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
              if (
                request.amount === undefined ||
                request.amount === null ||
                request.destination === undefined ||
                request.destination === null ||
                request.data === undefined ||
                request.data === null
              ) {
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
  let lastBootstrapResults: BootstrapResult[] = [];

  // 11. Build and return ServiceNode
  const node: ServiceNode = {
    get pubkey() {
      return pubkey;
    },
    get evmAddress() {
      return evmAddress;
    },
    get connector() {
      return (
        config.connector ??
        (autoCreatedConnector as unknown as EmbeddableConnectorLike) ??
        null
      );
    },
    get channelClient() {
      return channelClient;
    },

    getSkillDescriptor(): SkillDescriptor | undefined {
      return buildSkillDescriptor(registry, {
        basePricePerByte: config.basePricePerByte ?? 10n,
        kindPricing: config.kindPricing,
        ...config.skillConfig,
      });
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
        lastBootstrapResults = result.bootstrapResults;
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
      options?: { destination: string; amount?: bigint; bid?: bigint }
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

        // Resolve intermediary routing fees from discovered peers
        const { hopFees, warnings } = resolveRouteFees({
          destination: options.destination,
          ownIlpAddress: ilpInfo.ilpAddress,
          discoveredPeers: discoveryTrackerInstance.getAllDiscoveredPeers(),
        });

        // Log warnings about unknown intermediaries
        for (const warning of warnings) {
          console.warn(`[publishEvent] ${warning}`);
        }

        // Compute destination amount: use override or default basePricePerByte * bytes
        const destinationAmount =
          options.amount ??
          (config.basePricePerByte ?? 10n) * BigInt(toonData.length);

        // Bid safety cap: if bid is provided, reject if destination amount exceeds bid
        if (options.bid !== undefined && destinationAmount > options.bid) {
          throw new NodeError(
            `Cannot publish: destination amount ${destinationAmount} exceeds bid safety cap ${options.bid}`
          );
        }

        // Compute total amount: destination amount + intermediary route fees
        let amount: bigint;
        if (options.amount !== undefined) {
          // When amount override is provided, add only hop fees (no basePricePerByte)
          const hopFeesTotal = calculateRouteAmount({
            basePricePerByte: 0n,
            packetByteLength: toonData.length,
            hopFees,
          });
          amount = options.amount + hopFeesTotal;
        } else {
          // Default: basePricePerByte * bytes + hop fees
          amount = calculateRouteAmount({
            basePricePerByte: config.basePricePerByte ?? 10n,
            packetByteLength: toonData.length,
            hopFees,
          });
        }

        // Build ILP PREPARE packet using shared construction (packet equivalence
        // with x402 rail -- the destination relay cannot distinguish between
        // packets sent via publishEvent() and the x402 /publish endpoint).
        const packet = buildIlpPrepare({
          destination: options.destination,
          amount,
          data: toonData,
        });

        // Send via ILP client
        const result = await ilpClient.sendIlpPacket(packet);

        // Map IlpSendResult to PublishEventResult
        if (result.accepted) {
          return {
            success: true,
            eventId: event.id,
            ...(result.data !== undefined ? { data: result.data } : {}),
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

    async publishFeedback(
      requestEventId: string,
      customerPubkey: string,
      status: DvmJobStatus,
      content?: string,
      options?: { destination: string }
    ): Promise<PublishEventResult> {
      // Build Kind 7000 feedback event using provider's secretKey
      const feedbackEvent = buildJobFeedbackEvent(
        { requestEventId, customerPubkey, status, content },
        config.secretKey
      );

      // Delegate to publishEvent() for TOON encoding, pricing, and ILP delivery
      return node.publishEvent(feedbackEvent, options);
    },

    async publishResult(
      requestEventId: string,
      customerPubkey: string,
      amount: string,
      content: string,
      options?: { destination: string; kind?: number }
    ): Promise<PublishEventResult> {
      // Default result kind is 6100 (text generation result = 5100 + 1000)
      const resultKind = options?.kind ?? 6100;

      // Build Kind 6xxx result event using provider's secretKey
      const resultEvent = buildJobResultEvent(
        { kind: resultKind, requestEventId, customerPubkey, amount, content },
        config.secretKey
      );

      // Delegate to publishEvent() for TOON encoding, pricing, and ILP delivery
      return node.publishEvent(resultEvent, options);
    },

    async settleCompute(
      resultEvent: NostrEvent,
      providerIlpAddress: string,
      options?: { originalBid?: string }
    ): Promise<IlpSendResult> {
      // Deprecation warning
      console.warn(
        '[settleCompute] DEPRECATED: Use publishEvent() with { amount } option instead. The prepaid model sends job request + payment in one packet.'
      );

      // Guard: node must be started
      if (!started) {
        throw new NodeError(
          'Cannot settle compute: node not started. Call start() first.'
        );
      }

      // Guard: providerIlpAddress must be a non-empty, non-whitespace string
      if (
        !providerIlpAddress ||
        typeof providerIlpAddress !== 'string' ||
        providerIlpAddress.trim() === ''
      ) {
        throw new NodeError(
          "Cannot settle compute: providerIlpAddress is required. Resolve it from the provider's kind:10035 service discovery event."
        );
      }

      // Extract amount from result event via parseJobResult()
      const parsed = parseJobResult(resultEvent);
      if (!parsed) {
        throw new NodeError(
          'Cannot settle compute: failed to parse result event. Ensure the event is a valid Kind 6xxx with an amount tag.'
        );
      }

      const computeAmount = parsed.amount;

      // Validate computeAmount is a valid non-negative numeric string before any
      // further processing. Without this, a non-numeric amount would propagate to
      // ilpClient.sendIlpPacket() and cause a BootstrapError instead of a clear
      // NodeError. Negative amounts would cause undefined behavior in the ILP layer.
      let amountBigInt: bigint;
      try {
        amountBigInt = BigInt(computeAmount);
      } catch {
        throw new NodeError(
          `Cannot settle compute: result event amount ('${computeAmount}') is not a valid numeric string.`
        );
      }
      if (amountBigInt < 0n) {
        throw new NodeError(
          `Cannot settle compute: result event amount ('${computeAmount}') must be non-negative.`
        );
      }

      // E5-R005 bid validation: if originalBid is provided, validate amount <= bid
      if (options?.originalBid !== undefined) {
        let bidBigInt: bigint;
        try {
          bidBigInt = BigInt(options.originalBid);
        } catch {
          throw new NodeError(
            `Cannot settle compute: originalBid ('${options.originalBid}') is not a valid numeric string.`
          );
        }
        if (amountBigInt > bidBigInt) {
          throw new NodeError(
            `Cannot settle compute: result amount (${computeAmount}) exceeds original bid (${options.originalBid}). Potential provider overcharge.`
          );
        }
      }

      // Send pure ILP value transfer (empty data = no event payload)
      // This is a payment-only operation -- no TOON encoding, no relay write.
      return ilpClient.sendIlpPacket({
        destination: providerIlpAddress,
        amount: computeAmount,
        data: '',
      });
    },

    // Task 6.3: Address lifecycle management for multi-peered nodes
    addUpstreamPeer(upstreamPrefix: string): void {
      const derivedAddress = deriveChildAddress(upstreamPrefix, pubkey);

      // Check for collision against existing addresses
      checkAddressCollision(derivedAddress, addressRegistry.getAddresses());

      // Update registry
      addressRegistry.addAddress(upstreamPrefix, derivedAddress);

      // Update ilpInfo for kind:10032 republication
      ilpInfo.ilpAddresses = addressRegistry.getAddresses();
      ilpInfo.ilpAddress =
        addressRegistry.getPrimaryAddress() ?? ilpInfo.ilpAddress;

      // Register self-route in embedded connector (if available)
      if (autoCreatedConnector) {
        const nodeId = `toon-${pubkey.slice(0, 16)}`;
        autoCreatedConnector.addRoute({
          prefix: derivedAddress,
          nextHop: nodeId,
          priority: 100,
        });
      }

      // Trigger kind:10032 republication to propagate updated address list
      if (started && lastBootstrapResults.length > 0) {
        void bootstrapServiceInstance.republish(lastBootstrapResults);
      }
    },

    removeUpstreamPeer(upstreamPrefix: string): void {
      // Guard: cannot remove the last address -- a node must always have at least one
      // ILP address (AC #3: empty ilpAddresses array is rejected at construction time).
      if (
        addressRegistry.hasPrefix(upstreamPrefix) &&
        addressRegistry.size <= 1
      ) {
        throw new NodeError(
          'Cannot remove last upstream peer: a node must have at least one ILP address'
        );
      }

      const removedAddress = addressRegistry.removeAddress(upstreamPrefix);
      if (removedAddress === undefined) {
        return; // No-op if prefix not found
      }

      // Update ilpInfo for kind:10032 republication
      ilpInfo.ilpAddresses = addressRegistry.getAddresses();
      const newPrimary = addressRegistry.getPrimaryAddress();
      if (newPrimary !== undefined) {
        ilpInfo.ilpAddress = newPrimary;
      }

      // Remove self-route from embedded connector (if available)
      if (autoCreatedConnector && autoCreatedConnector.removeRoute) {
        autoCreatedConnector.removeRoute(removedAddress);
      }

      // Trigger kind:10032 republication to propagate updated address list
      if (started && lastBootstrapResults.length > 0) {
        void bootstrapServiceInstance.republish(lastBootstrapResults);
      }
    },

    async claimPrefix(
      prefix: string,
      upstreamDestination: string,
      options?: { prefixPrice?: bigint }
    ): Promise<PublishEventResult> {
      // Guard: node must be started
      if (!started) {
        throw new NodeError(
          'Cannot claim prefix: node not started. Call start() first.'
        );
      }

      // Validate prefix format before sending payment (fail-fast, like bid safety cap)
      const prefixValidation = validatePrefix(prefix);
      if (!prefixValidation.valid) {
        throw new NodeError(
          `Cannot claim prefix: ${prefixValidation.reason ?? 'invalid prefix'}`
        );
      }

      // Determine the amount: explicit override, or look up upstream's prefixPricing
      let claimAmount = options?.prefixPrice;
      if (claimAmount === undefined) {
        // Look up from discovered peers
        const peers = discoveryTrackerInstance.getAllDiscoveredPeers();
        const upstreamPeer = peers.find(
          (p) =>
            p.peerInfo.ilpAddress === upstreamDestination ||
            (p.peerInfo.ilpAddresses &&
              p.peerInfo.ilpAddresses.includes(upstreamDestination))
        );
        if (upstreamPeer?.peerInfo.prefixPricing?.basePrice) {
          claimAmount = BigInt(upstreamPeer.peerInfo.prefixPricing.basePrice);
        } else {
          throw new NodeError(
            'Cannot claim prefix: no amount provided and upstream peer prefix pricing not found in discovery'
          );
        }
      }

      // Build the prefix claim event
      const claimEvent = buildPrefixClaimEvent(
        { requestedPrefix: prefix },
        config.secretKey
      );

      // Delegate to publishEvent with the amount override
      return node.publishEvent(claimEvent, {
        destination: upstreamDestination,
        amount: claimAmount,
      });
    },
  };

  return node;
}
