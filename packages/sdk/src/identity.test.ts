import { describe, it, expect } from 'vitest';
import { generateMnemonic, fromMnemonic, fromSecretKey } from './identity.js';
import { IdentityError } from './errors.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { getPublicKey } from 'nostr-tools/pure';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';

/**
 * Known test vector for NIP-06 derivation.
 * Mnemonic: "leader monkey parrot ring guide accident before fence cannon height naive bean"
 * Path: m/44'/1237'/0'/0/0
 * This is the standard NIP-06 test vector from https://github.com/nostr-protocol/nips/blob/master/06.md
 */
const NIP06_TEST_MNEMONIC =
  'leader monkey parrot ring guide accident before fence cannon height naive bean';

/**
 * Expected secret key (hex) for the standard NIP-06 test vector at path m/44'/1237'/0'/0/0.
 * Source: https://github.com/nostr-protocol/nips/blob/master/06.md
 */
const EXPECTED_PRIVKEY_HEX =
  '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';

/**
 * General-purpose test mnemonic (BIP-39 "all abandon" vector).
 * Used for format validation, roundtrip, and derivation path tests.
 */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * Expected EVM address (EIP-55 checksummed) for the NIP-06 test vector at path m/44'/1237'/0'/0/0.
 * Derived from private key 7f7ff03...1ccba9a via Keccak-256 of uncompressed secp256k1 pubkey.
 */
const EXPECTED_NIP06_EVM_ADDRESS = '0x25bF1D7CcDb07C1216FB4B4daf6fc08646902e30';

/**
 * Expected pubkey (x-only Schnorr, 64 lowercase hex) for the NIP-06 test vector.
 */
const EXPECTED_NIP06_PUBKEY =
  '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

