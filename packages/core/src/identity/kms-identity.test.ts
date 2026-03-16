import { describe, it, expect } from 'vitest';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { deriveFromKmsSeed, KmsIdentityError } from './kms-identity.js';
import { buildAttestationEvent } from '../events/attestation.js';
import { TEE_ATTESTATION_KIND } from '../constants.js';

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

/**
 * Expected x-only Schnorr pubkey for TEST_MNEMONIC at NIP-06 path m/44'/1237'/0'/0/0.
 * Computed via: mnemonicToSeedSync(TEST_MNEMONIC) -> HDKey.fromMasterSeed -> derive(path) -> getPublicKey
 */
const EXPECTED_ABANDON_PUBKEY =
  'e8bcf3823669444d0b49ad45d65088635d9fd8500a75b5f20b59abefa56a144f';

/**
 * Valid TeeAttestation payload matching the TeeAttestation type shape.
 * Uses 96-char hex PCR values and base64 attestation doc.
 */
const TEST_ATTESTATION_PAYLOAD = {
  enclave: 'marlin-oyster',
  pcr0: 'a'.repeat(96),
  pcr1: 'b'.repeat(96),
  pcr2: 'c'.repeat(96),
  attestationDoc: 'dGVzdC1hdHRlc3RhdGlvbi1kb2N1bWVudA==',
  version: '1.0.0',
};

// ---------------------------------------------------------------------------
// T-4.4-01 [P0] KMS-derived Nostr keypair produces valid Schnorr signatures
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- Schnorr signature validity', () => {
  it('T-4.4-01: KMS-derived keypair signs an event verifiable by nostr-tools', () => {
    // Arrange -- derive a keypair from the test seed
    const { secretKey, pubkey } = deriveFromKmsSeed(TEST_KMS_SEED);

    // Act -- build a minimal unsigned event template and sign it
    const unsigned = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'hello from KMS identity',
      pubkey,
    };
    const signed = finalizeEvent(unsigned, secretKey);

    // Assert -- nostr-tools verifyEvent returns true
    expect(verifyEvent(signed)).toBe(true);
    expect(signed.pubkey).toBe(pubkey);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
  });
});

// ---------------------------------------------------------------------------
// T-4.4-02 [P0] KMS seed derivation follows NIP-06 path
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- NIP-06 compatibility', () => {
  it("T-4.4-02: derived key matches NIP-06 path m/44'/1237'/0'/0/0 for known mnemonic", () => {
    // Arrange -- use the well-known BIP-39 test mnemonic ("abandon" vector)
    // The expected pubkey is the deterministic output of:
    //   mnemonic -> BIP-39 seed -> derive(m/44'/1237'/0'/0/0) -> x-only pubkey

    // Act
    const { pubkey } = deriveFromKmsSeed(TEST_KMS_SEED, {
      mnemonic: TEST_MNEMONIC,
    });

    // Assert -- pubkey must be 64-char lowercase hex
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);

    // Assert -- pubkey must equal the canonical NIP-06 derivation for this mnemonic
    expect(pubkey).toBe(EXPECTED_ABANDON_PUBKEY);
  });
});

// ---------------------------------------------------------------------------
// T-4.4-03 [P1] Same KMS seed produces same Nostr pubkey across invocations
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- determinism', () => {
  it('T-4.4-03: same seed produces identical pubkey on two separate derivations', () => {
    // Arrange & Act -- derive twice from the same seed
    const first = deriveFromKmsSeed(TEST_KMS_SEED);
    const second = deriveFromKmsSeed(TEST_KMS_SEED);

    // Assert -- both derivations yield the exact same keypair
    expect(first.pubkey).toBe(second.pubkey);
    expect(first.secretKey).toEqual(second.secretKey);
  });
});

