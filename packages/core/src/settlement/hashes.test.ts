/**
 * v2 EIP-712 balance-proof digest — CONFORMANCE FIXTURES.
 *
 * `@toon-protocol/core` is the canonical single source of truth for the
 * balance-proof digest that every signer and verifier in the monorepo depends
 * on. This suite pins the exact golden vectors from the cross-repo spec
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
 * the toon-client leg byte-for-byte.
 */
import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  balanceProofHashEvm,
  coopCloseHashEvm,
  eip712DomainSeparatorEvm,
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

describe('v2 EIP-712 digest — golden vectors (spec §4, connector#325)', () => {
  it('[P0] domain separator matches the pinned value', () => {
    const ds = eip712DomainSeparatorEvm(
      CHAIN_ID,
      hexToBytes(VERIFYING_CONTRACT)
    );
    expect(bytesToHex(ds)).toBe(DOMAIN_SEPARATOR);
  });

  it('[P0] balanceProofHashEvm reproduces the CLAIM digest byte-for-byte', () => {
    const h = balanceProofHashEvm(
      hexToBytes(CHANNEL_ID),
      CUMULATIVE,
      NONCE,
      hexToBytes(RECIPIENT),
      CHAIN_ID,
      hexToBytes(VERIFYING_CONTRACT)
    );
    expect(h.length).toBe(32);
    expect(bytesToHex(h)).toBe(CLAIM_DIGEST);
  });

  it('[P0] coopCloseHashEvm reproduces the COOP-CLOSE digest byte-for-byte', () => {
    const h = coopCloseHashEvm(
      hexToBytes(CHANNEL_ID),
      CUMULATIVE,
      NONCE,
      CHAIN_ID,
      hexToBytes(VERIFYING_CONTRACT)
    );
    expect(h.length).toBe(32);
    expect(bytesToHex(h)).toBe(COOP_DIGEST);
  });
});

describe('v2 EIP-712 digest — domain binding (finding #1: replay closed)', () => {
  const channelId = hexToBytes(CHANNEL_ID);
  const recipient = hexToBytes(RECIPIENT);
  const vc = hexToBytes(VERIFYING_CONTRACT);

  it('[P0] changing chainId changes the claim digest (cross-chain replay closed)', () => {
    const a = balanceProofHashEvm(channelId, CUMULATIVE, NONCE, recipient, 8453n, vc);
    const b = balanceProofHashEvm(channelId, CUMULATIVE, NONCE, recipient, 10n, vc);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('[P0] changing verifyingContract changes the claim digest (cross-deployment replay closed)', () => {
    const a = balanceProofHashEvm(channelId, CUMULATIVE, NONCE, recipient, CHAIN_ID, vc);
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
    const claim = balanceProofHashEvm(channelId, CUMULATIVE, NONCE, recipient, CHAIN_ID, vc);
    const coop = coopCloseHashEvm(channelId, CUMULATIVE, NONCE, CHAIN_ID, vc);
    expect(bytesToHex(claim)).not.toBe(bytesToHex(coop));
  });

  it('[P0] rejects a non-32-byte channelId', () => {
    expect(() =>
      balanceProofHashEvm(hexToBytes('0x1234'), CUMULATIVE, NONCE, recipient, CHAIN_ID, vc)
    ).toThrow(/channelId must be 32 bytes/);
  });

  it('[P0] rejects a non-20-byte recipient', () => {
    expect(() =>
      balanceProofHashEvm(channelId, CUMULATIVE, NONCE, hexToBytes('0x1234'), CHAIN_ID, vc)
    ).toThrow(/recipient must be 20 bytes/);
  });

  it('[P0] rejects a non-20-byte verifyingContract', () => {
    expect(() =>
      eip712DomainSeparatorEvm(CHAIN_ID, hexToBytes('0x1234'))
    ).toThrow(/verifyingContract must be 20 bytes/);
  });
});
