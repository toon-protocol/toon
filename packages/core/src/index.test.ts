import { describe, it, expect } from 'vitest';
import * as core from './index.js';
import {
  VERSION,
  encodeEventToToon,
  encodeEventToToonString,
  decodeEventFromToon,
  shallowParseToon,
  ToonEncodeError,
  ToonDecodeError,
  ToonError,
} from './index.js';
import type { ToonRoutingMeta } from './index.js';
import type { NostrEvent } from 'nostr-tools/pure';

describe('@toon-protocol/core', () => {
  it('should export VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });

  it('exports exactly this list, so a stray export fails', () => {
    expect(Object.keys(core).sort()).toEqual(
      [
        'BLOB_STORAGE_REQUEST_KIND',
        'BLOB_STORAGE_RESULT_KIND',
        'ToonDecodeError',
        'ToonEncodeError',
        'ToonError',
        'VERSION',
        'base58Decode',
        'base58Encode',
        'buildBlobStorageRequest',
        'decodeEventFromToon',
        'encodeEventToToon',
        'encodeEventToToonString',
        'parseBlobStorageRequest',
        'shallowParseToon',
      ].sort()
    );
  });

  describe('exports TOON codec (AC #8)', () => {
    const testEvent: NostrEvent = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      kind: 1,
      content: 'Hello from index export test',
      tags: [],
      created_at: 1234567890,
      sig: 'c'.repeat(128),
    };

    it('should export encodeEventToToon function', () => {
      expect(typeof encodeEventToToon).toBe('function');
      const encoded = encodeEventToToon(testEvent);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should export encodeEventToToonString function', () => {
      expect(typeof encodeEventToToonString).toBe('function');
      const encoded = encodeEventToToonString(testEvent);
      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should export decodeEventFromToon function', () => {
      expect(typeof decodeEventFromToon).toBe('function');
      const encoded = encodeEventToToon(testEvent);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded).toEqual(testEvent);
    });

    it('should export shallowParseToon function', () => {
      expect(typeof shallowParseToon).toBe('function');
      const encoded = encodeEventToToon(testEvent);
      const meta: ToonRoutingMeta = shallowParseToon(encoded);
      expect(meta.kind).toBe(testEvent.kind);
      expect(meta.pubkey).toBe(testEvent.pubkey);
      expect(meta.id).toBe(testEvent.id);
      expect(meta.sig).toBe(testEvent.sig);
      expect(meta.rawBytes).toBe(encoded);
    });

    it('should export ToonEncodeError class extending ToonError', () => {
      expect(ToonEncodeError).toBeDefined();
      const err = new ToonEncodeError('test encode error');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ToonError);
      expect(err.name).toBe('ToonEncodeError');
      expect(err.code).toBe('TOON_ENCODE_ERROR');
    });

    it('should export ToonDecodeError class extending ToonError', () => {
      expect(ToonDecodeError).toBeDefined();
      const err = new ToonDecodeError('test decode error');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ToonError);
      expect(err.name).toBe('ToonDecodeError');
      expect(err.code).toBe('TOON_DECODE_ERROR');
    });

    it('should support full encode-decode round-trip via package index exports', () => {
      const encoded = encodeEventToToon(testEvent);
      const decoded = decodeEventFromToon(encoded);
      expect(decoded.id).toBe(testEvent.id);
      expect(decoded.pubkey).toBe(testEvent.pubkey);
      expect(decoded.kind).toBe(testEvent.kind);
      expect(decoded.content).toBe(testEvent.content);
      expect(decoded.tags).toEqual(testEvent.tags);
      expect(decoded.created_at).toBe(testEvent.created_at);
      expect(decoded.sig).toBe(testEvent.sig);
    });
  });
});
