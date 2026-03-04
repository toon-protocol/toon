import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  fromMnemonic,
  fromSecretKey,
} from './identity.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { getPublicKey } from 'nostr-tools/pure';

// ATDD Red Phase - tests will fail until implementation exists

/**
 * Known test vector for NIP-06 derivation.
 * Mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
 * Path: m/44'/1237'/0'/0/0
 * This is the standard NIP-06 test vector used across the Nostr ecosystem.
 */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * Expected secret key (hex) for the standard NIP-06 test vector at path m/44'/1237'/0'/0/0.
 * Derived via BIP-32 from the standard BIP-39 seed for the "abandon" mnemonic.
 */
const EXPECTED_PRIVKEY_HEX =
  '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';

describe('Identity', () => {
  describe('generateMnemonic()', () => {
    it.skip('[P0] should return a valid 12-word BIP-39 mnemonic', () => {
      // Arrange
      // (no setup needed)

      // Act
      const mnemonic = generateMnemonic();

      // Assert
      const words = mnemonic.split(' ');
      expect(words).toHaveLength(12);
      expect(validateMnemonic(mnemonic, wordlist)).toBe(true);
    });

    it.skip('[P1] should generate different mnemonics on successive calls', () => {
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
    it.skip('[P0] should derive secretKey at NIP-06 path m/44\'/1237\'/0\'/0/0 matching known test vector', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert
      const secretKeyHex = Buffer.from(identity.secretKey).toString('hex');
      expect(secretKeyHex).toBe(EXPECTED_PRIVKEY_HEX);
    });

    it.skip('[P0] should return a pubkey that is 64 lowercase hex characters', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert
      expect(identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it.skip('[P0] should return an evmAddress that is 0x + 40 hex characters', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert
      expect(identity.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it.skip('[P0] should derive the correct x-only pubkey from the known test vector', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;
      const expectedSecretKey = Uint8Array.from(
        Buffer.from(EXPECTED_PRIVKEY_HEX, 'hex')
      );
      const expectedPubkey = getPublicKey(expectedSecretKey);

      // Act
      const identity = fromMnemonic(mnemonic);

      // Assert
      expect(identity.pubkey).toBe(expectedPubkey);
    });

    it.skip('[P1] should use accountIndex to change derivation path', () => {
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

    it.skip('[P1] should default to accountIndex 0 when not specified', () => {
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
  });

  describe('fromSecretKey()', () => {
    it.skip('[P0] should derive pubkey and evmAddress from a 32-byte secret key', () => {
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

    it.skip('[P1] should produce consistent results across calls with same key', () => {
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

    it.skip('[P0] should match the result of fromMnemonic for the same derived key', () => {
      // Arrange
      const mnemonic = TEST_MNEMONIC;
      const mnemonicIdentity = fromMnemonic(mnemonic);

      // Act
      const keyIdentity = fromSecretKey(mnemonicIdentity.secretKey);

      // Assert
      expect(keyIdentity.pubkey).toBe(mnemonicIdentity.pubkey);
      expect(keyIdentity.evmAddress).toBe(mnemonicIdentity.evmAddress);
    });
  });
});
