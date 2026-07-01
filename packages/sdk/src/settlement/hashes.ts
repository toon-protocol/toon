/**
 * Shared balance-proof hash helpers — re-exported from `@toon-protocol/core`.
 *
 * The canonical hash/field layouts (the single source of truth for every
 * signer and verifier) now live in `@toon-protocol/core`'s settlement module so
 * the `@toon-protocol/client` package can consume them without depending on the
 * SDK. This file preserves the historical `@toon-protocol/sdk` import surface
 * (Story 12.6 AC-6) so existing SDK consumers and `@toon-protocol/swap` (which
 * import these names via the SDK root export) are unaffected.
 *
 * Any change to a hash layout must be made in `@toon-protocol/core` — it
 * applies to the Swap signer, the SDK verifiers, and the client signers at once.
 *
 * @module
 * @since 12.6
 * @see _bmad-output/epics/epic-12-token-swap-primitive.md
 */

export {
  hexToBytes,
  bigintToBytes32BE,
  concatBytes,
  balanceProofHashEvm,
  balanceProofHashSolana,
  minaHashToField,
  balanceProofFieldsMina,
} from '@toon-protocol/core';
