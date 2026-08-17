/**
 * Story 12.6 AC-9: Solana settlement tx encoding + Ed25519 verification.
 *
 * toon#214 rewrote what these tests assert. They previously signed and verified
 * `balanceProofHashSolana` — a digest no deployed program checks — and asserted
 * nothing about the emitted transaction beyond `length > 0`, which is exactly
 * why a tx that could never execute passed them. They now sign the program's own
 * 48-byte message and DECODE the compiled message, asserting the discriminator,
 * the field order, the account privileges and the out-of-band Ed25519 precompile
 * instruction against connector `packages/solana-program`.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { SwapPair } from '@toon-protocol/core';

import type { AccumulatedClaim } from './accumulated-claim.js';
import type { SettlementTxError } from '../errors.js';
import { base58Decode, base58Encode } from '../identity.js';
import { balanceProofHashSolana, balanceProofMessageSolana } from './hashes.js';
import {
  buildSolanaSettlementTx,
  patchSolanaRecentBlockhash,
  verifyEd25519Signature,
  SOLANA_CLAIM_FROM_CHANNEL_DISCRIMINATOR,
  SOLANA_ED25519_PROGRAM_ID,
  SOLANA_INSTRUCTIONS_SYSVAR_ID,
} from './solana.js';
import type { SwapSignerConfig } from './types.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
  rate: '0.001',
};

function fill32(byte: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(byte);
  return out;
}

function makeClaim(
  overrides: Partial<AccumulatedClaim> = {}
): AccumulatedClaim {
  const channelIdBytes = fill32(0x77);
  const recipientBytes = fill32(0x88);
  return {
    packetIndex: 0,
    sourceAmount: 1_000_000n,
    targetAmount: 500n,
    claimBytes: new Uint8Array(64),
    swapEphemeralPubkey: '0'.repeat(64),
    pair: PAIR,
    receivedAt: Date.now(),
    channelId: base58Encode(channelIdBytes),
    nonce: '1',
    cumulativeAmount: '500',
    recipient: base58Encode(recipientBytes),
    swapSignerAddress: base58Encode(fill32(0x99)),
    ...overrides,
  };
}

/** Deterministic test signer. */
function signer32(byte: number): {
  privateKey: Uint8Array;
  address: string;
} {
  const privateKey = new Uint8Array(32);
  privateKey[0] = byte;
  return {
    privateKey,
    address: base58Encode(new Uint8Array(ed25519.getPublicKey(privateKey))),
  };
}

/** Sign a claim the way the on-chain program requires. */
function signedClaim(overrides: Partial<AccumulatedClaim> = {}): {
  claim: AccumulatedClaim;
  signerAddress: string;
} {
  const { privateKey, address } = signer32(1);
  const base = makeClaim({ swapSignerAddress: address, ...overrides });
  const message = balanceProofMessageSolana(
    base58Decode(base.channelId as string),
    BigInt(base.nonce as string),
    BigInt(base.cumulativeAmount as string)
  );
  return {
    claim: {
      ...base,
      claimBytes: new Uint8Array(ed25519.sign(message, privateKey)),
    },
    signerAddress: address,
  };
}

// ---------------------------------------------------------------------------
// A minimal legacy-Message decoder, so the assertions below read as structure
// rather than as a golden blob. Mirrors Solana's own wire format.
// ---------------------------------------------------------------------------

interface DecodedInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

interface DecodedMessage {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  accountKeys: string[];
  recentBlockhash: Uint8Array;
  instructions: DecodedInstruction[];
}

function readShortVec(
  bytes: Uint8Array,
  offset: number
): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = bytes[cursor] as number;
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: cursor };
}

