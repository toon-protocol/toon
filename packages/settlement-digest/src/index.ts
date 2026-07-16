/**
 * `@toon-protocol/settlement-digest` — dependency-light leaf (`@noble/*` only)
 * for the RollingSwapChannel v2 EIP-712 balance-proof digest and the
 * Solana/Mina message digests, plus pure EVM signer recovery.
 *
 * Extracted from `@toon-protocol/core` (`settlement/hashes.ts`) and
 * `@toon-protocol/sdk` (`settlement/evm.ts`) so any consumer — the toon
 * monorepo's core/sdk/swap, the toon-client, and the connector's off-chain
 * verifier — can share ONE byte-identical digest without core's heavy tree or
 * its optional circular peer-dep on the connector (Phase 1 of connector#329).
 *
 * The digest bytes are a published wire contract (core/sdk@3.0.0); the leaf
 * OWNS the golden vectors from `docs/rolling-swap-v2-digest-spec.md` §4.
 *
 * @module
 */

// Byte helpers.
export { hexToBytes, bigintToBytes32BE, concatBytes } from './hashes.js';

// EVM v2 EIP-712 digest + exported typehash/domain constants.
export {
  eip712DomainSeparatorEvm,
  balanceProofHashEvm,
  coopCloseHashEvm,
  EIP712DOMAIN_TYPEHASH,
  DOMAIN_NAME_HASH,
  DOMAIN_VERSION_HASH,
  CLAIM_TYPEHASH,
  COOP_CLOSE_TYPEHASH,
} from './hashes.js';

// Non-EVM message digests.
export {
  balanceProofHashSolana,
  minaHashToField,
  balanceProofFieldsMina,
} from './hashes.js';

// Pure EVM signer recovery + verification.
export {
  recoverEvmSigner,
  recoverEvmClaimSigner,
  verifyEvmClaimSignature,
} from './recover.js';
export type { EvmClaimDigestParams } from './recover.js';
