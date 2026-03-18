/**
 * Tests for DVM Builder Functions (Story 5.1, AC #1-3)
 *
 * Split from dvm.test.ts during A4 (Epic 6 start).
 * Covers: buildJobRequestEvent, buildJobResultEvent, buildJobFeedbackEvent,
 * plus builder-specific gap-fill tests.
 *
 * Test IDs:
 * - T-5.1-12 [P0]: buildJobRequestEvent valid Schnorr signature
 * - T-5.1-09 [P1]: NIP-90 i tag format
 * - T-5.1-11 [P1]: bid/amount in USDC micro-units as string
 * - T-5.1-10 [P2]: Targeted vs open marketplace (p tag)
 * - T-5.1-25 [P2]: Multiple param tags preserved
 * - T-5.1-24 [P2]: relays tag with multiple URLs preserved
 * - T-5.1-05 [P1]: Missing required tags (request)
 * - T-5.1-18 [P1]: Kind range validation for request builder
 * - T-5.1-13 [P0]: buildJobResultEvent valid Schnorr signature
 * - T-5.1-06 [P1]: Missing required tags (result)
 * - T-5.1-19 [P1]: Kind range validation for result builder
 * - T-5.1-14 [P0]: buildJobFeedbackEvent valid Schnorr signature
 * - T-5.1-07 [P1]: Status values
 */

import { describe, it, expect } from 'vitest';
import { verifyEvent } from 'nostr-tools/pure';
import { ToonError } from '../errors.js';
import {
  buildJobRequestEvent,
  buildJobResultEvent,
  buildJobFeedbackEvent,
} from './dvm.js';
import type { DvmJobStatus } from './dvm.js';
// Kind constants not needed directly in builder tests -- see dvm-roundtrip.test.ts
import {
  FIXED_BUILDER_SECRET_KEY,
  FIXED_BUILDER_PUBKEY,
  createJobRequestParams,
  createJobResultParams,
  createJobFeedbackParams,
} from './dvm-test-helpers.js';

