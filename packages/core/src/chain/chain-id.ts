/**
 * Chain identifier validation.
 *
 * Shared helper used by `parseIlpPeerInfo` and `swap-pair-validation` to avoid
 * a circular import between `events/parsers.ts` and `events/swap-pair-validation.ts`
 * (Story 12.1 Task 2.2 fallback).
 */

/**
 * Validates a chain identifier string.
 * Valid format: {blockchain}:{network} or {blockchain}:{network}:{chainId}
 * Minimum 2 segments, maximum 3, separated by `:`. All segments must be non-empty.
 *
 * @param chainId - The chain identifier to validate
 * @returns true if the chain identifier is valid
 */
export function validateChainId(chainId: string): boolean {
  if (!chainId) return false;
  const segments = chainId.split(':');
  if (segments.length < 2 || segments.length > 3) return false;
  return segments.every((s) => s.length > 0);
}
