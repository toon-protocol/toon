/**
 * Solana-specific settlement tx construction + signature verification
 * (Story 12.6 AC-9).
 *
 * @module
 * @since 12.6
 * @see _bmad-output/implementation-artifacts/12-6-build-settlement-tx.md
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { SettlementTxError } from '../errors.js';
import { base58Decode, base58Encode } from '../identity.js';
import type { AccumulatedClaim } from '../stream-swap.js';
import { balanceProofHashSolana, concatBytes } from './hashes.js';
import type { SwapSignerConfig, SettlementBundle } from './types.js';

/**
 * Verify a Solana Ed25519 balance-proof signature.
 *
 * @since 12.6
 */
export function verifyEd25519Signature(
  claim: AccumulatedClaim,
  expectedSignerAddress: string
): boolean {
  if (
    claim.channelId === undefined ||
    claim.cumulativeAmount === undefined ||
    claim.nonce === undefined ||
    claim.recipient === undefined
  ) {
    throw new SettlementTxError(
      'MISSING_SETTLEMENT_METADATA',
      'Claim missing channelId/cumulativeAmount/nonce/recipient for Solana signature verify'
    );
  }
  if (claim.claimBytes.length !== 64) {
    throw new SettlementTxError(
      'INVALID_SIGNATURE_LENGTH',
      `Solana signature must be 64 bytes, got ${claim.claimBytes.length}`
    );
  }
  const msgHash = balanceProofHashSolana(
    claim.channelId,
    BigInt(claim.cumulativeAmount),
    BigInt(claim.nonce),
    claim.recipient
  );
  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = base58Decode(expectedSignerAddress);
  } catch (err) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana expected signer address is not valid base58: ${expectedSignerAddress}`,
      { cause: err }
    );
  }
  if (pubkeyBytes.length !== 32) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana expected signer pubkey must be 32 bytes, got ${pubkeyBytes.length}`
    );
  }
  try {
    return ed25519.verify(claim.claimBytes, msgHash, pubkeyBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Anchor discriminator (default — may be overridden if the real program is
// non-Anchor. TODO(12.6 follow-up): confirm via ../connector/packages/solana-program/.
// Story 12.8 E2E against a real program will catch drift.)
// ---------------------------------------------------------------------------

const SOLANA_UPDATE_BALANCE_DISCRIMINATOR: Uint8Array = sha256(
  new TextEncoder().encode('global:update_balance')
).slice(0, 8);

/**
 * Write an 8-byte little-endian representation of a non-negative bigint.
 * Throws if value > 2^64 - 1.
 */
function bigintToBytes8LE(x: bigint): Uint8Array {
  if (x < 0n) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      'bigintToBytes8LE: negative input'
    );
  }
  if (x > 0xffffffffffffffffn) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      'bigintToBytes8LE: value exceeds 64 bits'
    );
  }
  const out = new Uint8Array(8);
  let v = x;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Build a Solana `SettlementBundle` from a winning AccumulatedClaim.
 *
 * Produces a serialized legacy `Message` (NOT `Transaction`, since Transaction
 * requires signatures). The Message header + account keys + placeholder
 * blockhash + single instruction invoking `signer.programId`.
 *
 * NOTE: This Message is a TEMPLATE. The caller (direct sender OR a Chain
 * Bridge DVM) MUST patch in a real recent blockhash before signing — the
 * current bundle carries an all-zero blockhash placeholder.
 *
 * @stable
 * @since 12.6
 */