describe('Identity', () => {
  describe('generateMnemonic()', () => {
    it('[P0] should return a valid 12-word BIP-39 mnemonic', () => {
      // Arrange
      // (no setup needed)

      // Act
      const mnemonic = generateMnemonic();

      // Assert
      const words = mnemonic.split(' ');
      expect(words).toHaveLength(12);
      expect(validateMnemonic(mnemonic, wordlist)).toBe(true);
    });

    it('[P1] should generate different mnemonics on successive calls', () => {
      // Arrange
      // (no setup needed)

      // Act
      const mnemonic1 = generateMnemonic();
      const mnemonic2 = generateMnemonic();

      // Assert
      expect(mnemonic1).not.toBe(mnemonic2);
    });
  });

  describe('fromMnemonic()', () => {
    it("[P0] should derive secretKey at NIP-06 path m/44'/1237'/0'/0/0 matching known test vector", () => {
      // Arrange -- use the official NIP-06 test vector mnemonic
      const mnemonic = NIP06_TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert
      const secretKeyHex = Buffer.from(identity.secretKey).toString('hex');
      expect(secretKeyHex).toBe(EXPECTED_PRIVKEY_HEX);
    });

    it('[P0] should return a pubkey that is 64 lowercase hex characters', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert
      expect(identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('[P0] should return an evmAddress that is 0x + 40 hex characters', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert
      expect(identity.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('[P0] should derive the correct x-only pubkey from the known test vector', () => {
      // Arrange -- use the official NIP-06 test vector mnemonic
      const mnemonic = NIP06_TEST_MNEMONIC;
      const expectedSecretKey = Uint8Array.from(
        Buffer.from(EXPECTED_PRIVKEY_HEX, 'hex')
      );
      const expectedPubkey = getPublicKey(expectedSecretKey);

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert
      expect(identity.pubkey).toBe(expectedPubkey);
    });

    it('[P0] T-1.1-05: Cross-library roundtrip -- sign with derived key, verify with nostr-tools', () => {
      // Arrange
      const identity = fromMnemonic(TEST_MNEMONIC);

      // Act -- create and sign a Nostr event using the derived key
      const unsignedEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'Hello from crosstown SDK identity test',
      };
      const signedEvent = finalizeEvent(unsignedEvent, identity.secretKey);

      // Assert -- verify the signed event using nostr-tools
      expect(signedEvent.pubkey).toBe(identity.pubkey);
      expect(verifyEvent(signedEvent)).toBe(true);
    });

    it('[P1] should use accountIndex to change derivation path', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act
      const identity0 = fromMnemonic(mnemonic, { accountIndex: 0 });
      const identity3 = fromMnemonic(mnemonic, { accountIndex: 3 });

      // Assert
      expect(identity0.secretKey).not.toEqual(identity3.secretKey);
      expect(identity0.pubkey).not.toBe(identity3.pubkey);
      expect(identity0.evmAddress).not.toBe(identity3.evmAddress);
    });

    it('[P1] should default to accountIndex 0 when not specified', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act
      const identityDefault = fromMnemonic(mnemonic);
      const identityExplicit = fromMnemonic(mnemonic, { accountIndex: 0 });

      // Assert
      expect(Buffer.from(identityDefault.secretKey).toString('hex')).toBe(
        Buffer.from(identityExplicit.secretKey).toString('hex')
      );
      expect(identityDefault.pubkey).toBe(identityExplicit.pubkey);
      expect(identityDefault.evmAddress).toBe(identityExplicit.evmAddress);
    });

    it('[P1] T-1.1-09: should accept a 24-word mnemonic and produce valid identity', () => {
      // Arrange -- a valid 24-word BIP-39 mnemonic (256-bit entropy)
      const mnemonic24 =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

      // Act
      const identity = fromMnemonic(mnemonic24);

      // Assert
      expect(identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(identity.secretKey).toHaveLength(32);
    });

    it('[P0] should return a NodeIdentity with secretKey as 32-byte Uint8Array (AC #2)', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert -- verify return shape completeness
      expect(identity).toHaveProperty('secretKey');
      expect(identity).toHaveProperty('pubkey');
      expect(identity).toHaveProperty('evmAddress');
      expect(identity.secretKey).toBeInstanceOf(Uint8Array);
      expect(identity.secretKey).toHaveLength(32);
    });

    it('[P0] should derive the correct EVM address from the NIP-06 test vector (AC #4)', () => {
      // Arrange -- use the official NIP-06 test vector mnemonic
      const mnemonic = NIP06_TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert -- verify against independently computed EIP-55 checksummed address
      expect(identity.evmAddress).toBe(EXPECTED_NIP06_EVM_ADDRESS);
    });

    it('[P0] should derive the correct pubkey from the NIP-06 test vector (AC #3)', () => {
      // Arrange -- use the official NIP-06 test vector mnemonic
      const mnemonic = NIP06_TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert -- verify against independently computed x-only Schnorr pubkey
      expect(identity.pubkey).toBe(EXPECTED_NIP06_PUBKEY);
    });

    it('[P1] T-1.1-10: should throw IdentityError for invalid mnemonic', () => {
      // Arrange
      const invalidMnemonic = 'invalid words here that are not a real mnemonic';

      // Act & Assert
      expect(() => fromMnemonic(invalidMnemonic)).toThrow(IdentityError);
      expect(() => fromMnemonic(invalidMnemonic)).toThrow(
        /Invalid BIP-39 mnemonic/
      );
    });

    it('[P1] should throw IdentityError with code IDENTITY_ERROR for invalid mnemonic (AC #9)', () => {
      // Arrange
      const invalidMnemonic = 'not a valid mnemonic phrase at all here';

      // Act & Assert -- verify both the error type and the error code
      try {
        fromMnemonic(invalidMnemonic);
        expect.fail('Expected IdentityError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(IdentityError);
        expect((error as IdentityError).code).toBe('IDENTITY_ERROR');
      }
    });

    it('[P1] should throw IdentityError for empty string mnemonic (AC #9)', () => {
      // Arrange
      const emptyMnemonic = '';

      // Act & Assert
      expect(() => fromMnemonic(emptyMnemonic)).toThrow(IdentityError);
    });
  });

  describe('fromSecretKey()', () => {
    it('[P0] should derive pubkey and evmAddress from a 32-byte secret key', () => {
      // Arrange
      const secretKey = Uint8Array.from(
        Buffer.from(EXPECTED_PRIVKEY_HEX, 'hex')
      );
      const expectedPubkey = getPublicKey(secretKey);

      // Act
      const identity = fromSecretKey(secretKey);

      // Assert
      expect(identity.pubkey).toBe(expectedPubkey);
      expect(identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('[P1] should produce consistent results across calls with same key', () => {
      // Arrange
      const secretKey = Uint8Array.from(
        Buffer.from(EXPECTED_PRIVKEY_HEX, 'hex')
      );

      // Act
      const identity1 = fromSecretKey(secretKey);
      const identity2 = fromSecretKey(secretKey);

      // Assert
      expect(identity1.pubkey).toBe(identity2.pubkey);
      expect(identity1.evmAddress).toBe(identity2.evmAddress);
    });

    it('[P0] should match the result of fromMnemonic for the same derived key', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;
      const mnemonicIdentity = fromMnemonic(mnemonic);

      // Act
      const keyIdentity = fromSecretKey(mnemonicIdentity.secretKey);

      // Assert
      expect(keyIdentity.pubkey).toBe(mnemonicIdentity.pubkey);
      expect(keyIdentity.evmAddress).toBe(mnemonicIdentity.evmAddress);
    });

    it('[P1] T-1.1-NEW: should throw IdentityError for invalid secret key length', () => {
      // Arrange -- 16 bytes instead of required 32
      const shortKey = new Uint8Array(16);

      // Act & Assert
      expect(() => fromSecretKey(shortKey)).toThrow(IdentityError);
      expect(() => fromSecretKey(shortKey)).toThrow(
        /expected 32 bytes, got 16 bytes/
      );
    });

    it('[P1] should throw IdentityError with code IDENTITY_ERROR for invalid key (AC #11)', () => {
      // Arrange -- 16 bytes instead of required 32
      const shortKey = new Uint8Array(16);

      // Act & Assert -- verify both the error type and the error code
      try {
        fromSecretKey(shortKey);
        expect.fail('Expected IdentityError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(IdentityError);
        expect((error as IdentityError).code).toBe('IDENTITY_ERROR');
      }
    });

    it('[P1] should throw IdentityError for empty (0-byte) secret key (AC #11)', () => {
      // Arrange
      const emptyKey = new Uint8Array(0);

      // Act & Assert
      expect(() => fromSecretKey(emptyKey)).toThrow(IdentityError);
      expect(() => fromSecretKey(emptyKey)).toThrow(
        /expected 32 bytes, got 0 bytes/
      );
    });

    it('[P1] should throw IdentityError for 64-byte (too long) secret key (AC #11)', () => {
      // Arrange
      const longKey = new Uint8Array(64);

      // Act & Assert
      expect(() => fromSecretKey(longKey)).toThrow(IdentityError);
      expect(() => fromSecretKey(longKey)).toThrow(
        /expected 32 bytes, got 64 bytes/
      );
    });

    it('[P1] should throw IdentityError for null input (runtime type safety)', () => {
      // Arrange -- simulate a JS caller passing null (bypassing TypeScript)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nullKey = null as any;

      // Act & Assert
      expect(() => fromSecretKey(nullKey)).toThrow(IdentityError);
      expect(() => fromSecretKey(nullKey)).toThrow(
        /expected Uint8Array, got null/
      );
    });

    it('[P1] should throw IdentityError for undefined input (runtime type safety)', () => {
      // Arrange -- simulate a JS caller passing undefined (bypassing TypeScript)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const undefinedKey = undefined as any;

      // Act & Assert
      expect(() => fromSecretKey(undefinedKey)).toThrow(IdentityError);
      expect(() => fromSecretKey(undefinedKey)).toThrow(
        /expected Uint8Array, got undefined/
      );
    });

    it('[P1] should throw IdentityError (not raw Error) for invalid secp256k1 scalar', () => {
      // Arrange -- all-zeros is a valid 32-byte buffer but not a valid secp256k1 scalar
      const zeros = new Uint8Array(32);

      // Act & Assert
      expect(() => fromSecretKey(zeros)).toThrow(IdentityError);
    });

    it('[P1] should return a defensive copy of secretKey (mutation isolation)', () => {
      // Arrange
      const secretKey = Uint8Array.from(
        Buffer.from(EXPECTED_PRIVKEY_HEX, 'hex')
      );

      // Act
      const identity = fromSecretKey(secretKey);

      // Assert -- mutating the input should not affect the returned identity
      const originalByte = identity.secretKey[0]!;
      secretKey[0] = 0xff;
      expect(identity.secretKey[0]).toBe(originalByte);

      // Assert -- mutating the returned secretKey should not affect the input
      identity.secretKey[0] = 0x00;
      expect(secretKey[0]).toBe(0xff); // still the mutated value, not affected
    });

    it('[P1] should return a defensive copy of secretKey from fromMnemonic (mutation isolation)', () => {
      // Arrange
      const identity = fromMnemonic(TEST_MNEMONIC);
      const originalFirst = identity.secretKey[0]!;

      // Act -- derive again and check independence
      const identity2 = fromMnemonic(TEST_MNEMONIC);

      // Assert -- mutating one should not affect the other
      identity.secretKey[0] = 0xff;
      expect(identity2.secretKey[0]).toBe(originalFirst);
    });
  });

  describe('fromMnemonic() accountIndex validation', () => {
    it('[P1] should throw IdentityError for negative accountIndex', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act & Assert
      expect(() => fromMnemonic(mnemonic, { accountIndex: -1 })).toThrow(
        IdentityError
      );
      expect(() => fromMnemonic(mnemonic, { accountIndex: -1 })).toThrow(
        /non-negative integer/
      );
    });

    it('[P1] should throw IdentityError for non-integer accountIndex', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act & Assert
      expect(() => fromMnemonic(mnemonic, { accountIndex: 1.5 })).toThrow(
        IdentityError
      );
      expect(() => fromMnemonic(mnemonic, { accountIndex: 1.5 })).toThrow(
        /non-negative integer/
      );
    });

    it('[P1] should throw IdentityError for accountIndex exceeding BIP-32 max (2^31 - 1)', () => {
      // Arrange -- 2^31 is the hardened derivation boundary
      const mnemonic = TEST_MNEMONIC;
      const overflowIndex = 0x80000000; // 2^31

      // Act & Assert
      expect(() =>
        fromMnemonic(mnemonic, { accountIndex: overflowIndex })
      ).toThrow(IdentityError);
      expect(() =>
        fromMnemonic(mnemonic, { accountIndex: overflowIndex })
      ).toThrow(/non-negative integer/);
    });

    it('[P1] should accept accountIndex at BIP-32 max (2^31 - 1)', () => {
      // Arrange -- 2^31 - 1 is the maximum valid non-hardened index
      const mnemonic = TEST_MNEMONIC;
      const maxIndex = 0x7fffffff;

      // Act
      const identity = fromMnemonic(mnemonic, { accountIndex: maxIndex });

      // Assert
      expect(identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(identity.secretKey).toHaveLength(32);
    });
  });
});
