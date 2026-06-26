/**
 * Shared balance-proof hash helpers — the single source of truth for the
 * byte/field layout that ALL signers and verifiers across the monorepo depend
 * on:
 *  - the Swap-side signer (`packages/swap/src/payment-channel-signer.ts`)
 *  - the sender-side settlement verifier (`packages/sdk/src/settlement/{evm,solana,mina}.ts`)
 *  - the client-side balance-proof signers (`packages/client/src/signing/{solana,mina}-signer.ts`)
 *
 * Originally extracted from the Swap signer (Story 12.4) into `@toon-protocol/sdk`
 * (Story 12.6 AC-6). Relocated here to `@toon-protocol/core` so the client can
 * consume the canonical hashes WITHOUT taking a dependency on `@toon-protocol/sdk`
 * (the client only depends on core). `@toon-protocol/sdk` re-exports these names
 * unchanged, so Swap and existing SDK consumers are unaffected.
 *
 * Any change to a hash layout here automatically applies to every signer AND
 * verifier — they cannot drift.
 *
 * @module
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  hexToBytes as nobleHexToBytes,
} from '@noble/hashes/utils.js';

/**
 * Convert a hex string (with or without `0x` prefix) to bytes. Rejects
 * odd-length and non-hex input.
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

/**
 * Hash an arbitrary string to a Pallas-field-safe bigint.
 *
 * The Pallas base field order is slightly below 2^254, so we take the first
 * 240 bits (60 hex chars / 30 bytes) of `sha256(utf8(s))` as a conservative,
 * guaranteed-in-field representation. Used to fold the variable-length
 * `channelId` / `recipient` strings into the fixed field-element array a Mina
 * Schnorr signature is computed over.
 *
 * @stable — Swap signer and SDK verifier depend on the exact derivation.
 */
export function minaHashToField(s: string): bigint {
  const digestHex = bytesToHex(sha256(new TextEncoder().encode(s)));
  return BigInt('0x' + digestHex.slice(0, 60));
}

/**
 * Compute the Mina balance-proof field-element message:
 *   [ minaHashToField(channelId),
 *     cumulativeAmount,
 *     nonce,
 *     minaHashToField(recipient) ]
 *
 * This is the EXACT `fields` array that the Swap's `MinaPaymentChannelSigner`
 * passes to `mina-signer`'s `signFields(...)`, and that the sender-side
 * `verifyMinaSignature` re-derives and passes to `verifyFields(...)`. Keeping
 * the derivation here (shared across `@toon-protocol/swap`, `@toon-protocol/sdk`,
 * and `@toon-protocol/client`) prevents signer/verifier drift — mirroring the
 * EVM/Solana hash helpers above.
 *
 * NOTE: this is the Swap↔sender wire contract (a Schnorr signature over four
 * field elements), NOT the connector's on-chain `MinaPaymentChannelSDK`
 * Poseidon-commitment proof shape. The two are distinct; see
 * `packages/sdk/src/settlement/mina.ts` for the relationship + the
 * remaining on-chain-settlement gap.
 *
 * @stable — Swap signer and SDK verifier depend on the exact byte layout.
 */
export function balanceProofFieldsMina(
  channelId: string,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipient: string
): bigint[] {
  return [
    minaHashToField(channelId),
    cumulativeAmount,
    nonce,
    minaHashToField(recipient),
  ];
}
