/**
 * TypeScript interfaces for ILP-related Nostr events.
 */

/**
 * ILP Peer Info - Published as kind 10032 event.
 * Contains information needed to establish an ILP peering relationship.
 */
export interface IlpPeerInfo {
  /** Nostr pubkey of the peer (64-char hex) */
  pubkey?: string;
  /** ILP address of the peer's connector (e.g., "g.example.connector") */
  ilpAddress: string;
  /** All ILP addresses of this peer (one per upstream peering). When absent (pre-Epic-7 events), consumers should default to [ilpAddress]. */
  ilpAddresses?: string[];
  /** BTP WebSocket endpoint URL for packet exchange (pay-per-event writes) */
  btpEndpoint: string;
  /**
   * ILP-over-HTTP endpoint URL (RFC-0035) for stateless, one-shot writes:
   * `POST` an ILP PREPARE here and receive a FULFILL/REJECT body. Suited to
   * pure consumers, browsers, and NAT'd agents that don't need a duplex BTP
   * session. Absent when the node only exposes BTP. The same host typically
   * also accepts an HTTP `Upgrade` to BTP — see {@link supportsUpgrade}.
   */
  httpEndpoint?: string;
  /**
   * Whether `httpEndpoint`'s host accepts an HTTP `Upgrade` to a BTP/WebSocket
   * session (`Sec-WebSocket-Protocol: btp`). Lets a client start on
   * ILP-over-HTTP and upgrade to duplex BTP when it becomes a peer or needs
   * server-initiated packets, carrying its HTTP-proven identity across.
   */
  supportsUpgrade?: boolean;
  /**
   * Public Nostr relay WebSocket URL for FREE reads (e.g. `wss://<addr>.anyone/`
   * or `ws://host:7100`). Lets a client discover where to subscribe/read without
   * out-of-band config. Absent when the relay isn't publicly exposed.
   */
  relayUrl?: string;
  /** Optional BLS HTTP endpoint for direct packet delivery (bootstrap only) */
  blsHttpEndpoint?: string;
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
  /** Routing fee per byte charged by this node as an intermediary, serialized as a non-negative integer string (e.g., '2'). Defaults to '0' (free routing) when absent. */
  feePerByte?: string;
  /** Prefix pricing for prefix claim marketplace. basePrice is in USDC micro-units as a non-negative integer string. */
  prefixPricing?: { basePrice: string };
  /** Token pairs this peer can swap, with current rates. Absent = no swap support. */
  swapPairs?: SwapPair[];
}

/**
 * Declarative advertisement of a token swap pair supported by a swap-capable peer (Mill).
 *
 * Source and target assets use the same `{blockchain}:{network}[:{chainId}]` chain format
 * as `IlpPeerInfo.supportedChains`. Rate is serialized as a decimal string (not a float) to
 * preserve arbitrary precision — D12-006. Min/max amounts are source-asset micro-unit integer
 * strings that may exceed `Number.MAX_SAFE_INTEGER`; compare via `BigInt`.
 */
export interface SwapPair {
  /** Source asset */
  from: { assetCode: string; assetScale: number; chain: string };
  /** Target asset */
  to: { assetCode: string; assetScale: number; chain: string };
  /** Exchange rate as decimal string (target units per source unit) */
  rate: string;
  /** Minimum swap amount per packet in source asset micro-units (optional) */
  minAmount?: string;
  /** Maximum swap amount per packet in source asset micro-units (optional) */
  maxAmount?: string;
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
  /**
   * On-chain channel `depositTotal` (base units), read at open time. Only
   * surfaced by the Mina opener: the Mina balance-proof signer must bind
   * `balanceB = depositTotal − balanceA` so the on-chain `claimFromChannel`
   * signatureA check passes (toon-protocol/connector#133). Left undefined by the
   * EVM and Solana openers, which do not need it.
   */
  depositTotal?: bigint;
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
 * TEE Attestation content for kind:10033 events (Pattern 14).
 * Contains attestation data from a Trusted Execution Environment.
 */
export interface TeeAttestation {
  /** Enclave type identifier (e.g., 'aws-nitro', 'marlin-oyster'). */
  enclave: string;
  /** Platform Configuration Register 0 (SHA-384 hex, 96 chars). */
  pcr0: string;
  /** Platform Configuration Register 1 (SHA-384 hex, 96 chars). */
  pcr1: string;
  /** Platform Configuration Register 2 (SHA-384 hex, 96 chars). */
  pcr2: string;
  /** Base64-encoded attestation document from the TEE platform. */
  attestationDoc: string;
  /** Attestation format version. */
  version: string;
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
