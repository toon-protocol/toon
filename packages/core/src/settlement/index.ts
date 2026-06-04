/**
 * Settlement chain negotiation utilities.
 *
 * Pure functions for selecting the best matching settlement chain
 * and token between peers during registration.
 */

export {
  negotiateSettlementChain,
  resolveTokenForChain,
} from './settlement.js';

// Canonical balance-proof hash/field layouts — the single source of truth for
// every signer and verifier in the monorepo (see ./hashes.ts). Plus the base58
// + Mina-key helpers needed to build chain-specific claims.
export {
  hexToBytes,
  bigintToBytes32BE,
  concatBytes,
  balanceProofHashEvm,
  balanceProofHashSolana,
  minaHashToField,
  balanceProofFieldsMina,
} from './hashes.js';

export { base58Encode, base58Decode } from './base58.js';

export { hexToMinaBase58PrivateKey } from './mina-key.js';
