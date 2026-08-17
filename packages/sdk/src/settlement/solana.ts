/**
 * Solana-specific settlement tx construction + signature verification
 * (Story 12.6 AC-9).
 *
 * ## What the deployed program actually expects (toon#214)
 *
 * The settlement target is the NATIVE (non-Anchor) payment-channel program in
 * connector `packages/solana-program/`. Everything in this module is derived
 * from that source, not guessed:
 *
 * - Instruction discriminator: `CLAIM_FROM_CHANNEL = [6,0,0,0,0,0,0,0]` — a
 *   flat 8-byte tag, NOT an Anchor `sha256("global:<ix_name>")` prefix
 *   (`instruction.rs:12`).
 * - Instruction data: `discriminator(8) || nonce(8 LE) || transferred_amount(8 LE)`
 *   — nonce FIRST (`instruction.rs:78-96`).
 * - The 64-byte balance-proof signature travels OUT OF BAND: it is not part of
 *   the program's instruction data at all. It must be verified by the Ed25519
 *   precompile in a SEPARATE instruction at transaction index 0, which the
 *   program then introspects through the Instructions sysvar
 *   (`processor.rs:799-806`, `831-912`).
 * - The signed message is the RAW 48 bytes
 *   `channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)`
 *   (`processor.rs:900-910`) — see `balanceProofMessageSolana`. It is compared
 *   byte-for-byte, so no hash of those fields can ever satisfy it.
 * - Accounts, positional (`processor.rs:664-675`):
 *     0. fee_payer     [signer]   — the submitter; pays the fee and signs the tx
 *     1. claimer       []         — the participant whose transferred_amount
 *                                   advances (the PAYER of the claim). It does
 *                                   NOT sign the tx; the precompile signature
 *                                   is its authorization (connector#99).
 *     2. channel_pda   [writable] — the 178-byte `ChannelState` account
 *     3. instructions  []         — the Instructions sysvar
 *
 * For a swap leg this maps to: `claimer` = the Swap's on-chain signer
 * (`claim.swapSignerAddress`), `fee_payer` = the `recipient` redeeming the
 * claim, `channel_pda` = the claim's `channelId` (a Solana channelId IS its
 * channel PDA).
 *
 * The two other client-side implementations of the same wire format, kept
 * byte-identical to this one, are connector
 * `crates/connector-settlement-solana/src/wire.rs` (Rust) and toon-client
 * `packages/client/src/channel/solana-payment-channel.ts` (channel open /
 * deposit).
 *
 * @module
 * @since 12.6
 * @see _bmad-output/implementation-artifacts/12-6-build-settlement-tx.md
 */

import { ed25519 } from '@noble/curves/ed25519.js';

import { SettlementTxError } from '../errors.js';
import { base58Decode, base58Encode } from '../identity.js';
import type { AccumulatedClaim } from './accumulated-claim.js';
import { balanceProofMessageSolana, concatBytes } from './hashes.js';
import type { SwapSignerConfig, SettlementBundle } from './types.js';

/**
 * Build the 48-byte balance-proof message for a claim, or throw a settlement
 * error naming the missing/invalid field.
 */
