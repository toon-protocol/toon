/**
 * Bootstrap state machine types, event types, and client interfaces.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { IlpPeerInfo } from '../types.js';
import type { SpspRequestSettlementInfo } from '../events/builders.js';

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
  /** Channel ID from SPSP FULFILL */
  channelId?: string;
  /** Negotiated chain from settlement negotiation */
  negotiatedChain?: string;
  /** Peer's settlement address */
  settlementAddress?: string;
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
   * Optional — not all callers will implement peer removal.
   * @param peerId - The peer ID to remove
   */
  removePeer?(peerId: string): Promise<void>;
}

/**
 * Bootstrap phase states.
 */
export type BootstrapPhase =
  | 'discovering'
  | 'registering'
  | 'handshaking'
  | 'announcing'
  | 'ready'
  | 'failed';

/**
 * Bootstrap events emitted during the bootstrap lifecycle.
 */
export type BootstrapEvent =
  | { type: 'bootstrap:phase'; phase: BootstrapPhase; previousPhase?: BootstrapPhase }
  | { type: 'bootstrap:peer-registered'; peerId: string; peerPubkey: string; ilpAddress: string }
  | { type: 'bootstrap:channel-opened'; peerId: string; channelId: string; negotiatedChain: string }
  | { type: 'bootstrap:handshake-failed'; peerId: string; reason: string }
  | { type: 'bootstrap:announced'; peerId: string; eventId: string; amount: string }
  | { type: 'bootstrap:announce-failed'; peerId: string; reason: string }
  | { type: 'bootstrap:ready'; peerCount: number; channelCount: number }
  | { type: 'bootstrap:peer-discovered'; peerPubkey: string; ilpAddress: string }
  | { type: 'bootstrap:peer-deregistered'; peerId: string; peerPubkey: string; reason: string };

/**
 * Listener callback for bootstrap events.
 */
export type BootstrapEventListener = (event: BootstrapEvent) => void;

/**
 * Result of sending an ILP packet via agent-runtime POST /ilp/send.
 * Note: agent-runtime may return either `accepted` or `fulfilled` as the
 * success indicator. AgentRuntimeClient normalizes to `accepted`.
 */
export interface IlpSendResult {
  accepted: boolean;
  fulfillment?: string;
  data?: string; // base64-encoded response TOON
  code?: string;
  message?: string;
}

/**
 * Client interface for sending ILP packets via the agent-runtime.
 */
export interface AgentRuntimeClient {
  sendIlpPacket(params: {
    destination: string;
    amount: string;
    data: string; // base64-encoded TOON
    timeout?: number;
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
    },
    claim: any // EVMClaimMessage type from client package
  ): Promise<IlpSendResult>;
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
  /** URL for the agent-runtime POST /ilp/send endpoint */
  agentRuntimeUrl?: string;
  /** Own settlement preferences for SPSP handshakes */
  settlementInfo?: SpspRequestSettlementInfo;
  /** This node's ILP address (for building ILP PREPARE destinations) */
  ownIlpAddress?: string;
  /** DI callback for TOON encoding (avoids circular dep) */
  toonEncoder?: (event: NostrEvent) => Uint8Array;
  /** DI callback for TOON decoding (avoids circular dep) */
  toonDecoder?: (bytes: Uint8Array) => NostrEvent;
  /** Static BTP secret for initial peer registration (before SPSP negotiation) */
  btpSecret?: string;
  /** Base price per byte for ILP packet pricing (default: 10n) */
  basePricePerByte?: bigint;
}

/**
 * Configuration for the RelayMonitor service.
 */
export interface RelayMonitorConfig {
  /** Relay URL to monitor for kind:10032 events */
  relayUrl: string;
  /** Nostr secret key for SPSP requests */
  secretKey: Uint8Array;
  /** DI callback for TOON encoding (avoids circular dep) */
  toonEncoder: (event: NostrEvent) => Uint8Array;
  /** DI callback for TOON decoding (avoids circular dep) */
  toonDecoder: (bytes: Uint8Array) => NostrEvent;
  /** Base price per byte for ILP packet pricing (default: 10n) */
  basePricePerByte?: bigint;
  /** Own settlement preferences for SPSP handshakes */
  settlementInfo?: SpspRequestSettlementInfo;
  /** SPSP handshake timeout in milliseconds (default: 30000) */
  defaultTimeout?: number;
}
