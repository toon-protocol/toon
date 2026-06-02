/**
 * Story 12.8 — Mina settlement: balance-proof signature verification
 * (`verifyMinaSignature`) + settlement-bundle construction
 * (`buildMinaSettlementTx`).
 *
 * These tests exercise the EXACT Mill↔sender wire contract: the Mill's
 * `MinaPaymentChannelSigner` signs `balanceProofFieldsMina(...)` via
 * `mina-signer`'s `signFields` and emits the base58 signature string as the
 * claim's `claimBytes` (UTF-8). We reproduce that signing here with the real
 * `mina-signer` peer dep, then assert the SDK verifier accepts valid claims
 * and rejects tampered / wrong-key / malformed ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { SwapPair } from '@toon-protocol/core';

import type { AccumulatedClaim } from '../stream-swap.js';
import { SettlementTxError } from '../errors.js';
import { balanceProofFieldsMina } from './hashes.js';
import {
  buildMinaSettlementTx,
  verifyMinaSignature,
  loadMinaSignerClient,
  type MinaSignerClientLike,
} from './mina.js';
import type { MillSignerConfig } from './types.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
  rate: '0.5',
};

// mina-signer Client shape used by these tests (signing + key gen).
interface MinaSignerFullClient extends MinaSignerClientLike {
  genKeys(): { privateKey: string; publicKey: string };
  signFields(
    fields: bigint[],
    privateKey: string
  ): { signature: string | { field: string; scalar: string } };
}

// `mina-signer` is an OPTIONAL peer dep. When it is absent (the default in
// CI, where peer deps are not installed) these round-trip tests are skipped —
// mirroring the Mill's `payment-channel-signer.test.ts` gating. The core
// behaviour (verifier dispatch, rejection without a client) is covered by
// `build-settlement-tx.test.ts` without the peer dep.
const initialClient = (await loadMinaSignerClient()) as
  | MinaSignerFullClient
  | undefined;
const hasMinaSigner = initialClient !== undefined;

let client: MinaSignerFullClient;

beforeAll(() => {
  // Non-null inside skipIf(!hasMinaSigner) blocks.
  client = initialClient as MinaSignerFullClient;
});

/**
 * Reproduce the Mill's signing path: sign the shared field-element message and
 * emit the base58 signature string as UTF-8 claimBytes.
 */
function signMillClaim(
  privateKey: string,
  channelId: string,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipient: string
): Uint8Array {
  const fields = balanceProofFieldsMina(
    channelId,
    cumulativeAmount,
    nonce,
    recipient
  );
  const signed = client.signFields(fields, privateKey);
  const sigStr =
    typeof signed.signature === 'string'
      ? signed.signature
      : JSON.stringify(signed.signature);
  return new TextEncoder().encode(sigStr);
}

function makeSignedClaim(opts?: {
  channelId?: string;
  recipient?: string;
  cumulativeAmount?: string;
  nonce?: string;
  privateKey?: string;
  publicKey?: string;
}): { claim: AccumulatedClaim; signerAddress: string } {
  const keys =
    opts?.privateKey && opts?.publicKey
      ? { privateKey: opts.privateKey, publicKey: opts.publicKey }
      : client.genKeys();
  const channelId =
    opts?.channelId ?? 'B62qChannelExample1111111111111111111111111111';
  const recipient =
    opts?.recipient ?? 'B62qRecipientExample22222222222222222222222222';
  const cumulativeAmount = opts?.cumulativeAmount ?? '500';
  const nonce = opts?.nonce ?? '1';

  const claimBytes = signMillClaim(
    keys.privateKey,
    channelId,
    BigInt(cumulativeAmount),
    BigInt(nonce),
    recipient
  );

  const claim: AccumulatedClaim = {
    packetIndex: 0,
    sourceAmount: 1_000_000n,
    targetAmount: 500n,
    claimBytes,
    millEphemeralPubkey: '0'.repeat(64),
    pair: PAIR,
    receivedAt: Date.now(),
    channelId,
    nonce,
    cumulativeAmount,
    recipient,
    millSignerAddress: keys.publicKey,
  };
  return { claim, signerAddress: keys.publicKey };
}

