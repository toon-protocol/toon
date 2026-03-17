/**
 * Tests for Story 5.1: DVM Event Kind Definitions (FR-DVM-1)
 *
 * Validates:
 * - buildJobRequestEvent() produces signed Kind 5xxx with NIP-90 tags (AC #1)
 * - buildJobResultEvent() produces signed Kind 6xxx with NIP-90 tags (AC #2)
 * - buildJobFeedbackEvent() produces signed Kind 7000 with NIP-90 tags (AC #3)
 * - DVM events survive TOON encode -> decode roundtrip (AC #4)
 * - shallowParseToon() extracts DVM event routing metadata (AC #5)
 * - DVM kind constants defined and exported (AC #6)
 * - Targeted vs open marketplace request detection via p tag (AC #7)
 *
 * Test IDs from test-design-epic-5.md:
 * - T-5.1-01 [P0]: Kind 5100 TOON roundtrip preserves all required + optional tags
 * - T-5.1-02 [P0]: Kind 6xxx TOON roundtrip preserves required tags + content
 * - T-5.1-03 [P0]: Kind 7000 TOON roundtrip preserves required tags + content
 * - T-5.1-04 [P0]: TOON shallow parser extracts kind for DVM events without full decode
 * - T-5.1-05 [P1]: Kind 5xxx missing `i` tag -> construction error; missing `bid` -> error
 * - T-5.1-06 [P1]: Kind 6xxx missing `e` tag -> construction error; missing `amount` -> error
 * - T-5.1-07 [P1]: Kind 7000 status values: processing/error/success/partial accepted; invalid rejected
 * - T-5.1-08 [P2]: Kind constants: TEXT_GENERATION_KIND=5100, etc.
 * - T-5.1-09 [P1]: NIP-90 `i` tag format: `['i', data, type, relay?, marker?]`
 * - T-5.1-10 [P2]: Targeted request: `p` tag = specific provider; no `p` = open marketplace
 * - T-5.1-11 [P1]: `bid`/`amount` in USDC micro-units as string
 * - T-5.1-12 [P0]: buildJobRequestEvent valid Schnorr signature
 * - T-5.1-13 [P0]: buildJobResultEvent valid Schnorr signature
 * - T-5.1-14 [P0]: buildJobFeedbackEvent valid Schnorr signature
 * - T-5.1-15 [P1]: Builder-parser roundtrip for job request
 * - T-5.1-16 [P1]: Builder-parser roundtrip for job result
 * - T-5.1-17 [P1]: Builder-parser roundtrip for job feedback
 * - T-5.1-18 [P1]: Kind range validation: 4999 and 6000 rejected for request builder
 * - T-5.1-19 [P1]: Kind range validation: 5999 and 7000 rejected for result builder
 * - T-5.1-20 [P1]: Parser returns null for wrong kind range, missing required tags
 * - T-5.1-21 [P2]: Edge cases: empty content, many tags (>20), large content (>10KB)
 * - T-5.1-22 [P1]: TOON roundtrip preserves tag order
 * - T-5.1-23 [P0]: Export verification from @crosstown/core
 * - T-5.1-24 [P2]: `relays` tag with multiple URLs preserved
 * - T-5.1-25 [P2]: Multiple `param` tags preserved
 */

import { describe, it, expect } from 'vitest';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  encodeEventToToon,
  decodeEventFromToon,
  shallowParseToon,
} from '../toon/index.js';
import { CrosstownError } from '../errors.js';

// DVM builders and parsers
import {
  buildJobRequestEvent,
  buildJobResultEvent,
  buildJobFeedbackEvent,
  parseJobRequest,
  parseJobResult,
  parseJobFeedback,
} from './dvm.js';
import type {
  JobRequestParams,
  JobResultParams,
  JobFeedbackParams,
  DvmJobStatus,
} from './dvm.js';

// DVM kind constants
import {
  JOB_REQUEST_KIND_BASE,
  JOB_RESULT_KIND_BASE,
  JOB_FEEDBACK_KIND,
  TEXT_GENERATION_KIND,
  IMAGE_GENERATION_KIND,
  TEXT_TO_SPEECH_KIND,
  TRANSLATION_KIND,
} from '../constants.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Fixed secret key for builder tests.
 * Used for event signing in builder test cases. Deterministic per project
 * testing rules (no random values in test fixtures).
 */
