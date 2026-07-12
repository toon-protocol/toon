/**
 * ATDD Tests: NIP-59 Gift Wrap Integration for ILP Packets (Story 12.2)
 *
 * These are acceptance-test-driven development tests that verify the NIP-59
 * gift wrap encode/decode layer for privacy-preserving ILP swap packets.
 *
 * Test IDs map to test-design-epic-12:
 *   T-009: Gift-wrap construction
 *   T-010: Unwrap at destination
 *   T-011: Ephemeral key uniqueness
 *   T-012: Intermediary cannot extract sender identity
 *   T-013: Intermediary cannot determine event kind
 *   T-014: TOON binary roundtrip
 *   T-015: Wrong recipient rejects
 *   T-016: Timestamp randomization
 *   + FULFILL encryption/decryption tests
 *   + Edge cases
 *
 * These tests MUST fail initially (ATDD) — they import functions that
 * do not yet exist. They will pass once Story 12.2 is implemented.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import {
  wrapSwapPacket,
  unwrapSwapPacket,
  wrapSwapPacketToToon,
  unwrapSwapPacketFromToon,
  encryptFulfillClaim,
  decryptFulfillClaim,
} from './gift-wrap.js';
import { GiftWrapError } from './errors.js';
import { ToonError } from '@toon-protocol/core';
import type { NostrEvent, UnsignedEvent } from 'nostr-tools/pure';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Sender keypair (Alice — the swap client). */
let senderSecretKey: Uint8Array;
let senderPubkey: string;

/** Recipient keypair (Bob — the Swap). */
let recipientSecretKey: Uint8Array;
let recipientPubkey: string;

/** Third-party keypair (Eve — intermediary/eavesdropper). */
let thirdPartySecretKey: Uint8Array;

/** A minimal unsigned rumor event for swap metadata. */
function createTestRumor(content = 'test swap metadata'): UnsignedEvent {
  return {
    kind: 10032,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['pair', 'ETH/USDC']],
    content,
    pubkey: senderPubkey,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  senderSecretKey = generateSecretKey();
  senderPubkey = getPublicKey(senderSecretKey);

  recipientSecretKey = generateSecretKey();
  recipientPubkey = getPublicKey(recipientSecretKey);

  thirdPartySecretKey = generateSecretKey();
});

// ---------------------------------------------------------------------------
// AC-1: wrapSwapPacket()
// ---------------------------------------------------------------------------

describe('wrapSwapPacket() — AC-1', () => {
  it('T-009: produces a kind:1059 gift wrap outer event', () => {
    const rumor = createTestRumor();
    const result = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    expect(result.giftWrap).toBeDefined();
    expect(result.giftWrap.kind).toBe(1059);
    expect(result.ephemeralPubkey).toBeDefined();
    expect(typeof result.ephemeralPubkey).toBe('string');
    expect(result.ephemeralPubkey).toHaveLength(64);
  });

  it('T-009: gift wrap outer event is signed (has sig and id)', () => {
    const rumor = createTestRumor();
    const result = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    expect(result.giftWrap.sig).toBeDefined();
    expect(typeof result.giftWrap.sig).toBe('string');
    expect(result.giftWrap.id).toBeDefined();
    expect(typeof result.giftWrap.id).toBe('string');
  });

  it('T-009: gift wrap outer event has p tag with recipientPubkey', () => {
    const rumor = createTestRumor();
    const result = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    const pTags = result.giftWrap.tags.filter((t) => t[0] === 'p');
    expect(pTags.length).toBeGreaterThanOrEqual(1);
    expect(pTags.some((t) => t[1] === recipientPubkey)).toBe(true);
  });

  it('T-009: gift wrap pubkey is the ephemeral key (not sender key)', () => {
    const rumor = createTestRumor();
    const result = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    expect(result.giftWrap.pubkey).toBe(result.ephemeralPubkey);
    expect(result.giftWrap.pubkey).not.toBe(senderPubkey);
  });
});

