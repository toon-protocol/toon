import { describe, it, expect } from 'vitest';
import {
  encodeEventToToon,
  encodeEventToToonString,
  decodeEventFromToon,
  ToonDecodeError,
  ToonEncodeError,
  shallowParseToon,
} from './index.js';
import type { ToonRoutingMeta } from './index.js';
import { ToonError } from '../errors.js';
import type { NostrEvent } from 'nostr-tools/pure';

/**
 * Create a test event with optional overrides.
 */
const createTestEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  kind: 1,
  content: 'Hello, world!',
  tags: [],
  created_at: 1234567890,
  sig: 'c'.repeat(128),
  ...overrides,
});

/**
 * Create a kind:0 profile metadata event.
 */
const createProfileEvent = (): NostrEvent => ({
  id: 'd'.repeat(64),
  pubkey: 'e'.repeat(64),
  kind: 0,
  content: JSON.stringify({
    name: 'Alice',
    about: 'Nostr enthusiast',
    picture: 'https://example.com/pic.jpg',
  }),
  tags: [],
  created_at: 1234567890,
  sig: 'f'.repeat(128),
});

/**
 * Create a kind:1 text note event.
 */
const createTextNote = (): NostrEvent => ({
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  kind: 1,
  content: 'Hello, Nostr!',
  tags: [
    ['e', '1'.repeat(64)],
    ['p', '2'.repeat(64)],
  ],
  created_at: 1234567890,
  sig: 'c'.repeat(128),
});

/**
 * Create a kind:3 follow list event with many tags.
 */
const createFollowList = (): NostrEvent => ({
  id: '1'.repeat(64),
  pubkey: '2'.repeat(64),
  kind: 3,
  content: '',
  tags: Array.from({ length: 50 }, (_, i) => [
    'p',
    '3'.repeat(62) + i.toString(16).padStart(2, '0'),
  ]),
  created_at: 1234567890,
  sig: '4'.repeat(128),
});

/**
 * Create a kind:7 reaction event.
 */
const createReactionEvent = (): NostrEvent => ({
  id: '5'.repeat(64),
  pubkey: '6'.repeat(64),
  kind: 7,
  content: '+',
  tags: [
    ['e', '7'.repeat(64)],
    ['p', '8'.repeat(64)],
  ],
  created_at: 1234567890,
  sig: '9'.repeat(128),
});

/**
 * Create a kind:10032 ILP Peer Info event.
 */
const createIlpPeerInfo = (): NostrEvent => ({
  id: 'aa'.repeat(32),
  pubkey: 'bb'.repeat(32),
  kind: 10032,
  content: JSON.stringify({
    ilpAddress: 'g.agent.alice',
    btpEndpoint: 'ws://localhost:8080',
    assetCode: 'USD',
    assetScale: 9,
  }),
  tags: [],
  created_at: 1234567890,
  sig: 'cc'.repeat(64),
});

/**
 * Create a kind:10047 event for TOON round-trip testing.
 */
const createKind10047Event = (): NostrEvent => ({
  id: 'dd'.repeat(32),
  pubkey: 'ee'.repeat(32),
  kind: 10047,
  content: JSON.stringify({
    destination_account: 'g.agent.alice.receiver',
    shared_secret: 'base64secret==',
  }),
  tags: [['d', 'default']],
  created_at: 1234567890,
  sig: 'ff'.repeat(64),
});

