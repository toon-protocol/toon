/**
 * Event builder and parser for kind:10033 TEE Attestation events.
 *
 * Kind 10033 is a NIP-16 replaceable event (kind 10000-19999) published by
 * nodes running in a Trusted Execution Environment (TEE). Relays store only
 * the latest event per `pubkey + kind`. No `d` tag is needed -- NIP-16
 * replaces by pubkey + kind alone (unlike NIP-33 parameterized replaceable
 * events in the 30000-39999 range).
 *
 * TEE attestation events contain PCR measurements, enclave type, and the
 * base64-encoded attestation document from the TEE platform (e.g., AWS Nitro
 * Enclaves via Marlin Oyster CVM).
 *
 * Content format (Pattern 14):
 * ```json
 * {
 *   "enclave": "marlin-oyster",
 *   "pcr0": "<sha384-hex-96-chars>",
 *   "pcr1": "<sha384-hex-96-chars>",
 *   "pcr2": "<sha384-hex-96-chars>",
 *   "attestationDoc": "<base64-encoded>",
 *   "version": "1.0.0"
 * }
 * ```
 *
 * Tags: ['relay', url], ['chain', chainId], ['expiry', unixTimestamp]
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { TEE_ATTESTATION_KIND } from '../constants.js';
import type { TeeAttestation } from '../types.js';

// Re-export for convenient co-located imports
export { TEE_ATTESTATION_KIND };
export type { TeeAttestation };

// ---------- Types ----------

/** Options for building a kind:10033 attestation event. */
export interface AttestationEventOptions {
  /** WebSocket URL where this relay can be reached. */
  relay: string;
  /** Chain identifier (e.g., '42161' for Arbitrum One). */
  chain: string;
  /** Unix timestamp when this attestation expires. */
  expiry: number;
}

/** Parsed result from a kind:10033 attestation event. */
export interface ParsedAttestation {
  /** The attestation content fields. */
  attestation: TeeAttestation;
  /** WebSocket relay URL from the 'relay' tag. */
  relay: string;
  /** Chain identifier from the 'chain' tag. */
  chain: string;
  /** Expiry unix timestamp from the 'expiry' tag. */
  expiry: number;
}

// ---------- Validation Helpers ----------

/** Regex for 96-char lowercase hex (SHA-384). */
const PCR_REGEX = /^[0-9a-f]{96}$/;

/** Regex for valid base64 (standard alphabet, 0-2 padding chars). */
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

// ---------- Builder ----------

/**
 * Builds a kind:10033 TEE Attestation event (NIP-16 replaceable).
 *
 * Content is `JSON.stringify(attestation)` per enforcement guideline 11.
 * Tags include relay, chain, and expiry. No `d` tag is included -- NIP-16
 * replaces by pubkey + kind alone.
 *
 * @param attestation - The TEE attestation content payload.
 * @param secretKey - The secret key to sign the event with.
 * @param options - Event options (relay URL, chain ID, expiry timestamp).
 * @returns A signed Nostr event.
 */
export function buildAttestationEvent(
  attestation: TeeAttestation,
  secretKey: Uint8Array,
  options: AttestationEventOptions
): NostrEvent {
  return finalizeEvent(
    {
      kind: TEE_ATTESTATION_KIND,
      content: JSON.stringify(attestation),
      tags: [
        ['relay', options.relay],
        ['chain', options.chain],
        ['expiry', String(options.expiry)],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

// ---------- Parser ----------

/**
 * Parses a kind:10033 event into a ParsedAttestation.
 *
 * Validates required content fields (enclave, pcr0-2, attestationDoc, version)
 * and required tags (relay, chain, expiry). Returns `null` for malformed or
 * missing data.
 *
 * When `options.verify` is `true`, performs strict validation:
 * - PCR values must be 96-char lowercase hex (SHA-384)
 * - attestationDoc must be non-empty valid base64
 * Throws on invalid data when verify=true (adversarial input gate).
 *
 * @param event - The Nostr event to parse.
 * @param options - Optional parse options. `verify: true` enables strict validation.
 * @returns The parsed attestation, or null if invalid.
 */
export function parseAttestation(
  event: NostrEvent,
  options?: { verify?: boolean }
): ParsedAttestation | null {
  // Parse JSON content
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }

  // Must be a non-null object (not an array)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  // Validate required string fields
  const enclave = record['enclave'];
  if (typeof enclave !== 'string') return null;

  const pcr0 = record['pcr0'];
  if (typeof pcr0 !== 'string') return null;

  const pcr1 = record['pcr1'];
  if (typeof pcr1 !== 'string') return null;

  const pcr2 = record['pcr2'];
  if (typeof pcr2 !== 'string') return null;

  const attestationDoc = record['attestationDoc'];
  if (typeof attestationDoc !== 'string') return null;

  const version = record['version'];
  if (typeof version !== 'string') return null;

  // Strict validation when verify=true
  if (options?.verify) {
    // Validate PCR format (96-char lowercase hex)
    if (!PCR_REGEX.test(pcr0)) {
      throw new Error('Invalid PCR0 format: expected 96-char lowercase hex');
    }
    if (!PCR_REGEX.test(pcr1)) {
      throw new Error('Invalid PCR1 format: expected 96-char lowercase hex');
    }
    if (!PCR_REGEX.test(pcr2)) {
      throw new Error('Invalid PCR2 format: expected 96-char lowercase hex');
    }

    // Validate attestationDoc is non-empty valid base64
    if (attestationDoc.length === 0) {
      throw new Error('Attestation document is empty');
    }
    if (!BASE64_REGEX.test(attestationDoc)) {
      throw new Error('Attestation document is not valid base64');
    }
  }

  // Extract required tags
  const relayTag = event.tags.find((t: string[]) => t[0] === 'relay');
  const chainTag = event.tags.find((t: string[]) => t[0] === 'chain');
  const expiryTag = event.tags.find((t: string[]) => t[0] === 'expiry');

  if (!relayTag?.[1] || !chainTag?.[1] || !expiryTag?.[1]) {
    return null;
  }

  const expiry = parseInt(expiryTag[1], 10);
  if (isNaN(expiry)) {
    return null;
  }

  return {
    attestation: {
      enclave,
      pcr0,
      pcr1,
      pcr2,
      attestationDoc,
      version,
    },
    relay: relayTag[1],
    chain: chainTag[1],
    expiry,
  };
}
