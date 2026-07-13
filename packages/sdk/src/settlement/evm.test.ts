/**
 * Story 12.6 AC-7: EVM settlement tx encoding + signature verification.
 *
 * Covers T-048 (bundle shape), T-049 (round-trip signer recovery via
 * EvmPaymentChannelSigner), tamper test, zero-signature, wrong-length,
 * invalid-v, fillEvmSettlementTxGas roundtrip.
 */
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SwapPair } from '@toon-protocol/core';

import type { AccumulatedClaim } from '../stream-swap.js';
import { SettlementTxError } from '../errors.js';
import {
  buildEvmSettlementTx,
  fillEvmSettlementTxGas,
  recoverEvmSignerAddress,
  verifyEvmClaimSignature,
  EVM_SETTLEMENT_FUNCTION_SELECTOR,
} from './evm.js';
import { balanceProofHashEvm, hexToBytes } from './hashes.js';
import type { SwapSignerConfig } from './types.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
  rate: '0.0005',
};

// v2 EIP-712 domain inputs used across the round-trip tests. `contractAddress`
// below (`0xdd..dd`) is the `verifyingContract`; chainId matches the pair.
const TEST_CHAIN_ID = 8453;
const TEST_VERIFYING_CONTRACT = '0x' + 'dd'.repeat(20);

function signBalanceProofEvm(
  privateKey: Uint8Array,
  channelId: string,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipient: string
): Uint8Array {
  const msgHash = balanceProofHashEvm(
    hexToBytes(channelId),
    cumulativeAmount,
    nonce,
    hexToBytes(recipient),
    BigInt(TEST_CHAIN_ID),
    hexToBytes(TEST_VERIFYING_CONTRACT)
  );
  const recoveredBytes = secp256k1.sign(msgHash, privateKey, {
    prehash: false,
    format: 'recovered',
  });
  const sigObj = secp256k1.Signature.fromBytes(recoveredBytes, 'recovered');
  const compact = sigObj.toBytes('compact');
  const recovery = sigObj.recovery ?? 0;
  const out = new Uint8Array(65);
  out.set(compact, 0);
  out[64] = 27 + recovery;
  return out;
}

function deriveEvmAddress(privateKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privateKey, false); // uncompressed
  const addrHash = keccak_256(pub.slice(1));
  return '0x' + bytesToHex(addrHash.slice(-20)).toLowerCase();
}

function makeClaim(
  overrides: Partial<AccumulatedClaim> = {}
): AccumulatedClaim {
  return {
    packetIndex: 0,
    sourceAmount: 1_000_000n,
    targetAmount: 500n,
    claimBytes: new Uint8Array(65),
    swapEphemeralPubkey: '0'.repeat(64),
    pair: PAIR,
    receivedAt: Date.now(),
    channelId: '0x' + 'aa'.repeat(32),
    nonce: '1',
    cumulativeAmount: '500',
    recipient: '0x' + 'bb'.repeat(20),
    swapSignerAddress: '0x' + 'cc'.repeat(20),
    ...overrides,
  };
}