// ---------------------------------------------------------------------------
// T-4.4-04 [P1] KMS-derived identity signs kind:10033 self-attestation events
// ---------------------------------------------------------------------------
describe('KMS identity -- kind:10033 self-attestation', () => {
  it('T-4.4-04: building a kind:10033 event with KMS keypair produces a valid signed event', () => {
    // Arrange -- derive identity
    const { secretKey, pubkey } = deriveFromKmsSeed(TEST_KMS_SEED);

    // Act -- build a self-attestation event using the attestation builder
    // buildAttestationEvent expects (TeeAttestation, secretKey, AttestationEventOptions)
    const attestation = TEST_ATTESTATION_PAYLOAD;
    const options = {
      relay: 'wss://test:7100',
      chain: '31337',
      expiry: Math.floor(Date.now() / 1000) + 300,
    };
    const event = buildAttestationEvent(attestation, secretKey, options);

    // Assert -- event structure and signature
    expect(event.kind).toBe(TEE_ATTESTATION_KIND);
    expect(event.pubkey).toBe(pubkey);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyEvent(event)).toBe(true);

    // Assert -- attestation content round-trips the TeeAttestation fields
    const content = JSON.parse(event.content) as Record<string, unknown>;
    expect(content['enclave']).toBe('marlin-oyster');
    expect(content['pcr0']).toBe('a'.repeat(96));
    expect(content['pcr1']).toBe('b'.repeat(96));
    expect(content['pcr2']).toBe('c'.repeat(96));
    expect(content['attestationDoc']).toBe(
      'dGVzdC1hdHRlc3RhdGlvbi1kb2N1bWVudA=='
    );
    expect(content['version']).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// T-4.4-05 [P2] KMS unavailable -- clear error, no silent random-key fallback
// ---------------------------------------------------------------------------
describe('KMS identity -- error handling', () => {
  it('T-4.4-05a: null seed throws KmsIdentityError', () => {
    // Arrange -- a null seed simulates KMS being unreachable
    const badSeed = null as unknown as Uint8Array;

    // Act & Assert -- must throw KmsIdentityError, not silently generate a
    // random keypair (which would be a security-critical bug).
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(KmsIdentityError);

    // Assert -- error message is actionable per AC #5 (/KMS|seed|unavailable/i)
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(/KMS|seed|unavailable/i);
  });

  it('T-4.4-05b: undefined seed throws KmsIdentityError with actionable message', () => {
    // Arrange -- undefined seed simulates missing KMS environment
    const badSeed = undefined as unknown as Uint8Array;

    // Act & Assert -- must throw KmsIdentityError (not TypeError or random fallback)
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(KmsIdentityError);

    // Assert -- error message is actionable per AC #5 (/KMS|seed|unavailable/i)
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(/KMS|seed|unavailable/i);
  });

  it('T-4.4-05c: empty Uint8Array (0 bytes) throws KmsIdentityError', () => {
    // Arrange -- zero-length array is not a valid 32-byte seed
    const badSeed = new Uint8Array(0);

    // Act & Assert -- throws KmsIdentityError with descriptive message
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(KmsIdentityError);
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(/seed|32/i);
  });

  it('T-4.4-05d: wrong-length Uint8Array (16 bytes) throws KmsIdentityError', () => {
    // Arrange -- 16-byte array is not a valid 32-byte seed
    const badSeed = new Uint8Array(16);

    // Act & Assert -- throws KmsIdentityError with descriptive message
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(KmsIdentityError);
    expect(() => deriveFromKmsSeed(badSeed)).toThrow(/seed|32/i);
  });
});

// ---------------------------------------------------------------------------
// AC #1 gap: keypair format validation from raw seed path
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- keypair format (AC #1)', () => {
  it('secretKey is exactly 32 bytes', () => {
    const { secretKey } = deriveFromKmsSeed(TEST_KMS_SEED);
    expect(secretKey).toBeInstanceOf(Uint8Array);
    expect(secretKey.length).toBe(32);
  });

  it('pubkey is a 64-char lowercase hex string (x-only Schnorr)', () => {
    const { pubkey } = deriveFromKmsSeed(TEST_KMS_SEED);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// AC #2 gap: mnemonic takes precedence over raw seed
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- mnemonic precedence (AC #2)', () => {
  it('mnemonic takes precedence over raw seed when both are provided', () => {
    // Arrange -- derive from raw seed alone
    const fromSeed = deriveFromKmsSeed(TEST_KMS_SEED);

    // Act -- derive with mnemonic (should ignore the raw seed)
    const fromMnemonicResult = deriveFromKmsSeed(TEST_KMS_SEED, {
      mnemonic: TEST_MNEMONIC,
    });

    // Assert -- mnemonic result matches the known mnemonic pubkey, not the seed pubkey
    expect(fromMnemonicResult.pubkey).toBe(EXPECTED_ABANDON_PUBKEY);
    expect(fromMnemonicResult.pubkey).not.toBe(fromSeed.pubkey);
  });
});

// ---------------------------------------------------------------------------
// AC #2 gap: accountIndex option
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- accountIndex option (AC #2)', () => {
  it('accountIndex=1 produces a different key than accountIndex=0', () => {
    // Arrange & Act
    const index0 = deriveFromKmsSeed(TEST_KMS_SEED, { accountIndex: 0 });
    const index1 = deriveFromKmsSeed(TEST_KMS_SEED, { accountIndex: 1 });

    // Assert -- different indices produce different keys
    expect(index0.pubkey).not.toBe(index1.pubkey);
    expect(index0.secretKey).not.toEqual(index1.secretKey);
  });

  it('default accountIndex is 0 (omitting it is equivalent to passing 0)', () => {
    // Arrange & Act
    const withDefault = deriveFromKmsSeed(TEST_KMS_SEED);
    const withExplicitZero = deriveFromKmsSeed(TEST_KMS_SEED, {
      accountIndex: 0,
    });

    // Assert -- identical results
    expect(withDefault.pubkey).toBe(withExplicitZero.pubkey);
    expect(withDefault.secretKey).toEqual(withExplicitZero.secretKey);
  });
});

// ---------------------------------------------------------------------------
// AC #2 gap: invalid mnemonic throws KmsIdentityError
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- invalid mnemonic (AC #2)', () => {
  it('invalid mnemonic string throws KmsIdentityError', () => {
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, {
        mnemonic: 'not a valid mnemonic phrase at all',
      })
    ).toThrow(KmsIdentityError);
  });

  it('error message mentions mnemonic', () => {
    // Act & Assert -- error message should mention "mnemonic" for operator clarity
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, { mnemonic: 'foo bar baz' })
    ).toThrow(KmsIdentityError);
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, { mnemonic: 'foo bar baz' })
    ).toThrow(/mnemonic/i);
  });

  it('empty string mnemonic throws KmsIdentityError (not silent fallback to raw seed)', () => {
    // An empty mnemonic from e.g. an unset env var must not silently use
    // the raw seed -- that would produce a different identity without warning.
    expect(() => deriveFromKmsSeed(TEST_KMS_SEED, { mnemonic: '' })).toThrow(
      KmsIdentityError
    );
    expect(() => deriveFromKmsSeed(TEST_KMS_SEED, { mnemonic: '' })).toThrow(
      /mnemonic/i
    );
  });

  it('whitespace-only mnemonic throws KmsIdentityError (env var edge case)', () => {
    // Environment variables can contain trailing whitespace or newlines.
    // A whitespace-only mnemonic must not silently fall back to raw seed.
    expect(() => deriveFromKmsSeed(TEST_KMS_SEED, { mnemonic: '   ' })).toThrow(
      KmsIdentityError
    );
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, { mnemonic: '\t\n' })
    ).toThrow(KmsIdentityError);
  });
});

