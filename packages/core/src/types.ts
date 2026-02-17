/**
 * TypeScript interfaces for ILP-related Nostr events.
 */

/**
 * ILP Peer Info - Published as kind 10032 event.
 * Contains information needed to establish an ILP peering relationship.
 */
export interface IlpPeerInfo {
  /** ILP address of the peer's connector (e.g., "g.example.connector") */
  ilpAddress: string;
  /** BTP WebSocket endpoint URL for packet exchange */
  btpEndpoint: string;
  /** @deprecated Use supportedChains instead. Kept for backward compatibility. */
  settlementEngine?: string;
  /** Asset code for the peering relationship (e.g., "USD", "XRP") */
  assetCode: string;
  /** Asset scale - number of decimal places (e.g., 9 for XRP, 6 for USD cents) */
  assetScale: number;
  /** Supported settlement chain identifiers in {blockchain}:{network}:{chainId} format (e.g., ["evm:base:8453", "xrp:mainnet"]) */
  supportedChains?: string[];
  /** Maps chain identifier to the peer's settlement address on that chain */
  settlementAddresses?: Record<string, string>;
  /** Maps chain identifier to preferred token contract address */
  preferredTokens?: Record<string, string>;
  /** Maps chain identifier to TokenNetwork contract address (EVM-specific) */
  tokenNetworks?: Record<string, string>;
}

/**
 * SPSP Info - Published as kind 10047 event.
 * Contains static SPSP parameters for receiving payments.
 */
export interface SpspInfo {
  /** ILP address to send payment to */
  destinationAccount: string;
  /** Base64-encoded shared secret for STREAM protocol */
  sharedSecret: string;
}

/**
 * SPSP Request - Published as kind 23194 ephemeral event.
 * Request for fresh SPSP parameters from a receiver.
 */
export interface SpspRequest {
  /** Unique request identifier for correlation */
  requestId: string;
  /** Unix timestamp of the request */
  timestamp: number;
  /** The requester's ILP address for the responder to identify who is requesting */
  ilpAddress?: string;
  /** Chain identifiers the requester supports (e.g., ["evm:base:8453", "xrp:mainnet"]) */
  supportedChains?: string[];
  /** Maps chain identifier to the requester's settlement address on that chain */
  settlementAddresses?: Record<string, string>;
  /** Maps chain identifier to the requester's preferred token contract address */
  preferredTokens?: Record<string, string>;
}

/**
 * SPSP Response - Published as kind 23195 ephemeral event.
 * Response containing fresh SPSP parameters.
 */
export interface SpspResponse {
  /** Matching request identifier */
  requestId: string;
  /** ILP address to send payment to */
  destinationAccount: string;
  /** Base64-encoded shared secret for STREAM protocol */
  sharedSecret: string;
  /** The agreed-upon chain identifier (e.g., "evm:base:8453") */
  negotiatedChain?: string;
  /** The responder's settlement address on the negotiated chain */
  settlementAddress?: string;
  /** Token contract address on the negotiated chain (EVM) */
  tokenAddress?: string;
  /** TokenNetwork contract address on the negotiated chain (EVM) */
  tokenNetworkAddress?: string;
  /** Payment channel ID if opened during handshake */
  channelId?: string;
  /** Challenge period in seconds */
  settlementTimeout?: number;
}

/**
 * Subscription handle for real-time event updates.
 * Returned by subscription methods to allow cleanup.
 */
export interface Subscription {
  /** Stops receiving updates and closes the underlying relay subscription */
  unsubscribe(): void;
}

/**
 * Parameters for opening a payment channel via the connector Admin API.
 */
export interface OpenChannelParams {
  /** Connector peer identifier */
  peerId: string;
  /** Settlement chain identifier (e.g., "evm:base:8453") */
  chain: string;
  /** Token contract address on the chain */
  token?: string;
  /** TokenNetwork contract address (EVM-specific) */
  tokenNetwork?: string;
  /** Peer's settlement address on the chain */
  peerAddress: string;
  /** Initial deposit amount */
  initialDeposit?: string;
  /** Challenge period in seconds */
  settlementTimeout?: number;
}

/**
 * Result of opening a payment channel.
 */
export interface OpenChannelResult {
  /** Unique channel identifier */
  channelId: string;
  /** Channel status after open request */
  status: string;
}

/**
 * State of a payment channel from the connector.
 */
export interface ChannelState {
  /** Unique channel identifier */
  channelId: string;
  /** Current channel status */
  status: 'opening' | 'open' | 'closed' | 'settled';
  /** Settlement chain identifier */
  chain: string;
}

/**
 * Interface for interacting with the connector's channel Admin API.
 * Abstracts POST /admin/channels and GET /admin/channels/:channelId.
 */
export interface ConnectorChannelClient {
  /** Opens a new payment channel via POST /admin/channels */
  openChannel(params: OpenChannelParams): Promise<OpenChannelResult>;
  /** Gets channel state via GET /admin/channels/:channelId */
  getChannelState(channelId: string): Promise<ChannelState>;
}

/**
 * Configuration for settlement negotiation in the SPSP server.
 */
export interface SettlementNegotiationConfig {
  /** Chains the server supports */
  ownSupportedChains: string[];
  /** Server's settlement addresses by chain */
  ownSettlementAddresses: Record<string, string>;
  /** Server's preferred token addresses by chain */
  ownPreferredTokens?: Record<string, string>;
  /** Server's TokenNetwork contract addresses by chain (EVM only) */
  ownTokenNetworks?: Record<string, string>;
  /** Initial deposit amount (default: "0") */
  initialDeposit?: string;
  /** Challenge period in seconds (default: 86400) */
  settlementTimeout?: number;
  /** Max time in ms to wait for channel to become open (default: 30000) */
  channelOpenTimeout?: number;
  /** Polling interval in ms for checking channel state (default: 1000) */
  pollInterval?: number;
}

/**
 * Result of a successful settlement negotiation, included in SPSP response.
 */
export interface SettlementNegotiationResult {
  /** The agreed-upon chain identifier */
  negotiatedChain: string;
  /** The responder's settlement address on the negotiated chain */
  settlementAddress: string;
  /** Token contract address on the negotiated chain */
  tokenAddress?: string;
  /** TokenNetwork contract address on the negotiated chain */
  tokenNetworkAddress?: string;
  /** Payment channel ID if opened during handshake */
  channelId?: string;
  /** Challenge period in seconds */
  settlementTimeout?: number;
}

