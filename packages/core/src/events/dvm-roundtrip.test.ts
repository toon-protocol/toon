/**
 * Tests for DVM TOON Roundtrip and Shallow Parse (Story 5.1, AC #4, #5)
 *
 * Split from dvm.test.ts during A4 (Epic 6 start).
 * Covers: TOON encode/decode roundtrip, shallowParseToon, full pipeline tests.
 *
 * Test IDs:
 * - T-5.1-01 [P0]: Kind 5100 TOON roundtrip preserves all required + optional tags
 * - T-5.1-02 [P0]: Kind 6xxx TOON roundtrip preserves required tags + content
 * - T-5.1-03 [P0]: Kind 7000 TOON roundtrip preserves required tags + content
 * - T-5.1-04 [P0]: TOON shallow parser extracts kind for DVM events without full decode
 * - T-5.1-22 [P1]: TOON roundtrip preserves tag order
 */

import { describe, it, expect } from 'vitest';
import {
  encodeEventToToon,
  decodeEventFromToon,
  shallowParseToon,
} from '../toon/index.js';
import {
  buildJobRequestEvent,
  buildJobResultEvent,
  buildJobFeedbackEvent,
  parseJobRequest,
  parseJobResult,
  parseJobFeedback,
} from './dvm.js';
import type { DvmJobStatus } from './dvm.js';
import {
  IMAGE_GENERATION_KIND,
  TEXT_TO_SPEECH_KIND,
  TRANSLATION_KIND,
} from '../constants.js';
import {
  FIXED_BUILDER_SECRET_KEY,
  createJobRequestParams,
  createJobResultParams,
  createJobFeedbackParams,
} from './dvm-test-helpers.js';

