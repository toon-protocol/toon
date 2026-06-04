/**
 * Base58 (Bitcoin/Solana alphabet) encode/decode.
 *
 * Identical implementation to `@toon-protocol/sdk`'s `identity.ts` helpers —
 * relocated/duplicated here so `@toon-protocol/core` (and its `client`
 * consumer) can base58-encode Solana addresses and the Mina base58check
 * private-key format without depending on the SDK.
 *
 * @module
 */

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encodes a byte array to a Base58 string (Bitcoin/Solana alphabet).
 */
export function base58Encode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;

  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let result = '';
  while (value > 0n) {
    result = BASE58_ALPHABET[Number(value % 58n)] + result;
    value = value / 58n;
  }

  // Add leading '1's for leading zero bytes
  for (let i = 0; i < zeros; i++) {
    result = '1' + result;
  }

  return result || '1';
}

/**
 * Decodes a Base58 string to a byte array (Bitcoin/Solana alphabet).
 */
export function base58Decode(str: string): Uint8Array {
  // Count leading '1's (zero bytes)
  let zeros = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i++) zeros++;

  let value = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base58 character: ${ch}`);
    value = value * 58n + BigInt(idx);
  }

  // Convert bigint to bytes
  const hex = value === 0n ? '' : value.toString(16);
  const hexPadded = hex.length % 2 ? '0' + hex : hex;
  const rawBytes: number[] = [];
  for (let i = 0; i < hexPadded.length; i += 2) {
    rawBytes.push(parseInt(hexPadded.slice(i, i + 2), 16));
  }

  const result = new Uint8Array(zeros + rawBytes.length);
  result.set(rawBytes, zeros);
  return result;
}
