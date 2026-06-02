/**
 * Story 12.6 AC-5/AC-8/AC-10: `buildSettlementTx()` algorithm.
 *
 * Covers claim grouping, winner selection, monotonicity checks, multi-
 * session merge (T-051), multi-chain dispatch, signature-verify filtering
 * (T-052), and the `verifyAccumulatedClaim` standalone utility.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SwapPair } from '@toon-protocol/core';

import { ed25519 } from '@noble/curves/ed25519.js';

import type { AccumulatedClaim } from '../stream-swap.js';
import type { SettlementTxError } from '../errors.js';
import { base58Encode } from '../identity.js';
import {
  buildSettlementTx,
  verifyAccumulatedClaim,
} from './build-settlement-tx.js';
import {
  balanceProofHashEvm,
  balanceProofHashSolana,
  balanceProofFieldsMina,
  hexToBytes,
} from './hashes.js';
import { loadMinaSignerClient } from './mina.js';
import type { MillSignerConfig } from './types.js';

const EVM_PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'ETH', assetScale: 18, chain: 'evm:base:8453' },
  rate: '0.0005',
};

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
    hexToBytes(recipient)
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
  const pub = secp256k1.getPublicKey(privateKey, false);
  const addrHash = keccak_256(pub.slice(1));
  return '0x' + bytesToHex(addrHash.slice(-20)).toLowerCase();
}

const MILL_PK = new Uint8Array(32);
MILL_PK[31] = 7;
const MILL_ADDR = deriveEvmAddress(MILL_PK);
const CHANNEL_A = '0x' + 'aa'.repeat(32);
const CHANNEL_B = '0x' + 'bb'.repeat(32);
const RECIPIENT = '0x' + 'cc'.repeat(20);
const CONTRACT = '0x' + 'dd'.repeat(20);

function makeSignerCfg(): MillSignerConfig {
  return {
    address: MILL_ADDR,
    contractAddress: CONTRACT,
    chainId: 8453,
  };
}

function makeClaim(params: {
  packetIndex: number;
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
  recipient?: string;
  millSignerAddress?: string;
  privateKey?: Uint8Array;
  pair?: SwapPair;
  tamperSig?: boolean;
}): AccumulatedClaim {
  const recipient = params.recipient ?? RECIPIENT;
  const pk = params.privateKey ?? MILL_PK;
  const sig = signBalanceProofEvm(
    pk,
    params.channelId,
    params.cumulativeAmount,
    params.nonce,
    recipient
  );
  if (params.tamperSig) sig[0] = (sig[0] ?? 0) ^ 0x01;
  return {
    packetIndex: params.packetIndex,
    sourceAmount: 1_000_000n,
    targetAmount: params.cumulativeAmount,
    claimBytes: sig,
    millEphemeralPubkey: '0'.repeat(64),
    pair: params.pair ?? EVM_PAIR,
    receivedAt: Date.now(),
    channelId: params.channelId,
    nonce: params.nonce.toString(),
    cumulativeAmount: params.cumulativeAmount.toString(),
    recipient,
    millSignerAddress: params.millSignerAddress ?? MILL_ADDR,
  };
}

describe('buildSettlementTx validation (AC-4)', () => {
  it('[P0] throws INVALID_INPUT on empty claims array', () => {
    expect(() =>
      buildSettlementTx({
        claims: [],
        signers: {},
        recipients: {},
      })
    ).toThrow(/empty/);
  });

  it('[P0] throws MISSING_SETTLEMENT_METADATA when a claim lacks context fields', () => {
    const incomplete: AccumulatedClaim = {
      packetIndex: 0,
      sourceAmount: 1n,
      targetAmount: 1n,
      claimBytes: new Uint8Array(65),
      millEphemeralPubkey: '0'.repeat(64),
      pair: EVM_PAIR,
      receivedAt: 0,
    };
    try {
      buildSettlementTx({
        claims: [incomplete],
        signers: { 'evm:base:8453': makeSignerCfg() },
        recipients: { 'evm:base:8453': RECIPIENT },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe(
        'MISSING_SETTLEMENT_METADATA'
      );
    }
  });

  it('[P0] throws UNSUPPORTED_CHAIN when signers map missing the chain', () => {
    const claim = makeClaim({
      packetIndex: 0,
      channelId: CHANNEL_A,
      cumulativeAmount: 100n,
      nonce: 1n,
    });
    try {
      buildSettlementTx({
        claims: [claim],
        signers: {},
        recipients: { 'evm:base:8453': RECIPIENT },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('UNSUPPORTED_CHAIN');
    }
  });

  it('[P0] throws MISSING_RECIPIENT when recipients map missing the chain', () => {
    const claim = makeClaim({
      packetIndex: 0,
      channelId: CHANNEL_A,
      cumulativeAmount: 100n,
      nonce: 1n,
    });
    try {
      buildSettlementTx({
        claims: [claim],
        signers: { 'evm:base:8453': makeSignerCfg() },
        recipients: {},
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('MISSING_RECIPIENT');
    }
  });
});

describe('buildSettlementTx grouping + winner selection (AC-5, AC-8, T-048)', () => {
  it('[P0] (T-048) 5 claims from one channel collapse to one bundle with the highest-nonce claim', () => {
    const claims = [1, 2, 3, 4, 5].map((i) =>
      makeClaim({
        packetIndex: i - 1,
        channelId: CHANNEL_A,
        cumulativeAmount: BigInt(i * 100),
        nonce: BigInt(i),
      })
    );
    const res = buildSettlementTx({
      claims,
      signers: { 'evm:base:8453': makeSignerCfg() },
      recipients: { 'evm:base:8453': RECIPIENT },
    });
    expect(res.bundles.length).toBe(1);
    const b = res.bundles[0]!;
    expect(b.claimsMerged).toBe(5);
    expect(b.selectedClaimIndex).toBe(4);
    expect(b.cumulativeAmount).toBe('500');
    expect(b.nonce).toBe('5');
  });

  it('[P0] (T-051) two channels produce two bundles', () => {
    const claimsA = [1, 2].map((i) =>
      makeClaim({
        packetIndex: i - 1,
        channelId: CHANNEL_A,
        cumulativeAmount: BigInt(i * 100),
        nonce: BigInt(i),
      })
    );
    const claimsB = [1, 2, 3].map((i) =>
      makeClaim({
        packetIndex: 10 + i,
        channelId: CHANNEL_B,
        cumulativeAmount: BigInt(i * 50),
        nonce: BigInt(i),
      })
    );
    const res = buildSettlementTx({
      claims: [...claimsA, ...claimsB],
      signers: { 'evm:base:8453': makeSignerCfg() },
      recipients: { 'evm:base:8453': RECIPIENT },
    });
    expect(res.bundles.length).toBe(2);
  });

  it('[P0] throws DUPLICATE_NONCE when two claims share nonce in same channel', () => {
    const claims = [
      makeClaim({
        packetIndex: 0,
        channelId: CHANNEL_A,
        cumulativeAmount: 100n,
        nonce: 1n,
      }),
      makeClaim({
        packetIndex: 1,
        channelId: CHANNEL_A,
        cumulativeAmount: 200n,
        nonce: 1n,
      }),
    ];
    try {
      buildSettlementTx({
        claims,
        signers: { 'evm:base:8453': makeSignerCfg() },
        recipients: { 'evm:base:8453': RECIPIENT },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('DUPLICATE_NONCE');
    }
  });

  it('[P0] throws NON_MONOTONIC_CUMULATIVE when cumulativeAmount decreases with nonce', () => {
    const claims = [
      makeClaim({
        packetIndex: 0,
        channelId: CHANNEL_A,
        cumulativeAmount: 500n,
        nonce: 1n,
      }),
      makeClaim({
        packetIndex: 1,
        channelId: CHANNEL_A,
        cumulativeAmount: 100n,
        nonce: 2n,
      }),
    ];
    try {
      buildSettlementTx({
        claims,
        signers: { 'evm:base:8453': makeSignerCfg() },
        recipients: { 'evm:base:8453': RECIPIENT },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('NON_MONOTONIC_CUMULATIVE');
    }
  });

  it('[P0] throws RECIPIENT_MISMATCH when claims in same channel disagree on recipient', () => {
    const claims = [
      makeClaim({
        packetIndex: 0,
        channelId: CHANNEL_A,
        cumulativeAmount: 100n,
        nonce: 1n,
      }),
      makeClaim({
        packetIndex: 1,
        channelId: CHANNEL_A,
        cumulativeAmount: 200n,
        nonce: 2n,
        recipient: '0x' + 'ff'.repeat(20),
      }),
    ];
    try {
      buildSettlementTx({
        claims,
        signers: { 'evm:base:8453': makeSignerCfg() },
        recipients: { 'evm:base:8453': RECIPIENT },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('RECIPIENT_MISMATCH');
    }
  });

  it('[P0] (T-052) tampered signature lands in result.rejected[]', () => {
    const goodClaim = makeClaim({
      packetIndex: 0,
      channelId: CHANNEL_A,
      cumulativeAmount: 100n,
      nonce: 1n,
    });
    const badClaim = makeClaim({
      packetIndex: 1,
      channelId: CHANNEL_A,
      cumulativeAmount: 200n,
      nonce: 2n,
      tamperSig: true,
    });
    const res = buildSettlementTx({
      claims: [goodClaim, badClaim],
      signers: { 'evm:base:8453': makeSignerCfg() },
      recipients: { 'evm:base:8453': RECIPIENT },
    });
    expect(res.rejected.length).toBe(1);
    expect(res.bundles.length).toBe(1);
    // The bundle winner must be the good claim (nonce=1).
    expect(res.bundles[0]!.nonce).toBe('1');
  });

  it('[P0] all-rejected group produces no bundle for that group', () => {
    const badClaim = makeClaim({
      packetIndex: 0,
      channelId: CHANNEL_A,
      cumulativeAmount: 100n,
      nonce: 1n,
      tamperSig: true,
    });
    const res = buildSettlementTx({
      claims: [badClaim],
      signers: { 'evm:base:8453': makeSignerCfg() },
      recipients: { 'evm:base:8453': RECIPIENT },
    });
    expect(res.rejected.length).toBe(1);
    expect(res.bundles.length).toBe(0);
  });

  it('[P0] verifySignatures:false skips verification', () => {
    const badClaim = makeClaim({
      packetIndex: 0,
      channelId: CHANNEL_A,
      cumulativeAmount: 100n,
      nonce: 1n,
      tamperSig: true,
    });
    const res = buildSettlementTx({
      claims: [badClaim],
      signers: { 'evm:base:8453': makeSignerCfg() },
      recipients: { 'evm:base:8453': RECIPIENT },
      verifySignatures: false,
    });
    expect(res.rejected.length).toBe(0);
    expect(res.bundles.length).toBe(1);
  });

  it('[P0] throws MILL_SIGNER_MISMATCH when claims in same channel disagree on millSignerAddress', () => {
    const claims = [
      makeClaim({
        packetIndex: 0,
        channelId: CHANNEL_A,
        cumulativeAmount: 100n,
        nonce: 1n,
      }),
      makeClaim({
        packetIndex: 1,
        channelId: CHANNEL_A,
        cumulativeAmount: 200n,
        nonce: 2n,
        millSignerAddress: '0x' + 'ee'.repeat(20),
      }),
    ];
    try {
      buildSettlementTx({
        claims,
        signers: { 'evm:base:8453': makeSignerCfg() },
        recipients: { 'evm:base:8453': RECIPIENT },
        verifySignatures: false, // bypass so we reach the group-consensus check
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SettlementTxError).code).toBe('MILL_SIGNER_MISMATCH');
    }
  });

  it('[P0] heartbeat — equal cumulativeAmount across adjacent nonces is allowed', () => {
    // AC-5 step 3: non-decreasing, equality permitted (zero-value heartbeat claims).
    const claims = [
      makeClaim({
        packetIndex: 0,
        channelId: CHANNEL_A,
        cumulativeAmount: 100n,
        nonce: 1n,
      }),
      makeClaim({
        packetIndex: 1,
        channelId: CHANNEL_A,
        cumulativeAmount: 100n, // unchanged
        nonce: 2n,
      }),
      makeClaim({
        packetIndex: 2,
        channelId: CHANNEL_A,
        cumulativeAmount: 150n,
        nonce: 3n,
      }),
    ];
    const res = buildSettlementTx({
      claims,
      signers: { 'evm:base:8453': makeSignerCfg() },
      recipients: { 'evm:base:8453': RECIPIENT },
    });
    expect(res.bundles.length).toBe(1);
    expect(res.bundles[0]!.nonce).toBe('3');
    expect(res.bundles[0]!.cumulativeAmount).toBe('150');
  });

  it('[P0] cross-chain — claims spanning evm + solana produce two chain-specific bundles', () => {
    // EVM claim
    const evmClaim = makeClaim({
      packetIndex: 0,
      channelId: CHANNEL_A,
      cumulativeAmount: 100n,
      nonce: 1n,
    });

    // Solana claim with real Ed25519 signature
    const solPk = new Uint8Array(32);
    solPk[0] = 3;
    const solPub = ed25519.getPublicKey(solPk);
    const solSignerAddr = base58Encode(solPub);
    const solChannelBytes = new Uint8Array(32);
    solChannelBytes.fill(0x11);
    const solChannelId = base58Encode(solChannelBytes);
    const solRecipientBytes = new Uint8Array(32);
    solRecipientBytes.fill(0x22);
    const solRecipient = base58Encode(solRecipientBytes);
    const solMsgHash = balanceProofHashSolana(
      solChannelId,
      777n,
      1n,
      solRecipient
    );
    const solSig = new Uint8Array(ed25519.sign(solMsgHash, solPk));
    const solPair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
      rate: '0.001',
    };
    const solClaim: AccumulatedClaim = {
      packetIndex: 1,
      sourceAmount: 1_000_000n,
      targetAmount: 777n,
      claimBytes: solSig,
      millEphemeralPubkey: '0'.repeat(64),
      pair: solPair,
      receivedAt: Date.now(),
      channelId: solChannelId,
      nonce: '1',
      cumulativeAmount: '777',
      recipient: solRecipient,
      millSignerAddress: solSignerAddr,
    };

    const res = buildSettlementTx({
      claims: [evmClaim, solClaim],
      signers: {
        'evm:base:8453': makeSignerCfg(),
        'solana:mainnet': {
          address: solSignerAddr,
          programId: base58Encode(new Uint8Array(32).fill(0x66)),
        },
      },
      recipients: {
        'evm:base:8453': RECIPIENT,
        'solana:mainnet': solRecipient,
      },
    });
    expect(res.bundles.length).toBe(2);
    const kinds = res.bundles.map((b) => b.chainKind).sort();
    expect(kinds).toEqual(['evm', 'solana']);
    expect(res.rejected.length).toBe(0);
  });

  it('[P1] includeSuperseded populates superseded array', () => {
    const claims = [1, 2, 3].map((i) =>
      makeClaim({
        packetIndex: i - 1,
        channelId: CHANNEL_A,
        cumulativeAmount: BigInt(i * 100),
        nonce: BigInt(i),
      })
    );
    const res = buildSettlementTx({
      claims,
      signers: { 'evm:base:8453': makeSignerCfg() },
      recipients: { 'evm:base:8453': RECIPIENT },
      includeSuperseded: true,
    });
    expect(res.superseded.length).toBe(2);
  });
});

describe('verifyAccumulatedClaim (AC-10)', () => {
  it('[P0] returns valid:true for a correctly-signed EVM claim', () => {
    const claim = makeClaim({
      packetIndex: 0,
      channelId: CHANNEL_A,
      cumulativeAmount: 100n,
      nonce: 1n,
    });
    const res = verifyAccumulatedClaim(claim, makeSignerCfg());
    expect(res.valid).toBe(true);
  });

  it('[P0] returns valid:false for a tampered EVM claim', () => {
    const claim = makeClaim({
      packetIndex: 0,
      channelId: CHANNEL_A,
      cumulativeAmount: 100n,
      nonce: 1n,
      tamperSig: true,
    });
    const res = verifyAccumulatedClaim(claim, makeSignerCfg());
    expect(res.valid).toBe(false);
  });

  it('[P0] returns valid:true for a correctly-signed Solana claim', () => {
    const solPk = new Uint8Array(32);
    solPk[0] = 5;
    const solPub = ed25519.getPublicKey(solPk);
    const solSignerAddr = base58Encode(solPub);
    const channelBytes = new Uint8Array(32);
    channelBytes.fill(0x44);
    const channelId = base58Encode(channelBytes);
    const recipientBytes = new Uint8Array(32);
    recipientBytes.fill(0x55);
    const recipient = base58Encode(recipientBytes);
    const msgHash = balanceProofHashSolana(channelId, 250n, 3n, recipient);
    const sig = new Uint8Array(ed25519.sign(msgHash, solPk));
    const pair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
      rate: '0.001',
    };
    const claim: AccumulatedClaim = {
      packetIndex: 0,
      sourceAmount: 1n,
      targetAmount: 250n,
      claimBytes: sig,
      millEphemeralPubkey: '0'.repeat(64),
      pair,
      receivedAt: 0,
      channelId,
      nonce: '3',
      cumulativeAmount: '250',
      recipient,
      millSignerAddress: solSignerAddr,
    };
    const res = verifyAccumulatedClaim(claim, {
      address: solSignerAddr,
      programId: base58Encode(new Uint8Array(32).fill(0x66)),
    });
    expect(res.valid).toBe(true);
  });

  it('[P1] returns valid:false with MINA reason for a mina chain claim', () => {
    const pair: SwapPair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
      to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
      rate: '0.5',
    };
    const claim: AccumulatedClaim = {
      packetIndex: 0,
      sourceAmount: 1n,
      targetAmount: 1n,
      claimBytes: new Uint8Array(64),
      millEphemeralPubkey: '0'.repeat(64),
      pair,
      receivedAt: 0,
      channelId: 'mina-channel',
      nonce: '1',
      cumulativeAmount: '1',
      recipient: 'B62qmina',
      millSignerAddress: 'B62qmina',
    };
    const res = verifyAccumulatedClaim(claim, { address: 'B62qmina' });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toMatch(/MINA_VERIFICATION_UNSUPPORTED/);
  });
});

// ---------------------------------------------------------------------------
// Mina pipeline integration (Story 12.8) — buildSettlementTx + the standalone
// verifier, with a real `mina-signer` client injected.
// ---------------------------------------------------------------------------

const MINA_PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
  rate: '0.5',
};

interface MinaSignerFullClient {
  genKeys(): { privateKey: string; publicKey: string };
  signFields(
    fields: bigint[],
    privateKey: string
  ): { signature: string | { field: string; scalar: string } };
  verifyFields(input: {
    data: bigint[];
    signature: string;
    publicKey: string;
  }): boolean;
}

// `mina-signer` is an OPTIONAL peer dep — gate the Mina pipeline tests on its
// presence (skipped in CI where peer deps are not installed). The
// without-client rejection path is covered by the `verifyAccumulatedClaim`
// MINA test above, which needs no peer dep.
const initialMinaClient = (await loadMinaSignerClient()) as
  | MinaSignerFullClient
  | undefined;
const hasMinaSigner = initialMinaClient !== undefined;

let minaClient: MinaSignerFullClient;

beforeAll(() => {
  minaClient = initialMinaClient as MinaSignerFullClient;
});

function makeMinaClaim(opts?: {
  channelId?: string;
  recipient?: string;
  cumulativeAmount?: string;
  nonce?: string;
}): { claim: AccumulatedClaim; signerAddress: string } {
  const keys = minaClient.genKeys();
  const channelId =
    opts?.channelId ?? 'B62qChannelExample1111111111111111111111111111';
  const recipient =
    opts?.recipient ?? 'B62qRecipientExample22222222222222222222222222';
  const cumulativeAmount = opts?.cumulativeAmount ?? '500';
  const nonce = opts?.nonce ?? '1';
  const fields = balanceProofFieldsMina(
    channelId,
    BigInt(cumulativeAmount),
    BigInt(nonce),
    recipient
  );
  const signed = minaClient.signFields(fields, keys.privateKey);
  const sigStr =
    typeof signed.signature === 'string'
      ? signed.signature
      : JSON.stringify(signed.signature);
  const claim: AccumulatedClaim = {
    packetIndex: 0,
    sourceAmount: 1_000_000n,
    targetAmount: 500n,
    claimBytes: new TextEncoder().encode(sigStr),
    millEphemeralPubkey: '0'.repeat(64),
    pair: MINA_PAIR,
    receivedAt: Date.now(),
    channelId,
    nonce,
    cumulativeAmount,
    recipient,
    millSignerAddress: keys.publicKey,
  };
  return { claim, signerAddress: keys.publicKey };
}

describe.skipIf(!hasMinaSigner)(
  'buildSettlementTx — Mina pipeline (Story 12.8)',
  () => {
    it('[P0] produces a bundle for a valid Mina claim when a client is provided', () => {
      const { claim, signerAddress } = makeMinaClaim();
      const res = buildSettlementTx({
        claims: [claim],
        signers: { 'mina:mainnet': { address: signerAddress } },
        recipients: { 'mina:mainnet': claim.recipient! },
        minaSignerClient: minaClient,
      });
      expect(res.rejected.length).toBe(0);
      expect(res.bundles.length).toBe(1);
      expect(res.bundles[0]!.chainKind).toBe('mina');
      expect(res.bundles[0]!.channelId).toBe(claim.channelId);
      expect(res.bundles[0]!.nonce).toBe('1');
    });

    it('[P0] rejects a Mina claim when no minaSignerClient is provided', () => {
      const { claim, signerAddress } = makeMinaClaim();
      const res = buildSettlementTx({
        claims: [claim],
        signers: { 'mina:mainnet': { address: signerAddress } },
        recipients: { 'mina:mainnet': claim.recipient! },
        // minaSignerClient intentionally omitted
      });
      expect(res.bundles.length).toBe(0);
      expect(res.rejected.length).toBe(1);
      expect(res.rejected[0]!.reason).toBe('MINA_VERIFICATION_UNSUPPORTED');
    });

    it('[P0] rejects a Mina claim signed by a different key', () => {
      const { claim } = makeMinaClaim();
      const other = minaClient.genKeys();
      const res = buildSettlementTx({
        claims: [claim],
        signers: { 'mina:mainnet': { address: other.publicKey } },
        recipients: { 'mina:mainnet': claim.recipient! },
        minaSignerClient: minaClient,
      });
      expect(res.bundles.length).toBe(0);
      expect(res.rejected.length).toBe(1);
      expect(res.rejected[0]!.reason).toBe('SIGNER_MISMATCH');
    });

    it('[P0] picks the highest-nonce winner across multiple Mina claims', () => {
      // Sign three claims on the same channel/recipient with the same key.
      const keys = minaClient.genKeys();
      const channelId = 'B62qChannelMulti33333333333333333333333333333';
      const recipient = 'B62qRecipientMulti4444444444444444444444444444';
      const claims: AccumulatedClaim[] = [1, 2, 3].map((n) => {
        const fields = balanceProofFieldsMina(
          channelId,
          BigInt(n * 100),
          BigInt(n),
          recipient
        );
        const signed = minaClient.signFields(fields, keys.privateKey);
        const sigStr =
          typeof signed.signature === 'string'
            ? signed.signature
            : JSON.stringify(signed.signature);
        return {
          packetIndex: n - 1,
          sourceAmount: 1_000_000n,
          targetAmount: BigInt(n * 100),
          claimBytes: new TextEncoder().encode(sigStr),
          millEphemeralPubkey: '0'.repeat(64),
          pair: MINA_PAIR,
          receivedAt: Date.now(),
          channelId,
          nonce: String(n),
          cumulativeAmount: String(n * 100),
          recipient,
          millSignerAddress: keys.publicKey,
        } satisfies AccumulatedClaim;
      });
      const res = buildSettlementTx({
        claims,
        signers: { 'mina:mainnet': { address: keys.publicKey } },
        recipients: { 'mina:mainnet': recipient },
        minaSignerClient: minaClient,
      });
      expect(res.rejected.length).toBe(0);
      expect(res.bundles.length).toBe(1);
      expect(res.bundles[0]!.nonce).toBe('3');
      expect(res.bundles[0]!.cumulativeAmount).toBe('300');
      expect(res.bundles[0]!.claimsMerged).toBe(3);
    });

    it('[P0] verifyAccumulatedClaim verifies a Mina claim when a client is passed', () => {
      const { claim, signerAddress } = makeMinaClaim();
      const res = verifyAccumulatedClaim(
        claim,
        { address: signerAddress },
        minaClient
      );
      expect(res.valid).toBe(true);
    });
  }
);
