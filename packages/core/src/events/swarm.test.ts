/**
 * Unit Tests: Swarm Event Builders and Parsers (Story 6.2, Task 1)
 *
 * ATDD RED PHASE: These tests define the expected behavior of the swarm
 * event builders and parsers. All tests will FAIL until the production
 * code in swarm.ts is implemented.
 *
 * Test IDs (from test-design-epic-6.md):
 *   T-6.2-01 [P0]: Swarm request tags preserved through TOON encode/decode roundtrip
 *   T-6.2-12 [P2]: Non-swarm-aware provider participation (dual-publish)
 *   T-6.2-13 [P1]: Swarm event flows through standard SDK pipeline
 *
 * Follows existing patterns from:
 *   - dvm.ts builder/parser validation (kind range, hex validation, ToonError codes)
 *   - workflow.ts builder/parser structure
 */

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '../toon/index.js';
import { ToonError } from '../errors.js';
import {
  buildJobRequestEvent,
  parseJobRequest,
  JOB_FEEDBACK_KIND,
} from './dvm.js';

// These imports will FAIL until swarm.ts is created (RED PHASE)
import {
  buildSwarmRequestEvent,
  buildSwarmSelectionEvent,
  parseSwarmRequest,
  parseSwarmSelection,
} from './swarm.js';

import type { SwarmRequestParams, SwarmSelectionParams } from './swarm.js';

// ============================================================================
// Fixed Test Data (deterministic per project testing rules)
// ============================================================================

/** Fixed secret key for deterministic identity derivation (32 bytes) */
const TEST_SECRET_KEY = generateSecretKey();

/** Deterministic customer pubkey derived from test key */
const TEST_CUSTOMER_PUBKEY = getPublicKey(TEST_SECRET_KEY);

/** Deterministic swarm request event ID (for selection tests) */
const TEST_SWARM_REQUEST_ID = 'aa'.repeat(32);

/** Deterministic winning result event ID */
const TEST_WINNER_RESULT_ID = 'bb'.repeat(32);

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a valid SwarmRequestParams for testing.
 */
function createTestSwarmRequestParams(
  overrides: Partial<SwarmRequestParams> = {}
): SwarmRequestParams {
  return {
    kind: 5100,
    input: { data: 'Generate a poem about the ocean', type: 'text' },
    bid: '5000000',
    output: 'text/plain',
    maxProviders: 3,
    ...overrides,
  };
}

/**
 * Creates a valid SwarmSelectionParams for testing.
 */
