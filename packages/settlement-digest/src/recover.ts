/**
 * Pure EVM balance-proof signer recovery + verification.
 *
 * Extracted from `@toon-protocol/sdk`'s `settlement/evm.ts` (Phase 1 of
 * connector#329) and DECOUPLED from the SDK's `AccumulatedClaim` /
 * `SettlementTxError` types so any consumer — including the connector's
 * off-chain inbound verifier — can recover an EVM signer from plain params +
 * a 65-byte signature using only `@noble/curves` + `@noble/hashes`.
 *
 * The recovery math is byte-identical to the SDK's `recoverEvmSignerAddress`:
 * `secp256k1` recover over the v2 EIP-712 digest, then keccak256 address
 * derivation. The SDK now wraps these functions (keeping its own error codes).
 *
 * @module
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { balanceProofHashEvm, hexToBytes } from './hashes.js';

/**
 * Plain settlement-context params for the v2 EVM claim digest. Mirrors the
 * fields the SDK's `AccumulatedClaim` carried, but as a dependency-free shape.
 * `cumulativeAmount` / `nonce` / `chainId` accept `bigint | number | string`
 * (coerced via `BigInt(...)`, exactly as the SDK did).
 */
export interface EvmClaimDigestParams {
  /** Channel identifier — `0x` + 64 hex (32 bytes). */
  channelId: string;
  /** Cumulative transferred amount (target micro-units). */
  cumulativeAmount: bigint | number | string;
  /** Balance-proof nonce (monotonically increasing within a channel). */
  nonce: bigint | number | string;
  /** Recipient address — `0x` + 40 hex (20 bytes). */
  recipient: string;
  /** Settlement chain id (e.g. `8453` for Base). */
  chainId: bigint | number | string;
  /** Deployed `RollingSwapChannel` address — `0x` + 40 hex (20 bytes). */
  verifyingContract: string;
}

/**
 * Recover the EVM signer address from a precomputed 32-byte digest and a
 * 65-byte `r||s||v` signature. Returns a lowercase `0x`-prefixed 40-hex-char
 * address.
 *
 * `v` MUST be 27 or 28 (Ethereum convention). Throws a plain `Error` on an
 * invalid signature length / `v` byte, or if recovery fails.
 */
export function recoverEvmSigner(
  digest: Uint8Array,
  sig65: Uint8Array
): string {
  if (sig65.length !== 65) {
    throw new Error(
      `EVM signature must be 65 bytes (r||s||v), got ${sig65.length}`
    );
  }
  const v = sig65[64];
  if (v !== 27 && v !== 28) {
    throw new Error(`EVM signature v must be 27 or 28, got ${v}`);
  }
  const recovery = v - 27;
  const compactRS = sig65.slice(0, 64);
  const sig = secp256k1.Signature.fromBytes(
    compactRS,
    'compact'
  ).addRecoveryBit(recovery);
  const point = sig.recoverPublicKey(digest);
  const uncompressedPubkey = point.toBytes(false);

  // Uncompressed pubkey is 65 bytes: 0x04 || X(32) || Y(32). Address =
  // last 20 bytes of keccak256(X||Y).
  const addrHash = keccak_256(uncompressedPubkey.slice(1));
  return '0x' + bytesToHex(addrHash.slice(-20)).toLowerCase();
}

/**
 * Recover the EVM signer address for a v2 balance-proof CLAIM: reconstructs the
 * EIP-712 digest via {@link balanceProofHashEvm} from `params` (channelId,
 * cumulativeAmount, nonce, recipient, chainId, verifyingContract), then recovers
 * the secp256k1 signer from `sig65`. Returns a lowercase `0x` address.
 *
 * `chainId` + `verifyingContract` are REQUIRED by the v2 digest (refs
 * connector#324 finding #1) — a signature is valid on exactly one
 * (chain, contract) pair. Throws a plain `Error` on malformed field lengths or
 * an invalid signature.
 */
export function recoverEvmClaimSigner(
  params: EvmClaimDigestParams,
  sig65: Uint8Array
): string {
  const channelIdBytes = hexToBytes(params.channelId);
  const recipientBytes = hexToBytes(params.recipient);
  const verifyingContractBytes = hexToBytes(params.verifyingContract);
  if (channelIdBytes.length !== 32) {
    throw new Error(
      `channelId must be 32 bytes (got ${channelIdBytes.length})`
    );
  }
  if (recipientBytes.length !== 20) {
    throw new Error(
      `recipient must be 20 bytes (got ${recipientBytes.length})`
    );
  }
  if (verifyingContractBytes.length !== 20) {
    throw new Error(
      `verifyingContract must be 20 bytes (got ${verifyingContractBytes.length})`
    );
  }
  const digest = balanceProofHashEvm(
    channelIdBytes,
    BigInt(params.cumulativeAmount),
    BigInt(params.nonce),
    recipientBytes,
    BigInt(params.chainId),
    verifyingContractBytes
  );
  return recoverEvmSigner(digest, sig65);
}

/**
 * Verify a v2 EVM claim signature by recovering the signer from `params` +
 * `sig65` and comparing (case-insensitively) to `expectedAddress`. Returns
 * `{ valid, recovered }` — `recovered` is the lowercase recovered address.
 */
export function verifyEvmClaimSignature(
  params: EvmClaimDigestParams,
  sig65: Uint8Array,
  expectedAddress: string
): { valid: boolean; recovered: string } {
  const recovered = recoverEvmClaimSigner(params, sig65);
  return {
    valid: recovered.toLowerCase() === expectedAddress.toLowerCase(),
    recovered,
  };
}
