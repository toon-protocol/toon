import { decode } from '@toon-format/toon';
import { ToonDecodeError } from './decoder.js';
import { isValidHex } from './validate.js';

/**
 * Routing metadata extracted from TOON-encoded bytes without full NostrEvent validation.
 *
 * The shallow parser extracts only the 4 routing fields needed for signature verification
 * and event routing, skipping expensive validation of content, tags, and created_at.
 */
export interface ToonRoutingMeta {
  kind: number;
  pubkey: string;
  id: string;
  sig: string;
  rawBytes: Uint8Array;
}

/**
 * Shallow-parse TOON-encoded bytes to extract routing metadata.
 *
 * This function decodes the TOON data and extracts only the 4 routing fields
 * (kind, pubkey, id, sig) without performing full NostrEvent validation.
 * It is cheaper than a full decode + validate cycle.
 *
 * The `rawBytes` field preserves the original input bytes for downstream
 * use (e.g., Schnorr signature verification against the serialized payload).
 *
 * @param data - The TOON-encoded Uint8Array
 * @returns Routing metadata with the original raw bytes
 * @throws ToonDecodeError if the data cannot be parsed or required routing fields are missing/invalid
 */
export function shallowParseToon(data: Uint8Array): ToonRoutingMeta {
  let decoded: unknown;
  try {
    const toonString = new TextDecoder().decode(data);
    decoded = decode(toonString);
  } catch (error) {
    throw new ToonDecodeError(
      `Failed to parse TOON data: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new ToonDecodeError('Decoded TOON value is not an object');
  }

  const obj = decoded as Record<string, unknown>;

  // Validate kind (number, integer)
  if (typeof obj['kind'] !== 'number' || !Number.isInteger(obj['kind'])) {
    throw new ToonDecodeError(
      'Missing or invalid routing field: kind must be an integer'
    );
  }

  // Validate pubkey (64-char hex)
  if (!isValidHex(obj['pubkey'], 64)) {
    throw new ToonDecodeError(
      'Missing or invalid routing field: pubkey must be a 64-character hex string'
    );
  }

  // Validate id (64-char hex)
  if (!isValidHex(obj['id'], 64)) {
    throw new ToonDecodeError(
      'Missing or invalid routing field: id must be a 64-character hex string'
    );
  }

  // Validate sig (128-char hex)
  if (!isValidHex(obj['sig'], 128)) {
    throw new ToonDecodeError(
      'Missing or invalid routing field: sig must be a 128-character hex string'
    );
  }

  return {
    kind: obj['kind'] as number,
    pubkey: obj['pubkey'] as string,
    id: obj['id'] as string,
    sig: obj['sig'] as string,
    rawBytes: data,
  };
}