describe('DVM builders', () => {
  // ==========================================================================
  // Tests: buildJobRequestEvent (AC #1)
  // ==========================================================================

  describe('buildJobRequestEvent (AC #1)', () => {
    // --------------------------------------------------------------------------
    // T-5.1-12 [P0]: Valid Schnorr signature
    // --------------------------------------------------------------------------
    describe('signature verification (T-5.1-12)', () => {
      it('[P0] produces an event that passes verifyEvent()', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams();

        // Act
        const event = buildJobRequestEvent(params, secretKey);
        const isValid = verifyEvent(event);

        // Assert
        expect(isValid).toBe(true);
        expect(event.kind).toBe(5100);
        expect(event.pubkey).toBe(FIXED_BUILDER_PUBKEY);
        expect(event.id).toMatch(/^[0-9a-f]{64}$/);
        expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-09 [P1]: NIP-90 i tag format
    // --------------------------------------------------------------------------
    describe('NIP-90 i tag format (T-5.1-09)', () => {
      it('[P1] creates i tag with data and type: [i, data, type]', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          input: { data: 'test-data', type: 'text' },
        });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const iTag = event.tags.find((t: string[]) => t[0] === 'i');
        expect(iTag).toBeDefined();
        expect(iTag![1]).toBe('test-data');
        expect(iTag![2]).toBe('text');
      });

      it('[P1] creates i tag with optional relay: [i, data, type, relay]', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          input: {
            data: 'test-data',
            type: 'text',
            relay: 'wss://relay.example.com',
          },
        });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const iTag = event.tags.find((t: string[]) => t[0] === 'i');
        expect(iTag).toBeDefined();
        expect(iTag![3]).toBe('wss://relay.example.com');
      });

      it('[P1] creates i tag with optional relay and marker: [i, data, type, relay, marker]', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          input: {
            data: 'test-data',
            type: 'url',
            relay: 'wss://relay.example.com',
            marker: 'source',
          },
        });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const iTag = event.tags.find((t: string[]) => t[0] === 'i');
        expect(iTag).toBeDefined();
        expect(iTag![1]).toBe('test-data');
        expect(iTag![2]).toBe('url');
        expect(iTag![3]).toBe('wss://relay.example.com');
        expect(iTag![4]).toBe('source');
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-11 [P1]: bid value in USDC micro-units
    // --------------------------------------------------------------------------
    describe('bid tag USDC micro-units (T-5.1-11)', () => {
      it('[P1] creates bid tag with amount and usdc currency: [bid, amount, usdc]', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ bid: '1000000' });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const bidTag = event.tags.find((t: string[]) => t[0] === 'bid');
        expect(bidTag).toBeDefined();
        expect(bidTag![1]).toBe('1000000');
        expect(bidTag![2]).toBe('usdc');
      });
    });

    // --------------------------------------------------------------------------
    // output tag
    // --------------------------------------------------------------------------
    describe('output tag', () => {
      it('[P1] creates output tag with MIME type: [output, mimeType]', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ output: 'application/json' });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const outputTag = event.tags.find((t: string[]) => t[0] === 'output');
        expect(outputTag).toBeDefined();
        expect(outputTag![1]).toBe('application/json');
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-10 [P2]: Targeted vs open marketplace (p tag)
    // --------------------------------------------------------------------------
    describe('targeted request via p tag (T-5.1-10)', () => {
      it('[P2] includes p tag when targetProvider is specified', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const providerPubkey = 'c'.repeat(64);
        const params = createJobRequestParams({
          targetProvider: providerPubkey,
        });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const pTag = event.tags.find((t: string[]) => t[0] === 'p');
        expect(pTag).toBeDefined();
        expect(pTag![1]).toBe(providerPubkey);
      });

      it('[P2] omits p tag for open marketplace request', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams(); // no targetProvider

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const pTag = event.tags.find((t: string[]) => t[0] === 'p');
        expect(pTag).toBeUndefined();
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-25 [P2]: Multiple param tags
    // --------------------------------------------------------------------------
    describe('multiple param tags (T-5.1-25)', () => {
      it('[P2] creates param tags for each key-value pair', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          params: [
            { key: 'temperature', value: '0.7' },
            { key: 'max_tokens', value: '1024' },
            { key: 'model', value: 'gpt-4' },
          ],
        });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const paramTags = event.tags.filter((t: string[]) => t[0] === 'param');
        expect(paramTags).toHaveLength(3);
        expect(paramTags[0]).toEqual(['param', 'temperature', '0.7']);
        expect(paramTags[1]).toEqual(['param', 'max_tokens', '1024']);
        expect(paramTags[2]).toEqual(['param', 'model', 'gpt-4']);
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-24 [P2]: relays tag with multiple URLs
    // --------------------------------------------------------------------------
    describe('relays tag with multiple URLs (T-5.1-24)', () => {
      it('[P2] creates relays tag with all provided URLs', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          relays: [
            'wss://relay1.example.com',
            'wss://relay2.example.com',
            'wss://relay3.example.com',
          ],
        });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        const relaysTag = event.tags.find((t: string[]) => t[0] === 'relays');
        expect(relaysTag).toBeDefined();
        expect(relaysTag![1]).toBe('wss://relay1.example.com');
        expect(relaysTag![2]).toBe('wss://relay2.example.com');
        expect(relaysTag![3]).toBe('wss://relay3.example.com');
      });
    });

    // --------------------------------------------------------------------------
    // content field
    // --------------------------------------------------------------------------
    describe('content field', () => {
      it('sets content from params.content', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          content: 'Please summarize the following text',
        });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        expect(event.content).toBe('Please summarize the following text');
      });

      it('defaults content to empty string when not provided', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams();
        delete (params as Record<string, unknown>)['content'];

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        expect(event.content).toBe('');
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-05 [P1]: Missing required tags
    // --------------------------------------------------------------------------
    describe('validation errors (T-5.1-05)', () => {
      it('[P1] throws when input is missing', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams();
        delete (params as Record<string, unknown>)['input'];

        // Act & Assert
        expect(() => buildJobRequestEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when bid is missing', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams();
        delete (params as Record<string, unknown>)['bid'];

        // Act & Assert
        expect(() => buildJobRequestEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when bid is empty string', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ bid: '' });

        // Act & Assert
        expect(() => buildJobRequestEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when output is missing', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams();
        delete (params as Record<string, unknown>)['output'];

        // Act & Assert
        expect(() => buildJobRequestEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when output is empty string', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ output: '' });

        // Act & Assert
        expect(() => buildJobRequestEvent(params, secretKey)).toThrow();
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-18 [P1]: Kind range validation for request builder
    // --------------------------------------------------------------------------
    describe('kind range validation (T-5.1-18)', () => {
      it('[P1] throws when kind is 4999 (below 5000-5999 range)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ kind: 4999 });

        // Act & Assert
        expect(() => buildJobRequestEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when kind is 6000 (above 5000-5999 range)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ kind: 6000 });

        // Act & Assert
        expect(() => buildJobRequestEvent(params, secretKey)).toThrow();
      });

      it('[P1] accepts kind 5000 (lower boundary)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ kind: 5000 });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        expect(event.kind).toBe(5000);
      });

      it('[P1] accepts kind 5999 (upper boundary)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({ kind: 5999 });

        // Act
        const event = buildJobRequestEvent(params, secretKey);

        // Assert
        expect(event.kind).toBe(5999);
      });
    });
  });

  // ==========================================================================
  // Tests: buildJobResultEvent (AC #2)
  // ==========================================================================

  describe('buildJobResultEvent (AC #2)', () => {
    // --------------------------------------------------------------------------
    // T-5.1-13 [P0]: Valid Schnorr signature
    // --------------------------------------------------------------------------
    describe('signature verification (T-5.1-13)', () => {
      it('[P0] produces an event that passes verifyEvent()', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams();

        // Act
        const event = buildJobResultEvent(params, secretKey);
        const isValid = verifyEvent(event);

        // Assert
        expect(isValid).toBe(true);
        expect(event.kind).toBe(6100);
        expect(event.pubkey).toBe(FIXED_BUILDER_PUBKEY);
      });
    });

    // --------------------------------------------------------------------------
    // Required tags: e, p, amount
    // --------------------------------------------------------------------------
    describe('required tags', () => {
      it('[P1] creates e tag referencing request event ID', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const requestId = 'd'.repeat(64);
        const params = createJobResultParams({ requestEventId: requestId });

        // Act
        const event = buildJobResultEvent(params, secretKey);

        // Assert
        const eTag = event.tags.find((t: string[]) => t[0] === 'e');
        expect(eTag).toBeDefined();
        expect(eTag![1]).toBe(requestId);
      });

      it('[P1] creates p tag with customer pubkey', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const customerPk = 'e'.repeat(64);
        const params = createJobResultParams({ customerPubkey: customerPk });

        // Act
        const event = buildJobResultEvent(params, secretKey);

        // Assert
        const pTag = event.tags.find((t: string[]) => t[0] === 'p');
        expect(pTag).toBeDefined();
        expect(pTag![1]).toBe(customerPk);
      });

      it('[P1] creates amount tag with cost and usdc currency (T-5.1-11)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ amount: '2000000' });

        // Act
        const event = buildJobResultEvent(params, secretKey);

        // Assert
        const amountTag = event.tags.find((t: string[]) => t[0] === 'amount');
        expect(amountTag).toBeDefined();
        expect(amountTag![1]).toBe('2000000');
        expect(amountTag![2]).toBe('usdc');
      });

      it('[P1] sets content to result data', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({
          content: 'The generated summary text goes here',
        });

        // Act
        const event = buildJobResultEvent(params, secretKey);

        // Assert
        expect(event.content).toBe('The generated summary text goes here');
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-06 [P1]: Missing required tags
    // --------------------------------------------------------------------------
    describe('validation errors (T-5.1-06)', () => {
      it('[P1] throws when requestEventId is missing', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams();
        delete (params as Record<string, unknown>)['requestEventId'];

        // Act & Assert
        expect(() => buildJobResultEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when requestEventId is not 64-char hex', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ requestEventId: 'too-short' });

        // Act & Assert
        expect(() => buildJobResultEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when customerPubkey is not 64-char hex', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ customerPubkey: 'invalid' });

        // Act & Assert
        expect(() => buildJobResultEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when amount is missing', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams();
        delete (params as Record<string, unknown>)['amount'];

        // Act & Assert
        expect(() => buildJobResultEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when amount is empty string', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ amount: '' });

        // Act & Assert
        expect(() => buildJobResultEvent(params, secretKey)).toThrow();
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-19 [P1]: Kind range validation for result builder
    // --------------------------------------------------------------------------
    describe('kind range validation (T-5.1-19)', () => {
      it('[P1] throws when kind is 5999 (below 6000-6999 range)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ kind: 5999 });

        // Act & Assert
        expect(() => buildJobResultEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when kind is 7000 (above 6000-6999 range)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ kind: 7000 });

        // Act & Assert
        expect(() => buildJobResultEvent(params, secretKey)).toThrow();
      });

      it('[P1] accepts kind 6000 (lower boundary)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ kind: 6000 });

        // Act
        const event = buildJobResultEvent(params, secretKey);

        // Assert
        expect(event.kind).toBe(6000);
      });

      it('[P1] accepts kind 6999 (upper boundary)', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({ kind: 6999 });

        // Act
        const event = buildJobResultEvent(params, secretKey);

        // Assert
        expect(event.kind).toBe(6999);
      });
    });
  });

  // ==========================================================================
  // Tests: buildJobFeedbackEvent (AC #3)
  // ==========================================================================

  describe('buildJobFeedbackEvent (AC #3)', () => {
    // --------------------------------------------------------------------------
    // T-5.1-14 [P0]: Valid Schnorr signature
    // --------------------------------------------------------------------------
    describe('signature verification (T-5.1-14)', () => {
      it('[P0] produces an event that passes verifyEvent()', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams();

        // Act
        const event = buildJobFeedbackEvent(params, secretKey);
        const isValid = verifyEvent(event);

        // Assert
        expect(isValid).toBe(true);
        expect(event.kind).toBe(7000);
        expect(event.pubkey).toBe(FIXED_BUILDER_PUBKEY);
      });
    });

    // --------------------------------------------------------------------------
    // Required tags: e, p, status
    // --------------------------------------------------------------------------
    describe('required tags', () => {
      it('[P1] creates e tag referencing request event ID', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const requestId = 'f'.repeat(64);
        const params = createJobFeedbackParams({ requestEventId: requestId });

        // Act
        const event = buildJobFeedbackEvent(params, secretKey);

        // Assert
        const eTag = event.tags.find((t: string[]) => t[0] === 'e');
        expect(eTag).toBeDefined();
        expect(eTag![1]).toBe(requestId);
      });

      it('[P1] creates p tag with customer pubkey', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const customerPk = 'e'.repeat(64);
        const params = createJobFeedbackParams({ customerPubkey: customerPk });

        // Act
        const event = buildJobFeedbackEvent(params, secretKey);

        // Assert
        const pTag = event.tags.find((t: string[]) => t[0] === 'p');
        expect(pTag).toBeDefined();
        expect(pTag![1]).toBe(customerPk);
      });

      it('[P1] creates status tag with status value', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams({
          status: 'success' as DvmJobStatus,
        });

        // Act
        const event = buildJobFeedbackEvent(params, secretKey);

        // Assert
        const statusTag = event.tags.find((t: string[]) => t[0] === 'status');
        expect(statusTag).toBeDefined();
        expect(statusTag![1]).toBe('success');
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-07 [P1]: Status values
    // --------------------------------------------------------------------------
    describe('DvmJobStatus values (T-5.1-07)', () => {
      it.each(['processing', 'error', 'success', 'partial'] as DvmJobStatus[])(
        '[P1] accepts valid status: %s',
        (status) => {
          // Arrange
          const secretKey = FIXED_BUILDER_SECRET_KEY;
          const params = createJobFeedbackParams({ status });

          // Act
          const event = buildJobFeedbackEvent(params, secretKey);

          // Assert
          const statusTag = event.tags.find((t: string[]) => t[0] === 'status');
          expect(statusTag).toBeDefined();
          expect(statusTag![1]).toBe(status);
        }
      );

      it('[P1] throws when status is invalid', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams({
          status: 'invalid-status' as DvmJobStatus,
        });

        // Act & Assert
        expect(() => buildJobFeedbackEvent(params, secretKey)).toThrow();
      });
    });

    // --------------------------------------------------------------------------
    // content field
    // --------------------------------------------------------------------------
    describe('content field', () => {
      it('sets content from params.content', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams({
          content: 'Error: model overloaded',
        });

        // Act
        const event = buildJobFeedbackEvent(params, secretKey);

        // Assert
        expect(event.content).toBe('Error: model overloaded');
      });

      it('defaults content to empty string when not provided', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams();
        delete (params as Record<string, unknown>)['content'];

        // Act
        const event = buildJobFeedbackEvent(params, secretKey);

        // Assert
        expect(event.content).toBe('');
      });
    });

    // --------------------------------------------------------------------------
    // Validation errors
    // --------------------------------------------------------------------------
    describe('validation errors', () => {
      it('[P1] throws when requestEventId is not 64-char hex', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams({
          requestEventId: 'not-valid',
        });

        // Act & Assert
        expect(() => buildJobFeedbackEvent(params, secretKey)).toThrow();
      });

      it('[P1] throws when customerPubkey is not 64-char hex', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams({
          customerPubkey: 'not-valid',
        });

        // Act & Assert
        expect(() => buildJobFeedbackEvent(params, secretKey)).toThrow();
      });
    });
  });

  // ==========================================================================
  // Gap-fill tests: i tag with marker but no relay (AC #1)
  // ==========================================================================

  describe('buildJobRequestEvent i tag with marker but no relay (AC #1 gap-fill)', () => {
    it('[P1] inserts empty relay placeholder when marker is set without relay', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({
        input: {
          data: 'test-data',
          type: 'text',
          marker: 'source',
          // no relay
        },
      });

      // Act
      const event = buildJobRequestEvent(params, secretKey);

      // Assert: i tag has ['i', data, type, '', marker]
      const iTag = event.tags.find((t: string[]) => t[0] === 'i');
      expect(iTag).toBeDefined();
      expect(iTag).toEqual(['i', 'test-data', 'text', '', 'source']);
      // Empty string placeholder at index 3 preserves NIP-90 positional format
      expect(iTag![3]).toBe('');
      expect(iTag![4]).toBe('source');
    });
  });

  // ==========================================================================
  // Gap-fill tests: ToonError code verification (AC #1, #2, #3)
  // ==========================================================================

  describe('ToonError codes on builder validation (AC #1-3 gap-fill)', () => {
    it('buildJobRequestEvent throws ToonError with DVM_INVALID_KIND code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({ kind: 4999 });

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_KIND');
      }
    });

    it('buildJobRequestEvent throws ToonError with DVM_INVALID_BID code for empty bid', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({ bid: '' });

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_BID');
      }
    });

    it('buildJobRequestEvent throws ToonError with DVM_MISSING_OUTPUT code for empty output', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({ output: '' });

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_MISSING_OUTPUT');
      }
    });

    it('buildJobRequestEvent throws ToonError with DVM_MISSING_INPUT code for empty input type', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({
        input: { data: 'test', type: '' },
      });

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_MISSING_INPUT');
      }
    });

    it('buildJobResultEvent throws ToonError with DVM_INVALID_KIND code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({ kind: 5999 });

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_KIND');
      }
    });

    it('buildJobResultEvent throws ToonError with DVM_INVALID_EVENT_ID code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({ requestEventId: 'too-short' });

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_EVENT_ID');
      }
    });

    it('buildJobResultEvent throws ToonError with DVM_INVALID_PUBKEY code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({ customerPubkey: 'invalid' });

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_PUBKEY');
      }
    });

    it('buildJobResultEvent throws ToonError with DVM_INVALID_AMOUNT code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({ amount: '' });

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_AMOUNT');
      }
    });

    it('buildJobFeedbackEvent throws ToonError with DVM_INVALID_STATUS code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobFeedbackParams({
        status: 'not-a-status' as DvmJobStatus,
      });

      // Act & Assert
      try {
        buildJobFeedbackEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_STATUS');
      }
    });

    it('buildJobFeedbackEvent throws ToonError with DVM_INVALID_EVENT_ID code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobFeedbackParams({ requestEventId: 'bad' });

      // Act & Assert
      try {
        buildJobFeedbackEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_EVENT_ID');
      }
    });

    it('buildJobFeedbackEvent throws ToonError with DVM_INVALID_PUBKEY code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobFeedbackParams({ customerPubkey: 'bad' });

      // Act & Assert
      try {
        buildJobFeedbackEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_PUBKEY');
      }
    });

    it('buildJobRequestEvent throws ToonError with DVM_INVALID_PUBKEY for invalid targetProvider', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({
        targetProvider: 'not-a-valid-hex-pubkey',
      });

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_PUBKEY');
      }
    });
  });

  // ==========================================================================
  // Gap-fill tests: bid/amount bigint-compatible string format (T-5.1-11)
  // ==========================================================================

  describe('bid/amount bigint-compatible format validation (T-5.1-11 gap-fill)', () => {
    it('bid value survives BigInt conversion (bigint-compatible)', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const bidValue = '1000000'; // 1 USDC in micro-units
      const params = createJobRequestParams({ bid: bidValue });

      // Act
      const event = buildJobRequestEvent(params, secretKey);
      const bidTag = event.tags.find((t: string[]) => t[0] === 'bid');

      // Assert: value can be parsed as BigInt
      expect(bidTag![1]).toBe('1000000');
      expect(() => BigInt(bidTag![1]!)).not.toThrow();
      expect(BigInt(bidTag![1]!)).toBe(1000000n);
    });

    it('amount value survives BigInt conversion (bigint-compatible)', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const amountValue = '500000'; // 0.5 USDC in micro-units
      const params = createJobResultParams({ amount: amountValue });

      // Act
      const event = buildJobResultEvent(params, secretKey);
      const amountTag = event.tags.find((t: string[]) => t[0] === 'amount');

      // Assert: value can be parsed as BigInt
      expect(amountTag![1]).toBe('500000');
      expect(() => BigInt(amountTag![1]!)).not.toThrow();
      expect(BigInt(amountTag![1]!)).toBe(500000n);
    });

    it('large bid value (max USDC supply range) is accepted as string', () => {
      // Arrange: Very large USDC amount -- 1 billion USDC in micro-units
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const largeBid = '1000000000000000'; // 10^15
      const params = createJobRequestParams({ bid: largeBid });

      // Act
      const event = buildJobRequestEvent(params, secretKey);
      const bidTag = event.tags.find((t: string[]) => t[0] === 'bid');

      // Assert
      expect(bidTag![1]).toBe(largeBid);
      expect(BigInt(bidTag![1]!)).toBe(1000000000000000n);
    });
  });

  // ==========================================================================
  // Gap-fill tests: Result kind = request kind + 1000 relationship (AC #2)
  // ==========================================================================

  describe('result kind = request kind + 1000 relationship (AC #2 gap-fill)', () => {
    it.each([
      [5100, 6100],
      [5200, 6200],
      [5300, 6300],
      [5302, 6302],
      [5000, 6000],
      [5999, 6999],
    ])('request kind %i maps to result kind %i', (requestKind, resultKind) => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const request = buildJobRequestEvent(
        createJobRequestParams({ kind: requestKind }),
        secretKey
      );
      const result = buildJobResultEvent(
        createJobResultParams({
          kind: resultKind,
          requestEventId: request.id,
        }),
        secretKey
      );

      // Assert: result kind = request kind + 1000
      expect(result.kind).toBe(request.kind + 1000);
    });
  });

  // ==========================================================================
  // Gap-fill tests: DVM_MISSING_CONTENT error code (AC #2)
  // ==========================================================================

  describe('buildJobResultEvent DVM_MISSING_CONTENT error code (AC #2 gap-fill)', () => {
    it('throws ToonError with DVM_MISSING_CONTENT when content is not a string', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams();
      // Force content to undefined to trigger non-string validation
      delete (params as Record<string, unknown>)['content'];

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_MISSING_CONTENT');
      }
    });
  });

  // ==========================================================================
  // Gap-fill tests: buildJobRequestEvent with non-string bid type (AC #1)
  // ==========================================================================

  describe('buildJobRequestEvent non-string bid type (AC #1 gap-fill)', () => {
    it('throws ToonError with DVM_INVALID_BID when bid is a number', () => {
      // Arrange: force bid to a numeric value (TypeScript won't prevent this at runtime)
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams();
      (params as Record<string, unknown>)['bid'] = 1000000;

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_BID');
      }
    });
  });

  // ==========================================================================
  // Gap-fill tests: buildJobResultEvent with non-string amount type (AC #2)
  // ==========================================================================

  describe('buildJobResultEvent non-string amount type (AC #2 gap-fill)', () => {
    it('throws ToonError with DVM_INVALID_AMOUNT when amount is a number', () => {
      // Arrange: force amount to a numeric value
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams();
      (params as Record<string, unknown>)['amount'] = 500000;

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_INVALID_AMOUNT');
      }
    });
  });

  // ==========================================================================
  // Edge cases (T-5.1-21) -- builder-specific
  // ==========================================================================

  describe('edge cases (T-5.1-21)', () => {
    it('[P2] handles empty content in job request', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({ content: '' });

      // Act
      const event = buildJobRequestEvent(params, secretKey);

      // Assert
      expect(event.content).toBe('');
      expect(verifyEvent(event)).toBe(true);
    });

    it('[P2] handles large content payload (>10KB)', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const largeContent = 'x'.repeat(15000); // 15KB
      const params = createJobResultParams({ content: largeContent });

      // Act
      const event = buildJobResultEvent(params, secretKey);

      // Assert
      expect(event.content).toBe(largeContent);
      expect(event.content.length).toBeGreaterThan(10000);
      expect(verifyEvent(event)).toBe(true);
    });

    it('[P2] handles many tags (>20)', () => {
      // Arrange: create request with many param tags
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const manyParams = Array.from({ length: 25 }, (_, i) => ({
        key: `param_${i}`,
        value: `value_${i}`,
      }));
      const params = createJobRequestParams({
        params: manyParams,
        targetProvider: 'c'.repeat(64),
        relays: ['wss://r1.example.com', 'wss://r2.example.com'],
      });

      // Act
      const event = buildJobRequestEvent(params, secretKey);

      // Assert: 3 required + 1 p + 25 params + 1 relays = 30 tags
      expect(event.tags.length).toBeGreaterThan(20);
      expect(verifyEvent(event)).toBe(true);
    });
  });
});