// ---------------------------------------------------------------------------
// AC-2: unwrapSwapPacket()
// ---------------------------------------------------------------------------

describe('unwrapSwapPacket() — AC-2', () => {
  it('T-010: recovers original rumor content and sender pubkey', () => {
    const rumor = createTestRumor();
    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    const unwrapped = unwrapSwapPacket({
      giftWrap,
      recipientSecretKey,
    });

    expect(unwrapped.senderPubkey).toBe(senderPubkey);
    expect(unwrapped.rumor.content).toBe(rumor.content);
    expect(unwrapped.rumor.kind).toBe(rumor.kind);
    expect(unwrapped.rumor.tags).toEqual(rumor.tags);
  });

  it('T-010: recovered rumor is unsigned (no sig field)', () => {
    const rumor = createTestRumor();
    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    const unwrapped = unwrapSwapPacket({
      giftWrap,
      recipientSecretKey,
    });

    // Rumor should not have sig field (unsigned inner event)
    expect((unwrapped.rumor as Record<string, unknown>)['sig']).toBeUndefined();
  });

  it('T-015: throws GiftWrapError with wrong recipient secret key', () => {
    const rumor = createTestRumor();
    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    expect(() =>
      unwrapSwapPacket({
        giftWrap,
        recipientSecretKey: thirdPartySecretKey,
      })
    ).toThrow(GiftWrapError);
  });

  it('throws GiftWrapError for non-1059 kind event', () => {
    const fakeEvent = {
      kind: 1,
      id: 'deadbeef'.repeat(8),
      pubkey: senderPubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'not a gift wrap',
      sig: 'deadbeef'.repeat(16),
    };

    expect(() =>
      unwrapSwapPacket({
        giftWrap: fakeEvent,
        recipientSecretKey,
      })
    ).toThrow(GiftWrapError);

    expect(() =>
      unwrapSwapPacket({
        giftWrap: fakeEvent,
        recipientSecretKey,
      })
    ).toThrow('Expected kind:1059 gift wrap');
  });

  it('throws GiftWrapError for malformed gift wrap content (garbled ciphertext)', () => {
    const fakeEvent = {
      kind: 1059,
      id: 'deadbeef'.repeat(8),
      pubkey: senderPubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'this is not valid NIP-44 ciphertext',
      sig: 'deadbeef'.repeat(16),
    };

    expect(() =>
      unwrapSwapPacket({
        giftWrap: fakeEvent,
        recipientSecretKey,
      })
    ).toThrow(GiftWrapError);
  });
});

// ---------------------------------------------------------------------------
// AC-1 + T-011: Ephemeral key uniqueness
// ---------------------------------------------------------------------------

