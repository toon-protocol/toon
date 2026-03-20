/**
 * Custom error classes for @toon-protocol/core.
 */

/**
 * Base error class for all toon errors.
 * Provides a consistent error interface with error codes and cause chaining.
 */
export class ToonError extends Error {
  public readonly code: string;

  constructor(message: string, code: string, cause?: Error) {
    super(message, { cause });
    this.name = 'ToonError';
    this.code = code;
  }
}

/**
 * Error thrown when parsing a Nostr event fails.
 * Used for malformed events, wrong kind, invalid JSON, or missing required fields.
 */
export class InvalidEventError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'INVALID_EVENT', cause);
    this.name = 'InvalidEventError';
  }
}

/**
 * Error thrown when peer discovery fails.
 * Used for invalid pubkeys or relay failures.
 */
export class PeerDiscoveryError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'PEER_DISCOVERY_FAILED', cause);
    this.name = 'PeerDiscoveryError';
  }
}
