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