describe('Ephemeral key uniqueness — T-011', () => {
  it('T-011: 100 consecutive wraps produce 100 distinct ephemeral pubkeys', () => {
    const rumor = createTestRumor();
    const ephemeralPubkeys = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const result = wrapSwapPacket({
        rumor,
        senderSecretKey,
        recipientPubkey,
      });
      ephemeralPubkeys.add(result.ephemeralPubkey);
    }

    expect(ephemeralPubkeys.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// T-012: Intermediary cannot extract sender identity
// ---------------------------------------------------------------------------

describe('Privacy: intermediary cannot extract sender identity — T-012', () => {
  it('T-012: third-party key cannot decrypt to reveal sender pubkey', () => {
    const rumor = createTestRumor();
    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    // Intermediary only sees the ephemeral pubkey on the outer event
    expect(giftWrap.pubkey).not.toBe(senderPubkey);

    // Attempting to unwrap with a third-party key fails
    expect(() =>
      unwrapSwapPacket({
        giftWrap,
        recipientSecretKey: thirdPartySecretKey,
      })
    ).toThrow(GiftWrapError);
  });
});

// ---------------------------------------------------------------------------
// T-013: Intermediary cannot determine event kind
// ---------------------------------------------------------------------------

describe('Privacy: intermediary cannot determine event kind — T-013', () => {
  it('T-013: outer event content is opaque (encrypted) to non-recipient', () => {
    const rumor = createTestRumor();
    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    // The outer event content is NIP-44 encrypted — parsing as JSON should
    // either fail or not reveal the inner kind:10032 event
    const content = giftWrap.content;
    expect(typeof content).toBe('string');

    // The content should NOT contain the plaintext kind or swap metadata
    expect(content).not.toContain('"kind":10032');
    expect(content).not.toContain('test swap metadata');
    expect(content).not.toContain('ETH/USDC');
  });
});

// ---------------------------------------------------------------------------
// T-016: Timestamp randomization
// ---------------------------------------------------------------------------

describe('Timestamp randomization — T-016', () => {
  it('T-016: gift wrap created_at is <= current time (past-only)', () => {
    const rumor = createTestRumor();
    const now = Math.floor(Date.now() / 1000);

    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    expect(giftWrap.created_at).toBeLessThanOrEqual(now + 1); // +1 for clock drift tolerance
  });

  it('T-016: at least some timestamps differ from real time across multiple wraps', () => {
    const rumor = createTestRumor();
    const timestamps: number[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < 20; i++) {
      const { giftWrap } = wrapSwapPacket({
        rumor,
        senderSecretKey,
        recipientPubkey,
      });
      timestamps.push(giftWrap.created_at);
    }

    // NIP-59 subtracts 0-172800 seconds. At least some should differ from now.
    const differing = timestamps.filter((ts) => Math.abs(now - ts) > 2);
    expect(differing.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-3: wrapSwapPacketToToon() + AC-4: unwrapSwapPacketFromToon()
// ---------------------------------------------------------------------------

describe('wrapSwapPacketToToon() / unwrapSwapPacketFromToon() — AC-3 / AC-4', () => {
  it('T-014: TOON binary roundtrip — wrap to ILP PREPARE, extract, unwrap recovers rumor', () => {
    const rumor = createTestRumor();
    const destination = 'g.toon.swap.swap';
    const amount = 5000000n;

    const { ilpPrepare, ephemeralPubkey } = wrapSwapPacketToToon({
      rumor,
      senderSecretKey,
      recipientPubkey,
      destination,
      amount,
    });

    // ilpPrepare should have the expected shape
    expect(ilpPrepare.destination).toBe(destination);
    expect(ilpPrepare.amount).toBe(String(amount));
    expect(typeof ilpPrepare.data).toBe('string'); // base64
    expect(ephemeralPubkey).toHaveLength(64);

    // Decode the base64 data field back to Uint8Array
    const toonData = Buffer.from(ilpPrepare.data, 'base64');

    // Unwrap from TOON binary
    const unwrapped = unwrapSwapPacketFromToon({
      toonData: new Uint8Array(toonData),
      recipientSecretKey,
    });

    expect(unwrapped.senderPubkey).toBe(senderPubkey);
    expect(unwrapped.rumor.content).toBe(rumor.content);
    expect(unwrapped.rumor.kind).toBe(rumor.kind);
  });

  it('wrapSwapPacketToToon() returns a valid IlpPreparePacket with base64 data', () => {
    const rumor = createTestRumor();

    const { ilpPrepare } = wrapSwapPacketToToon({
      rumor,
      senderSecretKey,
      recipientPubkey,
      destination: 'g.toon.test',
      amount: 1000n,
    });

    expect(ilpPrepare).toHaveProperty('destination');
    expect(ilpPrepare).toHaveProperty('amount');
    expect(ilpPrepare).toHaveProperty('data');

    // Verify data is valid base64
    const decoded = Buffer.from(ilpPrepare.data, 'base64');
    expect(decoded.length).toBeGreaterThan(0);
  });

  it('unwrapSwapPacketFromToon() correctly chains TOON decode + unwrap', () => {
    const rumor = createTestRumor('chained convenience roundtrip');

    const { ilpPrepare } = wrapSwapPacketToToon({
      rumor,
      senderSecretKey,
      recipientPubkey,
      destination: 'g.toon.test',
      amount: 2000n,
    });

    const toonData = new Uint8Array(Buffer.from(ilpPrepare.data, 'base64'));

    const unwrapped = unwrapSwapPacketFromToon({
      toonData,
      recipientSecretKey,
    });

    expect(unwrapped.rumor.content).toBe('chained convenience roundtrip');
    expect(unwrapped.senderPubkey).toBe(senderPubkey);
  });
});

// ---------------------------------------------------------------------------
// AC-5: encryptFulfillClaim() + AC-6: decryptFulfillClaim()
// ---------------------------------------------------------------------------

describe('FULFILL encryption — AC-5 / AC-6', () => {
  it('encryptFulfillClaim() -> decryptFulfillClaim() roundtrip recovers original claim', () => {
    const claimData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const encrypted = encryptFulfillClaim({
      claimData,
      senderPubkey,
    });

    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
    expect(encrypted.ephemeralPubkey).toHaveLength(64);

    const decrypted = decryptFulfillClaim({
      ciphertext: encrypted.ciphertext,
      ephemeralPubkey: encrypted.ephemeralPubkey,
      recipientSecretKey: senderSecretKey,
    });

    expect(decrypted).toEqual(claimData);
  });

  it('FULFILL ephemeral key uniqueness: multiple calls produce distinct keys', () => {
    const claimData = new Uint8Array([42, 43, 44]);
    const ephemeralPubkeys = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const encrypted = encryptFulfillClaim({
        claimData,
        senderPubkey,
      });
      ephemeralPubkeys.add(encrypted.ephemeralPubkey);
    }

    expect(ephemeralPubkeys.size).toBe(10);
  });

  it('FULFILL wrong key rejects: decryptFulfillClaim() with wrong key throws GiftWrapError', () => {
    const claimData = new Uint8Array([99, 100, 101]);

    const encrypted = encryptFulfillClaim({
      claimData,
      senderPubkey,
    });

    expect(() =>
      decryptFulfillClaim({
        ciphertext: encrypted.ciphertext,
        ephemeralPubkey: encrypted.ephemeralPubkey,
        recipientSecretKey: thirdPartySecretKey, // wrong key
      })
    ).toThrow(GiftWrapError);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('empty rumor content: wrapping a rumor with empty content works', () => {
    const rumor = createTestRumor('');

    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    expect(giftWrap.kind).toBe(1059);

    const unwrapped = unwrapSwapPacket({
      giftWrap,
      recipientSecretKey,
    });

    expect(unwrapped.rumor.content).toBe('');
    expect(unwrapped.senderPubkey).toBe(senderPubkey);
  });

  it('large rumor content: wrapping a rumor with >1 KB content works', () => {
    const largeContent = 'x'.repeat(2048);
    const rumor = createTestRumor(largeContent);

    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    expect(giftWrap.kind).toBe(1059);

    const unwrapped = unwrapSwapPacket({
      giftWrap,
      recipientSecretKey,
    });

    expect(unwrapped.rumor.content).toBe(largeContent);
    expect(unwrapped.senderPubkey).toBe(senderPubkey);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('Input validation', () => {
  it('wrapSwapPacket() rejects invalid senderSecretKey (wrong length)', () => {
    const rumor = createTestRumor();
    expect(() =>
      wrapSwapPacket({
        rumor,
        senderSecretKey: new Uint8Array(16), // wrong length
        recipientPubkey,
      })
    ).toThrow(GiftWrapError);
    expect(() =>
      wrapSwapPacket({
        rumor,
        senderSecretKey: new Uint8Array(16),
        recipientPubkey,
      })
    ).toThrow('senderSecretKey must be a 32-byte Uint8Array');
  });

  it('wrapSwapPacket() rejects invalid recipientPubkey (wrong format)', () => {
    const rumor = createTestRumor();
    expect(() =>
      wrapSwapPacket({
        rumor,
        senderSecretKey,
        recipientPubkey: 'not-a-valid-pubkey',
      })
    ).toThrow(GiftWrapError);
    expect(() =>
      wrapSwapPacket({
        rumor,
        senderSecretKey,
        recipientPubkey: 'not-a-valid-pubkey',
      })
    ).toThrow('recipientPubkey must be a 64-character lowercase hex string');
  });

  it('unwrapSwapPacket() rejects invalid recipientSecretKey', () => {
    const rumor = createTestRumor();
    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    expect(() =>
      unwrapSwapPacket({
        giftWrap,
        recipientSecretKey: new Uint8Array(0),
      })
    ).toThrow(GiftWrapError);
  });

  it('decryptFulfillClaim() rejects invalid ephemeralPubkey', () => {
    expect(() =>
      decryptFulfillClaim({
        ciphertext: new Uint8Array([1, 2, 3]),
        ephemeralPubkey: 'UPPERCASE_INVALID',
        recipientSecretKey: senderSecretKey,
      })
    ).toThrow(GiftWrapError);
  });

  it('encryptFulfillClaim() rejects invalid senderPubkey', () => {
    expect(() =>
      encryptFulfillClaim({
        claimData: new Uint8Array([1, 2, 3]),
        senderPubkey: '0x1234',
      })
    ).toThrow(GiftWrapError);
  });

  it('unwrapSwapPacket() rejects null/undefined giftWrap', () => {
    expect(() =>
      unwrapSwapPacket({
        giftWrap: null as unknown as NostrEvent,
        recipientSecretKey,
      })
    ).toThrow(GiftWrapError);
    expect(() =>
      unwrapSwapPacket({
        giftWrap: null as unknown as NostrEvent,
        recipientSecretKey,
      })
    ).toThrow('giftWrap must be a non-null object');
  });

  it('decryptFulfillClaim() rejects empty ciphertext', () => {
    expect(() =>
      decryptFulfillClaim({
        ciphertext: new Uint8Array(0),
        ephemeralPubkey: senderPubkey,
        recipientSecretKey: senderSecretKey,
      })
    ).toThrow(GiftWrapError);
    expect(() =>
      decryptFulfillClaim({
        ciphertext: new Uint8Array(0),
        ephemeralPubkey: senderPubkey,
        recipientSecretKey: senderSecretKey,
      })
    ).toThrow('ciphertext must be a non-empty Uint8Array');
  });

  it('unwrapSwapPacketFromToon() rejects non-Uint8Array toonData', () => {
    expect(() =>
      unwrapSwapPacketFromToon({
        toonData: 'not a uint8array' as unknown as Uint8Array,
        recipientSecretKey,
      })
    ).toThrow(GiftWrapError);
    expect(() =>
      unwrapSwapPacketFromToon({
        toonData: 'not a uint8array' as unknown as Uint8Array,
        recipientSecretKey,
      })
    ).toThrow('toonData must be a non-empty Uint8Array');
  });

  it('encryptFulfillClaim() rejects non-Uint8Array claimData', () => {
    expect(() =>
      encryptFulfillClaim({
        claimData: 'not bytes' as unknown as Uint8Array,
        senderPubkey,
      })
    ).toThrow(GiftWrapError);
    expect(() =>
      encryptFulfillClaim({
        claimData: 'not bytes' as unknown as Uint8Array,
        senderPubkey,
      })
    ).toThrow('claimData must be a Uint8Array');
  });
});

// ---------------------------------------------------------------------------
// AC-7: GiftWrapError class shape
// ---------------------------------------------------------------------------

describe('GiftWrapError class — AC-7', () => {
  it('extends ToonError with code GIFT_WRAP_ERROR', () => {
    const err = new GiftWrapError('test message');
    expect(err).toBeInstanceOf(ToonError);
    expect(err).toBeInstanceOf(GiftWrapError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GiftWrapError');
    expect(err.code).toBe('GIFT_WRAP_ERROR');
    expect(err.message).toBe('test message');
  });

  it('supports cause chaining', () => {
    const cause = new Error('underlying failure');
    const err = new GiftWrapError('wrapped message', cause);
    expect(err.cause).toBe(cause);
    expect(err.code).toBe('GIFT_WRAP_ERROR');
  });
});

// ---------------------------------------------------------------------------
// AC-8: Package exports verification
// ---------------------------------------------------------------------------

describe('Package exports — AC-8', () => {
  it('all gift-wrap functions are importable from the module', async () => {
    const mod = await import('./gift-wrap.js');
    expect(typeof mod.wrapSwapPacket).toBe('function');
    expect(typeof mod.unwrapSwapPacket).toBe('function');
    expect(typeof mod.wrapSwapPacketToToon).toBe('function');
    expect(typeof mod.unwrapSwapPacketFromToon).toBe('function');
    expect(typeof mod.encryptFulfillClaim).toBe('function');
    expect(typeof mod.decryptFulfillClaim).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC-2 additional: recovered rumor has no id field
// ---------------------------------------------------------------------------

describe('unwrapSwapPacket() — rumor unsigned fields', () => {
  it('T-010: recovered rumor has no sig field (unsigned inner event)', () => {
    const rumor = createTestRumor();
    const { giftWrap } = wrapSwapPacket({
      rumor,
      senderSecretKey,
      recipientPubkey,
    });

    const unwrapped = unwrapSwapPacket({
      giftWrap,
      recipientSecretKey,
    });

    // The rumor returned by unwrap should not carry a sig field
    expect((unwrapped.rumor as Record<string, unknown>)['sig']).toBeUndefined();
    // Verify the rumor content is intact
    expect(unwrapped.rumor.kind).toBe(10032);
    expect(unwrapped.rumor.content).toBe(rumor.content);
  });
});

// ---------------------------------------------------------------------------
// AC-4 additional: unwrapSwapPacketFromToon error path
// ---------------------------------------------------------------------------

describe('unwrapSwapPacketFromToon() — error paths', () => {
  it('throws GiftWrapError for invalid TOON binary data', () => {
    const invalidToonData = new Uint8Array([0, 1, 2, 3, 4, 5]);

    expect(() =>
      unwrapSwapPacketFromToon({
        toonData: invalidToonData,
        recipientSecretKey,
      })
    ).toThrow(GiftWrapError);
  });

  it('throws GiftWrapError for empty TOON data', () => {
    const emptyToonData = new Uint8Array(0);

    expect(() =>
      unwrapSwapPacketFromToon({
        toonData: emptyToonData,
        recipientSecretKey,
      })
    ).toThrow(GiftWrapError);
  });
});

// ---------------------------------------------------------------------------
// AC-3 additional: wrapSwapPacketToToon with custom expiresAt
// ---------------------------------------------------------------------------

describe('wrapSwapPacketToToon() — expiresAt parameter', () => {
  it('accepts a custom expiresAt date', () => {
    const rumor = createTestRumor();
    const futureDate = new Date(Date.now() + 60_000); // 60s from now

    const { ilpPrepare, ephemeralPubkey } = wrapSwapPacketToToon({
      rumor,
      senderSecretKey,
      recipientPubkey,
      destination: 'g.toon.swap.swap',
      amount: 1000n,
      expiresAt: futureDate,
    });

    expect(ilpPrepare).toBeDefined();
    expect(ilpPrepare.destination).toBe('g.toon.swap.swap');
    expect(ephemeralPubkey).toHaveLength(64);

    // Issue #81: the supplied expiry must survive onto the produced PREPARE
    // (previously buildIlpPrepare silently dropped it).
    expect(ilpPrepare.expiresAt).toBe(futureDate.toISOString());

    // Verify the data still roundtrips
    const toonData = new Uint8Array(Buffer.from(ilpPrepare.data, 'base64'));
    const unwrapped = unwrapSwapPacketFromToon({
      toonData,
      recipientSecretKey,
    });
    expect(unwrapped.senderPubkey).toBe(senderPubkey);
    expect(unwrapped.rumor.content).toBe(rumor.content);
  });

  it('regression: omitting expiresAt leaves the PREPARE without an expiresAt field', () => {
    const rumor = createTestRumor();

    const { ilpPrepare } = wrapSwapPacketToToon({
      rumor,
      senderSecretKey,
      recipientPubkey,
      destination: 'g.toon.swap.swap',
      amount: 1000n,
    });

    // Absent (not undefined-valued) so the transport keeps applying its
    // timeout-derived default expiry.
    expect('expiresAt' in ilpPrepare).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-5 additional: FULFILL with empty claim data
// ---------------------------------------------------------------------------

describe('FULFILL encryption — edge cases', () => {
  it('throws GiftWrapError for empty claim data', () => {
    const emptyClaimData = new Uint8Array(0);

    expect(() =>
      encryptFulfillClaim({
        claimData: emptyClaimData,
        senderPubkey,
      })
    ).toThrow(GiftWrapError);

    expect(() =>
      encryptFulfillClaim({
        claimData: emptyClaimData,
        senderPubkey,
      })
    ).toThrow('claimData must not be empty');
  });

  it('handles large claim data (4 KB)', () => {
    const largeClaimData = new Uint8Array(4096);
    for (let i = 0; i < largeClaimData.length; i++) {
      largeClaimData[i] = i % 256;
    }

    const encrypted = encryptFulfillClaim({
      claimData: largeClaimData,
      senderPubkey,
    });

    const decrypted = decryptFulfillClaim({
      ciphertext: encrypted.ciphertext,
      ephemeralPubkey: encrypted.ephemeralPubkey,
      recipientSecretKey: senderSecretKey,
    });

    expect(decrypted).toEqual(largeClaimData);
  });
});

// ---------------------------------------------------------------------------
// Story 12.9 AC-15 — chain-recipient tag round-trips through the NIP-59 wrap
// / TOON encode / decode / unwrap cycle. The encryption layer treats the
// rumor's tag array as opaque, so this is a one-assertion regression guard
// that prevents an encoder change from silently truncating unknown tags.
// ---------------------------------------------------------------------------

describe('Story 12.9 AC-15 — chain-recipient tag round-trip', () => {
  it('preserves the chain-recipient tag across wrap → TOON encode → decode → unwrap', () => {
    const FIXTURE_EVM_RECIPIENT = '0x' + '11'.repeat(20);
    const rumor: UnsignedEvent = {
      kind: 20032,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      pubkey: senderPubkey,
      tags: [
        ['swap-from', 'USDC:evm:base:8453'],
        ['swap-to', 'ETH:evm:base:8453'],
        ['amount', '1000000'],
        ['seq', '1', '1'],
        ['nonce', 'deadbeef'],
        ['chain-recipient', FIXTURE_EVM_RECIPIENT],
      ],
    };

    const { ilpPrepare } = wrapSwapPacketToToon({
      rumor,
      senderSecretKey,
      recipientPubkey,
      destination: 'g.toon.swap.12_9',
      amount: 1_000_000n,
    });
    const toonData = new Uint8Array(Buffer.from(ilpPrepare.data, 'base64'));
    const { rumor: decoded } = unwrapSwapPacketFromToon({
      toonData,
      recipientSecretKey,
    });

    expect(decoded.tags).toContainEqual([
      'chain-recipient',
      FIXTURE_EVM_RECIPIENT,
    ]);
  });
});
