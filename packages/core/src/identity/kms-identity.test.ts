import { describe, it, expect } from 'vitest';
import {
  generateSecretKey as _generateSecretKey,
  getPublicKey as _getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure';

// These imports do not exist yet — each will cause a build/import failure
// until the corresponding module is implemented.
// Uncomment when implementing the green phase:
// import { deriveFromKmsSeed, KmsIdentityError } from './kms-identity.js';
// import { buildAttestationEvent } from '../events/attestation.js';
// import { TEE_ATTESTATION_KIND } from '../constants.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Deterministic 32-byte seed for reproducible test derivations. */
const TEST_KMS_SEED = new Uint8Array(32).fill(0x42);

/**
 * Standard BIP-39 test mnemonic (12-word "abandon" vector).
 * NIP-06 derivation path: m/44'/1237'/0'/0/0
 */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// ---------------------------------------------------------------------------
// T-4.4-01 [P0] KMS-derived Nostr keypair produces valid Schnorr signatures
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed — Schnorr signature validity', () => {
  it.skip('T-4.4-01: KMS-derived keypair signs an event verifiable by nostr-tools', () => {
    // Will fail: ./kms-identity.js does not exist yet.
    //
    // Arrange — derive a keypair from the test seed
    const { secretKey, pubkey } = deriveFromKmsSeed(TEST_KMS_SEED);

    // Act — build a minimal unsigned event template and sign it
    const _unsigned = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'hello from KMS identity',
      pubkey,
    };
    // finalizeEvent is the nostr-tools helper that hashes + signs; import it
    // once the implementation exists. For now the test is skipped.
    // const signed = finalizeEvent(unsigned, secretKey);

    // Assert — nostr-tools verifyEvent returns true
    // expect(verifyEvent(signed)).toBe(true);
    // expect(signed.pubkey).toBe(pubkey);

    // Placeholder assertion so the skip-block is syntactically complete
    expect(secretKey).toBeDefined();
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// T-4.4-02 [P0] KMS seed derivation follows NIP-06 path
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed — NIP-06 compatibility', () => {
  it.skip("T-4.4-02: derived key matches NIP-06 path m/44'/1237'/0'/0/0 for known mnemonic", () => {
    // Will fail: ./kms-identity.js does not exist yet.
    //
    // Arrange — use the well-known BIP-39 test mnemonic
    // The expected pubkey is the deterministic output of:
    //   mnemonic -> BIP-32 seed -> derive(m/44'/1237'/0'/0/0) -> x-only pubkey
    //
    // Act
    const { pubkey } = deriveFromKmsSeed(TEST_KMS_SEED, {
      mnemonic: TEST_MNEMONIC,
    });

    // Assert — the pubkey must equal the canonical NIP-06 derivation.
    // The exact expected value will be filled in when the implementation
    // is written and the golden-file value is captured.
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    // TODO(green phase): replace with exact expected hex once derived:
    // expect(pubkey).toBe('<expected-nip06-pubkey-hex>');
  });
});

// ---------------------------------------------------------------------------
// T-4.4-03 [P1] Same KMS seed produces same Nostr pubkey across invocations
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed — determinism', () => {
  it.skip('T-4.4-03: same seed produces identical pubkey on two separate derivations', () => {
    // Will fail: ./kms-identity.js does not exist yet.
    //
    // Arrange & Act — derive twice from the same seed
    const first = deriveFromKmsSeed(TEST_KMS_SEED);
    const second = deriveFromKmsSeed(TEST_KMS_SEED);

    // Assert — both derivations yield the exact same keypair
    expect(first.pubkey).toBe(second.pubkey);
    expect(first.secretKey).toEqual(second.secretKey);
  });
});

// ---------------------------------------------------------------------------
// T-4.4-04 [P1] KMS-derived identity signs kind:10033 self-attestation events
// ---------------------------------------------------------------------------
describe('KMS identity — kind:10033 self-attestation', () => {
  it.skip('T-4.4-04: building a kind:10033 event with KMS keypair produces a valid signed event', () => {
    // Will fail: ./kms-identity.js AND ../events/attestation.js do not exist yet.
    // Additionally, TEE_ATTESTATION_KIND (10033) is not yet in constants.ts.
    //
    // Arrange — derive identity
    const { secretKey, pubkey } = deriveFromKmsSeed(TEST_KMS_SEED);

    // Act — build a self-attestation event using the attestation builder
    const attestationPayload = {
      nodeId: pubkey,
      platform: 'aws-nitro',
      pcrs: { pcr0: 'aabb', pcr1: 'ccdd' },
    };
    const event = buildAttestationEvent(attestationPayload, secretKey);

    // Assert — event structure and signature
    expect(event.kind).toBe(TEE_ATTESTATION_KIND);
    expect(event.pubkey).toBe(pubkey);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyEvent(event)).toBe(true);

    // Assert — attestation content round-trips
    const content = JSON.parse(event.content);
    expect(content.nodeId).toBe(pubkey);
    expect(content.platform).toBe('aws-nitro');
  });
});

// ---------------------------------------------------------------------------
// T-4.4-05 [P2] KMS unavailable — clear error, no silent random-key fallback
// ---------------------------------------------------------------------------
describe('KMS identity — error handling', () => {
  it.skip('T-4.4-05: KMS unavailability propagates KmsIdentityError, not a random key', () => {
    // Will fail: ./kms-identity.js does not exist yet, so KmsIdentityError
    // is not importable.
    //
    // Arrange — a null/undefined seed simulates KMS being unreachable
    const badSeed = null as unknown as Uint8Array;

    // Act & Assert — must throw KmsIdentityError, not silently generate a
    // random keypair (which would be a security-critical bug).
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(KmsIdentityError);

    // Additionally verify the error message is actionable
    try {
      deriveFromKmsSeed(badSeed);
    } catch (err) {
      expect(err).toBeInstanceOf(KmsIdentityError);
      expect((err as KmsIdentityError).message).toMatch(
        /KMS|seed|unavailable/i
      );
    }
  });
});
