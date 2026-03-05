/**
 * Shared validation utilities for the TOON codec.
 */

/**
 * Validate that a value is a valid hex string of expected length.
 *
 * @param value - The value to check
 * @param length - The expected string length (number of hex characters)
 * @returns True if value is a hex string of the expected length
 */
export function isValidHex(value: unknown, length: number): value is string {
  if (typeof value !== 'string') return false;
  if (value.length !== length) return false;
  return /^[0-9a-f]+$/i.test(value);
}