function decodeMessage(bytes: Uint8Array): DecodedMessage {
  const numRequiredSignatures = bytes[0] as number;
  const numReadonlySigned = bytes[1] as number;
  const numReadonlyUnsigned = bytes[2] as number;
  const keyCount = readShortVec(bytes, 3);
  const accountKeys: string[] = [];
  let cursor = keyCount.next;
  for (let i = 0; i < keyCount.value; i++) {
    accountKeys.push(base58Encode(bytes.slice(cursor, cursor + 32)));
    cursor += 32;
  }
  const recentBlockhash = bytes.slice(cursor, cursor + 32);
  cursor += 32;
  const ixCount = readShortVec(bytes, cursor);
  cursor = ixCount.next;
  const instructions: DecodedInstruction[] = [];
  for (let i = 0; i < ixCount.value; i++) {
    const programIdIndex = bytes[cursor] as number;
    cursor += 1;
    const accountsLen = readShortVec(bytes, cursor);
    cursor = accountsLen.next;
    const accounts: string[] = [];
    for (let a = 0; a < accountsLen.value; a++) {
      accounts.push(accountKeys[bytes[cursor] as number] as string);
      cursor += 1;
    }
    const dataLen = readShortVec(bytes, cursor);
    cursor = dataLen.next;
    instructions.push({
      programId: accountKeys[programIdIndex] as string,
      accounts,
      data: bytes.slice(cursor, cursor + dataLen.value),
    });
    cursor += dataLen.value;
  }
  expect(cursor).toBe(bytes.length);
  return {
    numRequiredSignatures,
    numReadonlySigned,
    numReadonlyUnsigned,
    accountKeys,
    recentBlockhash,
    instructions,
  };
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let out = 0n;
  for (let i = 0; i < 8; i++) {
    out |= BigInt(bytes[offset + i] as number) << BigInt(i * 8);
  }
  return out;
}

describe('verifyEd25519Signature (AC-9)', () => {
  it('[P0] returns true for a signature over the program-verified 48-byte message', () => {
    const { claim, signerAddress } = signedClaim();
    expect(verifyEd25519Signature(claim, signerAddress)).toBe(true);
  });

  it('[P0] returns false for a tampered signature', () => {
    const { claim, signerAddress } = signedClaim();
    const sig = new Uint8Array(claim.claimBytes);
    sig[0] = (sig[0] ?? 0) ^ 0x01;
    expect(
      verifyEd25519Signature({ ...claim, claimBytes: sig }, signerAddress)
    ).toBe(false);
  });

  it('[P0] returns false for a claim signed over the LEGACY sha256 digest (toon#214)', () => {
    // The pre-toon#214 scheme. Such a claim is unredeemable: the Ed25519
    // precompile verifies the raw 48-byte message, so accepting it here would
    // hand the caller a bundle the chain must reject.
    const { privateKey, address } = signer32(1);
    const base = makeClaim({ swapSignerAddress: address });
    const legacyDigest = balanceProofHashSolana(
      base.channelId as string,
      BigInt(base.cumulativeAmount as string),
      BigInt(base.nonce as string),
      base.recipient as string
    );
    const claim = {
      ...base,
      claimBytes: new Uint8Array(ed25519.sign(legacyDigest, privateKey)),
    };
    expect(verifyEd25519Signature(claim, address)).toBe(false);
  });

  it('[P0] a valid signature is INDEPENDENT of recipient — the program binds only channel/nonce/amount', () => {
    const { claim, signerAddress } = signedClaim();
    expect(
      verifyEd25519Signature(
        { ...claim, recipient: base58Encode(fill32(0x22)) },
        signerAddress
      )
    ).toBe(true);
  });

  it('[P0] tampering nonce, amount or channelId breaks verification', () => {
    const { claim, signerAddress } = signedClaim();
    expect(
      verifyEd25519Signature({ ...claim, nonce: '2' }, signerAddress)
    ).toBe(false);
    expect(
      verifyEd25519Signature(
        { ...claim, cumulativeAmount: '501' },
        signerAddress
      )
    ).toBe(false);
    expect(
      verifyEd25519Signature(
        { ...claim, channelId: base58Encode(fill32(0x55)) },
        signerAddress
      )
    ).toBe(false);
  });

  it('[P0] throws INVALID_SIGNATURE_LENGTH on wrong-length claimBytes', () => {
    const claim = makeClaim({ claimBytes: new Uint8Array(63) });
    try {
      verifyEd25519Signature(claim, claim.swapSignerAddress as string);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('INVALID_SIGNATURE_LENGTH');
    }
  });
});

