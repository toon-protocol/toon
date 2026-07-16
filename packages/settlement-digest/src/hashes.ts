/**
 * Balance-proof digest helpers — the dependency-light single source of truth for
 * the byte/field layout that ALL signers and verifiers across the TOON ecosystem
 * depend on (the toon monorepo's `@toon-protocol/core` + `@toon-protocol/sdk`,
 * the swap signer, the toon-client leg, and the connector's off-chain verifier).
 *
 * This module was extracted VERBATIM from `@toon-protocol/core`'s
 * `settlement/hashes.ts` (Phase 1 of connector#329) so the digest can be consumed
 * WITHOUT pulling in core's heavy transitive tree (`arweave`, `@ardrive/turbo-sdk`,
 * `nostr-tools`, `simple-git`, `ws`) or its optional circular peer-dep on the
 * connector. Its only runtime deps are `@noble/hashes` (+ `@noble/curves` for the
 * recover helpers in `./recover.ts`).
 *
 * The byte output here is a published wire contract: `@toon-protocol/core@3.0.0`
 * and `@toon-protocol/sdk@3.0.0` shipped these exact digests, and the on-chain
 * `RollingSwapChannel` verifier reproduces them. Any change to a hash layout here
 * is an ABI-breaking wire migration.
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

// ---------------------------------------------------------------------------
// EVM v2 balance-proof digest — EIP-712 domain-separated
// (refs connector#324 finding #1; canonical spec:
//  connector `docs/rolling-swap-v2-digest-spec.md`, connector#325)
//
// The v1 digest was `keccak256(channelId || cumulative(32BE) || nonce(32BE) ||
// recipient(20))` with NO domain separation, which allowed a signature earned
// on one (chain, contract) pair to be replayed verbatim on another. v2 folds
// `chainId` AND `verifyingContract` into the signed preimage via a standard
// EIP-712 typed-data domain, so a signature is valid on EXACTLY one
// (chainId, contract) pair. `version = "2"` makes the cutover fail-closed: a v1
// raw-keccak signature can never validate as v2 and vice-versa.
//
// This is an ABI-BREAKING wire migration — the swap signer, the sdk builder,
// and the toon-client leg MUST adopt the same v2 preimage in lock-step. The
// two new REQUIRED inputs (`chainId`, `verifyingContract`) are what v1 lacked.
// ---------------------------------------------------------------------------

const EIP712_PREFIX = new Uint8Array([0x19, 0x01]);

/** keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
 *  = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f */
export const EIP712DOMAIN_TYPEHASH: Uint8Array = keccak_256(
  new TextEncoder().encode(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  )
);

/** keccak256("RollingSwapChannel")
 *  = 0x03b1e55f7f93cd70e54a750705030a137e734d1a9c1f1921ac04f8898b004f7f */
export const DOMAIN_NAME_HASH: Uint8Array = keccak_256(
  new TextEncoder().encode('RollingSwapChannel')
);

/** keccak256("2") = 0xad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5 */
export const DOMAIN_VERSION_HASH: Uint8Array = keccak_256(
  new TextEncoder().encode('2')
);

/** keccak256("ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)")
 *  = 0xa0c8262c1a8615f7674d3af796b14d19672d3634f89c6093502ab35c0afe2d91 */
export const CLAIM_TYPEHASH: Uint8Array = keccak_256(
  new TextEncoder().encode(
    'ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)'
  )
);

/** keccak256("CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)")
 *  = 0xa5753389755fea51cd5016d7b02b508ac03f2e822d9a7ee345ec45b36574ff9f */
export const COOP_CLOSE_TYPEHASH: Uint8Array = keccak_256(
  new TextEncoder().encode(
    'CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)'
  )
);

/**
 * Left-pad `bytes` (<= 32) into a 32-byte word (big-endian / right-aligned).
 * Used to place a 20-byte `address` into an `abi.encode` word.
 */
function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) {
    throw new Error(`cannot left-pad ${bytes.length} bytes into 32`);
  }
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/**
 * Compute the EIP-712 domain separator for the RollingSwapChannel v2 domain:
 *   keccak256(abi.encode(
 *     EIP712DOMAIN_TYPEHASH,
 *     keccak256("RollingSwapChannel"),
 *     keccak256("2"),
 *     chainId,               // uint256, big-endian
 *     verifyingContract      // address, right-aligned in 32 bytes
 *   ))
 *
 * `verifyingContractBytes` MUST be the 20-byte deployed RollingSwapChannel
 * address. Equivalent to OpenZeppelin `EIP712._domainSeparatorV4()`.
 *
 * @stable — every signer and verifier depends on the exact layout.
 */