const FIXED_BUILDER_SECRET_KEY = new Uint8Array(32).fill(2);
const FIXED_BUILDER_PUBKEY = getPublicKey(FIXED_BUILDER_SECRET_KEY);

/**
 * Fixed secret key for parser test factories.
 * Used only for generating a valid pubkey in manually-constructed events
 * (not for signature verification). Deterministic per project testing rules.
 */
const FIXED_FACTORY_SECRET_KEY = new Uint8Array(32).fill(1);
const FIXED_FACTORY_PUBKEY = getPublicKey(FIXED_FACTORY_SECRET_KEY);

/**
 * Creates a valid JobRequestParams for testing.
 * Uses deterministic values for reproducible tests.
 */
function createJobRequestParams(
  overrides: Partial<JobRequestParams> = {}
): JobRequestParams {
  return {
    kind: 5100,
    input: { data: 'Summarize this article', type: 'text' },
    bid: '1000000', // 1 USDC in micro-units
    output: 'text/plain',
    content: '',
    ...overrides,
  };
}

/**
 * Creates a valid JobResultParams for testing.
 * Uses deterministic values for reproducible tests.
 */
function createJobResultParams(
  overrides: Partial<JobResultParams> = {}
): JobResultParams {
  return {
    kind: 6100,
    requestEventId: 'a'.repeat(64),
    customerPubkey: 'b'.repeat(64),
    amount: '500000', // 0.5 USDC in micro-units
    content: 'Here is the summary of the article...',
    ...overrides,
  };
}

/**
 * Creates a valid JobFeedbackParams for testing.
 * Uses deterministic values for reproducible tests.
 */
function createJobFeedbackParams(
  overrides: Partial<JobFeedbackParams> = {}
): JobFeedbackParams {
  return {
    requestEventId: 'a'.repeat(64),
    customerPubkey: 'b'.repeat(64),
    status: 'processing' as DvmJobStatus,
    content: 'Job is being processed...',
    ...overrides,
  };
}

/**
 * Creates a well-formed Kind 5xxx event for parser tests.
 * Constructs the event structure manually (without builder) so parser
 * tests can run independently of the builder.
 */
function createTestJobRequestEvent(
  overrides: Partial<{
    kind: number;
    content: string;
    tags: string[][];
  }> = {}
): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: FIXED_FACTORY_PUBKEY,
    kind: overrides.kind ?? 5100,
    content: overrides.content ?? '',
    tags: overrides.tags ?? [
      ['i', 'Summarize this article', 'text'],
      ['bid', '1000000', 'usdc'],
      ['output', 'text/plain'],
    ],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

/**
 * Creates a well-formed Kind 6xxx event for parser tests.
 */
function createTestJobResultEvent(
  overrides: Partial<{
    kind: number;
    content: string;
    tags: string[][];
  }> = {}
): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: FIXED_FACTORY_PUBKEY,
    kind: overrides.kind ?? 6100,
    content: overrides.content ?? 'Here is the result...',
    tags: overrides.tags ?? [
      ['e', 'a'.repeat(64)],
      ['p', 'b'.repeat(64)],
      ['amount', '500000', 'usdc'],
    ],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

/**
 * Creates a well-formed Kind 7000 event for parser tests.
 */
function createTestJobFeedbackEvent(
  overrides: Partial<{
    kind: number;
    content: string;
    tags: string[][];
  }> = {}
): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: FIXED_FACTORY_PUBKEY,
    kind: overrides.kind ?? 7000,
    content: overrides.content ?? 'Processing your request...',
    tags: overrides.tags ?? [
      ['e', 'a'.repeat(64)],
      ['p', 'b'.repeat(64)],
      ['status', 'processing'],
    ],
    created_at: Math.floor(Date.now() / 1000),
    sig: '0'.repeat(128),
  };
}

// ============================================================================
// Tests: DVM Kind Constants (AC #6)
// ============================================================================

