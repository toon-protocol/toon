/**
 * JSON utilities for handling special types like BigInt
 */

/**
 * Replacer function for JSON.stringify() that converts BigInt to string.
 * BigInt values are serialized as strings with a '__bigint__' marker.
 *
 * @example
 * ```typescript
 * const obj = { amount: 1000n, nonce: 5n };
 * const json = JSON.stringify(obj, bigIntReplacer);
 * // Result: '{"amount":"__bigint__1000","nonce":"__bigint__5"}'
 * ```
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return `__bigint__${value.toString()}`;
  }
  return value;
}

/**
 * Reviver function for JSON.parse() that converts string-encoded BigInt back to BigInt.
 * Looks for strings with '__bigint__' prefix and converts them back.
 *
 * @example
 * ```typescript
 * const json = '{"amount":"__bigint__1000","nonce":"__bigint__5"}';
 * const obj = JSON.parse(json, bigIntReviver);
 * // Result: { amount: 1000n, nonce: 5n }
 * ```
 */
export function bigIntReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('__bigint__')) {
    return BigInt(value.slice(10)); // Remove '__bigint__' prefix
  }
  return value;
}

/**
 * JSON.stringify with BigInt support.
 *
 * @param value - The value to stringify
 * @param space - Optional indentation (same as JSON.stringify)
 * @returns JSON string with BigInt values encoded as strings
 */
export function stringifyWithBigInt(value: unknown, space?: string | number): string {
  return JSON.stringify(value, bigIntReplacer, space);
}

/**
 * JSON.parse with BigInt support.
 *
 * @param text - The JSON string to parse
 * @returns Parsed object with BigInt values restored
 */
export function parseWithBigInt<T = unknown>(text: string): T {
  return JSON.parse(text, bigIntReviver) as T;
}
