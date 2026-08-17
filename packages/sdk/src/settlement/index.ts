/**
 * Public settlement surface for `@toon-protocol/sdk`.
 *
 * Consumed by a swap sender (direct EVM/Solana settlement) OR by a
 * Chain Bridge DVM (Epic 13, kind:5260) that gas-sponsors + broadcasts the
 * settlement on behalf of the sender.
 *
 * A Solana bundle is EXECUTABLE as of toon#214: its bytes are proven against the
 * real native payment-channel program by
 * `tests/integration/solana-claim-redeem.integration.test.ts`, which redeems a
 * claim on a local validator and asserts the channel account moved. That is only
 * true for claims signed over `balanceProofMessageSolana` — the raw 48-byte
 * message the program's Ed25519 precompile check reconstructs. A claim signed
 * over the legacy `balanceProofHashSolana` digest is REJECTED here rather than
 * built into a bundle the chain would refuse.
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

export {
  verifyEd25519Signature,
  buildSolanaClaimInstructionData,
  buildSolanaEd25519VerifyInstructionData,
  patchSolanaRecentBlockhash,
  SOLANA_CLAIM_FROM_CHANNEL_DISCRIMINATOR,
  SOLANA_ED25519_PROGRAM_ID,
  SOLANA_INSTRUCTIONS_SYSVAR_ID,
} from './solana.js';

export {
  balanceProofHashEvm,
  coopCloseHashEvm,
  eip712DomainSeparatorEvm,
  balanceProofMessageSolana,
  SOLANA_BALANCE_PROOF_MESSAGE_SIZE,
  balanceProofHashSolana,
  balanceProofFieldsMina,
  minaHashToField,
  bigintToBytes32BE,
  concatBytes,
  hexToBytes,
} from './hashes.js';

export { verifyMinaSignature, loadMinaSignerClient } from './mina.js';
export type { MinaSignerClientLike } from './mina.js';

export type { AccumulatedClaim } from './accumulated-claim.js';

export type {
  SettlementBundle,
  BuildSettlementTxParams,
  BuildSettlementTxResult,
  SwapSignerConfig,
} from './types.js';
