/**
 * createNode() composition for @crosstown/sdk.
 *
 * Wires the full ILP packet processing pipeline:
 *   shallow TOON parse -> Schnorr signature verification -> pricing validation -> handler dispatch
 *
 * Provides start() / stop() lifecycle management by delegating to
 * the core CrosstownNode composition.
 */

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
import type { SpspRequestSettlementInfo } from '@crosstown/core';
import type { SettlementNegotiationConfig } from '@crosstown/core';
import { createCrosstownNode } from '@crosstown/core';
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
 */
export interface NodeConfig {
  /** 32-byte secp256k1 secret key */
  secretKey: Uint8Array;
  /** Embedded connector instance */
  connector: EmbeddableConnectorLike;
  /** ILP address (default: 'g.crosstown.local') */
  ilpAddress?: string;
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
  /** Settlement info for SPSP handshakes */
  settlementInfo?: SpspRequestSettlementInfo;
  /** Enable ArDrive peer lookup */
  ardriveEnabled?: boolean;
  /** Settlement negotiation config for payment channels */
  settlementNegotiationConfig?: SettlementNegotiationConfig;
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
 * A fully wired Crosstown node with lifecycle management.
 */
export interface ServiceNode {
  /** Nostr x-only public key (32 bytes, 64 hex chars) */
  readonly pubkey: string;
  /** EVM address derived from the same secp256k1 key */
  readonly evmAddress: string;
  /** Pass-through to the underlying connector */
  readonly connector: EmbeddableConnectorLike;
  /** Channel client (null if connector lacks channel support) */
  readonly channelClient: ConnectorChannelClient | null;
  /** Register a handler for a specific event kind (builder pattern) */
  on(kind: number, handler: Handler): ServiceNode;
  /** Register a lifecycle event listener */
  on(event: 'bootstrap', listener: BootstrapEventListener): ServiceNode;
  /** Register a default handler for unrecognized kinds (builder pattern) */
  onDefault(handler: Handler): ServiceNode;
  /** Start the node: wire packet handler, run bootstrap, start relay monitor */
  start(): Promise<StartResult>;
  /** Stop the node: unsubscribe relay monitor, clean up lifecycle state */
  stop(): Promise<void>;
  /** Initiate peering with a discovered peer (register + SPSP handshake) */
  peerWith(pubkey: string): Promise<void>;
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
 * Handlers can be registered via config or post-creation .on()/.onDefault().
 */
export function createNode(config: NodeConfig): ServiceNode {
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
      return await registry.dispatch(ctx);
    } catch (err: unknown) {
      // Log only the error message, not the full error object (which may contain payload data)
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Handler dispatch failed:', errMsg);
      return { accept: false, code: 'T00', message: 'Internal error' };
    }
  };

  // 9. Create CrosstownNode from @crosstown/core for bootstrap/relay monitor lifecycle
  const crosstownNode = createCrosstownNode({
    connector: config.connector,
    handlePacket: pipelinedHandler,
    secretKey: config.secretKey,
    ilpInfo: {
      ilpAddress: config.ilpAddress ?? 'g.crosstown.local',
      btpEndpoint: '',
      assetCode: config.assetCode ?? 'USD',
      assetScale: config.assetScale ?? 6,
    },
    toonEncoder: encoder,
    toonDecoder: decoder,
    relayUrl: config.relayUrl,
    knownPeers: config.knownPeers,
    settlementInfo: config.settlementInfo,
    basePricePerByte: config.basePricePerByte,
    ardriveEnabled: config.ardriveEnabled,
    settlementNegotiationConfig: config.settlementNegotiationConfig,
  });

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
      return config.connector;
    },
    get channelClient() {
      return crosstownNode.channelClient;
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
        // Lifecycle event listener -- forward to bootstrapService AND relayMonitor
        const listener = handlerOrListener as BootstrapEventListener;
        crosstownNode.bootstrapService.on(listener);
        crosstownNode.relayMonitor.on(listener);
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
        const result = await crosstownNode.start();
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

      await crosstownNode.stop();
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
      return crosstownNode.peerWith(targetPubkey);
    },
  };

  return node;
}
