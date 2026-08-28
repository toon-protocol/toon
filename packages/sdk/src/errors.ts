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

/**
 * Error thrown when NIP-59 gift wrap or NIP-44 FULFILL encryption operations fail.
 * Used for wrap/unwrap failures, decryption errors, and malformed gift wrap events.
 */
export class GiftWrapError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'GIFT_WRAP_ERROR', cause);
    this.name = 'GiftWrapError';
  }
}

/**
 * Error thrown by `applyRate()` (rate-conversion errors: invalid format,
 * zero, overflow guards). Originally also covered the legacy swap handler's
 * issuer-boundary failures; that handler was withdrawn by toon#211 (ADR 0003
 * stage 7), but the class name is kept — `applyRate` is path-agnostic and
 * shared by the rolling swap engine, so the error's identity is now tied to
 * the primitive, not the handler that used to house it.
 */
export class SwapHandlerError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'SWAP_HANDLER_ERROR', cause);
    this.name = 'SwapHandlerError';
  }
}

/**
 * Error thrown by the sender-side `buildSettlementTx()` helper (Story 12.6).
 *
 * Settlement is a post-swap one-shot computation, so this error class is
 * THROWN synchronously. Callers are expected to wrap the call in
 * `try/catch`.
 *
 * Narrow `code` union lets callers branch on cause — see
 * `_bmad-output/implementation-artifacts/12-6-build-settlement-tx.md` AC-11
 * for the per-code semantics.
 *
 * @since 12.6
 * @stable — Epic 13 Chain Bridge DVM depends on this error shape.
 */
export class SettlementTxError extends Error {
  readonly code:
    | 'INVALID_INPUT'
    | 'MISSING_SETTLEMENT_METADATA'
    | 'UNSUPPORTED_CHAIN'
    | 'MISSING_RECIPIENT'
    | 'RECIPIENT_MISMATCH'
    | 'SWAP_SIGNER_MISMATCH'
    | 'DUPLICATE_NONCE'
    | 'NON_MONOTONIC_CUMULATIVE'
    | 'INVALID_SIGNATURE_LENGTH'
    | 'INVALID_SIGNATURE_V'
    | 'ENCODING_FAILED';
  declare readonly cause?: unknown;

  constructor(
    code: SettlementTxError['code'],
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message);
    this.name = 'SettlementTxError';
    this.code = code;
    if (options && 'cause' in options) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
}