describe('DVM TOON roundtrip and shallow parse', () => {
  // ==========================================================================
  // Tests: TOON Roundtrip (AC #4)
  // ==========================================================================

  describe('TOON roundtrip (AC #4)', () => {
    // --------------------------------------------------------------------------
    // T-5.1-01 [P0]: Kind 5100 TOON roundtrip
    // --------------------------------------------------------------------------
    describe('Kind 5100 job request TOON roundtrip (T-5.1-01)', () => {
      it('[P0] preserves all required and optional tags through encode/decode', () => {
        // Arrange: build a complex job request with all tag types
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          kind: 5100,
          input: {
            data: 'https://example.com/article',
            type: 'url',
            relay: 'wss://relay.example.com',
            marker: 'source',
          },
          bid: '1000000',
          output: 'text/plain',
          content: 'Summarize this',
          targetProvider: 'c'.repeat(64),
          params: [
            { key: 'temperature', value: '0.7' },
            { key: 'max_tokens', value: '2048' },
          ],
          relays: ['wss://r1.example.com', 'wss://r2.example.com'],
        });
        const event = buildJobRequestEvent(params, secretKey);

        // Act: encode to TOON, then decode back
        const toonBytes = encodeEventToToon(event);
        const decoded = decodeEventFromToon(toonBytes);

        // Assert: all fields survive roundtrip
        expect(decoded.kind).toBe(event.kind);
        expect(decoded.pubkey).toBe(event.pubkey);
        expect(decoded.id).toBe(event.id);
        expect(decoded.sig).toBe(event.sig);
        expect(decoded.content).toBe(event.content);
        expect(decoded.created_at).toBe(event.created_at);

        // Assert: all tags survive roundtrip
        expect(decoded.tags).toHaveLength(event.tags.length);

        // Verify i tag with all elements
        const iTag = decoded.tags.find((t: string[]) => t[0] === 'i');
        expect(iTag).toEqual([
          'i',
          'https://example.com/article',
          'url',
          'wss://relay.example.com',
          'source',
        ]);

        // Verify bid tag with currency
        const bidTag = decoded.tags.find((t: string[]) => t[0] === 'bid');
        expect(bidTag).toEqual(['bid', '1000000', 'usdc']);

        // Verify output tag
        const outputTag = decoded.tags.find((t: string[]) => t[0] === 'output');
        expect(outputTag).toEqual(['output', 'text/plain']);

        // Verify p tag
        const pTag = decoded.tags.find((t: string[]) => t[0] === 'p');
        expect(pTag).toEqual(['p', 'c'.repeat(64)]);

        // Verify param tags
        const paramTags = decoded.tags.filter(
          (t: string[]) => t[0] === 'param'
        );
        expect(paramTags).toHaveLength(2);
        expect(paramTags[0]).toEqual(['param', 'temperature', '0.7']);
        expect(paramTags[1]).toEqual(['param', 'max_tokens', '2048']);

        // Verify relays tag
        const relaysTag = decoded.tags.find((t: string[]) => t[0] === 'relays');
        expect(relaysTag).toEqual([
          'relays',
          'wss://r1.example.com',
          'wss://r2.example.com',
        ]);
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-02 [P0]: Kind 6xxx TOON roundtrip
    // --------------------------------------------------------------------------
    describe('Kind 6100 job result TOON roundtrip (T-5.1-02)', () => {
      it('[P0] preserves required tags and content through encode/decode', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({
          kind: 6100,
          content: 'Here is your generated text summary...',
        });
        const event = buildJobResultEvent(params, secretKey);

        // Act
        const toonBytes = encodeEventToToon(event);
        const decoded = decodeEventFromToon(toonBytes);

        // Assert: metadata
        expect(decoded.kind).toBe(6100);
        expect(decoded.pubkey).toBe(event.pubkey);
        expect(decoded.id).toBe(event.id);
        expect(decoded.sig).toBe(event.sig);
        expect(decoded.content).toBe('Here is your generated text summary...');

        // Assert: tags
        const eTag = decoded.tags.find((t: string[]) => t[0] === 'e');
        expect(eTag).toEqual(['e', 'a'.repeat(64)]);

        const pTag = decoded.tags.find((t: string[]) => t[0] === 'p');
        expect(pTag).toEqual(['p', 'b'.repeat(64)]);

        const amountTag = decoded.tags.find((t: string[]) => t[0] === 'amount');
        expect(amountTag).toEqual(['amount', '500000', 'usdc']);
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-03 [P0]: Kind 7000 TOON roundtrip
    // --------------------------------------------------------------------------
    describe('Kind 7000 job feedback TOON roundtrip (T-5.1-03)', () => {
      it('[P0] preserves required tags and content through encode/decode', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams({
          status: 'error' as DvmJobStatus,
          content: 'Model capacity exceeded',
        });
        const event = buildJobFeedbackEvent(params, secretKey);

        // Act
        const toonBytes = encodeEventToToon(event);
        const decoded = decodeEventFromToon(toonBytes);

        // Assert: metadata
        expect(decoded.kind).toBe(7000);
        expect(decoded.pubkey).toBe(event.pubkey);
        expect(decoded.id).toBe(event.id);
        expect(decoded.sig).toBe(event.sig);
        expect(decoded.content).toBe('Model capacity exceeded');

        // Assert: tags
        const eTag = decoded.tags.find((t: string[]) => t[0] === 'e');
        expect(eTag).toEqual(['e', 'a'.repeat(64)]);

        const pTag = decoded.tags.find((t: string[]) => t[0] === 'p');
        expect(pTag).toEqual(['p', 'b'.repeat(64)]);

        const statusTag = decoded.tags.find((t: string[]) => t[0] === 'status');
        expect(statusTag).toEqual(['status', 'error']);
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-22 [P1]: Tag order preservation
    // --------------------------------------------------------------------------
    describe('tag order preservation (T-5.1-22)', () => {
      it('[P1] tags in decoded event appear in same order as original', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          kind: 5100,
          input: { data: 'data', type: 'text' },
          bid: '1000',
          output: 'text/plain',
          targetProvider: 'c'.repeat(64),
          params: [{ key: 'k', value: 'v' }],
          relays: ['wss://relay.example.com'],
        });
        const event = buildJobRequestEvent(params, secretKey);

        // Act
        const toonBytes = encodeEventToToon(event);
        const decoded = decodeEventFromToon(toonBytes);

        // Assert: tag order is preserved
        expect(decoded.tags.map((t: string[]) => t[0])).toEqual(
          event.tags.map((t: string[]) => t[0])
        );
      });
    });
  });

  // ==========================================================================
  // Tests: TOON Shallow Parse (AC #5)
  // ==========================================================================

  describe('shallowParseToon for DVM events (AC #5)', () => {
    // --------------------------------------------------------------------------
    // T-5.1-04 [P0]: Shallow parser extracts kind for DVM events
    // --------------------------------------------------------------------------
    describe('shallow parser DVM kind extraction (T-5.1-04)', () => {
      it('[P0] extracts kind 5100 from TOON-encoded job request', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ kind: 5100 });
        const event = buildJobRequestEvent(params, secretKey);
        const toonBytes = encodeEventToToon(event);

        // Act
        const meta = shallowParseToon(toonBytes);

        // Assert
        expect(meta.kind).toBe(5100);
        expect(meta.pubkey).toBe(event.pubkey);
        expect(meta.id).toBe(event.id);
        expect(meta.sig).toBe(event.sig);
      });

      it('[P0] extracts kind 6100 from TOON-encoded job result', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ kind: 6100 });
        const event = buildJobResultEvent(params, secretKey);
        const toonBytes = encodeEventToToon(event);

        // Act
        const meta = shallowParseToon(toonBytes);

        // Assert
        expect(meta.kind).toBe(6100);
        expect(meta.pubkey).toBe(event.pubkey);
        expect(meta.id).toBe(event.id);
      });

      it('[P0] extracts kind 7000 from TOON-encoded job feedback', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams();
        const event = buildJobFeedbackEvent(params, secretKey);
        const toonBytes = encodeEventToToon(event);

        // Act
        const meta = shallowParseToon(toonBytes);

        // Assert
        expect(meta.kind).toBe(7000);
        expect(meta.pubkey).toBe(event.pubkey);
        expect(meta.id).toBe(event.id);
      });
    });
  });

  // ==========================================================================
  // Gap-fill tests: Full pipeline build -> TOON -> parse roundtrip (AC #4)
  // ==========================================================================

  describe('full pipeline build -> TOON encode -> TOON decode -> parse (AC #4 gap-fill)', () => {
    it('[P0] Kind 5100 job request survives full build->TOON->parse pipeline', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({
        kind: 5100,
        input: {
          data: 'https://example.com/article',
          type: 'url',
          relay: 'wss://relay.example.com',
          marker: 'source',
        },
        bid: '2500000',
        output: 'text/plain',
        content: 'Please summarize',
        targetProvider: 'c'.repeat(64),
        params: [{ key: 'temperature', value: '0.7' }],
        relays: ['wss://r1.example.com'],
      });

      // Act: build -> TOON encode -> TOON decode -> parse
      const event = buildJobRequestEvent(params, secretKey);
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);
      const parsed = parseJobRequest(decoded);

      // Assert: parsed result matches original params
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe(5100);
      expect(parsed!.input.data).toBe('https://example.com/article');
      expect(parsed!.input.type).toBe('url');
      expect(parsed!.input.relay).toBe('wss://relay.example.com');
      expect(parsed!.input.marker).toBe('source');
      expect(parsed!.bid).toBe('2500000');
      expect(parsed!.output).toBe('text/plain');
      expect(parsed!.content).toBe('Please summarize');
      expect(parsed!.targetProvider).toBe('c'.repeat(64));
      expect(parsed!.params).toHaveLength(1);
      expect(parsed!.params[0]).toEqual({ key: 'temperature', value: '0.7' });
      expect(parsed!.relays).toEqual(['wss://r1.example.com']);
    });

    it('[P0] Kind 6100 job result survives full build->TOON->parse pipeline', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({
        kind: 6100,
        requestEventId: 'a'.repeat(64),
        customerPubkey: 'b'.repeat(64),
        amount: '750000',
        content: 'Generated summary text here...',
      });

      // Act
      const event = buildJobResultEvent(params, secretKey);
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);
      const parsed = parseJobResult(decoded);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe(6100);
      expect(parsed!.requestEventId).toBe('a'.repeat(64));
      expect(parsed!.customerPubkey).toBe('b'.repeat(64));
      expect(parsed!.amount).toBe('750000');
      expect(parsed!.content).toBe('Generated summary text here...');
    });

    it('[P0] Kind 7000 job feedback survives full build->TOON->parse pipeline', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobFeedbackParams({
        requestEventId: 'a'.repeat(64),
        customerPubkey: 'b'.repeat(64),
        status: 'partial' as DvmJobStatus,
        content: '50% complete',
      });

      // Act
      const event = buildJobFeedbackEvent(params, secretKey);
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);
      const parsed = parseJobFeedback(decoded);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.requestEventId).toBe('a'.repeat(64));
      expect(parsed!.customerPubkey).toBe('b'.repeat(64));
      expect(parsed!.status).toBe('partial');
      expect(parsed!.content).toBe('50% complete');
    });
  });

  // ==========================================================================
  // Gap-fill tests: TOON roundtrip with i tag marker-no-relay placeholder (AC #4)
  // ==========================================================================

  describe('TOON roundtrip with i tag empty relay placeholder (AC #4 gap-fill)', () => {
    it('[P1] preserves empty relay placeholder in i tag through TOON encode/decode', () => {
      // Arrange: build event with marker but no relay (creates empty placeholder)
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({
        kind: 5100,
        input: {
          data: 'test-data',
          type: 'text',
          marker: 'source',
          // no relay -- builder inserts empty string placeholder
        },
        bid: '1000000',
        output: 'text/plain',
      });
      const event = buildJobRequestEvent(params, secretKey);

      // Verify the builder created the placeholder
      const iTagBefore = event.tags.find((t: string[]) => t[0] === 'i');
      expect(iTagBefore).toEqual(['i', 'test-data', 'text', '', 'source']);

      // Act: TOON roundtrip
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert: empty placeholder survives roundtrip
      const iTagAfter = decoded.tags.find((t: string[]) => t[0] === 'i');
      expect(iTagAfter).toEqual(['i', 'test-data', 'text', '', 'source']);
    });
  });

  // ==========================================================================
  // Gap-fill tests: TOON roundtrip for specific DVM kinds (5200, 5300, 5302)
  // ==========================================================================

  describe('TOON roundtrip for additional DVM kinds (AC #4 gap-fill)', () => {
    it('[P1] Kind 5200 (IMAGE_GENERATION) survives TOON roundtrip', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({
        kind: IMAGE_GENERATION_KIND,
        input: { data: 'a sunset over mountains', type: 'text' },
        bid: '5000000',
        output: 'image/png',
      });
      const event = buildJobRequestEvent(params, secretKey);

      // Act
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert
      expect(decoded.kind).toBe(5200);
      expect(decoded.tags.find((t: string[]) => t[0] === 'output')).toEqual([
        'output',
        'image/png',
      ]);
    });

    it('[P1] Kind 5300 (TEXT_TO_SPEECH) survives TOON roundtrip', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({
        kind: TEXT_TO_SPEECH_KIND,
        input: { data: 'Hello world', type: 'text' },
        bid: '3000000',
        output: 'audio/mpeg',
      });
      const event = buildJobRequestEvent(params, secretKey);

      // Act
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert
      expect(decoded.kind).toBe(5300);
    });

    it('[P1] Kind 5302 (TRANSLATION) survives TOON roundtrip', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({
        kind: TRANSLATION_KIND,
        input: { data: 'Hola mundo', type: 'text' },
        bid: '500000',
        output: 'text/plain',
        params: [
          { key: 'source_lang', value: 'es' },
          { key: 'target_lang', value: 'en' },
        ],
      });
      const event = buildJobRequestEvent(params, secretKey);

      // Act
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert
      expect(decoded.kind).toBe(5302);
      const paramTags = decoded.tags.filter((t: string[]) => t[0] === 'param');
      expect(paramTags).toHaveLength(2);
      expect(paramTags[0]).toEqual(['param', 'source_lang', 'es']);
      expect(paramTags[1]).toEqual(['param', 'target_lang', 'en']);
    });
  });
});