function claimBalanceProofMessage(claim: AccumulatedClaim): Uint8Array {
  if (
    claim.channelId === undefined ||
    claim.cumulativeAmount === undefined ||
    claim.nonce === undefined
  ) {
    throw new SettlementTxError(
      'MISSING_SETTLEMENT_METADATA',
      'Claim missing channelId/cumulativeAmount/nonce for Solana balance proof'
    );
  }
  let channelPda: Uint8Array;
  try {
    channelPda = base58Decode(claim.channelId);
  } catch (err) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana channelId is not valid base58: ${claim.channelId}`,
      { cause: err }
    );
  }
  try {
    return balanceProofMessageSolana(
      channelPda,
      BigInt(claim.nonce),
      BigInt(claim.cumulativeAmount)
    );
  } catch (err) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `Solana balance-proof message encoding failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Verify a Solana Ed25519 balance-proof signature against the message the
 * on-chain program verifies — the raw 48 bytes
 * `channel_pda || nonce(8 LE) || transferred_amount(8 LE)`.
 *
 * A signature that passes here is one the Ed25519 precompile will also accept
 * for this `(channelId, nonce, cumulativeAmount)`, which is the whole point:
 * before toon#214 this verified a `sha256(...)` digest no deployed program has
 * ever checked, so a claim could verify here and still be unredeemable.
 *
 * Note the message deliberately does NOT bind `recipient` — the program's does
 * not either. Who receives the payout is fixed by the channel's participants,
 * not by the proof.
 *
 * @since 12.6
 */
export function verifyEd25519Signature(
  claim: AccumulatedClaim,
  expectedSignerAddress: string
): boolean {
  if (claim.claimBytes.length !== 64) {
    throw new SettlementTxError(
      'INVALID_SIGNATURE_LENGTH',
      `Solana signature must be 64 bytes, got ${claim.claimBytes.length}`
    );
  }
  const message = claimBalanceProofMessage(claim);
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
    return ed25519.verify(claim.claimBytes, message, pubkeyBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wire constants — mirrored from connector packages/solana-program
// ---------------------------------------------------------------------------

/**
 * `PaymentChannelInstruction::ClaimFromChannel`'s discriminator
 * (connector `packages/solana-program/src/instruction.rs:12`). A flat u8 tag in
 * an 8-byte little-endian field — deliberately NOT an Anchor
 * `sha256("global:...")` prefix; the program is native and `unpack` matches on
 * these exact 8 bytes.
 */
export const SOLANA_CLAIM_FROM_CHANNEL_DISCRIMINATOR: Uint8Array =
  new Uint8Array([6, 0, 0, 0, 0, 0, 0, 0]);

/** The Ed25519 signature-verification precompile's program address. */
export const SOLANA_ED25519_PROGRAM_ID =
  'Ed25519SigVerify111111111111111111111111111';

/** The Instructions sysvar the program introspects the precompile through. */
export const SOLANA_INSTRUCTIONS_SYSVAR_ID =
  'Sysvar1nstructions1111111111111111111111111';

/** Size of a compiled legacy Message's 3-byte privilege header. */
const MESSAGE_HEADER_SIZE = 3;

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
 * Solana's `short_vec` (compact-u16) length prefix: 7 bits per byte, low group
 * first, high bit set on every byte but the last. One byte below 0x80, two up
 * to 0x3FFF. The previous encoder assumed one byte always sufficed and threw
 * above 127, which the Ed25519 precompile's 160-byte instruction data alone
 * would have tripped.
 */
function encodeShortVecLength(len: number): Uint8Array {
  if (!Number.isInteger(len) || len < 0 || len > 0xffff) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `short_vec length out of range: ${len}`
    );
  }
  const out: number[] = [];
  let remaining = len;
  for (;;) {
    const chunk = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      out.push(chunk);
      break;
    }
    out.push(chunk | 0x80);
  }
  return new Uint8Array(out);
}

/** Length of a compiled message's short_vec-prefixed account-key array. */
function accountKeysSectionLength(numKeys: number): number {
  return encodeShortVecLength(numKeys).length + numKeys * 32;
}

/**
 * Build the Ed25519 precompile instruction data that verifies `signature` by
 * `pubkey` over `message`, with all three data references pointing INTO this
 * same instruction (`*_instruction_index = 0xFFFF`).
 *
 * Layout (mirrors solana-sdk's `new_ed25519_instruction`, which cannot be used
 * here because it signs the message itself and this builder only ever holds a
 * signature it was handed):
 *
 * ```text
 *   [0]      num_signatures = 1
 *   [1]      padding
 *   [2..4]   signature_offset            u16 LE
 *   [4..6]   signature_instruction_index u16 LE = 0xFFFF
 *   [6..8]   public_key_offset           u16 LE
 *   [8..10]  public_key_instruction_index u16 LE = 0xFFFF
 *   [10..12] message_data_offset         u16 LE
 *   [12..14] message_data_size           u16 LE
 *   [14..16] message_instruction_index   u16 LE = 0xFFFF
 *   [16..48] pubkey
 *   [48..112] signature
 *   [112..]  message
 * ```
 *
 * The program re-reads these same offsets and rejects any index other than
 * `0xFFFF` (`processor.rs:859-875`), so cross-instruction data confusion is not
 * available even to a caller that wanted it.
 *
 * @since 12.6
 */
