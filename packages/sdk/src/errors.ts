/**
 * SDK-specific error classes for @toon-protocol/sdk.
 * All errors extend ToonError from @toon-protocol/core for a consistent error hierarchy.
 */

import { ToonError } from '@toon-protocol/core';

/**
 * Error thrown when identity operations fail.
 * Used for invalid mnemonics, invalid secret keys, and key derivation failures.
 */
export class IdentityError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'IDENTITY_ERROR', cause);
    this.name = 'IdentityError';
  }
}

/**
 * Error thrown when node lifecycle operations fail.
 * Used for start/stop failures, configuration errors, etc.
 */
export class NodeError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'NODE_ERROR', cause);
    this.name = 'NodeError';
  }
}

/**
 * Error thrown when handler dispatch operations fail.
 * Used for handler registration conflicts, missing handlers, and dispatch errors.
 */
export class HandlerError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'HANDLER_ERROR', cause);
    this.name = 'HandlerError';
  }
}

/**
 * Error thrown when Schnorr signature verification fails.
 * Used for invalid signatures, malformed events, and verification pipeline errors.
 */
export class VerificationError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'VERIFICATION_ERROR', cause);
    this.name = 'VerificationError';
  }
}

/**
 * Error thrown when payment validation fails.
 * Used for pricing calculation errors, insufficient payment, and pricing policy violations.
 */
export class PricingError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'PRICING_ERROR', cause);
    this.name = 'PricingError';
  }
}
