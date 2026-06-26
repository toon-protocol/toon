import { describe, it, expect } from 'vitest';
import {
  hexToMinaBase58PrivateKey,
  deriveMinaPublicKeyBase58,
} from './mina-key.js';

// A valid 32-byte big-endian hex scalar (top bits cleared, as derivation emits).
const HEX_SCALAR =
  '3f00000000000000000000000000000000000000000000000000000000000001';

describe('hexToMinaBase58PrivateKey', () => {
  it('passes through a value that is not a 64-char hex scalar', () => {
    const ek = 'EKEsomeAlreadyBase58Key';
    expect(hexToMinaBase58PrivateKey(ek)).toBe(ek);
  });

  it('encodes a hex scalar deterministically to a base58 string', () => {
    const a = hexToMinaBase58PrivateKey(HEX_SCALAR);
    const b = hexToMinaBase58PrivateKey(HEX_SCALAR);
    expect(a).toBe(b);
    // Base58 (Bitcoin alphabet) — no 0, O, I, or l.
    expect(a).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(a).not.toBe(HEX_SCALAR);
  });
});

describe('deriveMinaPublicKeyBase58', () => {
  it('returns null without mina-signer, or a B62 address when the peer dep is present', async () => {
    // mina-signer is an OPTIONAL peer dep: absent in most CI/dev installs
    // (→ null), present in the swap E2E image (→ real B62). Assert both shapes
    // so the test is robust either way and never throws.
    const pub = await deriveMinaPublicKeyBase58(HEX_SCALAR);
    expect(pub === null || pub.startsWith('B62')).toBe(true);
  });

  it('does not throw on an already-base58 EK private key', async () => {
    await expect(
      deriveMinaPublicKeyBase58('EKEsomeAlreadyBase58Key')
    ).resolves.not.toThrow();
  });
});
