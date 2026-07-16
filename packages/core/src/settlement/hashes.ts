/**
 * Shared balance-proof hash helpers — now re-exported from the dependency-light
 * leaf `@toon-protocol/settlement-digest`.
 *
 * These are the single source of truth for the byte/field layout that ALL
 * signers and verifiers across the monorepo depend on:
 *  - the Swap-side signer (`packages/swap/src/payment-channel-signer.ts`)
 *  - the sender-side settlement verifier (`packages/sdk/src/settlement/{evm,solana,mina}.ts`)
 *  - the client-side balance-proof signers (`packages/client/src/signing/{solana,mina}-signer.ts`)
 *
 * Originally extracted from the Swap signer (Story 12.4) into `@toon-protocol/sdk`
 * (Story 12.6 AC-6), then relocated here to `@toon-protocol/core` so the client
 * could consume the canonical hashes without depending on the SDK. As of
 * connector#329 Phase 1 the digest itself lives in the `@toon-protocol/core`-free
 * leaf `@toon-protocol/settlement-digest` (`@noble/*`-only) so the connector's
 * off-chain verifier can share the SAME bytes without core's heavy transitive
 * tree. `@toon-protocol/core` (this file) and `@toon-protocol/sdk` re-export the
 * names unchanged, so Swap, the client, and existing SDK consumers are
 * unaffected — the public API is byte-identical to before.
 *
 * Any change to a hash layout must be made in `@toon-protocol/settlement-digest`
 * — it applies to every signer AND verifier at once; they cannot drift.
 *
 * NOTE: base58 (`./base58.ts`) and the Mina *key derivation* (`./mina-key.ts`)
 * intentionally REMAIN in `@toon-protocol/core` — they are not digests.
 *
 * @module
 */

export {
  // Byte helpers.
  hexToBytes,
  bigintToBytes32BE,
  concatBytes,
  // EVM v2 EIP-712 digest.
  eip712DomainSeparatorEvm,
  balanceProofHashEvm,
  coopCloseHashEvm,
  // Non-EVM message digests.
  balanceProofHashSolana,
  minaHashToField,
  balanceProofFieldsMina,
} from '@toon-protocol/settlement-digest';