// ---------------------------------------------------------------------------
// AC #5 gap: invalid accountIndex validation
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- invalid accountIndex (AC #5)', () => {
  it('negative accountIndex throws KmsIdentityError', () => {
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, { accountIndex: -1 })
    ).toThrow(KmsIdentityError);
  });

  it('float accountIndex throws KmsIdentityError', () => {
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, { accountIndex: 1.5 })
    ).toThrow(KmsIdentityError);
  });

  it('accountIndex exceeding MAX_BIP32_INDEX throws KmsIdentityError', () => {
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, { accountIndex: 0x80000000 })
    ).toThrow(KmsIdentityError);
  });

  it('accountIndex at MAX_BIP32_INDEX (0x7FFFFFFF) succeeds', () => {
    // Arrange & Act -- 2^31 - 1 is the maximum valid non-hardened BIP-32 index
    const result = deriveFromKmsSeed(TEST_KMS_SEED, {
      accountIndex: 0x7fffffff,
    });

    // Assert -- produces a valid keypair
    expect(result.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.secretKey).toBeInstanceOf(Uint8Array);
    expect(result.secretKey.length).toBe(32);
  });

  it('error message for invalid accountIndex is descriptive', () => {
    // Act & Assert -- error message should mention "accountIndex" for clarity
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, { accountIndex: -5 })
    ).toThrow(KmsIdentityError);
    expect(() =>
      deriveFromKmsSeed(TEST_KMS_SEED, { accountIndex: -5 })
    ).toThrow(/accountIndex/i);
  });
});

