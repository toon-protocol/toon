/**
 * Bootstrap state machine types, event types, and client interfaces.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { IlpPeerInfo } from '../types.js';

/** Regular expression for validating 64-character lowercase hex pubkeys */
export const PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/**
 * A peer discovered via kind:10032 relay events but not yet peered with.
 */
export interface DiscoveredPeer {
  /** Nostr pubkey of the discovered peer (64-char hex) */
  pubkey: string;
  /** Connector peer ID (e.g., "nostr-aabb11cc22dd33ee") */
  peerId: string;
  /** Parsed ILP peer info from the kind:10032 event */
  peerInfo: IlpPeerInfo;
  /** Timestamp (seconds since epoch) when the peer was first discovered */
  discoveredAt: number;
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
 * Result of a successful peer bootstrap.
 */
export interface BootstrapResult {
  /** The known peer that was bootstrapped with */
  knownPeer: KnownPeer;
  /** The peer's ILP info from their kind:10032 event */
  peerInfo: IlpPeerInfo;
  /** The ID used when registering with the connector (e.g., "nostr-aabb11cc22dd33ee") */
  registeredPeerId: string;
  /** Channel ID from unilateral channel opening */
  channelId?: string;
  /** Negotiated chain from local settlement negotiation */
  negotiatedChain?: string;
  /** Peer's settlement address */
  settlementAddress?: string;
  /** Token address for the negotiated chain */
  tokenAddress?: string;
  /** TokenNetwork/program/zkApp address for the negotiated chain */
  tokenNetwork?: string;
}

/**
 * Callback interface for connector Admin API operations.
 * Matches the connector admin API shape: POST /admin/peers
 */
export interface ConnectorAdminClient {
  /**
   * Add a peer to the connector via the admin API.
   * @param config - Peer configuration matching the connector admin API shape
   */
  addPeer(config: {
    id: string;
    url: string;
    authToken: string;
    routes?: { prefix: string; priority?: number }[];
    settlement?: {
      preference: string;
      evmAddress?: string;
      tokenAddress?: string;
      tokenNetworkAddress?: string;
      chainId?: number;
      channelId?: string;
      initialDeposit?: string;
    };
  }): Promise<void>;

  /**
   * Remove a peer from the connector via the admin API.
   * Optional -- not all callers will implement peer removal.
   * @param peerId - The peer ID to remove
   */
  removePeer?(peerId: string): Promise<void>;
}

/**
 * Bootstrap phase states.
 * Two-phase flow: discovering -> registering -> announcing -> ready | failed
 */
export type BootstrapPhase =
  | 'discovering'
  | 'registering'
  | 'announcing'
  | 'ready'
  | 'failed';

/**
 * Bootstrap events emitted during the bootstrap lifecycle.
 */
export type BootstrapEvent =
  | {
      type: 'bootstrap:phase';
      phase: BootstrapPhase;
      previousPhase?: BootstrapPhase;
    }
  | {
      type: 'bootstrap:peer-registered';
      peerId: string;
      peerPubkey: string;
      ilpAddress: string;
    }
  | {
      type: 'bootstrap:channel-opened';
      peerId: string;
      channelId: string;
      negotiatedChain: string;
    }
  | { type: 'bootstrap:settlement-failed'; peerId: string; reason: string }
  | {
      type: 'bootstrap:announced';
      peerId: string;
      eventId: string;
      amount: string;
    }
  | { type: 'bootstrap:announce-failed'; peerId: string; reason: string }
  | { type: 'bootstrap:ready'; peerCount: number; channelCount: number }
  | {
      type: 'bootstrap:peer-discovered';
      peerPubkey: string;
      ilpAddress: string;
    }
  | {
      type: 'bootstrap:peer-deregistered';
      peerId: string;
      peerPubkey: string;
      reason: string;
    };

/**
 * Listener callback for bootstrap events.
 */
export type BootstrapEventListener = (event: BootstrapEvent) => void;

/**
 * Result of sending an ILP packet via the connector.
 * The connector may return either `accepted` or `fulfilled` as the
 * success indicator. IlpClient normalizes to `accepted`.
 */
export interface IlpSendResult {
  accepted: boolean;
  data?: string; // base64-encoded response TOON
  code?: string;
  message?: string;
}

/**
 * Client interface for sending ILP packets via the connector.
 */
export interface IlpClient {
  sendIlpPacket(params: {
    destination: string;
    amount: string;
    data: string; // base64-encoded TOON
    timeout?: number;
    /**
     * Per-packet expiry as an ISO 8601 string. When set, the transport
     * MUST use exactly this expiry for the outgoing PREPARE. When absent,
     * the transport applies its default (timeout-derived).
     */
    expiresAt?: string;
    /**
     * The PREPARE's execution condition, base64-encoded (32 bytes) — the
     * transport MUST forward it verbatim onto the outgoing packet. An absent
     * or all-zero condition is refused outright by a Rust connector (toon#143),
     * so a caller sending a sealed-wire packet (see `@toon-protocol/core/wire`)
     * always sets this.
     */
    executionCondition?: string;
  }): Promise<IlpSendResult>;