export function buildSolanaEd25519VerifyInstructionData(
  pubkey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array
): Uint8Array {
  if (pubkey.length !== 32) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Ed25519 precompile pubkey must be 32 bytes, got ${pubkey.length}`
    );
  }
  if (signature.length !== 64) {
    throw new SettlementTxError(
      'INVALID_SIGNATURE_LENGTH',
      `Ed25519 precompile signature must be 64 bytes, got ${signature.length}`
    );
  }
  const publicKeyOffset = 16;
  const signatureOffset = publicKeyOffset + 32;
  const messageDataOffset = signatureOffset + 64;
  const out = new Uint8Array(messageDataOffset + message.length);
  const view = new DataView(out.buffer);
  out[0] = 1; // num_signatures
  out[1] = 0; // padding
  view.setUint16(2, signatureOffset, true);
  view.setUint16(4, 0xffff, true);
  view.setUint16(6, publicKeyOffset, true);
  view.setUint16(8, 0xffff, true);
  view.setUint16(10, messageDataOffset, true);
  view.setUint16(12, message.length, true);
  view.setUint16(14, 0xffff, true);
  out.set(pubkey, publicKeyOffset);
  out.set(signature, signatureOffset);
  out.set(message, messageDataOffset);
  return out;
}

/**
 * Build `ClaimFromChannel`'s instruction data:
 * `discriminator(8) || nonce(8 LE) || transferred_amount(8 LE)`.
 *
 * @since 12.6
 */
export function buildSolanaClaimInstructionData(
  nonce: bigint,
  transferredAmount: bigint
): Uint8Array {
  return concatBytes(
    SOLANA_CLAIM_FROM_CHANNEL_DISCRIMINATOR,
    bigintToBytes8LE(nonce),
    bigintToBytes8LE(transferredAmount)
  );
}

/**
 * Patch a real recent blockhash into the `unsignedTxBytes` of a Solana
 * settlement bundle, returning a new byte array.
 *
 * `buildSolanaSettlementTx` emits an all-zero blockhash placeholder, so the
 * submitter must call this (with `getLatestBlockhash`'s value) before signing.
 * The offset is derived from the message's own header + account-key count
 * rather than hard-coded, so this stays correct if the account list changes.
 *
 * @since 12.6
 */
export function patchSolanaRecentBlockhash(
  messageBytes: Uint8Array,
  recentBlockhash: Uint8Array | string
): Uint8Array {
  const blockhash =
    typeof recentBlockhash === 'string'
      ? base58Decode(recentBlockhash)
      : recentBlockhash;
  if (blockhash.length !== 32) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana recent blockhash must be 32 bytes, got ${blockhash.length}`
    );
  }
  if (messageBytes.length < MESSAGE_HEADER_SIZE + 1) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      'Solana message is too short to carry a header + account keys'
    );
  }
  // Only single-byte key counts occur here (this builder compiles 6 keys), and
  // a legacy message can address at most 256 accounts anyway.
  const numKeys = messageBytes[MESSAGE_HEADER_SIZE] as number;
  if (numKeys >= 0x80) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana message account-key count is not single-byte short_vec: ${numKeys}`
    );
  }
  const offset = MESSAGE_HEADER_SIZE + accountKeysSectionLength(numKeys);
  if (messageBytes.length < offset + 32) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      'Solana message is truncated before its recent-blockhash field'
    );
  }
  const out = new Uint8Array(messageBytes);
  out.set(blockhash, offset);
  return out;
}

/** Decode a base58 address to exactly 32 bytes, or throw a named error. */
function decode32(
  value: string,
  label: string,
  code: 'INVALID_INPUT' | 'ENCODING_FAILED' = 'INVALID_INPUT'
): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(value);
  } catch (err) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `Solana settlement tx: ${label} is not valid base58 (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }
  if (bytes.length !== 32) {
    throw new SettlementTxError(
      code,
      `Solana ${label} must decode to 32 bytes, got ${bytes.length}`
    );
  }
  return bytes;
}

