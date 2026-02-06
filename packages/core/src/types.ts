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
  /** Optional settlement engine identifier (e.g., "xrp-paychan", "eth-unidirectional") */
  settlementEngine?: string;
  /** Asset code for the peering relationship (e.g., "USD", "XRP") */
  assetCode: string;
  /** Asset scale - number of decimal places (e.g., 9 for XRP, 6 for USD cents) */
  assetScale: number;
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
 * Configuration for trust score calculation weights and thresholds.
 */
export interface TrustConfig {
  /** Weight for social distance component (0-1) */
  socialDistanceWeight: number;
  /** Weight for mutual followers component (0-1) */
  mutualFollowersWeight: number;
  /** Weight for reputation component (0-1) */
  reputationWeight: number;
  /** Social distance beyond which trust = 0 (default: 3) */
  maxSocialDistance: number;
  /** Mutual follower count for maximum contribution (default: 10) */
  maxMutualFollowers: number;
}

/**
 * Breakdown of individual component scores in trust calculation.
 */
export interface TrustBreakdown {
  /** Score contribution from social distance (0-1) */
  socialDistanceScore: number;
  /** Score contribution from mutual followers (0-1) */
  mutualFollowersScore: number;
  /** Score contribution from reputation (0-1) */
  reputationScore: number;
}

/**
 * Result of trust score calculation between two pubkeys.
 */
export interface TrustScore {
  /** Overall trust score (0-1), where 1.0 = maximum trust */
  score: number;
  /** Raw social distance (hops in follow graph) */
  socialDistance: number;
  /** Count of mutual followers */
  mutualFollowerCount: number;
  /** Component score breakdown */
  breakdown: TrustBreakdown;
}

/**
 * Configuration for mapping trust scores to ILP credit limits.
 */
export interface CreditLimitConfig {
  /** Maximum credit limit in asset units */
  maxCredit: number;
  /** Minimum credit limit in asset units */
  minCredit: number;
  /** Mapping function type: linear or exponential */
  curve: 'linear' | 'exponential';
}
