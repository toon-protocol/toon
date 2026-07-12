/**
 * NIP-59 Gift Wrap Integration for ILP Packets (Story 12.2)
 *
 * Provides privacy-preserving encoding/decoding of swap packets using the
 * NIP-59 three-layer gift wrap construction (rumor -> seal -> gift wrap).
 * Intermediary peers routing ILP packets see only opaque TOON-encoded binary
 * in the data field -- they cannot determine the event kind, sender identity,
 * or swap intent. Only the destination Swap can unwrap and process.
 *
 * Also provides NIP-44 encryption/decryption for FULFILL claim return path
 * (D12-008), using ephemeral keys so intermediaries on the return path see
 * only opaque ciphertext.
 *
 * @module
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent, NostrEvent } from 'nostr-tools/pure';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import {
  encrypt as nip44Encrypt,
  decrypt as nip44Decrypt,
  getConversationKey,
} from 'nostr-tools/nip44';
import {
  encodeEventToToon,
  decodeEventFromToon,
} from '@toon-protocol/core/toon';
import { buildIlpPrepare } from '@toon-protocol/core';
import type { IlpPreparePacket } from '@toon-protocol/core';

import { GiftWrapError } from './errors.js';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** Parameters for {@link wrapSwapPacket}. */
export interface WrapSwapPacketParams {
  /** Unsigned inner event containing swap metadata. */
  rumor: UnsignedEvent;
  /** Sender's secp256k1 secret key. */
  senderSecretKey: Uint8Array;
  /** Swap's compressed hex pubkey (64 chars). */
  recipientPubkey: string;
}

/** Result of {@link wrapSwapPacket}. */
export interface WrapSwapPacketResult {
  /** Fully-formed kind:1059 gift wrap event signed by a fresh ephemeral key. */
  giftWrap: NostrEvent;
  /** The ephemeral pubkey used for the outer gift wrap layer. */
  ephemeralPubkey: string;
}

/** Parameters for {@link unwrapSwapPacket}. */
export interface UnwrapSwapPacketParams {
  /** A kind:1059 gift wrap event. */
  giftWrap: NostrEvent;
  /** Recipient's (Swap's) secret key. */
  recipientSecretKey: Uint8Array;
}

/** Result of {@link unwrapSwapPacket}. */
export interface UnwrapSwapPacketResult {
  /** The decrypted inner rumor (unsigned). */
  rumor: UnsignedEvent;
  /** The sender's real pubkey (extracted from the seal layer). */
  senderPubkey: string;
}

/** Parameters for {@link wrapSwapPacketToToon}. */
export interface WrapSwapPacketToToonParams {
  /** Unsigned inner event containing swap metadata. */
  rumor: UnsignedEvent;
  /** Sender's secp256k1 secret key. */
  senderSecretKey: Uint8Array;
  /** Swap's compressed hex pubkey (64 chars). */
  recipientPubkey: string;
  /** ILP destination address. */
  destination: string;
  /** Payment amount in ILP units (bigint). */
  amount: bigint;
  /**
   * Per-packet expiry. Propagated onto the produced PREPARE as an ISO 8601
   * `expiresAt` string (rolling-swap R7 leg ordering). When omitted, the
   * transport applies its default (timeout-derived, ~30s).
   */
  expiresAt?: Date;
}

/** Result of {@link wrapSwapPacketToToon}. */
export interface WrapSwapPacketToToonResult {
  /** Ready-to-send ILP PREPARE packet with TOON-encoded gift wrap as data. */
  ilpPrepare: IlpPreparePacket;
  /** The ephemeral pubkey used for the outer gift wrap layer. */
  ephemeralPubkey: string;
}

/** Parameters for {@link unwrapSwapPacketFromToon}. */
export interface UnwrapSwapPacketFromToonParams {
  /** The data field from an incoming ILP PREPARE (TOON-encoded gift wrap). */
  toonData: Uint8Array;
  /** Recipient's (Swap's) secret key. */
  recipientSecretKey: Uint8Array;
}

/** Parameters for {@link encryptFulfillClaim}. */
export interface EncryptFulfillClaimParams {
  /** The signed claim bytes to encrypt. */
  claimData: Uint8Array;
  /** The original sender's pubkey (recovered from unwrap). */
  senderPubkey: string;
}