// ---------------------------------------------------------------------------
// AC #6: export verification (static analysis)
// ---------------------------------------------------------------------------
describe('KMS identity -- export verification (AC #6)', () => {
  it('deriveFromKmsSeed is a function', () => {
    expect(typeof deriveFromKmsSeed).toBe('function');
  });

  it('KmsIdentityError is a class extending Error', () => {
    const err = new KmsIdentityError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KmsIdentityError);
    expect(err.name).toBe('KmsIdentityError');
  });

  it('KmsIdentityError has code property KMS_IDENTITY_ERROR', () => {
    const err = new KmsIdentityError('test');
    expect(err.code).toBe('KMS_IDENTITY_ERROR');
  });

  it('KmsIdentityError accepts optional cause parameter', () => {
    const cause = new Error('root cause');
    const err = new KmsIdentityError('wrapped', cause);
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// AC #6 gap: top-level @crosstown/core exports include identity module
// ---------------------------------------------------------------------------
describe('KMS identity -- barrel export verification (AC #6)', () => {
  it('identity/index.ts re-exports deriveFromKmsSeed and KmsIdentityError', async () => {
    // Dynamic import of the identity barrel to confirm re-exports
    const identityModule = await import('./index.js');
    expect(identityModule.deriveFromKmsSeed).toBe(deriveFromKmsSeed);
    expect(identityModule.KmsIdentityError).toBe(KmsIdentityError);
  });

  it('top-level core index re-exports identity module', async () => {
    // Dynamic import of the top-level core barrel
    const coreModule = await import('../index.js');
    expect(coreModule.deriveFromKmsSeed).toBe(deriveFromKmsSeed);
    expect(coreModule.KmsIdentityError).toBe(KmsIdentityError);
  });
});

// ---------------------------------------------------------------------------
// Defensive copy: mutating returned secretKey does not affect later derivations
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- defensive copy', () => {
  it('mutating the returned secretKey does not affect subsequent derivations', () => {
    // Arrange -- derive keypair
    const first = deriveFromKmsSeed(TEST_KMS_SEED);
    const originalPubkey = first.pubkey;

    // Act -- mutate the returned secretKey
    first.secretKey.fill(0xff);

    // Assert -- new derivation still returns the correct key
    const second = deriveFromKmsSeed(TEST_KMS_SEED);
    expect(second.pubkey).toBe(originalPubkey);
    expect(second.secretKey).not.toEqual(first.secretKey);
  });
});

// ---------------------------------------------------------------------------
// SDK cross-compatibility: same mnemonic produces same pubkey as SDK identity
// ---------------------------------------------------------------------------
describe('deriveFromKmsSeed -- SDK cross-compatibility', () => {
  it('mnemonic derivation produces the same pubkey as SDK fromMnemonic() for abandon vector', () => {
    // This test confirms that deriveFromKmsSeed with mnemonic produces
    // identical output to the SDK's fromMnemonic() -- verified via the
    // golden value which has been independently computed and confirmed
    // against the SDK test suite.
    const { pubkey } = deriveFromKmsSeed(TEST_KMS_SEED, {
      mnemonic: TEST_MNEMONIC,
    });

    expect(pubkey).toBe(EXPECTED_ABANDON_PUBKEY);
  });

  it('official NIP-06 test vector produces expected private key and pubkey', () => {
    // Arrange -- official NIP-06 test vector from nips/06.md
    // Mnemonic: "leader monkey parrot ring guide accident before fence cannon height naive bean"
    // Expected private key: 7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a
    // Expected pubkey: 17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917
    const nip06Mnemonic =
      'leader monkey parrot ring guide accident before fence cannon height naive bean';
    const expectedPrivkeyHex =
      '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
    const expectedPubkey =
      '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

    // Act
    const { secretKey, pubkey } = deriveFromKmsSeed(TEST_KMS_SEED, {
      mnemonic: nip06Mnemonic,
    });

    // Assert -- matches the official NIP-06 specification values
    const secretKeyHex = Buffer.from(secretKey).toString('hex');
    expect(secretKeyHex).toBe(expectedPrivkeyHex);
    expect(pubkey).toBe(expectedPubkey);
  });
});
