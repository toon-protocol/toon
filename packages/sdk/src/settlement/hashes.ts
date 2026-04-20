/**
 * Shared balance-proof hash helpers used by both:
 *  - the Mill-side signer (`packages/mill/src/payment-channel-signer.ts`)
 *  - the sender-side settlement verifier (`packages/sdk/src/settlement/evm.ts`, `.../solana.ts`)
 *
 * Extracted from `packages/mill/src/payment-channel-signer.ts` (Story 12.4)
 * per Story 12.6 AC-6 so the two sides cannot drift: any change to the hash
 * layout here automatically applies to both signer and verifier.
 *
 * @module
 * @since 12.6
 * @see _bmad-output/epics/epic-12-token-swap-primitive.md
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js';

/**
 * Convert a hex string (with or without `0x` prefix) to bytes. Rejects
 * odd-length and non-hex input.
 *
 * @since 12.6
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  return nobleHexToBytes(clean);
}

/**
 * Encode a non-negative bigint as 32-byte big-endian. Throws if negative or
 * exceeds 256 bits.
 *
 * @since 12.6
 */
export function bigintToBytes32BE(x: bigint): Uint8Array {
  if (x < 0n) {
    throw new Error('bigint must be non-negative for balance-proof encoding');
  }
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error('bigint exceeds 256 bits');
  }
  return out;
}

/**
 * Concat N Uint8Arrays into one new Uint8Array.
 *
 * @since 12.6
 */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Compute the EVM balance-proof message hash:
 *   keccak256(channelId || cumulativeAmount(32BE) || nonce(32BE) || recipient)
 *
 * `channelIdBytes` MUST be 32 bytes. `recipientBytes` MUST be 20 bytes.
 * This hash is what `EvmPaymentChannelSigner.signBalanceProof` signs and
 * what `recoverEvmSignerAddress` recovers against.
 *
 * @stable — signer and verifier depend on the exact byte layout.
 * @since 12.6
 */
export function balanceProofHashEvm(
  channelIdBytes: Uint8Array,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipientBytes: Uint8Array
): Uint8Array {
  return keccak_256(
    concatBytes(
      channelIdBytes,
      bigintToBytes32BE(cumulativeAmount),
      bigintToBytes32BE(nonce),
      recipientBytes
    )
  );
}

/**
 * Compute the Solana balance-proof message hash:
 *   sha256(utf8(channelId) || cumulativeAmount(32BE) || nonce(32BE) || utf8(recipient))
 *
 * `channelId` and `recipient` are base58-encoded strings (ASCII-subset of
 * UTF-8). This hash is what `SolanaPaymentChannelSigner.signBalanceProof`
 * signs and what `verifyEd25519Signature` verifies against.
 *
 * @stable — signer and verifier depend on the exact byte layout.
 * @since 12.6
 */
export function balanceProofHashSolana(
  channelId: string,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipient: string
): Uint8Array {
  return sha256(
    concatBytes(
      new TextEncoder().encode(channelId),
      bigintToBytes32BE(cumulativeAmount),
      bigintToBytes32BE(nonce),
      new TextEncoder().encode(recipient)
    )
  );
}
