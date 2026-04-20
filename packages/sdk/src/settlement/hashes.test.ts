/**
 * Story 12.6 AC-6: Shared balance-proof hash helpers.
 *
 * Verifies the sdk-side helpers produce the same hash layout that
 * `packages/mill/src/payment-channel-signer.ts` signs against. This is the
 * cross-package parity safety net for the AC-6 refactor.
 */
import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  balanceProofHashEvm,
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
 * tests. Because `packages/mill/src/payment-channel-signer.ts` imports these
 * helpers (AC-6 refactor), the same layout drift would also break the Mill's
 * signer — this is the cross-package parity net.
 *
 * @fixture
 */
const EVM_GOLDEN_VECTORS = [
  {
    label: 'zero inputs',
    channelId: '0x' + '00'.repeat(32),
    cumulative: 0n,
    nonce: 0n,
    recipient: '0x' + '00'.repeat(20),
    expected:
      '3bdd562417b2b6c29b6c37a0fbf5c08139fe63f7baf013194f112d8319bf8b32',
  },
  {
    label: 'realistic inputs',
    channelId: '0x' + 'aa'.repeat(32),
    cumulative: 1_000_000n,
    nonce: 1n,
    recipient: '0x' + 'bb'.repeat(20),
    expected:
      '0056cde05486191be9f521b19ad24a200980924d8ac406c4ade22ce73199e7e2',
  },
  {
    label: 'near-max cumulativeAmount, high nonce',
    channelId: '0x' + '00'.repeat(32),
    cumulative: 2n ** 255n - 1n,
    nonce: 1_000_000n,
    recipient: '0x' + '00'.repeat(20),
    expected:
      '967ae7fa9e4a533cebe224f514f025746351ad2e7fdb25f11627fe6ef5f10bbe',
  },
  {
    label: 'cross-package parity sample',
    channelId: '0x' + '11'.repeat(32),
    cumulative: 12345n,
    nonce: 7n,
    recipient: '0x' + '22'.repeat(20),
    expected:
      '579ce58caed50ebbc8bb942a5ab7ff01297c4709cc49c61d44f8f7c8e441885f',
  },
] as const;

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

describe('balanceProofHashEvm — golden vectors (Story 12.6 AC-6)', () => {
  for (const v of EVM_GOLDEN_VECTORS) {
    it(`[P0] pinned digest: ${v.label}`, () => {
      const h = balanceProofHashEvm(
        hexToBytes(v.channelId),
        v.cumulative,
        v.nonce,
        hexToBytes(v.recipient)
      );
      expect(h.length).toBe(32);
      expect(bytesToHex(h)).toBe(v.expected);
    });
  }

  it('[P0] different nonce produces a different hash (collision avoidance)', () => {
    const channelId = hexToBytes('0x' + 'aa'.repeat(32));
    const recipient = hexToBytes('0x' + 'bb'.repeat(20));
    const h1 = balanceProofHashEvm(channelId, 1_000n, 1n, recipient);
    const h2 = balanceProofHashEvm(channelId, 1_000n, 2n, recipient);
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
  });

  it('[P0] different cumulativeAmount produces a different hash', () => {
    const channelId = hexToBytes('0x' + 'aa'.repeat(32));
    const recipient = hexToBytes('0x' + 'bb'.repeat(20));
    const h1 = balanceProofHashEvm(channelId, 100n, 1n, recipient);
    const h2 = balanceProofHashEvm(channelId, 200n, 1n, recipient);
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2));
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

describe('cross-package parity with mill/payment-channel-signer.ts (Story 12.6 AC-6)', () => {
  it('[P0] pinned EVM digest — signer drift detector', () => {
    // The Mill's EvmPaymentChannelSigner imports balanceProofHashEvm from
    // this module (AC-6 refactor). Any layout change here automatically
    // flips the Mill's signature output; the pinned digest catches that.
    const channelIdBytes = hexToBytes('0x' + '11'.repeat(32));
    const recipientBytes = hexToBytes('0x' + '22'.repeat(20));
    const h = balanceProofHashEvm(channelIdBytes, 12345n, 7n, recipientBytes);
    expect(bytesToHex(h)).toBe(
      '579ce58caed50ebbc8bb942a5ab7ff01297c4709cc49c61d44f8f7c8e441885f'
    );
  });
});