describe('TOON Encoding', () => {
  describe('encodeEventToToon', () => {
    it('should encode a simple kind:1 event to Uint8Array', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should encode an event with empty tags', () => {
      const event = createTestEvent({ tags: [] });
      const encoded = encodeEventToToon(event);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should encode an event with multiple tags (#e, #p tags)', () => {
      const event = createTextNote();
      const encoded = encodeEventToToon(event);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should encode an event with special characters in content', () => {
      const event = createTestEvent({
        content: 'Hello\nWorld\t"Quoted"\u{1F600}',
      });
      const encoded = encodeEventToToon(event);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should encode ILP event kind 10032', () => {
      const event = createIlpPeerInfo();
      const encoded = encodeEventToToon(event);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should encode ILP event kind 10047', () => {
      const event = createKind10047Event();
      const encoded = encodeEventToToon(event);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should produce reasonable output size for events with many uniform tags', () => {
      // Create a large follow list with 200 entries to test TOON efficiency
      const largeFollowList: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: '2'.repeat(64),
        kind: 3,
        content: '',
        tags: Array.from({ length: 200 }, (_, i) => [
          'p',
          '3'.repeat(62) + i.toString(16).padStart(2, '0'),
        ]),
        created_at: 1234567890,
        sig: '4'.repeat(128),
      };
      const encoded = encodeEventToToon(largeFollowList);
      const jsonBytes = new TextEncoder().encode(
        JSON.stringify(largeFollowList)
      );
      // TOON encoding should work and produce output
      expect(encoded.length).toBeGreaterThan(0);
      // For very large uniform arrays, TOON should approach or beat JSON size
      // The ratio should be reasonable (within 2x of JSON size)
      expect(encoded.length).toBeLessThan(jsonBytes.length * 2);
    });

    it('should throw ToonEncodeError for circular references', () => {
      // Create an object with circular reference
      const circular: Record<string, unknown> = { id: 'a'.repeat(64) };
      circular['self'] = circular;

      expect(() =>
        encodeEventToToon(circular as unknown as NostrEvent)
      ).toThrow(ToonEncodeError);
    });
  });

  describe('encodeEventToToonString', () => {
    it('should encode a simple kind:1 event to a string', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToonString(event);
      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should produce a string that decodes to the same event when converted to bytes', () => {
      const event = createTestEvent();
      const toonString = encodeEventToToonString(event);
      const bytes = new TextEncoder().encode(toonString);
      const decoded = decodeEventFromToon(bytes);
      expect(decoded).toEqual(event);
    });

    it('should produce a string equivalent to the Uint8Array encoder output', () => {
      const event = createTextNote();
      const toonString = encodeEventToToonString(event);
      const toonBytes = encodeEventToToon(event);
      const bytesFromString = new TextEncoder().encode(toonString);
      expect(bytesFromString).toEqual(toonBytes);
    });

    it('should throw ToonEncodeError for circular references', () => {
      const circular: Record<string, unknown> = { id: 'a'.repeat(64) };
      circular['self'] = circular;

      expect(() =>
        encodeEventToToonString(circular as unknown as NostrEvent)
      ).toThrow(ToonEncodeError);
    });
  });

  describe('decodeEventFromToon', () => {
    it('should decode a simple encoded event', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should decode an event with empty tags', () => {
      const event = createTestEvent({ tags: [] });
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should decode an event with multiple tags', () => {
      const event = createTextNote();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should decode an event with special characters in content', () => {
      const event = createTestEvent({
        content: 'Hello\nWorld\t"Quoted"\u{1F600}',
      });
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should decode ILP event kind 10032', () => {
      const event = createIlpPeerInfo();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should decode ILP event kind 10047', () => {
      const event = createKind10047Event();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should throw ToonError for invalid TOON data', () => {
      const invalidData = new TextEncoder().encode('not valid toon {{{');
      expect(() => decodeEventFromToon(invalidData)).toThrow(ToonError);
    });

    it('should throw ToonError for malformed event (missing id)', () => {
      const event = createTestEvent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, ...eventWithoutId } = event;
      const encoded = encodeEventToToon(
        eventWithoutId as unknown as NostrEvent
      );
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
      expect(() => decodeEventFromToon(encoded)).toThrow(
        'Invalid event id: must be a 64-character hex string'
      );
    });

    it('should throw ToonError for malformed event (missing pubkey)', () => {
      const event = createTestEvent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { pubkey, ...eventWithoutPubkey } = event;
      const encoded = encodeEventToToon(
        eventWithoutPubkey as unknown as NostrEvent
      );
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
    });

    it('should throw ToonError for invalid field types (kind is not a number)', () => {
      const invalidEvent = { ...createTestEvent(), kind: 'not-a-number' };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
      expect(() => decodeEventFromToon(encoded)).toThrow(
        'Invalid event kind: must be an integer'
      );
    });

    it('should throw ToonError for invalid id length', () => {
      const invalidEvent = { ...createTestEvent(), id: 'short' };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
    });

    it('should throw ToonError for invalid sig length', () => {
      const invalidEvent = { ...createTestEvent(), sig: 'short' };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
    });

    it('should throw ToonError for invalid tags (not an array)', () => {
      const invalidEvent = { ...createTestEvent(), tags: 'not-an-array' };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
      expect(() => decodeEventFromToon(encoded)).toThrow(
        'Invalid event tags: must be an array'
      );
    });

    it('should throw ToonError for invalid tag element (not a string)', () => {
      const invalidEvent = { ...createTestEvent(), tags: [['e', 123]] };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
    });
  });

  describe('Round-trip tests', () => {
    it('should round-trip kind:0 (profile metadata) event', () => {
      const event = createProfileEvent();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should round-trip kind:1 (text note) event with content', () => {
      const event = createTextNote();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should round-trip kind:3 (follow list) event with many tags', () => {
      const event = createFollowList();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should round-trip kind:7 (reaction) event', () => {
      const event = createReactionEvent();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should round-trip kind:10032 (ILP Peer Info) event', () => {
      const event = createIlpPeerInfo();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should round-trip kind:10047 event', () => {
      const event = createKind10047Event();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(event);
    });

    it('should preserve event signature through round-trip', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded.sig).toBe(event.sig);
    });

    it('should preserve all 7 event fields through round-trip', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      const decoded = decodeEventFromToon(encoded);

      expect(decoded.id).toBe(event.id);
      expect(decoded.pubkey).toBe(event.pubkey);
      expect(decoded.kind).toBe(event.kind);
      expect(decoded.content).toBe(event.content);
      expect(decoded.tags).toEqual(event.tags);
      expect(decoded.created_at).toBe(event.created_at);
      expect(decoded.sig).toBe(event.sig);
    });
  });

  describe('Shallow parser', () => {
    it('should extract kind from TOON bytes, matching full decode (T-1.0-02)', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      const meta = shallowParseToon(encoded);
      expect(meta.kind).toBe(event.kind);
    });

    it('should extract pubkey from TOON bytes, matching full decode (T-1.0-03)', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      const meta = shallowParseToon(encoded);
      expect(meta.pubkey).toBe(event.pubkey);
    });

    it('should extract id from TOON bytes, matching full decode (T-1.0-04)', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      const meta = shallowParseToon(encoded);
      expect(meta.id).toBe(event.id);
    });

    it('should extract sig from TOON bytes, matching full decode (T-1.0-05)', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      const meta = shallowParseToon(encoded);
      expect(meta.sig).toBe(event.sig);
    });

    it('should preserve rawBytes byte-exact match with encoded input (T-1.0-06)', () => {
      const event = createTestEvent();
      const encoded = encodeEventToToon(event);
      const meta = shallowParseToon(encoded);
      expect(meta.rawBytes).toBe(encoded);
      expect(meta.rawBytes.length).toBe(encoded.length);
      // Verify byte-for-byte identity
      for (let i = 0; i < encoded.length; i++) {
        expect(meta.rawBytes[i]).toBe(encoded[i]);
      }
    });

    it('should match full decode output for all routing fields (cross-validation)', () => {
      const events = [
        createTestEvent(),
        createProfileEvent(),
        createTextNote(),
        createFollowList(),
        createReactionEvent(),
        createIlpPeerInfo(),
        createKind10047Event(),
      ];

      for (const event of events) {
        const encoded = encodeEventToToon(event);
        const meta: ToonRoutingMeta = shallowParseToon(encoded);
        const fullDecode = decodeEventFromToon(encoded);

        expect(meta.kind).toBe(fullDecode.kind);
        expect(meta.pubkey).toBe(fullDecode.pubkey);
        expect(meta.id).toBe(fullDecode.id);
        expect(meta.sig).toBe(fullDecode.sig);
      }
    });

    it('should throw ToonError for invalid TOON data', () => {
      const invalidData = new TextEncoder().encode('not valid toon {{{');
      expect(() => shallowParseToon(invalidData)).toThrow(ToonError);
    });

    it('should throw ToonError for missing kind field', () => {
      const event = createTestEvent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { kind, ...eventWithoutKind } = event;
      const encoded = encodeEventToToon(
        eventWithoutKind as unknown as NostrEvent
      );
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('kind');
    });

    it('should throw ToonError for missing pubkey field', () => {
      const event = createTestEvent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { pubkey, ...eventWithoutPubkey } = event;
      const encoded = encodeEventToToon(
        eventWithoutPubkey as unknown as NostrEvent
      );
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('pubkey');
    });

    it('should throw ToonError for missing id field', () => {
      const event = createTestEvent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, ...eventWithoutId } = event;
      const encoded = encodeEventToToon(
        eventWithoutId as unknown as NostrEvent
      );
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('id');
    });

    it('should throw ToonError for missing sig field', () => {
      const event = createTestEvent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { sig, ...eventWithoutSig } = event;
      const encoded = encodeEventToToon(
        eventWithoutSig as unknown as NostrEvent
      );
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('sig');
    });

    it('should work with all event kinds used in the project', () => {
      const events = [
        createProfileEvent(), // kind:0
        createTextNote(), // kind:1
        createFollowList(), // kind:3
        createReactionEvent(), // kind:7
        createIlpPeerInfo(), // kind:10032
        createKind10047Event(), // kind:10047
      ];

      for (const event of events) {
        const encoded = encodeEventToToon(event);
        const meta = shallowParseToon(encoded);
        expect(meta.kind).toBe(event.kind);
        expect(meta.pubkey).toBe(event.pubkey);
        expect(meta.id).toBe(event.id);
        expect(meta.sig).toBe(event.sig);
      }
    });
  });

  describe('Re-exports from @toon-protocol/core (T-1.0-07)', () => {
    it('should export encodeEventToToon function', () => {
      expect(typeof encodeEventToToon).toBe('function');
    });

    it('should export encodeEventToToonString function', () => {
      expect(typeof encodeEventToToonString).toBe('function');
    });

    it('should export decodeEventFromToon function', () => {
      expect(typeof decodeEventFromToon).toBe('function');
    });

    it('should export shallowParseToon function', () => {
      expect(typeof shallowParseToon).toBe('function');
    });

    it('should export ToonEncodeError class', () => {
      expect(ToonEncodeError).toBeDefined();
      const err = new ToonEncodeError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ToonError);
      expect(err.name).toBe('ToonEncodeError');
      expect(err.code).toBe('TOON_ENCODE_ERROR');
    });

    it('should export ToonDecodeError class', () => {
      expect(ToonDecodeError).toBeDefined();
      const err = new ToonDecodeError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ToonError);
      expect(err.name).toBe('ToonDecodeError');
      expect(err.code).toBe('TOON_DECODE_ERROR');
    });
  });

  describe('Error cause chaining', () => {
    it('should propagate cause through ToonEncodeError via ToonError', () => {
      const originalError = new Error('underlying failure');
      const err = new ToonEncodeError('encode failed', originalError);
      expect(err.cause).toBe(originalError);
      expect(err.message).toBe('encode failed');
      expect(err).toBeInstanceOf(ToonError);
    });

    it('should propagate cause through ToonDecodeError via ToonError', () => {
      const originalError = new Error('decode failure');
      const err = new ToonDecodeError('decode failed', originalError);
      expect(err.cause).toBe(originalError);
      expect(err.message).toBe('decode failed');
      expect(err).toBeInstanceOf(ToonError);
    });

    it('should attach cause when encoding fails (e.g., circular reference)', () => {
      const circular: Record<string, unknown> = { id: 'a'.repeat(64) };
      circular['self'] = circular;

      try {
        encodeEventToToon(circular as unknown as NostrEvent);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ToonEncodeError);
        expect(error).toBeInstanceOf(ToonError);
        expect((error as ToonEncodeError).cause).toBeDefined();
      }
    });

    it('should not attach cause for validation errors (missing fields)', () => {
      // TOON parses successfully but validateNostrEvent fails --
      // the ToonError is thrown directly without a cause
      const validToonInvalidEvent = new TextEncoder().encode('{{not-toon}}');
      try {
        decodeEventFromToon(validToonInvalidEvent);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ToonDecodeError);
        expect(error).toBeInstanceOf(ToonError);
        // Validation errors are thrown directly, not wrapping another error
        expect((error as ToonDecodeError).cause).toBeUndefined();
      }
    });
  });

  describe('Edge cases', () => {
    it('should throw ToonError when decoding empty Uint8Array', () => {
      const emptyData = new Uint8Array(0);
      expect(() => decodeEventFromToon(emptyData)).toThrow(ToonError);
    });

    it('should throw ToonError when shallow parsing empty Uint8Array', () => {
      const emptyData = new Uint8Array(0);
      expect(() => shallowParseToon(emptyData)).toThrow(ToonError);
    });

    it('should throw ToonError for shallow parse with wrong-type kind (string)', () => {
      const invalidEvent = { ...createTestEvent(), kind: 'not-a-number' };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('kind');
    });

    it('should throw ToonError for shallow parse with wrong-type pubkey (number)', () => {
      const invalidEvent = { ...createTestEvent(), pubkey: 12345 };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('pubkey');
    });

    it('should throw ToonError for shallow parse with wrong-length id', () => {
      const invalidEvent = { ...createTestEvent(), id: 'ab'.repeat(16) };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('id');
    });

    it('should throw ToonError for shallow parse with wrong-length sig', () => {
      const invalidEvent = { ...createTestEvent(), sig: 'ab'.repeat(32) };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('sig');
    });

    it('should throw ToonError for decoder with missing content field', () => {
      const event = createTestEvent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { content, ...eventWithoutContent } = event;
      const encoded = encodeEventToToon(
        eventWithoutContent as unknown as NostrEvent
      );
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
      expect(() => decodeEventFromToon(encoded)).toThrow('content');
    });

    it('should throw ToonError for decoder with missing created_at field', () => {
      const event = createTestEvent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { created_at, ...eventWithoutCreatedAt } = event;
      const encoded = encodeEventToToon(
        eventWithoutCreatedAt as unknown as NostrEvent
      );
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
      expect(() => decodeEventFromToon(encoded)).toThrow('created_at');
    });

    it('should throw ToonError for decoder with non-integer created_at', () => {
      const invalidEvent = { ...createTestEvent(), created_at: 123.456 };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
      expect(() => decodeEventFromToon(encoded)).toThrow('created_at');
    });

    it('should throw ToonError for decoder with non-integer kind', () => {
      const invalidEvent = { ...createTestEvent(), kind: 1.5 };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
      expect(() => decodeEventFromToon(encoded)).toThrow('kind');
    });

    it('should throw ToonError for shallow parse with non-integer kind', () => {
      const invalidEvent = { ...createTestEvent(), kind: 1.5 };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('kind');
    });

    it('should throw ToonError for decoder when tag inner array element is not a string array', () => {
      const invalidEvent = {
        ...createTestEvent(),
        tags: [['e', '1'.repeat(64)], 'not-an-array'],
      };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
    });

    it('should throw ToonError for decoder with non-hex id characters', () => {
      const invalidEvent = {
        ...createTestEvent(),
        id: 'g'.repeat(64), // 'g' is not valid hex
      };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => decodeEventFromToon(encoded)).toThrow(ToonError);
      expect(() => decodeEventFromToon(encoded)).toThrow('id');
    });

    it('should throw ToonError for shallow parse with non-hex pubkey characters', () => {
      const invalidEvent = {
        ...createTestEvent(),
        pubkey: 'z'.repeat(64), // 'z' is not valid hex
      };
      const encoded = encodeEventToToon(invalidEvent as unknown as NostrEvent);
      expect(() => shallowParseToon(encoded)).toThrow(ToonError);
      expect(() => shallowParseToon(encoded)).toThrow('pubkey');
    });
  });
});
