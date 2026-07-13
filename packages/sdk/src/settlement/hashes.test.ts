/**
 * Story 12.6 AC-6: Shared balance-proof hash helpers.
 *
 * Verifies the sdk-side helpers produce the same hash layout that
 * `packages/swap/src/payment-channel-signer.ts` signs against. This is the
 * cross-package parity safety net for the AC-6 refactor.
 */
import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  balanceProofHashEvm,
  coopCloseHashEvm,
  eip712DomainSeparatorEvm,
  balanceProofHashSolana,
  bigintToBytes32BE,
  concatBytes,
  hexToBytes,
} from './hashes.js';

describe('hashes.ts — bigintToBytes32BE + concatBytes + hexToBytes', () => {
  it('bigintToBytes32BE encodes 0 as 32 zero bytes', () => {
    const out = bigintToBytes32BE(0n);
    expect(out.length).toBe(32);
    expect(Array.from(out)).toEqual(new Array(32).fill(0));
  });

  it('bigintToBytes32BE encodes 1 as 0x000...001', () => {
    const out = bigintToBytes32BE(1n);
    expect(bytesToHex(out)).toBe(
      '0000000000000000000000000000000000000000000000000000000000000001'
    );
  });

  it('bigintToBytes32BE rejects negative', () => {
    expect(() => bigintToBytes32BE(-1n)).toThrow(/non-negative/);
  });

  it('bigintToBytes32BE rejects > 256-bit', () => {
    expect(() => bigintToBytes32BE(2n ** 256n)).toThrow(/256 bits/);
  });

  it('bigintToBytes32BE encodes max 256-bit value', () => {
    const out = bigintToBytes32BE(2n ** 256n - 1n);
    expect(bytesToHex(out)).toBe('f'.repeat(64));
  });

  it('concatBytes concatenates multiple arrays', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const out = concatBytes(a, b);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('hexToBytes strips 0x prefix and decodes', () => {
    const out = hexToBytes('0xabcdef');
    expect(Array.from(out)).toEqual([0xab, 0xcd, 0xef]);
  });

  it('hexToBytes rejects odd-length input', () => {
    expect(() => hexToBytes('0xabc')).toThrow(/Invalid hex/);
  });

  it('hexToBytes rejects non-hex input', () => {
    expect(() => hexToBytes('0xZZ00')).toThrow(/Invalid hex/);
  });
});

/**
 * Golden vectors — pinned digests locking down the exact byte layout.
 *
 * Any change to `balanceProofHashEvm` / `balanceProofHashSolana` (or to
 * `bigintToBytes32BE` / `concatBytes`) that alters output will break these
 * tests. Because `packages/swap/src/payment-channel-signer.ts` imports these
 * helpers (AC-6 refactor), the same layout drift would also break the Swap's
 * signer — this is the cross-package parity net.
 *
 * @fixture
 */
/**
 * v2 EIP-712 CONFORMANCE FIXTURE — the single canonical golden vector pinned by
 * the cross-repo spec `docs/rolling-swap-v2-digest-spec.md` §4 (connector#325,
 * refs connector#324 finding #1). All four repos (connector contract, this
 * toon core/sdk, swap signer, toon-client) MUST reproduce these EXACT bytes.
 *
 * Changing `balanceProofHashEvm` / `coopCloseHashEvm` /
 * `eip712DomainSeparatorEvm` (or the underlying `bigintToBytes32BE` /
 * `concatBytes`) in a way that alters output breaks these — and would break the
 * on-chain verifier + the swap signer that import the same helper.
 *
 * @fixture
 */
const V2_GOLDEN = {
  chainId: 8453n,
  verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  channelId:
    '0x000000000000000000000000000000000000000000000000000000000000005b',
  cumulativeAmount: 24_000_000n,
  nonce: 24n,
  recipient: '0x00000000000000000000000000000000DEADBEEF',
  domainSeparator:
    'b94d6e9c9c28083295de906f48c4db4110392800177aad52c3f99f2afbce594f',
  claimDigest:
    '8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede',
  coopDigest:
    '8b748bdfc330a591164551d4b536d64b963aff1059b594acc1dc5a24297e25c0',
} as const;

const SOLANA_GOLDEN_VECTORS = [
  {
    label: 'empty strings, zero inputs',
    channelId: '',
    cumulative: 0n,
    nonce: 0n,
    recipient: '',
    expected:
      'f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b',
  },
  {
    label: 'sample base58-ish strings',
    channelId: 'ChannelOne111',
    cumulative: 100n,
    nonce: 1n,
    recipient: 'Recipient22',
    expected:
      'e19f66f5b9c8bfc9ac414b139b0a4ec48c3f965a826372da0b9b87b15a0c0302',
  },
] as const;

describe('EVM v2 EIP-712 digest — golden vectors (connector#324 finding #1 / connector#325 spec)', () => {
  const channelId = hexToBytes(V2_GOLDEN.channelId);
  const recipient = hexToBytes(V2_GOLDEN.recipient);
  const verifyingContract = hexToBytes(V2_GOLDEN.verifyingContract);

  it('[P0] eip712DomainSeparatorEvm reproduces the pinned domain separator', () => {
    const ds = eip712DomainSeparatorEvm(
      V2_GOLDEN.chainId,
      verifyingContract
    );
    expect(ds.length).toBe(32);
    expect(bytesToHex(ds)).toBe(V2_GOLDEN.domainSeparator);
  });

  it('[P0] balanceProofHashEvm reproduces the pinned CLAIM digest', () => {
    const h = balanceProofHashEvm(
      channelId,
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      recipient,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    expect(h.length).toBe(32);
    expect(bytesToHex(h)).toBe(V2_GOLDEN.claimDigest);
  });

  it('[P0] coopCloseHashEvm reproduces the pinned COOP-CLOSE digest', () => {
    const h = coopCloseHashEvm(
      channelId,
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    expect(h.length).toBe(32);
    expect(bytesToHex(h)).toBe(V2_GOLDEN.coopDigest);
  });

  it('[P0] claim and coop-close digests differ (distinct type hashes)', () => {
    const claim = balanceProofHashEvm(
      channelId,
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      recipient,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    const coop = coopCloseHashEvm(
      channelId,
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    expect(bytesToHex(claim)).not.toBe(bytesToHex(coop));
  });

  it('[P0] a different chainId produces a different digest (cross-chain replay closed)', () => {
    const base = balanceProofHashEvm(
      channelId,
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      recipient,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    const other = balanceProofHashEvm(
      channelId,
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      recipient,
      10n, // Optimism, same everything else
      verifyingContract
    );
    expect(bytesToHex(base)).not.toBe(bytesToHex(other));
  });

  it('[P0] a different verifyingContract produces a different digest (cross-deployment replay closed)', () => {
    const base = balanceProofHashEvm(
      channelId,
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      recipient,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    const other = balanceProofHashEvm(
      channelId,
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      recipient,
      V2_GOLDEN.chainId,
      hexToBytes('0x' + '11'.repeat(20))
    );
    expect(bytesToHex(base)).not.toBe(bytesToHex(other));
  });

  it('[P0] different nonce produces a different hash (collision avoidance)', () => {
    const h1 = balanceProofHashEvm(
      channelId,
      1_000n,
      1n,
      recipient,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    const h2 = balanceProofHashEvm(
      channelId,
      1_000n,
      2n,
      recipient,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
  });

  it('[P0] different cumulativeAmount produces a different hash', () => {
    const h1 = balanceProofHashEvm(
      channelId,
      100n,
      1n,
      recipient,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    const h2 = balanceProofHashEvm(
      channelId,
      200n,
      1n,
      recipient,
      V2_GOLDEN.chainId,
      verifyingContract
    );
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
  });

  it('[P0] rejects a non-20-byte verifyingContract', () => {
    expect(() =>
      balanceProofHashEvm(
        channelId,
        V2_GOLDEN.cumulativeAmount,
        V2_GOLDEN.nonce,
        recipient,
        V2_GOLDEN.chainId,
        hexToBytes('0x1234')
      )
    ).toThrow(/verifyingContract must be 20 bytes/);
  });
});

describe('balanceProofHashSolana — golden vectors (Story 12.6 AC-6)', () => {
  for (const v of SOLANA_GOLDEN_VECTORS) {
    it(`[P0] pinned digest: ${v.label}`, () => {
      const h = balanceProofHashSolana(
        v.channelId,
        v.cumulative,
        v.nonce,
        v.recipient
      );
      expect(h.length).toBe(32);
      expect(bytesToHex(h)).toBe(v.expected);
    });
  }

  it('[P0] different inputs produce different hashes', () => {
    const h1 = balanceProofHashSolana('a', 1n, 1n, 'b');
    const h2 = balanceProofHashSolana('a', 1n, 2n, 'b');
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
  });
});

describe('cross-package parity with swap/payment-channel-signer.ts (v2 EIP-712)', () => {
  it('[P0] pinned EVM v2 digest — signer drift detector', () => {
    // The Swap's EvmPaymentChannelSigner imports balanceProofHashEvm from
    // this module. Any layout change here automatically flips the Swap's
    // signature output; the pinned spec golden digest catches that.
    const h = balanceProofHashEvm(
      hexToBytes(V2_GOLDEN.channelId),
      V2_GOLDEN.cumulativeAmount,
      V2_GOLDEN.nonce,
      hexToBytes(V2_GOLDEN.recipient),
      V2_GOLDEN.chainId,
      hexToBytes(V2_GOLDEN.verifyingContract)
    );
    expect(bytesToHex(h)).toBe(V2_GOLDEN.claimDigest);
  });
});
