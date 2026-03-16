/**
 * KMS identity derivation for TEE enclave-bound keypairs.
 *
 * Derives a Nostr-compatible secp256k1 keypair from a raw 32-byte Nautilus
 * KMS seed using the NIP-06 derivation path (m/44'/1237'/0'/0/{index}).
 *
 * The KMS seed is only accessible when the enclave's attestation is valid
 * (correct PCR values). If the relay code changes, PCR values change,
 * attestation fails, KMS seed becomes inaccessible, and the relay loses its
 * identity -- creating a cryptographic binding: identity proves code integrity.
 *
 * This module lives in @crosstown/core (not SDK) because Docker entrypoints
 * import from core. It does NOT include EVM address derivation (SDK concern).
 */

import { validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { getPublicKey } from 'nostr-tools/pure';
import { CrosstownError } from '../errors.js';

// ---------- Error Class ----------

/**
 * Error thrown when KMS identity derivation fails.
 * Signals that the enclave cannot derive its identity -- this is a
 * security-critical condition that must NEVER fall back to random keys.
 */
export class KmsIdentityError extends CrosstownError {
  constructor(message: string, cause?: Error) {
    super(message, 'KMS_IDENTITY_ERROR', cause);
    this.name = 'KmsIdentityError';
  }
}

// ---------- Types ----------

/** A Nostr keypair derived from a KMS seed. */
export interface KmsKeypair {
  /** The 32-byte secp256k1 secret key derived from the KMS seed. */
  secretKey: Uint8Array;
  /** The x-only Schnorr public key (32 bytes, 64 lowercase hex characters). */
  pubkey: string;
}

/** Options for `deriveFromKmsSeed()`. */
export interface DeriveFromKmsSeedOptions {
  /** BIP-39 mnemonic -- when provided, takes precedence over raw seed for derivation. */
  mnemonic?: string;
  /** Key index in the NIP-06 derivation path. Defaults to 0. */
  accountIndex?: number;
}

// ---------- Constants ----------

/**
 * Maximum valid BIP-32 non-hardened child index (2^31 - 1).
 * Values at or above 2^31 are reserved for hardened derivation.
 */
const MAX_BIP32_INDEX = 0x7fffffff;

// ---------- Implementation ----------

/**
 * Derives a Nostr keypair from a raw 32-byte KMS seed or BIP-39 mnemonic
 * using the NIP-06 derivation path.
 *
 * When `options.mnemonic` is provided it takes precedence over the raw seed.
 * The raw seed is still validated even when a mnemonic is supplied (caller
 * must always provide a valid seed to prove KMS reachability).
 *
 * @param seed - A 32-byte Uint8Array from Nautilus KMS.
 * @param options - Optional derivation overrides (mnemonic, accountIndex).
 * @returns A `KmsKeypair` with `secretKey` and `pubkey`.
 * @throws {KmsIdentityError} If the seed is invalid or derivation fails.
 */
export function deriveFromKmsSeed(
  seed: Uint8Array,
  options?: DeriveFromKmsSeedOptions
): KmsKeypair {
  // -- Validate seed --
  if (!(seed instanceof Uint8Array)) {
    throw new KmsIdentityError(
      `KMS seed unavailable: expected Uint8Array, got ${seed === null ? 'null' : typeof seed}`
    );
  }
  if (seed.length !== 32) {
    throw new KmsIdentityError(
      `KMS seed invalid: expected 32 bytes, got ${seed.length} bytes`
    );
  }

  // -- Validate accountIndex --
  const accountIndex = options?.accountIndex ?? 0;
  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_BIP32_INDEX
  ) {
    throw new KmsIdentityError(
      `Invalid accountIndex: expected a non-negative integer (0 to ${MAX_BIP32_INDEX}), got ${String(accountIndex)}`
    );
  }

  const path = `m/44'/1237'/0'/0/${accountIndex}`;
  let derivationSeed: Uint8Array | undefined;
  let masterKey: HDKey | undefined;
  let childKey: HDKey | undefined;

  try {
    if (options?.mnemonic !== undefined) {
      // -- Mnemonic path (takes precedence) --
      if (!validateMnemonic(options.mnemonic, wordlist)) {
        throw new KmsIdentityError(
          'Invalid BIP-39 mnemonic: the provided words do not form a valid mnemonic phrase'
        );
      }
      derivationSeed = mnemonicToSeedSync(options.mnemonic);
    } else {
      // -- Raw seed path --
      derivationSeed = seed;
    }

    masterKey = HDKey.fromMasterSeed(derivationSeed);
    childKey = masterKey.derive(path);

    if (!childKey.privateKey) {
      throw new KmsIdentityError(
        `Failed to derive private key at path ${path}`
      );
    }

    const secretKey = childKey.privateKey;
    const pubkey = getPublicKey(secretKey);

    // Defensive copy of the private key to prevent external mutation
    return { secretKey: new Uint8Array(secretKey), pubkey };
  } catch (error: unknown) {
    if (error instanceof KmsIdentityError) {
      throw error;
    }
    throw new KmsIdentityError(
      `KMS key derivation failed at path ${path}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  } finally {
    // Best-effort zeroing of intermediate key material.
    // HDKey.wipePrivateData() zeros the internal private key buffer and
    // chain code, limiting the window during which secrets remain in memory.
    masterKey?.wipePrivateData();
    childKey?.wipePrivateData();

    // Only zero the mnemonic-derived seed (64 bytes), not the raw KMS seed
    // which the caller owns.
    if (options?.mnemonic !== undefined && derivationSeed) {
      derivationSeed.fill(0);
    }
  }
}