describe('recoverEvmSignerAddress (AC-7, T-049 round-trip)', () => {
  it('[P0] recovers the signer address from a real balance-proof signature', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1; // valid secp256k1 scalar
    const expectedAddr = deriveEvmAddress(privateKey);

    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const cumulative = 1_000_000n;
    const nonce = 1n;

    const sig = signBalanceProofEvm(
      privateKey,
      channelId,
      cumulative,
      nonce,
      recipient
    );

    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: cumulative.toString(),
      nonce: nonce.toString(),
    });

    const recovered = recoverEvmSignerAddress(claim, TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT);
    expect(recovered).toBe(expectedAddr);
  });

  it('[P0] throws INVALID_SIGNATURE_LENGTH on wrong-length claimBytes', () => {
    const claim = makeClaim({ claimBytes: new Uint8Array(64) });
    expect(() => recoverEvmSignerAddress(claim, TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT)).toThrowError(
      SettlementTxError
    );
    try {
      recoverEvmSignerAddress(claim, TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT);
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('INVALID_SIGNATURE_LENGTH');
    }
  });

  it('[P0] throws INVALID_SIGNATURE_V on invalid v byte', () => {
    const sig = new Uint8Array(65);
    sig[64] = 26; // not 27 or 28
    const claim = makeClaim({ claimBytes: sig });
    try {
      recoverEvmSignerAddress(claim, TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('INVALID_SIGNATURE_V');
    }
  });

  it('[P0] throws MISSING_SETTLEMENT_METADATA when settlement fields absent', () => {
    const claim = makeClaim({ channelId: undefined });
    try {
      recoverEvmSignerAddress(claim, TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe(
        'MISSING_SETTLEMENT_METADATA'
      );
    }
  });

  it('[P0] tampered signature recovers to a different address', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const expectedAddr = deriveEvmAddress(privateKey);

    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);

    const sig = signBalanceProofEvm(
      privateKey,
      channelId,
      1_000_000n,
      1n,
      recipient
    );
    // Tamper: flip one byte in the r component.
    sig[0] = (sig[0] ?? 0) ^ 0x01;

    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '1000000',
      nonce: '1',
    });

    // May throw or return a non-matching address; either is a reject path.
    try {
      const recovered = recoverEvmSignerAddress(claim, TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT);
      expect(recovered).not.toBe(expectedAddr);
    } catch (err) {
      expect(err).toBeInstanceOf(SettlementTxError);
    }
  });
});

describe('verifyEvmClaimSignature (AC-7)', () => {
  it('[P0] returns { valid: true } when recovered == expected', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const expectedAddr = deriveEvmAddress(privateKey);

    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const sig = signBalanceProofEvm(privateKey, channelId, 500n, 2n, recipient);
    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '500',
      nonce: '2',
    });

    const res = verifyEvmClaimSignature(claim, expectedAddr, TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT);
    expect(res.valid).toBe(true);
    expect(res.recovered).toBe(expectedAddr);
  });

  it('[P0] returns { valid: false } when recovered != expected', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;

    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const sig = signBalanceProofEvm(privateKey, channelId, 500n, 2n, recipient);
    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '500',
      nonce: '2',
    });

    // Wrong expected address
    const res = verifyEvmClaimSignature(claim, '0x' + '00'.repeat(20), TEST_CHAIN_ID, TEST_VERIFYING_CONTRACT);
    expect(res.valid).toBe(false);
  });
});

describe('buildEvmSettlementTx (AC-7, T-048)', () => {
  const signer: SwapSignerConfig = {
    address: '0x' + 'cc'.repeat(20),
    contractAddress: '0x' + 'dd'.repeat(20),
    chainId: 8453,
  };

  it('[P0] bundle carries the expected chain/channelId/cumulative/nonce/recipient', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const sig = signBalanceProofEvm(
      privateKey,
      channelId,
      1_000n,
      5n,
      recipient
    );

    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '1000',
      nonce: '5',
    });

    const bundle = buildEvmSettlementTx(claim, signer, recipient, 0, 1);

    expect(bundle.chain).toBe('evm:base:8453');
    expect(bundle.chainKind).toBe('evm');
    expect(bundle.channelId).toBe(channelId);
    expect(bundle.cumulativeAmount).toBe('1000');
    expect(bundle.nonce).toBe('5');
    expect(bundle.recipient).toBe(recipient);
    expect(bundle.swapSignerAddress).toBe('0x' + 'cc'.repeat(20));
    expect(bundle.claimsMerged).toBe(1);
    expect(bundle.selectedClaimIndex).toBe(0);
    expect(bundle.sourceChain).toBe('evm:base:8453');
    expect(bundle.sourceAssetCode).toBe('USDC');
  });

  it('[P0] unsignedTxBytes is a non-empty RLP list', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const sig = signBalanceProofEvm(
      privateKey,
      channelId,
      1_000n,
      5n,
      recipient
    );

    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '1000',
      nonce: '5',
    });

    const bundle = buildEvmSettlementTx(claim, signer, recipient, 0, 1);
    expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
    // First byte should be an RLP list header (>= 0xc0).
    expect(bundle.unsignedTxBytes[0]).toBeGreaterThanOrEqual(0xc0);
  });

  it('[P0] expectedEventSignature matches pinned keccak256 of SettlementSucceeded signature', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const sig = signBalanceProofEvm(
      privateKey,
      channelId,
      1_000n,
      5n,
      recipient
    );
    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '1000',
      nonce: '5',
    });

    const bundle = buildEvmSettlementTx(claim, signer, recipient, 0, 1);
    expect(bundle.expectedEventSignature).toBeDefined();
    expect(bundle.expectedEventSignature).toMatch(/^0x[0-9a-f]{64}$/);
    // Pinned digest for `SettlementSucceeded(bytes32,uint256,uint256,address)`.
    // Any drift here breaks Chain Bridge DVM event watching (Epic 13).
    expect(bundle.expectedEventSignature).toBe(
      '0xe354116c980d91957de31a62b7d1ead030361bfae7baee9ca677bf87aac68576'
    );
  });

  it('[P0] throws INVALID_INPUT when contractAddress missing', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const sig = signBalanceProofEvm(
      privateKey,
      channelId,
      1_000n,
      5n,
      recipient
    );
    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '1000',
      nonce: '5',
    });

    const bad: SwapSignerConfig = { address: signer.address, chainId: 8453 };
    expect(() => buildEvmSettlementTx(claim, bad, recipient, 0, 1)).toThrow(
      /contractAddress/
    );
  });
});