function createTestSwarmSelectionParams(
  overrides: Partial<SwarmSelectionParams> = {}
): SwarmSelectionParams {
  return {
    swarmRequestEventId: TEST_SWARM_REQUEST_ID,
    winnerResultEventId: TEST_WINNER_RESULT_ID,
    customerPubkey: TEST_CUSTOMER_PUBKEY,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Swarm Event Builders and Parsers (Story 6.2, Task 1)', () => {
  // ==========================================================================
  // T-6.2-01 [P0]: Swarm request tags preserved through TOON roundtrip
  // ==========================================================================

  describe('swarm request TOON encode/decode roundtrip (T-6.2-01)', () => {
    it('[P0] swarm tag preserved through TOON encode/decode roundtrip', () => {
      // Arrange
      const params = createTestSwarmRequestParams({ maxProviders: 5 });

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert: swarm tag preserved
      const swarmTag = decoded.tags.find((t: string[]) => t[0] === 'swarm');
      expect(swarmTag).toBeDefined();
      expect(swarmTag![1]).toBe('5');
    });

    it('[P0] judge tag preserved through TOON encode/decode roundtrip', () => {
      // Arrange
      const params = createTestSwarmRequestParams({ judge: 'customer' });

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert: judge tag preserved
      const judgeTag = decoded.tags.find((t: string[]) => t[0] === 'judge');
      expect(judgeTag).toBeDefined();
      expect(judgeTag![1]).toBe('customer');
    });

    it('[P0] custom judge value preserved through roundtrip', () => {
      // Arrange
      const customJudgePubkey = 'dd'.repeat(32);
      const params = createTestSwarmRequestParams({
        judge: customJudgePubkey,
      });

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert
      const judgeTag = decoded.tags.find((t: string[]) => t[0] === 'judge');
      expect(judgeTag).toBeDefined();
      expect(judgeTag![1]).toBe(customJudgePubkey);
    });

    it('[P0] all standard DVM tags coexist with swarm/judge tags', () => {
      // Arrange
      const params = createTestSwarmRequestParams({
        maxProviders: 3,
        judge: 'customer',
        content: 'Please generate a poem',
        params: [{ key: 'style', value: 'haiku' }],
      });

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert: standard DVM tags present
      const iTag = decoded.tags.find((t: string[]) => t[0] === 'i');
      expect(iTag).toBeDefined();
      const bidTag = decoded.tags.find((t: string[]) => t[0] === 'bid');
      expect(bidTag).toBeDefined();
      const outputTag = decoded.tags.find((t: string[]) => t[0] === 'output');
      expect(outputTag).toBeDefined();

      // Assert: swarm-specific tags also present
      const swarmTag = decoded.tags.find((t: string[]) => t[0] === 'swarm');
      expect(swarmTag).toBeDefined();
      const judgeTag = decoded.tags.find((t: string[]) => t[0] === 'judge');
      expect(judgeTag).toBeDefined();
    });
  });

  // ==========================================================================
  // Swarm Request Builder Validation
  // ==========================================================================

  describe('buildSwarmRequestEvent validation', () => {
    it('produces a Kind 5xxx event with swarm and judge tags', () => {
      // Arrange
      const params = createTestSwarmRequestParams({ maxProviders: 3 });

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Assert
      expect(event.kind).toBe(5100);
      const swarmTag = event.tags.find((t: string[]) => t[0] === 'swarm');
      expect(swarmTag).toEqual(['swarm', '3']);
      const judgeTag = event.tags.find((t: string[]) => t[0] === 'judge');
      expect(judgeTag).toEqual(['judge', 'customer']);
    });

    it('defaults judge to "customer" when not specified', () => {
      // Arrange -- no judge field in params
      const params = createTestSwarmRequestParams();

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Assert
      const judgeTag = event.tags.find((t: string[]) => t[0] === 'judge');
      expect(judgeTag).toBeDefined();
      expect(judgeTag![1]).toBe('customer');
    });

    it('throws ToonError with DVM_SWARM_INVALID_MAX_PROVIDERS when maxProviders < 1', () => {
      // Arrange
      const params = createTestSwarmRequestParams({ maxProviders: 0 });

      // Act & Assert
      expect(() => buildSwarmRequestEvent(params, TEST_SECRET_KEY)).toThrow(
        ToonError
      );
      try {
        buildSwarmRequestEvent(params, TEST_SECRET_KEY);
      } catch (err) {
        expect((err as ToonError).code).toBe('DVM_SWARM_INVALID_MAX_PROVIDERS');
      }
    });

    it('throws ToonError with DVM_SWARM_INVALID_MAX_PROVIDERS when maxProviders is negative', () => {
      // Arrange
      const params = createTestSwarmRequestParams({ maxProviders: -1 });

      // Act & Assert
      expect(() => buildSwarmRequestEvent(params, TEST_SECRET_KEY)).toThrow(
        ToonError
      );
    });

    it('accepts maxProviders = 1 (minimum valid)', () => {
      // Arrange
      const params = createTestSwarmRequestParams({ maxProviders: 1 });

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Assert
      const swarmTag = event.tags.find((t: string[]) => t[0] === 'swarm');
      expect(swarmTag).toEqual(['swarm', '1']);
    });

    it('delegates to buildJobRequestEvent for base DVM tags', () => {
      // Arrange
      const params = createTestSwarmRequestParams({
        kind: 5100,
        input: { data: 'test input', type: 'text' },
        bid: '1000000',
        output: 'text/plain',
        maxProviders: 2,
      });

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Assert: base DVM tags are present
      const iTag = event.tags.find((t: string[]) => t[0] === 'i');
      expect(iTag).toBeDefined();
      expect(iTag![1]).toBe('test input');
      expect(iTag![2]).toBe('text');
      const bidTag = event.tags.find((t: string[]) => t[0] === 'bid');
      expect(bidTag).toBeDefined();
      expect(bidTag![1]).toBe('1000000');
    });

    it('propagates kind range validation from buildJobRequestEvent', () => {
      // Arrange -- kind out of 5xxx range
      const params = createTestSwarmRequestParams({ kind: 6100 });

      // Act & Assert
      expect(() => buildSwarmRequestEvent(params, TEST_SECRET_KEY)).toThrow(
        ToonError
      );
    });
  });

  // ==========================================================================
  // Swarm Request Parser
  // ==========================================================================

  describe('parseSwarmRequest', () => {
    it('parses a valid swarm request event', () => {
      // Arrange
      const params = createTestSwarmRequestParams({
        maxProviders: 4,
        judge: 'customer',
      });
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Act
      const parsed = parseSwarmRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.maxProviders).toBe(4);
      expect(parsed!.judge).toBe('customer');
      // Also check base fields
      expect(parsed!.kind).toBe(5100);
      expect(parsed!.bid).toBe('5000000');
    });

    it('returns null for non-swarm Kind 5xxx event (no swarm tag)', () => {
      // Arrange -- build a standard job request (no swarm tags)
      const event = buildJobRequestEvent(
        {
          kind: 5100,
          input: { data: 'test', type: 'text' },
          bid: '1000000',
          output: 'text/plain',
        },
        TEST_SECRET_KEY
      );

      // Act
      const parsed = parseSwarmRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('returns null for Kind 6xxx event', () => {
      // Arrange -- wrong kind range
      const event = buildSwarmRequestEvent(
        createTestSwarmRequestParams(),
        TEST_SECRET_KEY
      );
      // Mutate kind to be out of range (simulates bad data)
      const mutated = { ...event, kind: 6100 };

      // Act
      const parsed = parseSwarmRequest(mutated);

      // Assert
      expect(parsed).toBeNull();
    });

    it('extracts custom judge value', () => {
      // Arrange
      const customJudge = 'dd'.repeat(32);
      const params = createTestSwarmRequestParams({ judge: customJudge });
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Act
      const parsed = parseSwarmRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.judge).toBe(customJudge);
    });

    it('includes base ParsedJobRequest fields', () => {
      // Arrange
      const params = createTestSwarmRequestParams({
        input: {
          data: 'specific test data',
          type: 'text',
          relay: 'wss://relay.example.com',
        },
        params: [{ key: 'style', value: 'formal' }],
      });
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Act
      const parsed = parseSwarmRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.input.data).toBe('specific test data');
      expect(parsed!.input.relay).toBe('wss://relay.example.com');
      expect(parsed!.params).toEqual([{ key: 'style', value: 'formal' }]);
    });
  });

  // ==========================================================================
  // Swarm Selection Builder
  // ==========================================================================

  describe('buildSwarmSelectionEvent', () => {
    it('produces a Kind 7000 event with winner tag and e tag', () => {
      // Arrange
      const params = createTestSwarmSelectionParams();

      // Act
      const event = buildSwarmSelectionEvent(params, TEST_SECRET_KEY);

      // Assert
      expect(event.kind).toBe(JOB_FEEDBACK_KIND);
      const eTag = event.tags.find((t: string[]) => t[0] === 'e');
      expect(eTag).toBeDefined();
      expect(eTag![1]).toBe(TEST_SWARM_REQUEST_ID);
      const winnerTag = event.tags.find((t: string[]) => t[0] === 'winner');
      expect(winnerTag).toBeDefined();
      expect(winnerTag![1]).toBe(TEST_WINNER_RESULT_ID);
    });

    it('sets status tag to success', () => {
      // Arrange
      const params = createTestSwarmSelectionParams();

      // Act
      const event = buildSwarmSelectionEvent(params, TEST_SECRET_KEY);

      // Assert
      const statusTag = event.tags.find((t: string[]) => t[0] === 'status');
      expect(statusTag).toBeDefined();
      expect(statusTag![1]).toBe('success');
    });

    it('throws ToonError for invalid winnerResultEventId (not 64-char hex)', () => {
      // Arrange
      const params = createTestSwarmSelectionParams({
        winnerResultEventId: 'not-a-valid-hex',
      });

      // Act & Assert
      expect(() => buildSwarmSelectionEvent(params, TEST_SECRET_KEY)).toThrow(
        ToonError
      );
    });

    it('throws ToonError for invalid swarmRequestEventId', () => {
      // Arrange
      const params = createTestSwarmSelectionParams({
        swarmRequestEventId: 'invalid',
      });

      // Act & Assert
      expect(() => buildSwarmSelectionEvent(params, TEST_SECRET_KEY)).toThrow(
        ToonError
      );
    });
  });

  // ==========================================================================
  // Swarm Selection Parser
  // ==========================================================================

  describe('parseSwarmSelection', () => {
    it('parses a valid swarm selection event', () => {
      // Arrange
      const params = createTestSwarmSelectionParams();
      const event = buildSwarmSelectionEvent(params, TEST_SECRET_KEY);

      // Act
      const parsed = parseSwarmSelection(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.swarmRequestEventId).toBe(TEST_SWARM_REQUEST_ID);
      expect(parsed!.winnerResultEventId).toBe(TEST_WINNER_RESULT_ID);
    });

    it('returns null for Kind 7000 event without winner tag', () => {
      // Arrange -- a standard feedback event (no winner tag)
      const event = {
        id: '0'.repeat(64),
        pubkey: TEST_CUSTOMER_PUBKEY,
        created_at: 1700000000,
        kind: JOB_FEEDBACK_KIND,
        content: '',
        tags: [
          ['e', TEST_SWARM_REQUEST_ID],
          ['p', TEST_CUSTOMER_PUBKEY],
          ['status', 'success'],
        ],
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseSwarmSelection(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('returns null for non-7000 kind event', () => {
      // Arrange
      const params = createTestSwarmSelectionParams();
      const event = buildSwarmSelectionEvent(params, TEST_SECRET_KEY);
      const mutated = { ...event, kind: 5100 };

      // Act
      const parsed = parseSwarmSelection(mutated);

      // Assert
      expect(parsed).toBeNull();
    });

    it('returns null if winner tag value is not 64-char hex', () => {
      // Arrange
      const event = {
        id: '0'.repeat(64),
        pubkey: TEST_CUSTOMER_PUBKEY,
        created_at: 1700000000,
        kind: JOB_FEEDBACK_KIND,
        content: '',
        tags: [
          ['e', TEST_SWARM_REQUEST_ID],
          ['p', TEST_CUSTOMER_PUBKEY],
          ['status', 'success'],
          ['winner', 'not-valid-hex'],
        ],
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseSwarmSelection(event);

      // Assert
      expect(parsed).toBeNull();
    });
  });

  // ==========================================================================
  // Additional validation gap-fill tests
  // ==========================================================================

  describe('buildSwarmRequestEvent additional validation', () => {
    it('throws ToonError with DVM_SWARM_INVALID_MAX_PROVIDERS for fractional maxProviders < 1', () => {
      // Arrange -- fractional value below 1
      const params = createTestSwarmRequestParams({ maxProviders: 0.5 });

      // Act & Assert
      expect(() => buildSwarmRequestEvent(params, TEST_SECRET_KEY)).toThrow(
        ToonError
      );
      try {
        buildSwarmRequestEvent(params, TEST_SECRET_KEY);
      } catch (err) {
        expect((err as ToonError).code).toBe('DVM_SWARM_INVALID_MAX_PROVIDERS');
      }
    });

    it('throws ToonError with DVM_SWARM_INVALID_MAX_PROVIDERS for fractional maxProviders >= 1', () => {
      // Arrange -- fractional value >= 1 that parseInt would silently truncate
      const params = createTestSwarmRequestParams({ maxProviders: 1.5 });

      // Act & Assert: must be an integer
      expect(() => buildSwarmRequestEvent(params, TEST_SECRET_KEY)).toThrow(
        ToonError
      );
      try {
        buildSwarmRequestEvent(params, TEST_SECRET_KEY);
      } catch (err) {
        expect((err as ToonError).code).toBe('DVM_SWARM_INVALID_MAX_PROVIDERS');
      }
    });

    it('produces event with correct kind from params', () => {
      // Arrange: use kind 5200 instead of default 5100
      const params = createTestSwarmRequestParams({ kind: 5200 });

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Assert
      expect(event.kind).toBe(5200);
    });
  });

  describe('parseSwarmRequest edge cases', () => {
    it('returns null when swarm tag has no value (missing second element)', () => {
      // Arrange: manually construct event with malformed swarm tag
      const event = buildSwarmRequestEvent(
        createTestSwarmRequestParams(),
        TEST_SECRET_KEY
      );
      // Replace swarm tag with one missing the value
      const mutated = {
        ...event,
        tags: event.tags.map((t: string[]) =>
          t[0] === 'swarm' ? ['swarm'] : t
        ),
      };

      // Act
      const parsed = parseSwarmRequest(mutated);

      // Assert
      expect(parsed).toBeNull();
    });

    it('returns null when swarm tag value is non-numeric', () => {
      // Arrange
      const event = buildSwarmRequestEvent(
        createTestSwarmRequestParams(),
        TEST_SECRET_KEY
      );
      const mutated = {
        ...event,
        tags: event.tags.map((t: string[]) =>
          t[0] === 'swarm' ? ['swarm', 'abc'] : t
        ),
      };

      // Act
      const parsed = parseSwarmRequest(mutated);

      // Assert
      expect(parsed).toBeNull();
    });

    it('returns null when swarm tag value is "0"', () => {
      // Arrange: maxProviders=0 is invalid
      const event = buildSwarmRequestEvent(
        createTestSwarmRequestParams(),
        TEST_SECRET_KEY
      );
      const mutated = {
        ...event,
        tags: event.tags.map((t: string[]) =>
          t[0] === 'swarm' ? ['swarm', '0'] : t
        ),
      };

      // Act
      const parsed = parseSwarmRequest(mutated);

      // Assert
      expect(parsed).toBeNull();
    });

    it('defaults judge to "customer" when judge tag is missing', () => {
      // Arrange: build event then remove judge tag
      const event = buildSwarmRequestEvent(
        createTestSwarmRequestParams(),
        TEST_SECRET_KEY
      );
      const mutated = {
        ...event,
        tags: event.tags.filter((t: string[]) => t[0] !== 'judge'),
      };

      // Act
      const parsed = parseSwarmRequest(mutated);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.judge).toBe('customer');
    });
  });

  describe('parseSwarmSelection edge cases', () => {
    it('returns null when e tag is missing', () => {
      // Arrange: Kind 7000 with winner but no e tag
      const event = {
        id: '0'.repeat(64),
        pubkey: TEST_CUSTOMER_PUBKEY,
        created_at: 1700000000,
        kind: JOB_FEEDBACK_KIND,
        content: '',
        tags: [
          ['p', TEST_CUSTOMER_PUBKEY],
          ['status', 'success'],
          ['winner', TEST_WINNER_RESULT_ID],
        ],
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseSwarmSelection(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('returns null when e tag value is not 64-char hex', () => {
      // Arrange
      const event = {
        id: '0'.repeat(64),
        pubkey: TEST_CUSTOMER_PUBKEY,
        created_at: 1700000000,
        kind: JOB_FEEDBACK_KIND,
        content: '',
        tags: [
          ['e', 'not-valid-hex'],
          ['p', TEST_CUSTOMER_PUBKEY],
          ['status', 'success'],
          ['winner', TEST_WINNER_RESULT_ID],
        ],
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseSwarmSelection(event);

      // Assert
      expect(parsed).toBeNull();
    });
  });

  // ==========================================================================
  // T-6.2-12 [P2]: Non-swarm-aware provider participation
  // ==========================================================================

  describe('non-swarm-aware provider participation (T-6.2-12)', () => {
    it('[P2] swarm request event is parseable as a standard job request', () => {
      // Arrange -- the swarm request should also be parseable by parseJobRequest
      const params = createTestSwarmRequestParams({ maxProviders: 3 });
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Act -- parse as standard job request (non-swarm-aware path)
      const standardParsed = parseJobRequest(event);

      // Assert -- standard fields are extractable
      expect(standardParsed).not.toBeNull();
      expect(standardParsed!.kind).toBe(5100);
      expect(standardParsed!.input.data).toBe(
        'Generate a poem about the ocean'
      );
      expect(standardParsed!.bid).toBe('5000000');
      expect(standardParsed!.output).toBe('text/plain');
    });
  });

  // ==========================================================================
  // T-6.2-13 [P1]: Swarm event flows through standard SDK pipeline
  // ==========================================================================

  describe('swarm event pipeline compatibility (T-6.2-13)', () => {
    it('[P1] swarm request event has valid Nostr event structure (id, pubkey, sig, created_at)', () => {
      // Arrange
      const params = createTestSwarmRequestParams();

      // Act
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Assert -- standard Nostr event fields present
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(typeof event.created_at).toBe('number');
      expect(event.created_at).toBeGreaterThan(0);
    });

    it('[P1] swarm request TOON encodes without error', () => {
      // Arrange
      const params = createTestSwarmRequestParams();
      const event = buildSwarmRequestEvent(params, TEST_SECRET_KEY);

      // Act & Assert -- no exception thrown
      const toonBytes = encodeEventToToon(event);
      expect(toonBytes.length).toBeGreaterThan(0);
    });

    it('[P1] swarm selection event has valid Nostr event structure', () => {
      // Arrange
      const params = createTestSwarmSelectionParams();

      // Act
      const event = buildSwarmSelectionEvent(params, TEST_SECRET_KEY);

      // Assert
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(event.kind).toBe(JOB_FEEDBACK_KIND);
    });
  });
});