export function eip712DomainSeparatorEvm(
  chainId: bigint,
  verifyingContractBytes: Uint8Array
): Uint8Array {
  if (verifyingContractBytes.length !== 20) {
    throw new Error(
      `verifyingContract must be 20 bytes (got ${verifyingContractBytes.length})`
    );
  }
  return keccak_256(
    concatBytes(
      EIP712DOMAIN_TYPEHASH,
      DOMAIN_NAME_HASH,
      DOMAIN_VERSION_HASH,
      bigintToBytes32BE(chainId),
      leftPad32(verifyingContractBytes)
    )
  );
}

/** Final EIP-712 digest: keccak256(0x1901 || domainSeparator || structHash). */
function eip712Digest(
  domainSeparator: Uint8Array,
  structHash: Uint8Array
): Uint8Array {
  return keccak_256(concatBytes(EIP712_PREFIX, domainSeparator, structHash));
}

/**
 * Compute the v2 EVM balance-proof (claim) digest — the 32-byte EIP-712 typed
 * digest the swap node signs and the on-chain `RollingSwapChannel` verifies:
 *
 *   structHash = keccak256(abi.encode(
 *     CLAIM_TYPEHASH, channelId, cumulativeAmount, nonce, recipient))
 *   digest     = keccak256(0x1901 || domainSeparator || structHash)
 *
 * with domain `EIP712Domain(name="RollingSwapChannel", version="2", chainId,
 * verifyingContract)`. `channelIdBytes` MUST be 32 bytes, `recipientBytes` MUST
 * be 20 bytes, `verifyingContractBytes` MUST be the 20-byte deployed contract
 * address. Equivalent to OZ `EIP712._hashTypedDataV4(claimStructHash)`.
 *
 * v2 REQUIRES `chainId` + `verifyingContract` — the two inputs v1 lacked. This
 * hash is what `EvmPaymentChannelSigner.signBalanceProof` signs and what
 * `recoverEvmSigner` recovers against.
 *
 * @stable — signer and verifier depend on the exact byte layout.
 */
export function balanceProofHashEvm(
  channelIdBytes: Uint8Array,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipientBytes: Uint8Array,
  chainId: bigint,
  verifyingContractBytes: Uint8Array
): Uint8Array {
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
  const structHash = keccak_256(
    concatBytes(
      CLAIM_TYPEHASH,
      channelIdBytes,
      bigintToBytes32BE(cumulativeAmount),
      bigintToBytes32BE(nonce),
      leftPad32(recipientBytes)
    )
  );
  return eip712Digest(
    eip712DomainSeparatorEvm(chainId, verifyingContractBytes),
    structHash
  );
}

/**
 * Compute the v2 EVM cooperative-close digest — the 32-byte EIP-712 typed
 * digest the recipient signs to acknowledge a cooperative close:
 *
 *   structHash = keccak256(abi.encode(
 *     COOP_CLOSE_TYPEHASH, channelId, cumulativeAmount, nonce))
 *   digest     = keccak256(0x1901 || domainSeparator || structHash)
 *
 * Shares the SAME domain as the claim digest (so it is bound to
 * `chainId + verifyingContract` too), but the distinct `CooperativeClose`
 * type hash guarantees a close-ack can never be recovered as a balance-proof
 * claim (or vice-versa). `channelIdBytes` MUST be 32 bytes.
 *
 * @stable — signer and verifier depend on the exact byte layout.
 */
export function coopCloseHashEvm(
  channelIdBytes: Uint8Array,
  cumulativeAmount: bigint,
  nonce: bigint,
  chainId: bigint,
  verifyingContractBytes: Uint8Array
): Uint8Array {
  if (channelIdBytes.length !== 32) {
    throw new Error(
      `channelId must be 32 bytes (got ${channelIdBytes.length})`
    );
  }
  const structHash = keccak_256(
    concatBytes(
      COOP_CLOSE_TYPEHASH,
      channelIdBytes,
      bigintToBytes32BE(cumulativeAmount),
      bigintToBytes32BE(nonce)
    )
  );
  return eip712Digest(
    eip712DomainSeparatorEvm(chainId, verifyingContractBytes),
    structHash
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
