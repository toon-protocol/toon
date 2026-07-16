/**
 * v2 EIP-712 balance-proof digest — CANONICAL GOLDEN VECTORS.
 *
 * `@toon-protocol/settlement-digest` is the single source of truth for the
 * balance-proof digest that every signer and verifier in the TOON ecosystem
 * depends on. This leaf OWNS the golden vectors from the cross-repo spec
 * `docs/rolling-swap-v2-digest-spec.md` §4 (connector#325; refs connector#324
 * finding #1 — the v1 raw-keccak digest lacked chainId / contract domain
 * separation, enabling cross-chain / cross-deployment claim replay).
 *
 * The v2 digest is standard EIP-712:
 *   domainSeparator = keccak256(abi.encode(EIP712DOMAIN_TYPEHASH,
 *     keccak256(name), keccak256(version), chainId, verifyingContract))
 *   structHash      = keccak256(abi.encode(TYPEHASH, fields...))
 *   digest          = keccak256(0x1901 || domainSeparator || structHash)
 * with name="RollingSwapChannel", version="2".
 *
 * These bytes MUST match the connector on-chain verifier, the swap signer, and
 * the toon-client leg byte-for-byte, AND the values already published in
 * `@toon-protocol/core@3.0.0` / `@toon-protocol/sdk@3.0.0`.
 *
 * @fixture
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

// Fixed parameters (spec §4).
const CHAIN_ID = 8453n;
const VERIFYING_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CHANNEL_ID =
  '0x000000000000000000000000000000000000000000000000000000000000005b';
const CUMULATIVE = 24_000_000n;
const NONCE = 24n;
const RECIPIENT = '0x00000000000000000000000000000000DEADBEEF';

// Pinned derived values (spec §4).
const DOMAIN_SEPARATOR =
  'b94d6e9c9c28083295de906f48c4db4110392800177aad52c3f99f2afbce594f';
const CLAIM_DIGEST =
  '8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede';
const COOP_DIGEST =
  '8b748bdfc330a591164551d4b536d64b963aff1059b594acc1dc5a24297e25c0';

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

describe('byte helpers — bigintToBytes32BE + concatBytes + hexToBytes', () => {
  it('bigintToBytes32BE encodes 0 as 32 zero bytes', () => {
    const out = bigintToBytes32BE(0n);
    expect(out.length).toBe(32);
    expect(Array.from(out)).toEqual(new Array(32).fill(0));
  });

  it('bigintToBytes32BE encodes 1 as 0x000...001', () => {
    expect(bytesToHex(bigintToBytes32BE(1n))).toBe(
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
    expect(bytesToHex(bigintToBytes32BE(2n ** 256n - 1n))).toBe('f'.repeat(64));
  });

  it('concatBytes concatenates multiple arrays', () => {
    const out = concatBytes(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]));
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('hexToBytes strips 0x prefix and decodes', () => {
    expect(Array.from(hexToBytes('0xabcdef'))).toEqual([0xab, 0xcd, 0xef]);
  });

  it('hexToBytes rejects odd-length input', () => {
    expect(() => hexToBytes('0xabc')).toThrow(/Invalid hex/);
  });

  it('hexToBytes rejects non-hex input', () => {
    expect(() => hexToBytes('0xZZ00')).toThrow(/Invalid hex/);
  });
});

describe('v2 EIP-712 digest — golden vectors (spec §4, connector#325)', () => {
  const channelId = hexToBytes(CHANNEL_ID);
  const recipient = hexToBytes(RECIPIENT);
  const vc = hexToBytes(VERIFYING_CONTRACT);

  it('[P0] domain separator matches the pinned value', () => {
    const ds = eip712DomainSeparatorEvm(CHAIN_ID, vc);
    expect(ds.length).toBe(32);
    expect(bytesToHex(ds)).toBe(DOMAIN_SEPARATOR);
  });

  it('[P0] balanceProofHashEvm reproduces the CLAIM digest byte-for-byte', () => {
    const h = balanceProofHashEvm(
      channelId,
      CUMULATIVE,
      NONCE,
      recipient,
      CHAIN_ID,
      vc
    );
    expect(h.length).toBe(32);
    expect(bytesToHex(h)).toBe(CLAIM_DIGEST);
  });

  it('[P0] coopCloseHashEvm reproduces the COOP-CLOSE digest byte-for-byte', () => {
    const h = coopCloseHashEvm(channelId, CUMULATIVE, NONCE, CHAIN_ID, vc);
    expect(h.length).toBe(32);
    expect(bytesToHex(h)).toBe(COOP_DIGEST);
  });
});

describe('v2 EIP-712 digest — domain binding (finding #1: replay closed)', () => {
  const channelId = hexToBytes(CHANNEL_ID);
  const recipient = hexToBytes(RECIPIENT);
  const vc = hexToBytes(VERIFYING_CONTRACT);

  it('[P0] changing chainId changes the claim digest (cross-chain replay closed)', () => {
    const a = balanceProofHashEvm(
      channelId,
      CUMULATIVE,
      NONCE,
      recipient,
      8453n,
      vc
    );
    const b = balanceProofHashEvm(
      channelId,
      CUMULATIVE,
      NONCE,
      recipient,
      10n,
      vc
    );
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('[P0] changing verifyingContract changes the claim digest (cross-deployment replay closed)', () => {
    const a = balanceProofHashEvm(
      channelId,
      CUMULATIVE,
      NONCE,
      recipient,
      CHAIN_ID,
      vc
    );
    const b = balanceProofHashEvm(
      channelId,
      CUMULATIVE,
      NONCE,
      recipient,
      CHAIN_ID,
      hexToBytes('0x' + '11'.repeat(20))
    );
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('[P0] claim vs coop-close never collide under the same domain (distinct type hashes)', () => {
    const claim = balanceProofHashEvm(
      channelId,
      CUMULATIVE,
      NONCE,
      recipient,
      CHAIN_ID,
      vc
    );
    const coop = coopCloseHashEvm(channelId, CUMULATIVE, NONCE, CHAIN_ID, vc);
    expect(bytesToHex(claim)).not.toBe(bytesToHex(coop));
  });

  it('[P0] rejects a non-32-byte channelId', () => {
    expect(() =>
      balanceProofHashEvm(
        hexToBytes('0x1234'),
        CUMULATIVE,
        NONCE,
        recipient,
        CHAIN_ID,
        vc
      )
    ).toThrow(/channelId must be 32 bytes/);
  });

  it('[P0] rejects a non-20-byte recipient', () => {
    expect(() =>
      balanceProofHashEvm(
        channelId,
        CUMULATIVE,
        NONCE,
        hexToBytes('0x1234'),
        CHAIN_ID,
        vc
      )
    ).toThrow(/recipient must be 20 bytes/);
  });

  it('[P0] rejects a non-20-byte verifyingContract', () => {
    expect(() =>
      eip712DomainSeparatorEvm(CHAIN_ID, hexToBytes('0x1234'))
    ).toThrow(/verifyingContract must be 20 bytes/);
  });
});

describe('balanceProofHashSolana — golden vectors', () => {
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