describe('fillEvmSettlementTxGas (AC-7)', () => {
  const signer: SwapSignerConfig = {
    address: '0x' + 'cc'.repeat(20),
    contractAddress: '0x' + 'dd'.repeat(20),
    chainId: 8453,
  };

  it('[P0] produces a different tx than the placeholder and includes the gas values', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const sig = signBalanceProofEvm(
      privateKey,
      channelId,
      1_000n,
      5n,
      recipient
    );

    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '1000',
      nonce: '5',
    });

    const bundle = buildEvmSettlementTx(claim, signer, recipient, 0, 1);
    const filled = fillEvmSettlementTxGas(
      bundle,
      { nonce: 42n, gasPrice: 1_000_000_000n, gasLimit: 200_000n },
      signer
    );
    expect(filled.length).toBeGreaterThan(0);
    // The filled tx should differ from the placeholder bundle's bytes.
    expect(bytesToHex(filled)).not.toBe(bytesToHex(bundle.unsignedTxBytes));
  });
});

describe('EVM_SETTLEMENT_FUNCTION_SELECTOR — pinned 4-byte keccak256 prefix', () => {
  it('[P0] selector is 4 bytes', () => {
    expect(EVM_SETTLEMENT_FUNCTION_SELECTOR.length).toBe(4);
  });

  it('[P0] selector matches pinned `updateBalance(bytes32,uint256,uint256,address,bytes)` digest', () => {
    // Any drift here breaks the on-chain call — Story 12.8 E2E would fail
    // fast, but this unit test catches it at refactor time.
    expect(bytesToHex(EVM_SETTLEMENT_FUNCTION_SELECTOR)).toBe('ee2ed211');
  });

  it('[P0] buildEvmSettlementTx calldata starts with the selector', () => {
    // Calldata lives inside the RLP-encoded tx — reconstruct and assert the
    // selector prefix is present in the unsignedTxBytes payload.
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const channelId = '0x' + 'aa'.repeat(32);
    const recipient = '0x' + 'bb'.repeat(20);
    const sig = signBalanceProofEvm(
      privateKey,
      channelId,
      1_000n,
      5n,
      recipient
    );
    const claim = makeClaim({
      claimBytes: sig,
      channelId,
      recipient,
      cumulativeAmount: '1000',
      nonce: '5',
    });
    const signerCfg: SwapSignerConfig = {
      address: '0x' + 'cc'.repeat(20),
      contractAddress: '0x' + 'dd'.repeat(20),
      chainId: 8453,
    };
    const bundle = buildEvmSettlementTx(claim, signerCfg, recipient, 0, 1);
    // The selector bytes (0xee 0x2e 0xd2 0x11) must appear somewhere inside
    // the RLP-encoded tx (as the head of the calldata field).
    const hex = bytesToHex(bundle.unsignedTxBytes);
    expect(hex).toContain('ee2ed211');
  });
});
