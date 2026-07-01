/**
 * Public settlement surface for `@toon-protocol/sdk`.
 *
 * Consumed by a swap sender (direct EVM/Solana settlement) OR by a
 * Chain Bridge DVM (Epic 13, kind:5260) that gas-sponsors + broadcasts the
 * settlement on behalf of the sender.
 *
 * @module
 * @since 12.6
 * @see _bmad-output/implementation-artifacts/12-6-build-settlement-tx.md
 */

export {
  buildSettlementTx,
  verifyAccumulatedClaim,
} from './build-settlement-tx.js';

export { fillEvmSettlementTxGas } from './evm.js';

export { verifyEd25519Signature } from './solana.js';

export {
  balanceProofHashEvm,
  balanceProofHashSolana,
  balanceProofFieldsMina,
  minaHashToField,
  bigintToBytes32BE,
  concatBytes,
  hexToBytes,
} from './hashes.js';

export { verifyMinaSignature, loadMinaSignerClient } from './mina.js';
export type { MinaSignerClientLike } from './mina.js';

export type {
  SettlementBundle,
  BuildSettlementTxParams,
  BuildSettlementTxResult,
  SwapSignerConfig,
} from './types.js';
