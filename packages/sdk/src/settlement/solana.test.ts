/**
 * Story 12.6 AC-9: Solana settlement tx encoding + Ed25519 verification.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { SwapPair } from '@toon-protocol/core';

import type { AccumulatedClaim } from '../stream-swap.js';
import type { SettlementTxError } from '../errors.js';
import { base58Encode } from '../identity.js';
import { balanceProofHashSolana } from './hashes.js';
import { buildSolanaSettlementTx, verifyEd25519Signature } from './solana.js';
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

describe('verifyEd25519Signature (AC-9)', () => {
  it('[P0] returns true for a valid signature', () => {
    const privateKey = new Uint8Array(32);
    privateKey[0] = 1;
    const pubkey = ed25519.getPublicKey(privateKey);
    const signerAddress = base58Encode(pubkey);

    const channelIdBytes = fill32(0x77);
    const recipientBytes = fill32(0x88);
    const channelId = base58Encode(channelIdBytes);
    const recipient = base58Encode(recipientBytes);

    const msgHash = balanceProofHashSolana(channelId, 500n, 1n, recipient);
    const sig = ed25519.sign(msgHash, privateKey);

    const claim = makeClaim({
      claimBytes: new Uint8Array(sig),
      channelId,
      recipient,
      cumulativeAmount: '500',
      nonce: '1',
    });

    expect(verifyEd25519Signature(claim, signerAddress)).toBe(true);
  });

  it('[P0] returns false for a tampered signature', () => {
    const privateKey = new Uint8Array(32);
    privateKey[0] = 1;
    const pubkey = ed25519.getPublicKey(privateKey);
    const signerAddress = base58Encode(pubkey);

    const channelIdBytes = fill32(0x77);
    const recipientBytes = fill32(0x88);
    const channelId = base58Encode(channelIdBytes);
    const recipient = base58Encode(recipientBytes);

    const msgHash = balanceProofHashSolana(channelId, 500n, 1n, recipient);
    const sig = new Uint8Array(ed25519.sign(msgHash, privateKey));
    sig[0] = (sig[0] ?? 0) ^ 0x01;

    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '500',
      nonce: '1',
    });

    expect(verifyEd25519Signature(claim, signerAddress)).toBe(false);
  });

  it('[P0] throws INVALID_SIGNATURE_LENGTH on wrong-length claimBytes', () => {
    const claim = makeClaim({ claimBytes: new Uint8Array(63) });
    try {
      verifyEd25519Signature(claim, claim.swapSignerAddress!);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('INVALID_SIGNATURE_LENGTH');
    }
  });
});

describe('buildSolanaSettlementTx (AC-9, T-053)', () => {
  const signer: SwapSignerConfig = {
    address: base58Encode(fill32(0x99)),
    programId: base58Encode(fill32(0x66)),
  };

  it('[P0] bundle carries the expected chain/channelId/cumulative/nonce/recipient', () => {
    const claim = makeClaim();
    const bundle = buildSolanaSettlementTx(
      claim,
      signer,
      claim.recipient!,
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

  it('[P0] throws INVALID_INPUT when programId missing', () => {
    const claim = makeClaim();
    const bad: SwapSignerConfig = { address: signer.address };
    expect(() =>
      buildSolanaSettlementTx(claim, bad, claim.recipient!, 0, 1)
    ).toThrow(/programId/);
  });
});
