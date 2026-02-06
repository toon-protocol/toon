/**
 * Custom error classes for @agent-society/core.
 */

/**
 * Base error class for all agent-society errors.
 * Provides a consistent error interface with error codes and cause chaining.
 */
export class AgentSocietyError extends Error {
  public readonly code: string;

  constructor(message: string, code: string, cause?: Error) {
    super(message, { cause });
    this.name = 'AgentSocietyError';
    this.code = code;
  }
}

/**
 * Error thrown when parsing a Nostr event fails.
 * Used for malformed events, wrong kind, invalid JSON, or missing required fields.
 */
export class InvalidEventError extends AgentSocietyError {
  constructor(message: string, cause?: Error) {
    super(message, 'INVALID_EVENT', cause);
    this.name = 'InvalidEventError';
  }
}

/**
 * Error thrown when peer discovery fails.
 * Used for invalid pubkeys or relay failures.
 */
export class PeerDiscoveryError extends AgentSocietyError {
  constructor(message: string, cause?: Error) {
    super(message, 'PEER_DISCOVERY_FAILED', cause);
    this.name = 'PeerDiscoveryError';
  }
}

/**
 * Error thrown when SPSP operations fail.
 * Used for invalid pubkeys or relay failures during SPSP queries.
 */
export class SpspError extends AgentSocietyError {
  constructor(message: string, cause?: Error) {
    super(message, 'SPSP_FAILED', cause);
    this.name = 'SpspError';
  }
}

/**
 * Error thrown when an SPSP request times out waiting for a response.
 */
export class SpspTimeoutError extends AgentSocietyError {
  public readonly recipientPubkey: string;

  constructor(message: string, recipientPubkey: string, cause?: Error) {
    super(message, 'SPSP_TIMEOUT', cause);
    this.name = 'SpspTimeoutError';
    this.recipientPubkey = recipientPubkey;
  }
}

/**
 * Error thrown when trust calculation fails.
 * Used for invalid pubkeys or failures during social graph traversal.
 */
export class TrustCalculationError extends AgentSocietyError {
  constructor(message: string, cause?: Error) {
    super(message, 'TRUST_CALCULATION_FAILED', cause);
    this.name = 'TrustCalculationError';
  }
}