describe('buildSolanaSettlementTx (AC-9, T-053)', () => {
  const programId = base58Encode(fill32(0x66));
  const signer: SwapSignerConfig = {
    address: base58Encode(fill32(0x99)),
    programId,
  };

  it('[P0] bundle carries the expected chain/channelId/cumulative/nonce/recipient', () => {
    const { claim, signerAddress } = signedClaim();
    const bundle = buildSolanaSettlementTx(
      claim,
      { address: signerAddress, programId },
      claim.recipient as string,
      0,
      1
    );
    expect(bundle.chain).toBe('solana:mainnet');
    expect(bundle.chainKind).toBe('solana');
    expect(bundle.channelId).toBe(claim.channelId);
    expect(bundle.cumulativeAmount).toBe('500');
    expect(bundle.nonce).toBe('1');
    expect(bundle.recipient).toBe(claim.recipient);
    expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
  });

  it('[P0] emits TWO instructions: the Ed25519 precompile FIRST, then the program', () => {
    const { claim, signerAddress } = signedClaim();
    const bundle = buildSolanaSettlementTx(
      claim,
      { address: signerAddress, programId },
      claim.recipient as string,
      0,
      1
    );
    const msg = decodeMessage(bundle.unsignedTxBytes);
    expect(msg.instructions).toHaveLength(2);
    // The program loads instruction index 0 from the Instructions sysvar and
    // requires it to BE the precompile (processor.rs:838-845).
    expect(msg.instructions[0]?.programId).toBe(SOLANA_ED25519_PROGRAM_ID);
    expect(msg.instructions[0]?.accounts).toEqual([]);
    expect(msg.instructions[1]?.programId).toBe(programId);
  });

  it('[P0] program instruction data is CLAIM_FROM_CHANNEL || nonce(8 LE) || transferred(8 LE)', () => {
    const { claim, signerAddress } = signedClaim({
      nonce: '7',
      cumulativeAmount: '123456',
    });
    const bundle = buildSolanaSettlementTx(
      claim,
      { address: signerAddress, programId },
      claim.recipient as string,
      0,
      1
    );
    const data = decodeMessage(bundle.unsignedTxBytes).instructions[1]
      ?.data as Uint8Array;
    expect(data).toHaveLength(24);
    expect(Array.from(data.slice(0, 8))).toEqual([6, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(data.slice(0, 8))).toEqual(
      Array.from(SOLANA_CLAIM_FROM_CHANNEL_DISCRIMINATOR)
    );
    // Nonce FIRST, then the transferred amount — the pre-toon#214 builder had
    // these reversed, on top of an Anchor discriminator.
    expect(readU64LE(data, 8)).toBe(7n);
    expect(readU64LE(data, 16)).toBe(123456n);
  });

  it('[P0] the discriminator is NOT the Anchor sha256("global:update_balance") prefix', () => {
    const anchorPrefix = sha256(
      new TextEncoder().encode('global:update_balance')
    ).slice(0, 8);
    expect(Array.from(SOLANA_CLAIM_FROM_CHANNEL_DISCRIMINATOR)).not.toEqual(
      Array.from(anchorPrefix)
    );
  });

  it('[P0] the 64-byte signature travels in the precompile instruction, not the program data', () => {
    const { claim, signerAddress } = signedClaim();
    const bundle = buildSolanaSettlementTx(
      claim,
      { address: signerAddress, programId },
      claim.recipient as string,
      0,
      1
    );
    const msg = decodeMessage(bundle.unsignedTxBytes);
    const ed = msg.instructions[0]?.data as Uint8Array;
    const view = new DataView(ed.buffer, ed.byteOffset, ed.byteLength);
    expect(ed[0]).toBe(1); // num_signatures
    const signatureOffset = view.getUint16(2, true);
    const publicKeyOffset = view.getUint16(6, true);
    const messageOffset = view.getUint16(10, true);
    const messageSize = view.getUint16(12, true);
    // All three references must point INTO this instruction (0xFFFF), or the
    // program rejects them outright (processor.rs:859-875).
    expect(view.getUint16(4, true)).toBe(0xffff);
    expect(view.getUint16(8, true)).toBe(0xffff);
    expect(view.getUint16(14, true)).toBe(0xffff);
    expect(messageSize).toBe(48);
    expect(base58Encode(ed.slice(publicKeyOffset, publicKeyOffset + 32))).toBe(
      signerAddress
    );
    expect(Array.from(ed.slice(signatureOffset, signatureOffset + 64))).toEqual(
      Array.from(claim.claimBytes)
    );
    const message = ed.slice(messageOffset, messageOffset + messageSize);
    expect(Array.from(message)).toEqual(
      Array.from(
        balanceProofMessageSolana(
          base58Decode(claim.channelId as string),
          1n,
          500n
        )
      )
    );
    // …and it must verify, which is what the precompile itself will do on chain.
    expect(
      ed25519.verify(claim.claimBytes, message, base58Decode(signerAddress))
    ).toBe(true);
    // The program's own instruction data carries no signature at all.
    expect(msg.instructions[1]?.data).toHaveLength(24);
  });

  it('[P0] accounts are ordered/privileged as processor.rs reads them', () => {
    const { claim, signerAddress } = signedClaim();
    const recipient = claim.recipient as string;
    const bundle = buildSolanaSettlementTx(
      claim,
      { address: signerAddress, programId },
      recipient,
      0,
      1
    );
    const msg = decodeMessage(bundle.unsignedTxBytes);
    // One signature required (the fee payer's) — the Swap never co-signs.
    expect(msg.numRequiredSignatures).toBe(1);
    expect(msg.numReadonlySigned).toBe(0);
    expect(msg.numReadonlyUnsigned).toBe(4);
    expect(msg.accountKeys[0]).toBe(recipient);
    // Exactly one writable non-signer: the channel PDA that the claim mutates.
    const writableNonSigners = msg.accountKeys.length - 1 - 4;
    expect(writableNonSigners).toBe(1);
    expect(msg.accountKeys[1]).toBe(claim.channelId);
    // Positional account list of ClaimFromChannel.
    expect(msg.instructions[1]?.accounts).toEqual([
      recipient,
      signerAddress,
      claim.channelId,
      SOLANA_INSTRUCTIONS_SYSVAR_ID,
    ]);
    expect(new Set(msg.accountKeys).size).toBe(msg.accountKeys.length);
  });

  it('[P0] the blockhash is a zero placeholder the caller patches', () => {
    const { claim, signerAddress } = signedClaim();
    const bundle = buildSolanaSettlementTx(
      claim,
      { address: signerAddress, programId },
      claim.recipient as string,
      0,
      1
    );
    expect(
      Array.from(decodeMessage(bundle.unsignedTxBytes).recentBlockhash)
    ).toEqual(Array.from(new Uint8Array(32)));

    const blockhash = fill32(0x42);
    const patched = patchSolanaRecentBlockhash(
      bundle.unsignedTxBytes,
      blockhash
    );
    const decoded = decodeMessage(patched);
    expect(Array.from(decoded.recentBlockhash)).toEqual(Array.from(blockhash));
    // Patching is non-destructive and changes nothing else.
    expect(patched.length).toBe(bundle.unsignedTxBytes.length);
    expect(decoded.instructions[1]?.data).toEqual(
      decodeMessage(bundle.unsignedTxBytes).instructions[1]?.data
    );
    expect(
      Array.from(decodeMessage(bundle.unsignedTxBytes).recentBlockhash)
    ).toEqual(Array.from(new Uint8Array(32)));
    // Base58 form accepted too (what getLatestBlockhash returns).
    expect(
      Array.from(
        decodeMessage(
          patchSolanaRecentBlockhash(
            bundle.unsignedTxBytes,
            base58Encode(blockhash)
          )
        ).recentBlockhash
      )
    ).toEqual(Array.from(blockhash));
  });

  it('[P0] throws INVALID_INPUT when programId missing', () => {
    const claim = makeClaim();
    const bad: SwapSignerConfig = { address: signer.address };
    expect(() =>
      buildSolanaSettlementTx(claim, bad, claim.recipient as string, 0, 1)
    ).toThrow(/programId/);
  });

  it('[P0] throws rather than emitting a duplicate-account tx the runtime rejects', () => {
    const { claim, signerAddress } = signedClaim();
    // Recipient == claimer: a legacy message addresses each account once, so
    // the runtime would fail this with AccountLoadedTwice.
    expect(() =>
      buildSolanaSettlementTx(
        claim,
        { address: signerAddress, programId },
        signerAddress,
        0,
        1
      )
    ).toThrow(/distinct/);
  });

  it('[P0] throws INVALID_SIGNATURE_LENGTH when the claim carries no usable signature', () => {
    const claim = makeClaim({ claimBytes: new Uint8Array(0) });
    expect(() =>
      buildSolanaSettlementTx(claim, signer, claim.recipient as string, 0, 1)
    ).toThrow(/64 bytes/);
  });
});
