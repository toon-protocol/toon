/**
 * Mina private-key format conversion.
 *
 * `deriveFullIdentity()` / `deriveMillKeys()` emit a Mina Pallas scalar as a
 * big-endian hex string, but `mina-signer`'s `signFields`/`derivePublicKey`
 * require the Mina base58check (`EK…`) private-key format. This helper bridges
 * the two so a hex-derived Mina key produces signatures verifiable by the
 * sender-side `verifyMinaSignature`.
 *
 * Mirrors `hexToMinaBase58PrivateKey` in `packages/mill/src/payment-channel-signer.ts`
 * (same fixed Mina base58check wire standard — version byte `0x5a`, non-zero
 * tag `0x01`, little-endian scalar, double-sha256 checksum).
 *
 * @module
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode } from './base58.js';
import { concatBytes, hexToBytes } from './hashes.js';

/**
 * Mina private-key version byte for the base58check encoding mina-signer
 * expects (the `EK…` prefix). Followed by a `0x01` non-zero tag byte and the
 * 32-byte field scalar in LITTLE-ENDIAN order, then a 4-byte double-sha256
 * checksum.
 */
const MINA_PRIVATE_KEY_VERSION = 0x5a;

/**
 * Convert a big-endian 32-byte hex scalar (the form `deriveFullIdentity()`
 * emits for Mina) into the Mina base58check private-key string mina-signer's
 * `signFields`/`derivePublicKey` require. If the input already looks like a
 * base58 `EK…` key it is returned unchanged.
 *
 * Layout (pre-checksum): `[0x5a, 0x01, <scalar bytes little-endian>]`, then
 * append the first 4 bytes of `sha256(sha256(payload))` and base58-encode.
 */
export function hexToMinaBase58PrivateKey(privateKey: string): string {
  // Already a Mina base58 private key (EK… ~52 chars) — pass through.
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    return privateKey;
  }
  const beScalar = hexToBytes(privateKey); // 32 bytes, big-endian
  // mina-signer/Pallas serializes the scalar little-endian.
  const leScalar = Uint8Array.from(beScalar).reverse();
  const payload = concatBytes(
    Uint8Array.from([MINA_PRIVATE_KEY_VERSION, 0x01]),
    leScalar
  );
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

/**
 * Derive the Mina base58 (`B62…`) public key for a private-key scalar, using
 * the optional `mina-signer` peer dep.
 *
 * `deriveFullIdentity()` / `deriveMillKeys()` emit only a keccak **hex
 * placeholder** for the Mina public key — they deliberately avoid pulling
 * Pallas curve math into derivation. That placeholder is unfundable and is
 * rejected by Mina GraphQL balance queries, so wallet views that display it
 * (e.g. a mill node's `/wallet/balances` Mina leg) show an unusable hex
 * string. This resolves the real, fundable `B62…` address when `mina-signer`
 * is installed.
 *
 * Returns `null` (not a throw) when `mina-signer` is absent — a missing
 * optional peer dep is not an error; callers fall back to the hex placeholder.
 * The B62 encoding is network-agnostic, so the chosen `network` is irrelevant.
 *
 * @param privateKey big-endian hex scalar (as derivation emits) or an
 *   already-base58 `EK…` Mina private key.
 */
export async function deriveMinaPublicKeyBase58(
  privateKey: string
): Promise<string | null> {
  let signerModule: unknown = null;
  try {
    // Dynamic specifier the TS compiler can't resolve at build time, so this
    // package type-checks without the optional `mina-signer` peer dep present.
    const specifier = 'mina-signer';
    signerModule = await import(/* @vite-ignore */ specifier);
  } catch {
    return null;
  }
  if (!signerModule) return null;
  const mod = signerModule as { default?: unknown };
  const ClientCtor = (mod.default ?? mod) as new (cfg: {
    network: 'mainnet' | 'testnet';
  }) => { derivePublicKey: (privateKey: string) => string };
  const client = new ClientCtor({ network: 'mainnet' });
  // mina-signer needs a base58check (`EK…`) private key; convert if hex.
  return client.derivePublicKey(hexToMinaBase58PrivateKey(privateKey));
}