  /**
   * Optional: Send ILP packet with signed balance proof claim (BTP only).
   * Falls back to sendIlpPacket if not implemented.
   */
  sendIlpPacketWithClaim?(
    params: {
      destination: string;
      amount: string;
      data: string;
      timeout?: number;
      /** Per-packet expiry as an ISO 8601 string (see sendIlpPacket). */
      expiresAt?: string;
      /** The PREPARE's execution condition, base64-encoded (see sendIlpPacket). */
      executionCondition?: string;
    },
    claim: unknown // EVMClaimMessage type from client package
  ): Promise<IlpSendResult>;
}

/**
 * @deprecated Use IlpClient instead
 */
export type AgentRuntimeClient = IlpClient;

/**
 * The terminating connector's own identity, as `GET /ilp/identity` reports it.
 */
export interface ConnectorEdgeIdentity {
  /** Uncompressed secp256k1 public key — exactly 65 raw bytes, leading 0x04. */
  publicKey: Uint8Array;
}

/**
 * What a locally-terminated route costs, as `GET /ilp/routes/price` reports it.
 */
export interface ConnectorEdgeRoutePrice {
  /** The price in ILP base units of the route asked about. */
  price: bigint;
}

/**
 * A sibling port to {@link IlpClient} (toon#143): who a destination's
 * terminating connector is, and what it charges. ADR 0018 makes holding that
 * connector's public key a precondition of forming a packet at all — a
 * sealed-wire payload (`@toon-protocol/core/wire`'s `sealExchange`) cannot be
 * built without it — and ADR 0020 makes the price something to ASK for, never
 * computed locally.
 *
 * Structural, like every other port in this file: a caller's own
 * `ConnectorEdgeClient` (resolving `destination` to the terminating
 * connector's client-edge endpoint first, per ADR 0022) satisfies this
 * without `core` importing it.
 */
export interface ConnectorEdgeLookup {
  /** The identity of the connector that terminates `destination`. */
  getIdentity(destination: string): Promise<ConnectorEdgeIdentity>;
  /**
   * What sending to `destination` costs, flat per handler (ADR 0020), or
   * `null` when nothing terminated here matches it.
   */
  getRoutePrice(destination: string): Promise<ConnectorEdgeRoutePrice | null>;
}

/**
 * Own settlement configuration for local chain selection during registration.
 */
export interface SettlementConfig {
  /** Chain identifiers this node supports */
  supportedChains?: string[];
  /** Maps chain identifier to this node's settlement address */
  settlementAddresses?: Record<string, string>;
  /** Maps chain identifier to this node's preferred token contract address */
  preferredTokens?: Record<string, string>;
  /** Maps chain identifier to TokenNetwork contract address (EVM only) */
  tokenNetworks?: Record<string, string>;
}

/**
 * Base configuration for the bootstrap service.
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
 * Extended configuration for the bootstrap service with ILP-first flow support.
 */
export interface BootstrapServiceConfig extends BootstrapConfig {
  /** Own settlement preferences for settlement during peer registration */
  settlementInfo?: SettlementConfig;
  /** This node's ILP address (for building ILP PREPARE destinations) */
  ownIlpAddress?: string;
  /** DI callback for TOON encoding (avoids circular dep) */
  toonEncoder?: (event: NostrEvent) => Uint8Array;
  /** DI callback for TOON decoding (avoids circular dep) */
  toonDecoder?: (bytes: Uint8Array) => NostrEvent;
  /** Static BTP secret for initial peer registration (before settlement) */
  btpSecret?: string;
  /**
   * @deprecated No longer multiplied by the announce payload's byte length
   * (toon#143 — ADR 0020 makes the announce packet's amount something ASKED
   * for via {@link connectorEdgeLookup}, not computed locally). When set, it
   * is used verbatim as an explicit override of the announce amount instead
   * of the asked-for route price; leave unset to always ask.
   */
  basePricePerByte?: bigint;
  /**
   * Identity + price lookup for the connector terminating a peer's
   * `ilpAddress` (toon#143). Required for `announceViaIlp` to seal its
   * packet (ADR 0018/0019/0020); when absent, the announce phase is skipped
   * entirely rather than sending an unsealed packet with no condition.
   */
  connectorEdgeLookup?: ConnectorEdgeLookup;
}