/** Result of {@link encryptFulfillClaim}. */
export interface EncryptFulfillClaimResult {
  /** NIP-44 encrypted claim bytes. */
  ciphertext: Uint8Array;
  /** The Swap's ephemeral pubkey (included in FULFILL so sender can decrypt). */
  ephemeralPubkey: string;
}

/** Parameters for {@link decryptFulfillClaim}. */
export interface DecryptFulfillClaimParams {
  /** The encrypted claim bytes from the FULFILL data field. */
  ciphertext: Uint8Array;
  /** The Swap's ephemeral pubkey from the FULFILL data field. */
  ephemeralPubkey: string;
  /** The sender's (recipient of FULFILL) secret key. */
  recipientSecretKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/** Validate a 32-byte secret key. */
function validateSecretKey(key: Uint8Array, paramName: string): void {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new GiftWrapError(
      `${paramName} must be a 32-byte Uint8Array, got ${key instanceof Uint8Array ? `${key.length} bytes` : typeof key}`
    );
  }
}

/** Validate a 64-char lowercase hex pubkey. */
function validatePubkey(pubkey: string, paramName: string): void {
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new GiftWrapError(
      `${paramName} must be a 64-character lowercase hex string`
    );
  }
}

// ---------------------------------------------------------------------------
// Core wrap/unwrap functions (AC-1, AC-2)
// ---------------------------------------------------------------------------

/**
 * NIP-59 three-layer gift wrap a swap packet.
 *
 * Constructs a kind:1059 gift wrap event using a fresh ephemeral keypair.
 * The rumor is sealed with the sender's real key, then wrapped with the
 * ephemeral key. Intermediaries see only the ephemeral pubkey.
 *
 * Each invocation generates a fresh ephemeral keypair for forward secrecy
 * and message unlinkability (risk R-006).
 *
 * @throws {GiftWrapError} If the wrap operation fails (invalid keys, crypto failure).
 */