/**
 * Build a Solana `SettlementBundle` from a winning AccumulatedClaim.
 *
 * `unsignedTxBytes` is a compiled legacy `Message` (NOT a `Transaction`, which
 * would require signatures) carrying TWO instructions, in the order the program
 * demands:
 *
 *   0. Ed25519 precompile — verifies `claim.claimBytes` by the Swap signer over
 *      the 48-byte balance proof. Must be index 0: the program loads
 *      instruction 0 from the Instructions sysvar and rejects anything else
 *      (`processor.rs:838-845`).
 *   1. `ClaimFromChannel` on `signer.programId`.
 *
 * Account keys, in the privilege order a legacy message header encodes
 * (writable signers, readonly signers, writable non-signers, readonly
 * non-signers):
 *
 * ```text
 *   0  recipient (fee payer)  writable, SIGNER
 *   1  channel PDA            writable
 *   2  claimer (swap signer)  readonly
 *   3  Instructions sysvar    readonly
 *   4  Ed25519 precompile     readonly (program of ix 0)
 *   5  payment-channel program readonly (program of ix 1)
 * ```
 *
 * The caller (direct sender OR a Chain Bridge DVM) MUST patch in a real recent
 * blockhash — see {@link patchSolanaRecentBlockhash} — before signing with the
 * `recipient` key and submitting; the bundle carries an all-zero placeholder.
 * The single required signature is the fee payer's, so the recipient can redeem
 * unilaterally: the Swap never co-signs the transaction.
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
  if (winner.claimBytes.length !== 64) {
    throw new SettlementTxError(
      'INVALID_SIGNATURE_LENGTH',
      `Solana balance-proof signature must be 64 bytes, got ${winner.claimBytes.length}`
    );
  }

  const programIdBytes = decode32(signer.programId, 'programId');
  const feePayerBytes = decode32(recipient, 'recipient');
  const claimerBytes = decode32(winner.swapSignerAddress, 'swapSignerAddress');
  const channelPdaBytes = decode32(winner.channelId, 'channelId');
  const instructionsSysvarBytes = base58Decode(SOLANA_INSTRUCTIONS_SYSVAR_ID);
  const ed25519ProgramBytes = base58Decode(SOLANA_ED25519_PROGRAM_ID);

  const accounts = [
    feePayerBytes, //           0 writable signer  — fee payer / claim recipient
    channelPdaBytes, //         1 writable         — ChannelState account
    claimerBytes, //            2 readonly         — authorized by the precompile
    instructionsSysvarBytes, // 3 readonly
    ed25519ProgramBytes, //     4 readonly         — program of instruction 0
    programIdBytes, //          5 readonly         — program of instruction 1
  ];

  // A legacy message addresses each account ONCE; a duplicate key makes the
  // runtime reject the transaction (AccountLoadedTwice) rather than dedupe it.
  // The realistic collision is a claim whose swap signer is also the recipient.
  const seen = new Set(accounts.map((a) => base58Encode(a)));
  if (seen.size !== accounts.length) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Solana settlement accounts must be distinct (recipient=${recipient}, ` +
        `swapSigner=${winner.swapSignerAddress}, channelId=${winner.channelId}, ` +
        `programId=${signer.programId})`
    );
  }

  const balanceProof = claimBalanceProofMessage(winner);
  const ed25519Data = buildSolanaEd25519VerifyInstructionData(
    claimerBytes,
    winner.claimBytes,
    balanceProof
  );
  const claimData = buildSolanaClaimInstructionData(
    BigInt(winner.nonce),
    BigInt(winner.cumulativeAmount)
  );

  // header: [numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned].
  // One signer (the fee payer), no readonly signers, four readonly non-signers
  // — which makes index 1 (the channel PDA) the only writable non-signer.
  const header = new Uint8Array([1, 0, 4]);

  const ed25519Instruction = concatBytes(
    new Uint8Array([4]), // program id index: Ed25519 precompile
    encodeShortVecLength(0), // takes no accounts
    encodeShortVecLength(ed25519Data.length),
    ed25519Data
  );
  const claimInstruction = concatBytes(
    new Uint8Array([5]), // program id index: payment-channel program
    encodeShortVecLength(4),
    // Positional, per processor.rs: fee_payer, claimer, channel_pda, instructions.
    new Uint8Array([0, 2, 1, 3]),
    encodeShortVecLength(claimData.length),
    claimData
  );

  const unsignedTxBytes = concatBytes(
    header,
    encodeShortVecLength(accounts.length),
    ...accounts,
    new Uint8Array(32), // recent blockhash placeholder — caller patches
    encodeShortVecLength(2),
    ed25519Instruction,
    claimInstruction
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
