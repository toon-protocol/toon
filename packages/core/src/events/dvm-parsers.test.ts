/**
 * Tests for DVM Parser Functions (Story 5.1, AC #1-3, #7)
 *
 * Split from dvm.test.ts during A4 (Epic 6 start).
 * Covers: parseJobRequest, parseJobResult, parseJobFeedback,
 * plus parser-specific gap-fill tests.
 *
 * Test IDs:
 * - T-5.1-15 [P1]: Builder-parser roundtrip for job request
 * - T-5.1-16 [P1]: Builder-parser roundtrip for job result
 * - T-5.1-17 [P1]: Builder-parser roundtrip for job feedback
 * - T-5.1-10 [P2]: Targeted vs open marketplace (parser side)
 * - T-5.1-20 [P1]: Parser returns null for wrong kind range, missing required tags
 * - T-5.1-07 [P1]: Parser status validation
 */

import { describe, it, expect } from 'vitest';
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
  FIXED_BUILDER_SECRET_KEY,
  createJobRequestParams,
  createJobResultParams,
  createJobFeedbackParams,
  createTestJobRequestEvent,
  createTestJobResultEvent,
  createTestJobFeedbackEvent,
} from './dvm-test-helpers.js';

describe('DVM parsers', () => {
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

    it('parseJobResult returns null when amount contains non-numeric characters', () => {
      // Arrange: amount with letters
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', 'not-a-number', 'usdc'],
        ],
      });

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobResult returns null when amount contains a decimal point', () => {
      // Arrange: USDC micro-units are integers, decimals not valid
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '500.50', 'usdc'],
        ],
      });

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobResult returns null when amount is negative', () => {
      // Arrange: negative amounts not valid
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '-500000', 'usdc'],
        ],
      });

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('parseJobResult accepts valid numeric amount string', () => {
      // Arrange: standard valid amount
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '500000', 'usdc'],
        ],
      });

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.amount).toBe('500000');
    });

    it('parseJobResult accepts zero amount', () => {
      // Arrange: zero is a valid numeric amount
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '0', 'usdc'],
        ],
      });

      // Act
      const parsed = parseJobResult(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.amount).toBe('0');
    });

    it('parseJobResult returns null when amount has trailing whitespace', () => {
      // Arrange: whitespace in amount string
      const event = createTestJobResultEvent({
        tags: [
          ['e', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
          ['amount', '500000 ', 'usdc'],
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
  // Gap-fill tests: Parser hex format validation (Review #3 M1/M2)
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
  // Gap-fill tests: parseJobFeedback accepts all four status values (T-5.1-07)
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
  // Gap-fill tests: Parser kind boundary edge cases (Task 6.7)
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
  // Gap-fill tests: parseJobRequest param tag edge cases
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
  // Gap-fill tests: parseJobRequest i tag missing type element (AC #1)
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
});
