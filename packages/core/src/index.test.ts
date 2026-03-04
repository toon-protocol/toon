import { describe, it, expect } from 'vitest';
import {
  VERSION,
  ILP_PEER_INFO_KIND,
  SPSP_REQUEST_KIND,
  SPSP_RESPONSE_KIND,
  encodeEventToToon,
  encodeEventToToonString,
  decodeEventFromToon,
  shallowParseToon,
  ToonEncodeError,
  ToonError,
  CrosstownError,
} from './index.js';
import type {
  IlpPeerInfo,
  SpspInfo,
  SpspRequest,
  SpspResponse,
  ToonRoutingMeta,
} from './index.js';
import type { NostrEvent } from 'nostr-tools/pure';

describe('@crosstown/core', () => {
  it('should export VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });

  describe('exports event kind constants', () => {
    it('should export ILP_PEER_INFO_KIND', () => {
      expect(ILP_PEER_INFO_KIND).toBe(10032);
    });

    it('should export SPSP_REQUEST_KIND', () => {
      expect(SPSP_REQUEST_KIND).toBe(23194);
    });

    it('should export SPSP_RESPONSE_KIND', () => {
      expect(SPSP_RESPONSE_KIND).toBe(23195);
    });
  });

  describe('exports TypeScript interfaces', () => {
    it('should export IlpPeerInfo type', () => {
      const peerInfo: IlpPeerInfo = {
        ilpAddress: 'g.test',
        btpEndpoint: 'wss://test.com',
        assetCode: 'USD',
        assetScale: 6,
      };
      expect(peerInfo).toBeDefined();
    });

    it('should export SpspInfo type', () => {
      const spspInfo: SpspInfo = {
        destinationAccount: 'g.test.user',
        sharedSecret: 'dGVzdA==',
      };
      expect(spspInfo).toBeDefined();
    });

    it('should export SpspRequest type', () => {
      const request: SpspRequest = {
        requestId: 'test-123',
        timestamp: Date.now(),
      };
      expect(request).toBeDefined();
    });

    it('should export SpspResponse type', () => {
      const response: SpspResponse = {
        requestId: 'test-123',
        destinationAccount: 'g.test.user',
        sharedSecret: 'dGVzdA==',
      };
      expect(response).toBeDefined();
    });
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

    it('should export ToonEncodeError class extending CrosstownError', () => {
      expect(ToonEncodeError).toBeDefined();
      const err = new ToonEncodeError('test encode error');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CrosstownError);
      expect(err.name).toBe('ToonEncodeError');
      expect(err.code).toBe('TOON_ENCODE_ERROR');
    });

    it('should export ToonError class extending CrosstownError', () => {
      expect(ToonError).toBeDefined();
      const err = new ToonError('test decode error');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CrosstownError);
      expect(err.name).toBe('ToonError');
      expect(err.code).toBe('TOON_DECODE_ERROR');
    });

    it('should export ToonRoutingMeta type (compile-time check via usage)', () => {
      const encoded = encodeEventToToon(testEvent);
      const meta: ToonRoutingMeta = shallowParseToon(encoded);
      // Type check: ToonRoutingMeta has the expected shape
      const _kind: number = meta.kind;
      const _pubkey: string = meta.pubkey;
      const _id: string = meta.id;
      const _sig: string = meta.sig;
      const _rawBytes: Uint8Array = meta.rawBytes;
      expect(_kind).toBe(testEvent.kind);
      expect(_pubkey).toBe(testEvent.pubkey);
      expect(_id).toBe(testEvent.id);
      expect(_sig).toBe(testEvent.sig);
      expect(_rawBytes).toBeInstanceOf(Uint8Array);
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