export function buildSolanaSettlementTx(
  winner: AccumulatedClaim,
  signer: SwapSignerConfig,
  recipient: string,
  selectedClaimIndex: number,
  claimsMerged: number
): SettlementBundle {
  if (
    winner.channelId === undefined ||
    winner.cumulativeAmount === undefined ||
    winner.nonce === undefined ||
    winner.recipient === undefined ||
    winner.swapSignerAddress === undefined
  ) {
    throw new SettlementTxError(
      'MISSING_SETTLEMENT_METADATA',
      'Solana winner claim missing settlement-context fields'
    );
  }
  if (!signer.programId) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana SwapSignerConfig.programId is required for chain ${winner.pair.to.chain}`
    );
  }

  let programIdBytes: Uint8Array;
  let recipientBytes: Uint8Array;
  let swapBytes: Uint8Array;
  let channelIdBytes: Uint8Array;
  try {
    programIdBytes = base58Decode(signer.programId);
    recipientBytes = base58Decode(recipient);
    swapBytes = base58Decode(winner.swapSignerAddress);
    channelIdBytes = base58Decode(winner.channelId);
  } catch (err) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `Solana settlement tx: base58 decode failed (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }
  if (programIdBytes.length !== 32) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana programId must be 32 bytes, got ${programIdBytes.length}`
    );
  }
  if (recipientBytes.length !== 32) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana recipient must decode to 32 bytes, got ${recipientBytes.length}`
    );
  }
  if (swapBytes.length !== 32) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana swapSignerAddress must decode to 32 bytes, got ${swapBytes.length}`
    );
  }
  if (channelIdBytes.length !== 32) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana channelId must decode to 32 bytes, got ${channelIdBytes.length}`
    );
  }

  // Instruction data: discriminator(8) || cumulative(8 LE) || nonce(8 LE) || signature(64)
  const instructionData = concatBytes(
    SOLANA_UPDATE_BALANCE_DISCRIMINATOR,
    bigintToBytes8LE(BigInt(winner.cumulativeAmount)),
    bigintToBytes8LE(BigInt(winner.nonce)),
    winner.claimBytes
  );

  // Accounts: [recipient (signer), swap, channel-state, system-program, programId]
  // We construct a minimal Message. For simplicity, use 4 accounts:
  //   [0] recipient (signer, writable)
  //   [1] swap (writable)
  //   [2] channel-state (writable, derived — we approximate via channelIdBytes)
  //   [3] program (readonly)
  const accounts = [recipientBytes, swapBytes, channelIdBytes, programIdBytes];

  // Message header: [numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned]
  const header = new Uint8Array([1, 0, 1]); // 1 signer (recipient), 1 readonly unsigned (program)

  // Compact-u16 length encoding (for small counts, one byte suffices)
  const accountsCountByte = new Uint8Array([accounts.length]);
  const recentBlockhash = new Uint8Array(32); // placeholder — caller patches
  const instructionsCountByte = new Uint8Array([1]);

  // Instruction: programIdIndex (u8) || accountsLen (compact-u16) ||
  //   accountIndices(u8 each) || dataLen (compact-u16) || data
  const programIdIndex = new Uint8Array([3]); // index of program in accounts
  const instrAccountsLen = new Uint8Array([3]); // recipient, swap, channel-state
  const instrAccountIndices = new Uint8Array([0, 1, 2]);
  // Instruction data length as compact-u16 (assume <127)
  if (instructionData.length >= 0x80) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `Solana instruction data too large for simple compact-u16 encoding: ${instructionData.length}`
    );
  }
  const instrDataLen = new Uint8Array([instructionData.length]);

  const instruction = concatBytes(
    programIdIndex,
    instrAccountsLen,
    instrAccountIndices,
    instrDataLen,
    instructionData
  );

  const unsignedTxBytes = concatBytes(
    header,
    accountsCountByte,
    ...accounts,
    recentBlockhash,
    instructionsCountByte,
    instruction
  );

  return {
    chain: winner.pair.to.chain,
    chainKind: 'solana',
    channelId: winner.channelId,
    cumulativeAmount: winner.cumulativeAmount,
    nonce: winner.nonce,
    recipient,
    swapSignerAddress: winner.swapSignerAddress,
    unsignedTxBytes,
    claimsMerged,
    selectedClaimIndex,
    sourceChain: winner.pair.from.chain,
    sourceAssetCode: winner.pair.from.assetCode,
  };
}

/**
 * Re-export base58 helpers so callers (e.g., a Chain Bridge DVM) can round-
 * trip Solana addresses without a second base58 impl.
 *
 * @since 12.6
 */
export { base58Decode, base58Encode };