describe.skipIf(!hasMinaSigner)('verifyMinaSignature (Story 12.8)', () => {
  it('[P0] returns true for a valid Mill-format signature (round-trip)', () => {
    const { claim, signerAddress } = makeSignedClaim();
    expect(verifyMinaSignature(claim, signerAddress, client)).toBe(true);
  });

  it('[P0] returns false when the nonce is tampered (re-derived message differs)', () => {
    const { claim, signerAddress } = makeSignedClaim({ nonce: '1' });
    // The signature is over nonce=1; verifying with nonce=2 must fail.
    const tampered: AccumulatedClaim = { ...claim, nonce: '2' };
    expect(verifyMinaSignature(tampered, signerAddress, client)).toBe(false);
  });

  it('[P0] returns false when the cumulativeAmount is tampered', () => {
    const { claim, signerAddress } = makeSignedClaim({
      cumulativeAmount: '500',
    });
    const tampered: AccumulatedClaim = { ...claim, cumulativeAmount: '999' };
    expect(verifyMinaSignature(tampered, signerAddress, client)).toBe(false);
  });

  it('[P0] returns false against a different signer public key', () => {
    const { claim } = makeSignedClaim();
    const other = client.genKeys();
    expect(verifyMinaSignature(claim, other.publicKey, client)).toBe(false);
  });

  it('[P0] returns false on a structurally invalid signature payload', () => {
    const { claim, signerAddress } = makeSignedClaim();
    const garbled: AccumulatedClaim = {
      ...claim,
      claimBytes: new TextEncoder().encode('not-a-valid-base58-signature!!!'),
    };
    // verifyFields throws internally on a bad signature; we swallow → false.
    expect(verifyMinaSignature(garbled, signerAddress, client)).toBe(false);
  });

  it('[P0] throws MISSING_SETTLEMENT_METADATA when channelId is absent', () => {
    const { claim, signerAddress } = makeSignedClaim();
    const incomplete: AccumulatedClaim = { ...claim, channelId: undefined };
    try {
      verifyMinaSignature(incomplete, signerAddress, client);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SettlementTxError);
      expect((err as SettlementTxError).code).toBe(
        'MISSING_SETTLEMENT_METADATA'
      );
    }
  });

  it('[P0] throws INVALID_SIGNATURE_LENGTH on empty claimBytes', () => {
    const { claim, signerAddress } = makeSignedClaim();
    const empty: AccumulatedClaim = { ...claim, claimBytes: new Uint8Array(0) };
    try {
      verifyMinaSignature(empty, signerAddress, client);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('INVALID_SIGNATURE_LENGTH');
    }
  });

  it('[P0] is bound to channelId (cross-channel replay is rejected)', () => {
    const { claim, signerAddress } = makeSignedClaim({
      channelId: 'B62qChannelAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const replayed: AccumulatedClaim = {
      ...claim,
      channelId: 'B62qChannelBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };
    expect(verifyMinaSignature(replayed, signerAddress, client)).toBe(false);
  });
});

describe.skipIf(!hasMinaSigner)('buildMinaSettlementTx (Story 12.8)', () => {
  it('[P0] bundle carries chain/channelId/cumulative/nonce/recipient + proof bytes', () => {
    const { claim, signerAddress } = makeSignedClaim();
    const signer: MillSignerConfig = { address: signerAddress };
    const bundle = buildMinaSettlementTx(claim, signer, claim.recipient!, 0, 1);
    expect(bundle.chain).toBe('mina:mainnet');
    expect(bundle.chainKind).toBe('mina');
    expect(bundle.channelId).toBe(claim.channelId);
    expect(bundle.cumulativeAmount).toBe('500');
    expect(bundle.nonce).toBe('1');
    expect(bundle.recipient).toBe(claim.recipient);
    expect(bundle.millSignerAddress).toBe(signerAddress);
    expect(bundle.sourceChain).toBe('evm:base:8453');
    expect(bundle.sourceAssetCode).toBe('USDC');
    // The envelope re-emits the verified balance-proof signature verbatim.
    expect(bundle.unsignedTxBytes).toEqual(claim.claimBytes);
    expect(bundle.selectedClaimIndex).toBe(0);
    expect(bundle.claimsMerged).toBe(1);
  });

  it('[P0] throws MISSING_SETTLEMENT_METADATA when settlement fields are absent', () => {
    const { claim, signerAddress } = makeSignedClaim();
    const incomplete: AccumulatedClaim = { ...claim, nonce: undefined };
    const signer: MillSignerConfig = { address: signerAddress };
    try {
      buildMinaSettlementTx(incomplete, signer, claim.recipient!, 0, 1);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SettlementTxError);
      expect((err as SettlementTxError).code).toBe(
        'MISSING_SETTLEMENT_METADATA'
      );
    }
  });

  it('[P0] throws INVALID_INPUT when signer address is empty', () => {
    const { claim } = makeSignedClaim();
    const bad: MillSignerConfig = { address: '' };
    expect(() =>
      buildMinaSettlementTx(claim, bad, claim.recipient!, 0, 1)
    ).toThrow(/address/);
  });

  it('[P0] throws INVALID_SIGNATURE_LENGTH on empty claimBytes', () => {
    const { claim, signerAddress } = makeSignedClaim();
    const empty: AccumulatedClaim = { ...claim, claimBytes: new Uint8Array(0) };
    const signer: MillSignerConfig = { address: signerAddress };
    expect(() =>
      buildMinaSettlementTx(empty, signer, claim.recipient!, 0, 1)
    ).toThrow(SettlementTxError);
  });
});