export function wrapSwapPacket(
  params: WrapSwapPacketParams
): WrapSwapPacketResult {
  const { rumor, senderSecretKey, recipientPubkey } = params;

  validateSecretKey(senderSecretKey, 'senderSecretKey');
  validatePubkey(recipientPubkey, 'recipientPubkey');

  try {
    // Use nostr-tools nip59 building blocks so we can capture the ephemeral pubkey.
    // Step 1: Create rumor (adds id + pubkey derived from senderSecretKey)
    const rumorEvent = createRumor(rumor, senderSecretKey);

    // Step 2: Create seal (kind:13, NIP-44 encrypted rumor, randomized timestamp)
    const seal = createSeal(rumorEvent, senderSecretKey, recipientPubkey);

    // Step 3: Create gift wrap (kind:1059, fresh ephemeral key, NIP-44 encrypted seal)
    const giftWrap = createWrap(seal, recipientPubkey);

    // The ephemeral pubkey is the pubkey on the gift wrap event
    const ephemeralPubkey = giftWrap.pubkey;

    return { giftWrap, ephemeralPubkey };
  } catch (error) {
    throw new GiftWrapError(
      `Failed to wrap swap packet: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Unwrap a NIP-59 gift-wrapped swap packet, recovering the inner rumor
 * and the sender's real pubkey.
 *
 * Performs two-layer decryption: gift wrap -> seal -> rumor.
 * The sender pubkey is extracted from the seal's pubkey field.
 *
 * @throws {GiftWrapError} If kind is not 1059, decryption fails, or structure is malformed.
 */
export function unwrapSwapPacket(
  params: UnwrapSwapPacketParams
): UnwrapSwapPacketResult {
  const { giftWrap, recipientSecretKey } = params;

  validateSecretKey(recipientSecretKey, 'recipientSecretKey');

  // Guard against null/undefined/non-object giftWrap before property access
  if (!giftWrap || typeof giftWrap !== 'object') {
    throw new GiftWrapError('giftWrap must be a non-null object');
  }

  // Validate kind before attempting decryption
  if (giftWrap.kind !== 1059) {
    throw new GiftWrapError('Expected kind:1059 gift wrap');
  }

  let conversationKey1: Uint8Array | null = null;
  let conversationKey2: Uint8Array | null = null;

  try {
    // Layer 1: Decrypt the gift wrap to recover the seal.
    // The gift wrap was encrypted with ECDH(ephemeralPrivkey, recipientPubkey),
    // so we decrypt with ECDH(recipientSecretKey, giftWrap.pubkey).
    conversationKey1 = getConversationKey(recipientSecretKey, giftWrap.pubkey);
    const sealJson = nip44Decrypt(giftWrap.content, conversationKey1);
    const seal = JSON.parse(sealJson) as NostrEvent;

    // Validate seal kind (must be kind:13 per NIP-59)
    if (seal.kind !== 13) {
      throw new GiftWrapError(
        `Expected kind:13 seal inside gift wrap, got kind:${seal.kind}`
      );
    }

    // Extract and validate the sender's real pubkey from the seal
    const senderPubkey = seal.pubkey;
    validatePubkey(senderPubkey, 'seal.pubkey (sender identity)');

    // Layer 2: Decrypt the seal to recover the rumor.
    // The seal was encrypted with ECDH(senderSecretKey, recipientPubkey),
    // so we decrypt with ECDH(recipientSecretKey, senderPubkey).
    conversationKey2 = getConversationKey(recipientSecretKey, senderPubkey);
    const rumorJson = nip44Decrypt(seal.content, conversationKey2);
    const rumor = JSON.parse(rumorJson) as UnsignedEvent & {
      id?: string;
      sig?: string;
    };

    // Strip sig if present (rumor should be unsigned)
    delete rumor.sig;

    return { rumor, senderPubkey };
  } catch (error) {
    if (error instanceof GiftWrapError) {
      throw error;
    }
    throw new GiftWrapError(
      `Failed to unwrap swap packet: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  } finally {
    // Zero ECDH-derived conversation keys (defense-in-depth)
    if (conversationKey1) {
      conversationKey1.fill(0);
      conversationKey1 = null;
    }
    if (conversationKey2) {
      conversationKey2.fill(0);
      conversationKey2 = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers for TOON + ILP integration (AC-3, AC-4)
// ---------------------------------------------------------------------------

/**
 * Convenience: gift wrap a swap packet, encode to TOON binary, and build
 * an ILP PREPARE packet.
 *
 * This is the path that `streamSwap()` (Story 12.5) will use in its
 * per-packet loop.
 */
export function wrapSwapPacketToToon(
  params: WrapSwapPacketToToonParams
): WrapSwapPacketToToonResult {
  const {
    rumor,
    senderSecretKey,
    recipientPubkey,
    destination,
    amount,
    expiresAt,
  } = params;

  // Step 1: Gift wrap
  const { giftWrap, ephemeralPubkey } = wrapSwapPacket({
    rumor,
    senderSecretKey,
    recipientPubkey,
  });

  // Step 2: Encode to TOON binary
  const toonBinary = encodeEventToToon(giftWrap);

  // Step 3: Build ILP PREPARE packet
  const ilpPrepare = buildIlpPrepare({
    destination,
    amount,
    data: toonBinary,
    expiresAt,
  });

  return { ilpPrepare, ephemeralPubkey };
}

/**
 * Convenience: decode TOON binary from an incoming ILP PREPARE data field
 * and unwrap the gift-wrapped swap packet.
 *
 * This is the path that the Swap handler (Story 12.3) will use to process
 * incoming swap packets.
 */
export function unwrapSwapPacketFromToon(
  params: UnwrapSwapPacketFromToonParams
): UnwrapSwapPacketResult {
  const { toonData, recipientSecretKey } = params;

  if (!(toonData instanceof Uint8Array) || toonData.length === 0) {
    throw new GiftWrapError('toonData must be a non-empty Uint8Array');
  }

  try {
    // Step 1: Decode TOON binary to NostrEvent
    const giftWrap = decodeEventFromToon(toonData);

    // Step 2: Unwrap
    return unwrapSwapPacket({ giftWrap, recipientSecretKey });
  } catch (error) {
    if (error instanceof GiftWrapError) {
      throw error;
    }
    throw new GiftWrapError(
      `Failed to unwrap swap packet from TOON: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
}

// ---------------------------------------------------------------------------
// FULFILL encryption/decryption (AC-5, AC-6)
// ---------------------------------------------------------------------------

/**
 * Encrypt a FULFILL claim for the return path (D12-008).
 *
 * Generates a fresh ephemeral keypair and NIP-44 encrypts the claim data.
 * The ephemeral pubkey is included alongside the ciphertext so the sender
 * can decrypt. The ephemeral privkey is discarded after encryption.
 *
 * @throws {GiftWrapError} If claimData is empty or encryption fails.
 */
export function encryptFulfillClaim(
  params: EncryptFulfillClaimParams
): EncryptFulfillClaimResult {
  const { claimData, senderPubkey } = params;

  validatePubkey(senderPubkey, 'senderPubkey');

  if (!(claimData instanceof Uint8Array)) {
    throw new GiftWrapError(
      `claimData must be a Uint8Array, got ${typeof claimData}`
    );
  }

  if (claimData.length === 0) {
    throw new GiftWrapError('claimData must not be empty');
  }

  // Generate fresh ephemeral keypair (let-scoped for GC after return)
  let ephemeralSecretKey: Uint8Array | null = generateSecretKey();
  const ephemeralPubkey = getPublicKey(ephemeralSecretKey);
  let conversationKey: Uint8Array | null = null;

  try {
    // NIP-44 encrypt: ECDH(ephemeralPrivkey, senderPubkey)
    conversationKey = getConversationKey(ephemeralSecretKey, senderPubkey);

    // NIP-44 encrypts strings, so base64-encode the claim bytes
    const claimString = Buffer.from(claimData).toString('base64');
    const ciphertextString = nip44Encrypt(claimString, conversationKey);

    // Convert ciphertext string to Uint8Array for transport
    const ciphertext = new TextEncoder().encode(ciphertextString);

    return { ciphertext, ephemeralPubkey };
  } catch (error) {
    if (error instanceof GiftWrapError) {
      throw error;
    }
    throw new GiftWrapError(
      `Failed to encrypt FULFILL claim: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  } finally {
    // Zero sensitive key material before releasing for GC (defense-in-depth)
    if (ephemeralSecretKey) {
      ephemeralSecretKey.fill(0);
      ephemeralSecretKey = null;
    }
    if (conversationKey) {
      conversationKey.fill(0);
      conversationKey = null;
    }
  }
}

/**
 * Decrypt a FULFILL claim from the return path.
 *
 * Uses the sender's secret key and the Swap's ephemeral pubkey (from the
 * FULFILL data field) to NIP-44 decrypt the claim bytes.
 *
 * @throws {GiftWrapError} If decryption fails (wrong key, malformed ciphertext).
 */
export function decryptFulfillClaim(
  params: DecryptFulfillClaimParams
): Uint8Array {
  const { ciphertext, ephemeralPubkey, recipientSecretKey } = params;

  validateSecretKey(recipientSecretKey, 'recipientSecretKey');
  validatePubkey(ephemeralPubkey, 'ephemeralPubkey');

  if (!(ciphertext instanceof Uint8Array) || ciphertext.length === 0) {
    throw new GiftWrapError('ciphertext must be a non-empty Uint8Array');
  }

  let conversationKey: Uint8Array | null = null;

  try {
    // NIP-44 decrypt: ECDH(recipientSecretKey, ephemeralPubkey)
    conversationKey = getConversationKey(recipientSecretKey, ephemeralPubkey);

    // Convert ciphertext Uint8Array back to string
    const ciphertextString = new TextDecoder().decode(ciphertext);

    // NIP-44 decrypt returns a string (base64-encoded claim bytes)
    const claimString = nip44Decrypt(ciphertextString, conversationKey);

    // Decode base64 back to Uint8Array
    return new Uint8Array(Buffer.from(claimString, 'base64'));
  } catch (error) {
    if (error instanceof GiftWrapError) {
      throw error;
    }
    throw new GiftWrapError(
      `Failed to decrypt FULFILL claim: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  } finally {
    // Zero ECDH-derived conversation key (defense-in-depth)
    if (conversationKey) {
      conversationKey.fill(0);
      conversationKey = null;
    }
  }
}
