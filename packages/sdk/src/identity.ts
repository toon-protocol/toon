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
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
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
 * Solana Ed25519 identity derived via SLIP-0010 from a BIP-39 mnemonic.
 */
export interface SolanaIdentity {
  /** 64-byte Ed25519 keypair (32-byte private key + 32-byte public key). */
  secretKey: Uint8Array;
  /** Base58-encoded Ed25519 public key (Solana address). */
  publicKey: string;
}

/**
 * Mina Pallas identity derived from a BIP-39 mnemonic via mina-signer.
 */
export interface MinaIdentity {
  /** Hex-encoded Pallas private key. */
  privateKey: string;
  /** Base58 Mina public key (B62 prefix). */
  publicKey: string;
}

/**
 * Full multi-chain identity derived from a single BIP-39 mnemonic.
 * Extends NodeIdentity (Nostr + EVM) with Solana and optionally Mina.
 */
export interface ToonIdentity extends NodeIdentity {
  /** Solana Ed25519 identity (always populated from mnemonic derivation). */
  solana: SolanaIdentity;
  /** Mina Pallas identity (undefined when mina-signer is not installed). */
  mina?: MinaIdentity;
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
): ToonIdentity {
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
    const base = deriveIdentity(secretKey);

    // Derive Solana Ed25519 identity from the same seed via SLIP-0010
    const solana = deriveSolanaIdentity(seed);

    return { ...base, solana };
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

// ---------------------------------------------------------------------------
// SLIP-0010 Ed25519 HD Key Derivation
// ---------------------------------------------------------------------------

/**
 * SLIP-0010 master key and child key derivation for Ed25519.
 *
 * Ed25519 SLIP-0010 only supports hardened derivation. The path
 * m/44'/501'/0'/0' is standard for Solana wallets.
 *
 * @param seed - The BIP-39 seed (64 bytes).
 * @param path - Array of hardened indices (must have 0x80000000 bit set).
 * @returns The derived 32-byte Ed25519 private key.
 */
function slip0010Derive(seed: Uint8Array, path: number[]): Uint8Array {
  const encoder = new TextEncoder();

  // Master key: HMAC-SHA512("ed25519 seed", seed)
  let I = hmac(sha512, encoder.encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  // Child derivation (hardened only)
  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    // Write index as big-endian uint32
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;

    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  return key;
}

/** Standard SLIP-0010 path for Solana: m/44'/501'/0'/0' (all hardened). */
const SOLANA_PATH = [
  0x8000002c, // 44'
  0x800001f5, // 501'
  0x80000000, // 0'
  0x80000000, // 0'
];

/**
 * Derives a Solana Ed25519 identity from a BIP-39 seed using SLIP-0010.
 */
function deriveSolanaIdentity(seed: Uint8Array): SolanaIdentity {
  const privateKey = slip0010Derive(seed, SOLANA_PATH);
  const publicKeyBytes = ed25519.getPublicKey(privateKey);

  // Solana keypair = 32-byte private key + 32-byte public key = 64 bytes
  const keypair = new Uint8Array(64);
  keypair.set(privateKey, 0);
  keypair.set(publicKeyBytes, 32);

  return { secretKey: keypair, publicKey: base58Encode(publicKeyBytes) };
}

// ---------------------------------------------------------------------------
// Mina Pallas Key Derivation (optional, requires mina-signer)
// ---------------------------------------------------------------------------

/**
 * Derives a Mina Pallas identity from a BIP-39 seed.
 *
 * Uses BIP-32 secp256k1 derivation at path m/44'/12586'/0'/0/0 to produce
 * a 32-byte scalar, then converts to Mina key format via mina-signer.
 *
 * @param seed - The BIP-39 seed (64 bytes).
 * @returns The Mina identity, or undefined if mina-signer is not installed.
 */
async function deriveMinaIdentity(
  seed: Uint8Array
): Promise<MinaIdentity | undefined> {
  const path = "m/44'/12586'/0'/0/0";
  const hdKey = HDKey.fromMasterSeed(seed).derive(path);

  if (!hdKey.privateKey) {
    throw new IdentityError(`Failed to derive Mina private key at path ${path}`);
  }

  const keyBytes = new Uint8Array(hdKey.privateKey);
  const hexKey = bytesToHex(keyBytes);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MinaSignerLib: any = await import('mina-signer');
    const Client =
      'default' in MinaSignerLib ? MinaSignerLib.default : MinaSignerLib;
    const client = new Client({ network: 'mainnet' });

    const publicKey: string = client.derivePublicKey(hexKey);
    return { privateKey: hexKey, publicKey };
  } catch {
    // mina-signer not installed -- graceful degradation
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public Multi-Chain Functions
// ---------------------------------------------------------------------------

/**
 * Derives a full multi-chain ToonIdentity from a BIP-39 mnemonic,
 * including async Mina derivation (requires mina-signer).
 *
 * Chains derived:
 * - Nostr (secp256k1): m/44'/1237'/0'/0/{accountIndex}
 * - EVM (secp256k1): same key as Nostr, Keccak-256 for address
 * - Solana (Ed25519): m/44'/501'/0'/0' (SLIP-0010)
 * - Mina (Pallas): m/44'/12586'/0'/0/0 (optional, requires mina-signer)
 *
 * @param mnemonic - A valid BIP-39 mnemonic (12 or 24 words).
 * @param options - Optional derivation options (accountIndex defaults to 0).
 * @returns The derived ToonIdentity with all chain identities populated.
 * @throws {IdentityError} If the mnemonic is invalid.
 */
export async function fromMnemonicFull(
  mnemonic: string,
  options?: FromMnemonicOptions
): Promise<ToonIdentity> {
  // Derive Nostr + EVM + Solana synchronously
  const identity = fromMnemonic(mnemonic, options);

  // Attempt async Mina derivation
  let seed: Uint8Array | undefined;
  try {
    seed = mnemonicToSeedSync(mnemonic);
    const mina = await deriveMinaIdentity(seed);
    if (mina) {
      return { ...identity, mina };
    }
  } finally {
    if (seed) {
      seed.fill(0);
    }
  }

  return identity;
}

/**
 * Generates a random Solana Ed25519 keypair (non-deterministic).
 *
 * For deterministic derivation from a mnemonic, use fromMnemonic() instead.
 *
 * @returns A SolanaIdentity with random keypair.
 */
export function generateSolanaKeypair(): SolanaIdentity {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKeyBytes = ed25519.getPublicKey(privateKey);

  const keypair = new Uint8Array(64);
  keypair.set(privateKey, 0);
  keypair.set(publicKeyBytes, 32);

  return { secretKey: keypair, publicKey: base58Encode(publicKeyBytes) };
}

// ---------------------------------------------------------------------------
// Base58 Encoding/Decoding
// ---------------------------------------------------------------------------

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
    if (idx === -1) throw new IdentityError(`Invalid base58 character: ${ch}`);
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
