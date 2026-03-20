/**
 * Unified identity module for @toon-protocol/sdk.
 *
 * Derives both a Nostr pubkey (x-only Schnorr, BIP-340) and an EVM address
 * (Keccak-256) from a single secp256k1 private key, following the NIP-06
 * derivation standard.
 *
 * Both Nostr and EVM use the secp256k1 elliptic curve, so a single 12-word
 * seed phrase can recover the complete identity across both layers.
 */

import {
  generateMnemonic as _generateMnemonic,
  validateMnemonic,
  mnemonicToSeedSync,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { getPublicKey } from 'nostr-tools/pure';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { IdentityError } from './errors.js';

/**
 * Represents a node's complete identity: secret key, Nostr pubkey, and EVM address.
 */
export interface NodeIdentity {
  /** The 32-byte secp256k1 secret key. */
  secretKey: Uint8Array;
  /** The x-only Schnorr public key (32 bytes, 64 lowercase hex characters). */
  pubkey: string;
  /** The EIP-55 checksummed EVM address (0x-prefixed, 42 characters). */
  evmAddress: string;
}

/**
 * Options for mnemonic-based key derivation.
 */
export interface FromMnemonicOptions {
  /** Key index in the NIP-06 derivation path. Defaults to 0. */
  accountIndex?: number;
}

/**
 * Generates a valid 12-word BIP-39 mnemonic using 128-bit entropy.
 *
 * @returns A space-separated string of 12 BIP-39 English words.
 */
export function generateMnemonic(): string {
  return _generateMnemonic(wordlist, 128);
}

/**
 * Derives a complete NodeIdentity from a BIP-39 mnemonic phrase.
 *
 * Uses the NIP-06 derivation path: m/44'/1237'/0'/0/{accountIndex}
 *
 * @param mnemonic - A valid BIP-39 mnemonic (12 or 24 words).
 * @param options - Optional derivation options (accountIndex defaults to 0).
 * @returns The derived NodeIdentity with secretKey, pubkey, and evmAddress.
 * @throws {IdentityError} If the mnemonic is invalid.
 */
export function fromMnemonic(
  mnemonic: string,
  options?: FromMnemonicOptions
): NodeIdentity {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new IdentityError(
      `Invalid BIP-39 mnemonic: the provided words do not form a valid mnemonic phrase`
    );
  }

  const accountIndex = options?.accountIndex ?? 0;

  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_BIP32_INDEX
  ) {
    throw new IdentityError(
      `Invalid accountIndex: expected a non-negative integer (0 to ${MAX_BIP32_INDEX}), got ${String(accountIndex)}`
    );
  }

  const path = `m/44'/1237'/0'/0/${accountIndex}`;

  let seed: Uint8Array | undefined;
  try {
    seed = mnemonicToSeedSync(mnemonic);
    const hdKey = HDKey.fromMasterSeed(seed).derive(path);

    if (!hdKey.privateKey) {
      throw new IdentityError(`Failed to derive private key at path ${path}`);
    }

    const secretKey = hdKey.privateKey;
    return deriveIdentity(secretKey);
  } catch (error: unknown) {
    if (error instanceof IdentityError) {
      throw error;
    }
    throw new IdentityError(
      `Key derivation failed at path ${path}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  } finally {
    // Best-effort zeroing of the intermediate seed to reduce the window
    // during which sensitive material remains in memory. This is not a
    // guarantee (JS has no secure-erase primitive), but it limits exposure.
    if (seed) {
      seed.fill(0);
    }
  }
}

/**
 * Derives a complete NodeIdentity from an existing 32-byte secret key.
 *
 * @param secretKey - A 32-byte secp256k1 secret key.
 * @returns The derived NodeIdentity with secretKey, pubkey, and evmAddress.
 * @throws {IdentityError} If the secret key is not exactly 32 bytes.
 */
export function fromSecretKey(secretKey: Uint8Array): NodeIdentity {
  if (!(secretKey instanceof Uint8Array)) {
    throw new IdentityError(
      `Invalid secret key: expected Uint8Array, got ${secretKey === null ? 'null' : typeof secretKey}`
    );
  }

  if (secretKey.length !== 32) {
    throw new IdentityError(
      `Invalid secret key: expected 32 bytes, got ${secretKey.length} bytes`
    );
  }

  try {
    return deriveIdentity(secretKey);
  } catch (error: unknown) {
    if (error instanceof IdentityError) {
      throw error;
    }
    throw new IdentityError(
      `Invalid secret key: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Maximum valid BIP-32 non-hardened child index (2^31 - 1).
 * Values at or above 2^31 are reserved for hardened derivation.
 */
const MAX_BIP32_INDEX = 0x7fffffff;

/**
 * Shared helper that computes pubkey and evmAddress from a 32-byte secret key.
 * Returns a defensive copy of the secret key to prevent external mutation.
 */
function deriveIdentity(secretKey: Uint8Array): NodeIdentity {
  // Compute x-only Schnorr pubkey (32 bytes hex) via nostr-tools
  const pubkey = getPublicKey(secretKey);

  // Compute EVM address from the uncompressed secp256k1 public key
  const evmAddress = computeEvmAddress(secretKey);

  // Return a defensive copy of the secret key to prevent external mutation
  // from affecting the identity or vice versa
  return { secretKey: new Uint8Array(secretKey), pubkey, evmAddress };
}

/**
 * Computes an EIP-55 checksummed EVM address from a secp256k1 private key.
 *
 * Steps:
 * 1. Compute the full uncompressed public key (65 bytes: 0x04 + 64 bytes X,Y)
 * 2. Strip the 0x04 prefix to get 64 bytes
 * 3. Hash with Keccak-256
 * 4. Take the last 20 bytes
 * 5. Format as 0x-prefixed hex with EIP-55 checksum
 */
function computeEvmAddress(secretKey: Uint8Array): string {
  // Get the uncompressed public key (65 bytes: 0x04 prefix + 64 bytes X,Y)
  const uncompressedPubkey = secp256k1.getPublicKey(secretKey, false);

  // Strip the 0x04 prefix (first byte), leaving 64 bytes of X,Y coordinates
  const pubkeyWithoutPrefix = uncompressedPubkey.slice(1);

  // Hash with Keccak-256
  const hash = keccak_256(pubkeyWithoutPrefix);

  // Take last 20 bytes
  const addressBytes = hash.slice(-20);
  const addressHex = bytesToHex(addressBytes);

  // Apply EIP-55 mixed-case checksum
  return toChecksumAddress(addressHex);
}

/**
 * Applies EIP-55 mixed-case checksum encoding to an Ethereum address.
 *
 * EIP-55 rules:
 * - Hash the lowercase hex address (without 0x) with Keccak-256
 * - For each hex character in the address:
 *   - If the corresponding nibble in the hash is >= 8, uppercase it
 *   - Otherwise, lowercase it
 *
 * @param addressHex - The 40-character lowercase hex address (without 0x prefix).
 * @returns The checksummed address with 0x prefix.
 */
function toChecksumAddress(addressHex: string): string {
  const lower = addressHex.toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));

  let checksummed = '0x';
  for (let i = 0; i < 40; i++) {
    const char = lower[i];
    const hashChar = hash[i];
    if (char === undefined || hashChar === undefined) {
      throw new IdentityError(
        `Unexpected undefined at index ${i} during checksum computation`
      );
    }
    const hashNibble = parseInt(hashChar, 16);
    checksummed += hashNibble >= 8 ? char.toUpperCase() : char;
  }

  return checksummed;
}