describe('Story 5.1: DVM Event Kind Definitions', () => {
  // --------------------------------------------------------------------------
  // T-5.1-08 [P2]: Kind constants defined
  // --------------------------------------------------------------------------
  describe('DVM kind constants (T-5.1-08)', () => {
    it('[P2] JOB_REQUEST_KIND_BASE equals 5000', () => {
      expect(JOB_REQUEST_KIND_BASE).toBe(5000);
    });

    it('[P2] JOB_RESULT_KIND_BASE equals 6000', () => {
      expect(JOB_RESULT_KIND_BASE).toBe(6000);
    });

    it('[P2] JOB_FEEDBACK_KIND equals 7000', () => {
      expect(JOB_FEEDBACK_KIND).toBe(7000);
    });

    it('[P2] TEXT_GENERATION_KIND equals 5100 (reference DVM kind)', () => {
      expect(TEXT_GENERATION_KIND).toBe(5100);
    });

    it('[P2] IMAGE_GENERATION_KIND equals 5200', () => {
      expect(IMAGE_GENERATION_KIND).toBe(5200);
    });

    it('[P2] TEXT_TO_SPEECH_KIND equals 5300', () => {
      expect(TEXT_TO_SPEECH_KIND).toBe(5300);
    });

    it('[P2] TRANSLATION_KIND equals 5302', () => {
      expect(TRANSLATION_KIND).toBe(5302);
    });
  });

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
  // Tests: parseJobRequest (AC #1, #7)
  // ==========================================================================

  describe('parseJobRequest (AC #1, #7)', () => {
    // --------------------------------------------------------------------------
    // T-5.1-15 [P1]: Builder-parser roundtrip
    // --------------------------------------------------------------------------
    describe('builder-parser roundtrip (T-5.1-15)', () => {
      it('[P1] parseJobRequest() parses buildJobRequestEvent() output', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobRequestParams({
          kind: 5100,
          input: {
            data: 'test input',
            type: 'text',
            relay: 'wss://relay.example.com',
            marker: 'source',
          },
          bid: '5000000',
          output: 'text/plain',
          content: 'test content',
          targetProvider: 'c'.repeat(64),
          params: [{ key: 'temp', value: '0.5' }],
          relays: ['wss://r1.example.com', 'wss://r2.example.com'],
        });

        // Act
        const event = buildJobRequestEvent(params, secretKey);
        const parsed = parseJobRequest(event);

        // Assert
        expect(parsed).not.toBeNull();
        expect(parsed!.kind).toBe(5100);
        expect(parsed!.input.data).toBe('test input');
        expect(parsed!.input.type).toBe('text');
        expect(parsed!.input.relay).toBe('wss://relay.example.com');
        expect(parsed!.input.marker).toBe('source');
        expect(parsed!.bid).toBe('5000000');
        expect(parsed!.output).toBe('text/plain');
        expect(parsed!.content).toBe('test content');
        expect(parsed!.targetProvider).toBe('c'.repeat(64));
        expect(parsed!.params).toHaveLength(1);
        expect(parsed!.params[0]).toEqual({ key: 'temp', value: '0.5' });
        expect(parsed!.relays).toEqual([
          'wss://r1.example.com',
          'wss://r2.example.com',
        ]);
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-10 [P2]: Targeted vs open marketplace
    // --------------------------------------------------------------------------
    describe('targeted vs open marketplace (T-5.1-10)', () => {
      it('[P2] returns targetProvider when p tag is present', () => {
        // Arrange
        const providerPk = 'c'.repeat(64);
        const event = createTestJobRequestEvent({
          tags: [
            ['i', 'data', 'text'],
            ['bid', '1000000', 'usdc'],
            ['output', 'text/plain'],
            ['p', providerPk],
          ],
        });

        // Act
        const parsed = parseJobRequest(event);

        // Assert
        expect(parsed).not.toBeNull();
        expect(parsed!.targetProvider).toBe(providerPk);
      });

      it('[P2] targetProvider is undefined when p tag is absent (open marketplace)', () => {
        // Arrange
        const event = createTestJobRequestEvent(); // no p tag

        // Act
        const parsed = parseJobRequest(event);

        // Assert
        expect(parsed).not.toBeNull();
        expect(parsed!.targetProvider).toBeUndefined();
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-20 [P1]: Parser returns null for invalid events
    // --------------------------------------------------------------------------
    describe('parser rejection (T-5.1-20)', () => {
      it('[P1] returns null for kind outside 5000-5999 range', () => {
        // Arrange
        const event = createTestJobRequestEvent({ kind: 4999 });

        // Act
        const parsed = parseJobRequest(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when i tag is missing', () => {
        // Arrange
        const event = createTestJobRequestEvent({
          tags: [
            ['bid', '1000000', 'usdc'],
            ['output', 'text/plain'],
          ],
        });

        // Act
        const parsed = parseJobRequest(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when bid tag is missing', () => {
        // Arrange
        const event = createTestJobRequestEvent({
          tags: [
            ['i', 'data', 'text'],
            ['output', 'text/plain'],
          ],
        });

        // Act
        const parsed = parseJobRequest(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when output tag is missing', () => {
        // Arrange
        const event = createTestJobRequestEvent({
          tags: [
            ['i', 'data', 'text'],
            ['bid', '1000000', 'usdc'],
          ],
        });

        // Act
        const parsed = parseJobRequest(event);

        // Assert
        expect(parsed).toBeNull();
      });
    });
  });

  // ==========================================================================
  // Tests: parseJobResult (AC #2)
  // ==========================================================================

  describe('parseJobResult (AC #2)', () => {
    // --------------------------------------------------------------------------
    // T-5.1-16 [P1]: Builder-parser roundtrip
    // --------------------------------------------------------------------------
    describe('builder-parser roundtrip (T-5.1-16)', () => {
      it('[P1] parseJobResult() parses buildJobResultEvent() output', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobResultParams({
          kind: 6100,
          requestEventId: 'a'.repeat(64),
          customerPubkey: 'b'.repeat(64),
          amount: '750000',
          content: 'Generated text result',
        });

        // Act
        const event = buildJobResultEvent(params, secretKey);
        const parsed = parseJobResult(event);

        // Assert
        expect(parsed).not.toBeNull();
        expect(parsed!.kind).toBe(6100);
        expect(parsed!.requestEventId).toBe('a'.repeat(64));
        expect(parsed!.customerPubkey).toBe('b'.repeat(64));
        expect(parsed!.amount).toBe('750000');
        expect(parsed!.content).toBe('Generated text result');
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-20 [P1]: Parser returns null for invalid events
    // --------------------------------------------------------------------------
    describe('parser rejection (T-5.1-20)', () => {
      it('[P1] returns null for kind outside 6000-6999 range', () => {
        // Arrange
        const event = createTestJobResultEvent({ kind: 5999 });

        // Act
        const parsed = parseJobResult(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when e tag is missing', () => {
        // Arrange
        const event = createTestJobResultEvent({
          tags: [
            ['p', 'b'.repeat(64)],
            ['amount', '500000', 'usdc'],
          ],
        });

        // Act
        const parsed = parseJobResult(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when p tag is missing', () => {
        // Arrange
        const event = createTestJobResultEvent({
          tags: [
            ['e', 'a'.repeat(64)],
            ['amount', '500000', 'usdc'],
          ],
        });

        // Act
        const parsed = parseJobResult(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when amount tag is missing', () => {
        // Arrange
        const event = createTestJobResultEvent({
          tags: [
            ['e', 'a'.repeat(64)],
            ['p', 'b'.repeat(64)],
          ],
        });

        // Act
        const parsed = parseJobResult(event);

        // Assert
        expect(parsed).toBeNull();
      });
    });
  });

  // ==========================================================================
  // Tests: parseJobFeedback (AC #3)
  // ==========================================================================

  describe('parseJobFeedback (AC #3)', () => {
    // --------------------------------------------------------------------------
    // T-5.1-17 [P1]: Builder-parser roundtrip
    // --------------------------------------------------------------------------
    describe('builder-parser roundtrip (T-5.1-17)', () => {
      it('[P1] parseJobFeedback() parses buildJobFeedbackEvent() output', () => {
        // Arrange
        const secretKey = FIXED_BUILDER_SECRET_KEY;
        const params = createJobFeedbackParams({
          requestEventId: 'a'.repeat(64),
          customerPubkey: 'b'.repeat(64),
          status: 'success' as DvmJobStatus,
          content: 'Job completed successfully',
        });

        // Act
        const event = buildJobFeedbackEvent(params, secretKey);
        const parsed = parseJobFeedback(event);

        // Assert
        expect(parsed).not.toBeNull();
        expect(parsed!.requestEventId).toBe('a'.repeat(64));
        expect(parsed!.customerPubkey).toBe('b'.repeat(64));
        expect(parsed!.status).toBe('success');
        expect(parsed!.content).toBe('Job completed successfully');
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-07 [P1]: Status validation in parser
    // --------------------------------------------------------------------------
    describe('parser status validation (T-5.1-07)', () => {
      it('[P1] returns null when status tag has invalid value', () => {
        // Arrange
        const event = createTestJobFeedbackEvent({
          tags: [
            ['e', 'a'.repeat(64)],
            ['p', 'b'.repeat(64)],
            ['status', 'invalid-status'],
          ],
        });

        // Act
        const parsed = parseJobFeedback(event);

        // Assert
        expect(parsed).toBeNull();
      });
    });

    // --------------------------------------------------------------------------
    // T-5.1-20 [P1]: Parser returns null for invalid events
    // --------------------------------------------------------------------------
    describe('parser rejection (T-5.1-20)', () => {
      it('[P1] returns null for kind not equal to 7000', () => {
        // Arrange
        const event = createTestJobFeedbackEvent({ kind: 7001 });

        // Act
        const parsed = parseJobFeedback(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when e tag is missing', () => {
        // Arrange
        const event = createTestJobFeedbackEvent({
          tags: [
            ['p', 'b'.repeat(64)],
            ['status', 'processing'],
          ],
        });

        // Act
        const parsed = parseJobFeedback(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when p tag is missing', () => {
        // Arrange
        const event = createTestJobFeedbackEvent({
          tags: [
            ['e', 'a'.repeat(64)],
            ['status', 'processing'],
          ],
        });

        // Act
        const parsed = parseJobFeedback(event);

        // Assert
        expect(parsed).toBeNull();
      });

      it('[P1] returns null when status tag is missing', () => {
        // Arrange
        const event = createTestJobFeedbackEvent({
          tags: [
            ['e', 'a'.repeat(64)],
            ['p', 'b'.repeat(64)],
          ],
        });

        // Act
        const parsed = parseJobFeedback(event);

        // Assert
        expect(parsed).toBeNull();
      });
    });
  });

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
  // Tests: Edge Cases (AC #1-3)
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

  // ==========================================================================
  // Tests: Export Verification (AC #6)
  // ==========================================================================

  describe('export verification (T-5.1-23)', () => {
    it('[P0] DVM constants importable from @crosstown/core', async () => {
      // Arrange
      const core = await import('../index.js');

      // Assert: kind constants
      expect(core.JOB_REQUEST_KIND_BASE).toBe(5000);
      expect(core.JOB_RESULT_KIND_BASE).toBe(6000);
      expect(core.JOB_FEEDBACK_KIND).toBe(7000);
      expect(core.TEXT_GENERATION_KIND).toBe(5100);
      expect(core.IMAGE_GENERATION_KIND).toBe(5200);
      expect(core.TEXT_TO_SPEECH_KIND).toBe(5300);
      expect(core.TRANSLATION_KIND).toBe(5302);
    });

    it('[P0] DVM builder functions importable from @crosstown/core', async () => {
      // Arrange
      const core = await import('../index.js');

      // Assert: builder functions
      expect(typeof core.buildJobRequestEvent).toBe('function');
      expect(typeof core.buildJobResultEvent).toBe('function');
      expect(typeof core.buildJobFeedbackEvent).toBe('function');
    });

    it('[P0] DVM parser functions importable from @crosstown/core', async () => {
      // Arrange
      const core = await import('../index.js');

      // Assert: parser functions
      expect(typeof core.parseJobRequest).toBe('function');
      expect(typeof core.parseJobResult).toBe('function');
      expect(typeof core.parseJobFeedback).toBe('function');
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
  // Gap-fill tests: CrosstownError code verification (AC #1, #2, #3)
  // ==========================================================================

  describe('CrosstownError codes on builder validation (AC #1-3 gap-fill)', () => {
    it('buildJobRequestEvent throws CrosstownError with DVM_INVALID_KIND code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({ kind: 4999 });

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_KIND');
      }
    });

    it('buildJobRequestEvent throws CrosstownError with DVM_INVALID_BID code for empty bid', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({ bid: '' });

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_BID');
      }
    });

    it('buildJobRequestEvent throws CrosstownError with DVM_MISSING_OUTPUT code for empty output', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams({ output: '' });

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_MISSING_OUTPUT');
      }
    });

    it('buildJobRequestEvent throws CrosstownError with DVM_MISSING_INPUT code for empty input type', () => {
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
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_MISSING_INPUT');
      }
    });

    it('buildJobResultEvent throws CrosstownError with DVM_INVALID_KIND code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({ kind: 5999 });

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_KIND');
      }
    });

    it('buildJobResultEvent throws CrosstownError with DVM_INVALID_EVENT_ID code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({ requestEventId: 'too-short' });

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_EVENT_ID');
      }
    });

    it('buildJobResultEvent throws CrosstownError with DVM_INVALID_PUBKEY code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({ customerPubkey: 'invalid' });

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_PUBKEY');
      }
    });

    it('buildJobResultEvent throws CrosstownError with DVM_INVALID_AMOUNT code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams({ amount: '' });

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_AMOUNT');
      }
    });

    it('buildJobFeedbackEvent throws CrosstownError with DVM_INVALID_STATUS code', () => {
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
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_STATUS');
      }
    });

    it('buildJobFeedbackEvent throws CrosstownError with DVM_INVALID_EVENT_ID code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobFeedbackParams({ requestEventId: 'bad' });

      // Act & Assert
      try {
        buildJobFeedbackEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_EVENT_ID');
      }
    });

    it('buildJobFeedbackEvent throws CrosstownError with DVM_INVALID_PUBKEY code', () => {
      // Arrange
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobFeedbackParams({ customerPubkey: 'bad' });

      // Act & Assert
      try {
        buildJobFeedbackEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_PUBKEY');
      }
    });

    it('buildJobRequestEvent throws CrosstownError with DVM_INVALID_PUBKEY for invalid targetProvider', () => {
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
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_PUBKEY');
      }
    });
  });

  // ==========================================================================
  // Gap-fill tests: Parser lenient handling of malformed tags (AC #1-3, Task 3.4)
  // ==========================================================================

  describe('parser lenient handling of malformed tags (Task 3.4 gap-fill)', () => {
    it('parseJobRequest returns null when i tag has no data element', () => {
      // Arrange: i tag with only the tag name, no data or type
      const event = createTestJobRequestEvent({
        tags: [['i'], ['bid', '1000000', 'usdc'], ['output', 'text/plain']],
      });

      // Act
      const parsed = parseJobRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobRequest returns null when bid tag has empty amount value', () => {
      // Arrange: bid tag with empty string amount
      const event = createTestJobRequestEvent({
        tags: [
          ['i', 'data', 'text'],
          ['bid', '', 'usdc'],
          ['output', 'text/plain'],
        ],
      });

      // Act
      const parsed = parseJobRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobRequest returns null when output tag has empty MIME type', () => {
      // Arrange: output tag with empty string
      const event = createTestJobRequestEvent({
        tags: [
          ['i', 'data', 'text'],
          ['bid', '1000000', 'usdc'],
          ['output', ''],
        ],
      });

      // Act
      const parsed = parseJobRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobResult returns null when e tag has empty value', () => {
      // Arrange: e tag with empty string event ID
      const event = createTestJobResultEvent({
        tags: [
          ['e', ''],
          ['p', 'b'.repeat(64)],
          ['amount', '500000', 'usdc'],
        ],
      });

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobResult returns null when p tag has empty value', () => {
      // Arrange: p tag with empty string pubkey
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', ''],
          ['amount', '500000', 'usdc'],
        ],
      });

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobResult returns null when amount tag has empty value', () => {
      // Arrange: amount tag with empty string
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '', 'usdc'],
        ],
      });

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobFeedback returns null when e tag has empty value', () => {
      // Arrange
      const event = createTestJobFeedbackEvent({
        tags: [
          ['e', ''],
          ['p', 'b'.repeat(64)],
          ['status', 'processing'],
        ],
      });

      // Act
      const parsed = parseJobFeedback(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobFeedback returns null when p tag has empty value', () => {
      // Arrange
      const event = createTestJobFeedbackEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', ''],
          ['status', 'processing'],
        ],
      });

      // Act
      const parsed = parseJobFeedback(event);

      // Assert
      expect(parsed).toBeNull();
    });
  });

  // ==========================================================================
  // Gap-fill tests: Parser hex format validation for event IDs and pubkeys
  // (Review #3 M1/M2: parsers now validate hex format for consistency with builders)
  // ==========================================================================

  describe('parser hex format validation (Review #3 M1/M2)', () => {
    it('parseJobResult returns null when requestEventId is not 64-char hex', () => {
      // Arrange: e tag with non-hex value
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'not-a-valid-hex-event-id'],
          ['p', 'b'.repeat(64)],
          ['amount', '500000', 'usdc'],
        ],
      });

      // Act & Assert
      expect(parseJobResult(event)).toBeNull();
    });

    it('parseJobResult returns null when customerPubkey is not 64-char hex', () => {
      // Arrange: p tag with non-hex value
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          [
            'p',
            'NOT-A-VALID-HEX-PUBKEY!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
          ],
          ['amount', '500000', 'usdc'],
        ],
      });

      // Act & Assert
      expect(parseJobResult(event)).toBeNull();
    });

    it('parseJobFeedback returns null when requestEventId is not 64-char hex', () => {
      // Arrange: e tag with non-hex value
      const event = createTestJobFeedbackEvent({
        tags: [
          ['e', 'invalid-event-id'],
          ['p', 'b'.repeat(64)],
          ['status', 'processing'],
        ],
      });

      // Act & Assert
      expect(parseJobFeedback(event)).toBeNull();
    });

    it('parseJobFeedback returns null when customerPubkey is not 64-char hex', () => {
      // Arrange: p tag with non-hex value
      const event = createTestJobFeedbackEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'INVALID-PUBKEY-FORMAT'],
          ['status', 'processing'],
        ],
      });

      // Act & Assert
      expect(parseJobFeedback(event)).toBeNull();
    });

    it('parseJobRequest returns null when targetProvider p tag is not 64-char hex', () => {
      // Arrange: p tag with non-hex value
      const event = createTestJobRequestEvent({
        tags: [
          ['i', 'data', 'text'],
          ['bid', '1000000', 'usdc'],
          ['output', 'text/plain'],
          ['p', 'not-a-valid-hex-pubkey'],
        ],
      });

      // Act & Assert
      expect(parseJobRequest(event)).toBeNull();
    });

    it('parseJobRequest accepts valid 64-char hex targetProvider', () => {
      // Arrange: p tag with valid hex
      const event = createTestJobRequestEvent({
        tags: [
          ['i', 'data', 'text'],
          ['bid', '1000000', 'usdc'],
          ['output', 'text/plain'],
          ['p', 'c'.repeat(64)],
        ],
      });

      // Act
      const parsed = parseJobRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.targetProvider).toBe('c'.repeat(64));
    });
  });

  // ==========================================================================
  // Gap-fill tests: Parser accepts all four status values (AC #3, T-5.1-07)
  // ==========================================================================

  describe('parseJobFeedback accepts all four status values (T-5.1-07 gap-fill)', () => {
    it.each(['processing', 'error', 'success', 'partial'] as DvmJobStatus[])(
      '[P1] parseJobFeedback returns parsed result for status: %s',
      (status) => {
        // Arrange
        const event = createTestJobFeedbackEvent({
          tags: [
            ['e', 'a'.repeat(64)],
            ['p', 'b'.repeat(64)],
            ['status', status],
          ],
        });

        // Act
        const parsed = parseJobFeedback(event);

        // Assert
        expect(parsed).not.toBeNull();
        expect(parsed!.status).toBe(status);
      }
    );
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
  // Gap-fill tests: Parser with various kind boundary values (AC #1-3, Task 6.7)
  // ==========================================================================

  describe('parser kind boundary edge cases (Task 6.7 gap-fill)', () => {
    it('parseJobRequest returns null for kind 6000 (just above request range)', () => {
      // Arrange
      const event = createTestJobRequestEvent({ kind: 6000 });

      // Act & Assert
      expect(parseJobRequest(event)).toBeNull();
    });

    it('parseJobResult returns null for kind 7000 (just above result range)', () => {
      // Arrange
      const event = createTestJobResultEvent({ kind: 7000 });

      // Act & Assert
      expect(parseJobResult(event)).toBeNull();
    });

    it('parseJobFeedback returns null for kind 6999 (just below feedback kind)', () => {
      // Arrange
      const event = createTestJobFeedbackEvent({ kind: 6999 });

      // Act & Assert
      expect(parseJobFeedback(event)).toBeNull();
    });

    it('parseJobFeedback returns null for kind 7001 (just above feedback kind)', () => {
      // Arrange
      const event = createTestJobFeedbackEvent({ kind: 7001 });

      // Act & Assert
      expect(parseJobFeedback(event)).toBeNull();
    });

    it('parseJobRequest accepts kind 5000 (lower boundary)', () => {
      // Arrange
      const event = createTestJobRequestEvent({ kind: 5000 });

      // Act & Assert
      expect(parseJobRequest(event)).not.toBeNull();
    });

    it('parseJobRequest accepts kind 5999 (upper boundary)', () => {
      // Arrange
      const event = createTestJobRequestEvent({ kind: 5999 });

      // Act & Assert
      expect(parseJobRequest(event)).not.toBeNull();
    });

    it('parseJobResult accepts kind 6000 (lower boundary)', () => {
      // Arrange
      const event = createTestJobResultEvent({ kind: 6000 });

      // Act & Assert
      expect(parseJobResult(event)).not.toBeNull();
    });

    it('parseJobResult accepts kind 6999 (upper boundary)', () => {
      // Arrange
      const event = createTestJobResultEvent({ kind: 6999 });

      // Act & Assert
      expect(parseJobResult(event)).not.toBeNull();
    });
  });

  // ==========================================================================
  // Gap-fill tests: parseJobRequest handles param tags with missing elements
  // ==========================================================================

  describe('parseJobRequest param tag edge cases (gap-fill)', () => {
    it('skips param tags with missing value element', () => {
      // Arrange: param tag with only key, no value
      const event = createTestJobRequestEvent({
        tags: [
          ['i', 'data', 'text'],
          ['bid', '1000000', 'usdc'],
          ['output', 'text/plain'],
          ['param', 'temperature'], // missing value
          ['param', 'max_tokens', '1024'], // valid
        ],
      });

      // Act
      const parsed = parseJobRequest(event);

      // Assert: only the valid param tag is included
      expect(parsed).not.toBeNull();
      expect(parsed!.params).toHaveLength(1);
      expect(parsed!.params[0]).toEqual({ key: 'max_tokens', value: '1024' });
    });

    it('returns empty params array when no param tags present', () => {
      // Arrange
      const event = createTestJobRequestEvent();

      // Act
      const parsed = parseJobRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.params).toEqual([]);
    });

    it('returns empty relays array when no relays tag present', () => {
      // Arrange
      const event = createTestJobRequestEvent();

      // Act
      const parsed = parseJobRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.relays).toEqual([]);
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
    it('throws CrosstownError with DVM_MISSING_CONTENT when content is not a string', () => {
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
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_MISSING_CONTENT');
      }
    });
  });

  // ==========================================================================
  // Gap-fill tests: parseJobRequest with i tag missing type element (AC #1)
  // ==========================================================================

  describe('parseJobRequest i tag missing type element (AC #1 gap-fill)', () => {
    it('returns null when i tag has data but no type element', () => {
      // Arrange: i tag with only data, no type
      const event = createTestJobRequestEvent({
        tags: [
          ['i', 'data'],
          ['bid', '1000000', 'usdc'],
          ['output', 'text/plain'],
        ],
      });

      // Act
      const parsed = parseJobRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });
  });

  // ==========================================================================
  // Gap-fill tests: parseJobRequest with empty input data (AC #1)
  // ==========================================================================

  describe('parseJobRequest with empty input data (AC #1 gap-fill)', () => {
    it('accepts i tag with empty data string (valid per NIP-90)', () => {
      // Arrange: i tag with empty data is allowed
      const event = createTestJobRequestEvent({
        tags: [
          ['i', '', 'text'],
          ['bid', '1000000', 'usdc'],
          ['output', 'text/plain'],
        ],
      });

      // Act
      const parsed = parseJobRequest(event);

      // Assert: empty data is accepted (inputData !== undefined check passes)
      expect(parsed).not.toBeNull();
      expect(parsed!.input.data).toBe('');
    });
  });

  // ==========================================================================
  // Gap-fill tests: buildJobRequestEvent with non-string bid type (AC #1)
  // ==========================================================================

  describe('buildJobRequestEvent non-string bid type (AC #1 gap-fill)', () => {
    it('throws CrosstownError with DVM_INVALID_BID when bid is a number', () => {
      // Arrange: force bid to a numeric value (TypeScript won't prevent this at runtime)
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobRequestParams();
      (params as Record<string, unknown>)['bid'] = 1000000;

      // Act & Assert
      try {
        buildJobRequestEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_BID');
      }
    });
  });

  // ==========================================================================
  // Gap-fill tests: buildJobResultEvent with non-string amount type (AC #2)
  // ==========================================================================

  describe('buildJobResultEvent non-string amount type (AC #2 gap-fill)', () => {
    it('throws CrosstownError with DVM_INVALID_AMOUNT when amount is a number', () => {
      // Arrange: force amount to a numeric value
      const secretKey = FIXED_BUILDER_SECRET_KEY;
      const params = createJobResultParams();
      (params as Record<string, unknown>)['amount'] = 500000;

      // Act & Assert
      try {
        buildJobResultEvent(params, secretKey);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CrosstownError);
        expect((err as CrosstownError).code).toBe('DVM_INVALID_AMOUNT');
      }
    });
  });
});
