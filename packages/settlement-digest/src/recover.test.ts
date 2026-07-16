/**
 * Pure EVM signer recovery — round-trip conformance.
 *
 * Signs the v2 EIP-712 claim digest with a known secp256k1 key, then asserts
 * `recoverEvmClaimSigner` / `verifyEvmClaimSignature` recover the derived
 * address byte-for-byte. This is the leaf-owned counterpart to the SDK's
 * `recoverEvmSignerAddress` round-trip (which now wraps these functions).
 */
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { balanceProofHashEvm, hexToBytes } from './hashes.js';
import {
  recoverEvmSigner,
  recoverEvmClaimSigner,
  verifyEvmClaimSignature,
  type EvmClaimDigestParams,
} from './recover.js';

const CHAIN_ID = 8453;
const VERIFYING_CONTRACT = '0x' + 'dd'.repeat(20);

function signBalanceProofEvm(
  privateKey: Uint8Array,
  params: EvmClaimDigestParams
): Uint8Array {
  const msgHash = balanceProofHashEvm(
    hexToBytes(params.channelId),
    BigInt(params.cumulativeAmount),
    BigInt(params.nonce),
    hexToBytes(params.recipient),
    BigInt(params.chainId),
    hexToBytes(params.verifyingContract)
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

function makeParams(
  overrides: Partial<EvmClaimDigestParams> = {}
): EvmClaimDigestParams {
  return {
    channelId: '0x' + 'aa'.repeat(32),
    cumulativeAmount: '1000000',
    nonce: '1',
    recipient: '0x' + 'bb'.repeat(20),
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    ...overrides,
  };
}

describe('recoverEvmClaimSigner — round-trip', () => {
  it('[P0] recovers the signer address from a real balance-proof signature', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1; // valid secp256k1 scalar
    const expectedAddr = deriveEvmAddress(privateKey);

    const params = makeParams();
    const sig = signBalanceProofEvm(privateKey, params);

    expect(recoverEvmClaimSigner(params, sig)).toBe(expectedAddr);
  });

  it('[P0] recoverEvmSigner recovers from a precomputed digest', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 3;
    const expectedAddr = deriveEvmAddress(privateKey);

    const params = makeParams({ cumulativeAmount: '500', nonce: '7' });
    const sig = signBalanceProofEvm(privateKey, params);
    const digest = balanceProofHashEvm(
      hexToBytes(params.channelId),
      BigInt(params.cumulativeAmount),
      BigInt(params.nonce),
      hexToBytes(params.recipient),
      BigInt(params.chainId),
      hexToBytes(params.verifyingContract)
    );

    expect(recoverEvmSigner(digest, sig)).toBe(expectedAddr);
  });

  it('[P0] throws on wrong-length signature', () => {
    expect(() =>
      recoverEvmClaimSigner(makeParams(), new Uint8Array(64))
    ).toThrow(/65 bytes/);
  });

  it('[P0] throws on invalid v byte', () => {
    const sig = new Uint8Array(65);
    sig[64] = 26; // not 27 or 28
    expect(() => recoverEvmClaimSigner(makeParams(), sig)).toThrow(
      /v must be 27 or 28/
    );
  });

  it('[P0] tampered signature recovers to a different address (or throws)', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const expectedAddr = deriveEvmAddress(privateKey);

    const params = makeParams();
    const sig = signBalanceProofEvm(privateKey, params);
    sig[0] = (sig[0] ?? 0) ^ 0x01; // flip a byte in r

    try {
      expect(recoverEvmClaimSigner(params, sig)).not.toBe(expectedAddr);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe('verifyEvmClaimSignature', () => {
  it('[P0] returns { valid: true } when recovered == expected', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const expectedAddr = deriveEvmAddress(privateKey);

    const params = makeParams({ cumulativeAmount: '500', nonce: '2' });
    const sig = signBalanceProofEvm(privateKey, params);

    const res = verifyEvmClaimSignature(params, sig, expectedAddr);
    expect(res.valid).toBe(true);
    expect(res.recovered).toBe(expectedAddr);
  });

  it('[P0] returns { valid: false } when recovered != expected', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;

    const params = makeParams({ cumulativeAmount: '500', nonce: '2' });
    const sig = signBalanceProofEvm(privateKey, params);

    const res = verifyEvmClaimSignature(params, sig, '0x' + '00'.repeat(20));
    expect(res.valid).toBe(false);
  });

  it('[P0] is case-insensitive on the expected address', () => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    const expectedAddr = deriveEvmAddress(privateKey);

    const params = makeParams();
    const sig = signBalanceProofEvm(privateKey, params);

    const res = verifyEvmClaimSignature(
      params,
      sig,
      expectedAddr.toUpperCase().replace('0X', '0x')
    );
    expect(res.valid).toBe(true);
  });
});
