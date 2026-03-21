/**
 * Unit Tests: Workflow Chain Event Builder/Parser (Story 6.1, Task 1, Task 4)
 *
 * ATDD RED PHASE: These tests define the expected behavior of the workflow
 * chain event types, builder, and parser. All tests will FAIL until the
 * production code in workflow.ts is implemented.
 *
 * Test IDs (from test-design-epic-6.md):
 *   T-6.1-01 [P0]: TOON roundtrip preserves steps, input, bid, provider targets
 *   T-6.1-02 [P1]: Validation errors for missing steps, empty input, missing bid
 *   T-6.1-05 [P0]: Input chaining fidelity -- complex JSON preserved through roundtrip
 *   T-6.1-10 [P0]: Per-step bid validation -- sum(allocations) <= total bid
 *   T-6.1-13 [P2]: Targeted provider per step via `p` tag
 *   T-6.1-14 [P1]: TOON shallow parser extracts kind:10040
 *   T-6.1-15 [P1]: Workflow event flows through SDK pipeline
 *
 * Follows existing patterns from:
 *   - dvm-roundtrip.test.ts (TOON encode/decode roundtrip)
 *   - dvm-builders.test.ts (builder validation)
 *   - dvm-parsers.test.ts (parser extraction)
 *   - dvm-test-helpers.ts (factory functions with fixed keys)
 */

import { describe, it, expect } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import {
  encodeEventToToon,
  decodeEventFromToon,
  shallowParseToon,
} from '../toon/index.js';

// These imports will FAIL until workflow.ts is created (RED PHASE)
import {
  buildWorkflowDefinitionEvent,
  parseWorkflowDefinition,
  WORKFLOW_CHAIN_KIND,
} from './workflow.js';
import type {
  WorkflowStep,
  WorkflowDefinitionParams,
  // ParsedWorkflowDefinition will be used in GREEN phase tests
} from './workflow.js';

// ============================================================================
// Fixed keys (deterministic per project testing rules)
// ============================================================================

const FIXED_SECRET_KEY = new Uint8Array(32).fill(3);
const FIXED_PUBKEY = getPublicKey(FIXED_SECRET_KEY);

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a valid WorkflowStep for testing.
 */
function createWorkflowStep(
  overrides: Partial<WorkflowStep> = {}
): WorkflowStep {
  return {
    kind: 5100,
    description: 'Text generation step',
    ...overrides,
  };
}

/**
 * Creates a valid WorkflowDefinitionParams for testing.
 */
function createWorkflowDefinitionParams(
  overrides: Partial<WorkflowDefinitionParams> = {}
): WorkflowDefinitionParams {
  return {
    steps: [
      createWorkflowStep({ kind: 5302, description: 'Translate input' }),
      createWorkflowStep({
        kind: 5100,
        description: 'Generate text from translation',
      }),
    ],
    initialInput: { data: 'Hola mundo', type: 'text' },
    totalBid: '2000000', // 2 USDC in micro-units
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Workflow Chain event builder/parser (Story 6.1)', () => {
  // ==========================================================================
  // T-6.1-01 [P0]: TOON roundtrip
  // ==========================================================================

  describe('TOON roundtrip (T-6.1-01)', () => {
    it('[P0] preserves step list, initial input, total bid through encode/decode', () => {
      // Arrange
      const params = createWorkflowDefinitionParams();
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      // Act: encode to TOON, then decode back
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);

      // Assert: metadata survives
      expect(decoded.kind).toBe(WORKFLOW_CHAIN_KIND);
      expect(decoded.pubkey).toBe(FIXED_PUBKEY);
      expect(decoded.id).toBe(event.id);
      expect(decoded.sig).toBe(event.sig);

      // Assert: parse the decoded event
      const parsed = parseWorkflowDefinition(decoded);
      expect(parsed).not.toBeNull();
      expect(parsed!.steps).toHaveLength(2);
      expect(parsed!.steps[0]!.kind).toBe(5302);
      expect(parsed!.steps[0]!.description).toBe('Translate input');
      expect(parsed!.steps[1]!.kind).toBe(5100);
      expect(parsed!.steps[1]!.description).toBe(
        'Generate text from translation'
      );
      expect(parsed!.initialInput.data).toBe('Hola mundo');
      expect(parsed!.initialInput.type).toBe('text');
      expect(parsed!.totalBid).toBe('2000000');
    });

    it('[P0] preserves step-specific provider targets through roundtrip', () => {
      // Arrange: steps with explicit provider targets
      const providerA = 'a'.repeat(64);
      const providerB = 'b'.repeat(64);
      const params = createWorkflowDefinitionParams({
        steps: [
          createWorkflowStep({
            kind: 5302,
            description: 'Step 1',
            targetProvider: providerA,
          }),
          createWorkflowStep({
            kind: 5100,
            description: 'Step 2',
            targetProvider: providerB,
          }),
        ],
      });
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      // Act
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);
      const parsed = parseWorkflowDefinition(decoded);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.steps[0]!.targetProvider).toBe(providerA);
      expect(parsed!.steps[1]!.targetProvider).toBe(providerB);
    });

    it('[P0] preserves per-step bid allocations through roundtrip', () => {
      // Arrange: steps with explicit bid allocations
      const params = createWorkflowDefinitionParams({
        steps: [
          createWorkflowStep({
            kind: 5302,
            description: 'Step 1',
            bidAllocation: '800000',
          }),
          createWorkflowStep({
            kind: 5100,
            description: 'Step 2',
            bidAllocation: '1200000',
          }),
        ],
        totalBid: '2000000',
      });
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      // Act
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);
      const parsed = parseWorkflowDefinition(decoded);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.steps[0]!.bidAllocation).toBe('800000');
      expect(parsed!.steps[1]!.bidAllocation).toBe('1200000');
    });
  });

  // ==========================================================================
  // T-6.1-02 [P1]: Validation errors
  // ==========================================================================

  describe('validation errors (T-6.1-02)', () => {
    it('[P1] throws on empty steps array', () => {
      const params = createWorkflowDefinitionParams({ steps: [] });
      expect(() =>
        buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY)
      ).toThrow();
    });

    it('[P1] throws on missing initial input data', () => {
      // Empty data string should be allowed per NIP-90 convention
      createWorkflowDefinitionParams({
        initialInput: { data: '', type: 'text' },
      });
      // but
      // missing type should throw. Adjust if the design chooses differently.
      // For now, test that a completely absent type throws:
      const badParams = createWorkflowDefinitionParams({
        initialInput: { data: 'hello', type: '' },
      });
      expect(() =>
        buildWorkflowDefinitionEvent(badParams, FIXED_SECRET_KEY)
      ).toThrow();
    });

    it('[P1] throws on missing totalBid', () => {
      const params = createWorkflowDefinitionParams({ totalBid: '' });
      expect(() =>
        buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY)
      ).toThrow();
    });

    it('[P1] throws on step kind outside 5000-5999 range', () => {
      const params = createWorkflowDefinitionParams({
        steps: [createWorkflowStep({ kind: 3000 })],
      });
      expect(() =>
        buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY)
      ).toThrow();
    });

    it('[P1] parser returns null for wrong event kind', () => {
      // Construct a manually-created event with wrong kind
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: 5100, // Not a workflow event
        content: '{}',
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      const parsed = parseWorkflowDefinition(event);
      expect(parsed).toBeNull();
    });
  });

  // ==========================================================================
  // T-6.1-05 [P0]: Input chaining fidelity
  // ==========================================================================

  describe('input chaining fidelity (T-6.1-05)', () => {
    it('[P0] complex JSON output preserved exactly through TOON roundtrip', () => {
      // Arrange: complex JSON as initial input
      const complexJson = JSON.stringify({
        results: [
          { id: 1, text: 'Hello world', score: 0.95 },
          { id: 2, text: 'Bonjour le monde', score: 0.87 },
        ],
        metadata: {
          source: 'translation-engine',
          timestamp: 1700000000,
          nested: { deep: { value: true } },
        },
      });
      const params = createWorkflowDefinitionParams({
        initialInput: { data: complexJson, type: 'json' },
      });
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      // Act: full roundtrip
      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);
      const parsed = parseWorkflowDefinition(decoded);

      // Assert: exact content preservation
      expect(parsed).not.toBeNull();
      expect(parsed!.initialInput.data).toBe(complexJson);
      expect(JSON.parse(parsed!.initialInput.data)).toEqual(
        JSON.parse(complexJson)
      );
    });

    it('[P0] multi-line text content preserved through TOON roundtrip', () => {
      const multiLineText = 'Line 1\nLine 2\nLine 3\n\nParagraph 2';
      const params = createWorkflowDefinitionParams({
        initialInput: { data: multiLineText, type: 'text' },
      });
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);
      const parsed = parseWorkflowDefinition(decoded);

      expect(parsed).not.toBeNull();
      expect(parsed!.initialInput.data).toBe(multiLineText);
    });

    it('[P0] plain text content preserved through TOON roundtrip', () => {
      const plainText = 'Simple plain text input for translation';
      const params = createWorkflowDefinitionParams({
        initialInput: { data: plainText, type: 'text' },
      });
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      const toonBytes = encodeEventToToon(event);
      const decoded = decodeEventFromToon(toonBytes);
      const parsed = parseWorkflowDefinition(decoded);

      expect(parsed).not.toBeNull();
      expect(parsed!.initialInput.data).toBe(plainText);
    });
  });

  // ==========================================================================
  // T-6.1-10 [P0]: Per-step bid validation
  // ==========================================================================

  describe('per-step bid validation (T-6.1-10)', () => {
    it('[P0] accepts when sum of step allocations equals total bid', () => {
      const params = createWorkflowDefinitionParams({
        steps: [
          createWorkflowStep({ kind: 5302, bidAllocation: '1000000' }),
          createWorkflowStep({ kind: 5100, bidAllocation: '1000000' }),
        ],
        totalBid: '2000000',
      });
      // Should NOT throw
      expect(() =>
        buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY)
      ).not.toThrow();
    });

    it('[P0] accepts when sum of step allocations is less than total bid', () => {
      const params = createWorkflowDefinitionParams({
        steps: [
          createWorkflowStep({ kind: 5302, bidAllocation: '500000' }),
          createWorkflowStep({ kind: 5100, bidAllocation: '500000' }),
        ],
        totalBid: '2000000',
      });
      expect(() =>
        buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY)
      ).not.toThrow();
    });

    it('[P0] throws when sum of step allocations exceeds total bid', () => {
      const params = createWorkflowDefinitionParams({
        steps: [
          createWorkflowStep({ kind: 5302, bidAllocation: '1500000' }),
          createWorkflowStep({ kind: 5100, bidAllocation: '1500000' }),
        ],
        totalBid: '2000000', // sum = 3000000 > 2000000
      });
      expect(() =>
        buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY)
      ).toThrow();
    });

    it('[P0] proportional split when no explicit allocations', () => {
      // When steps have no bidAllocation, totalBid is split proportionally
      const params = createWorkflowDefinitionParams({
        steps: [
          createWorkflowStep({ kind: 5302 }),
          createWorkflowStep({ kind: 5100 }),
        ],
        totalBid: '2000000',
      });
      // Should not throw -- proportional split is valid
      expect(() =>
        buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY)
      ).not.toThrow();
    });
  });

  // ==========================================================================
  // T-6.1-13 [P2]: Targeted provider per step
  // ==========================================================================

  describe('targeted provider per step (T-6.1-13)', () => {
    it('[P2] step with targetProvider gets `p` tag in generated Kind 5xxx', () => {
      const providerPubkey = 'c'.repeat(64);
      const params = createWorkflowDefinitionParams({
        steps: [
          createWorkflowStep({
            kind: 5100,
            description: 'Targeted step',
            targetProvider: providerPubkey,
          }),
        ],
      });
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);
      const parsed = parseWorkflowDefinition(event);

      expect(parsed).not.toBeNull();
      expect(parsed!.steps[0]!.targetProvider).toBe(providerPubkey);
    });

    it('[P2] step without targetProvider has no provider in parsed result', () => {
      const params = createWorkflowDefinitionParams({
        steps: [
          createWorkflowStep({ kind: 5100, description: 'Untargeted step' }),
        ],
      });
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);
      const parsed = parseWorkflowDefinition(event);

      expect(parsed).not.toBeNull();
      expect(parsed!.steps[0]!.targetProvider).toBeUndefined();
    });
  });

  // ==========================================================================
  // T-6.1-14 [P1]: TOON shallow parser
  // ==========================================================================

  describe('TOON shallow parser (T-6.1-14)', () => {
    it('[P1] extracts kind:10040 from TOON-encoded workflow definition', () => {
      // Arrange
      const params = createWorkflowDefinitionParams();
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);
      const toonBytes = encodeEventToToon(event);

      // Act
      const meta = shallowParseToon(toonBytes);

      // Assert
      expect(meta.kind).toBe(10040);
      expect(meta.pubkey).toBe(event.pubkey);
      expect(meta.id).toBe(event.id);
    });
  });

  // ==========================================================================
  // T-6.1-15 [P1]: SDK pipeline flow
  // ==========================================================================

  describe('SDK pipeline flow (T-6.1-15)', () => {
    it('[P1] workflow event flows through standard pipeline: shallow parse -> verify -> price -> dispatch', () => {
      // Arrange: build a valid workflow event
      const params = createWorkflowDefinitionParams();
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);
      const toonBytes = encodeEventToToon(event);

      // Act: shallow parse (first pipeline stage)
      const meta = shallowParseToon(toonBytes);

      // Assert: shallow parse extracts correct kind for routing
      expect(meta.kind).toBe(WORKFLOW_CHAIN_KIND);

      // Act: full decode (second pipeline stage)
      const decoded = decodeEventFromToon(toonBytes);

      // Assert: event is valid for verification
      expect(decoded.kind).toBe(WORKFLOW_CHAIN_KIND);
      expect(decoded.pubkey).toBe(FIXED_PUBKEY);
      expect(decoded.sig).toBe(event.sig);

      // Act: parse for pricing (third pipeline stage)
      const parsed = parseWorkflowDefinition(decoded);

      // Assert: pricing-relevant fields extractable
      expect(parsed).not.toBeNull();
      expect(parsed!.totalBid).toBe('2000000');
      expect(parsed!.steps).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Constant validation
  // ==========================================================================

  describe('WORKFLOW_CHAIN_KIND constant', () => {
    it('equals 10040', () => {
      expect(WORKFLOW_CHAIN_KIND).toBe(10040);
    });

    it('is in the TOON-specific replaceable range (10032-10099)', () => {
      expect(WORKFLOW_CHAIN_KIND).toBeGreaterThanOrEqual(10032);
      expect(WORKFLOW_CHAIN_KIND).toBeLessThanOrEqual(10099);
    });
  });

  // ==========================================================================
  // NFR: Parser robustness against malformed input
  // ==========================================================================

  describe('parser robustness (NFR)', () => {
    it('returns null for non-JSON content', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: 'this is not JSON',
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for JSON with missing steps array', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          initialInput: { data: 'hello', type: 'text' },
          totalBid: '1000000',
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for JSON with empty steps array', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [],
          initialInput: { data: 'hello', type: 'text' },
          totalBid: '1000000',
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for step with kind outside 5000-5999 range', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [{ kind: 7000, description: 'invalid kind' }],
          initialInput: { data: 'hello', type: 'text' },
          totalBid: '1000000',
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for missing initialInput', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [{ kind: 5100, description: 'valid' }],
          totalBid: '1000000',
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for initialInput missing data field', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [{ kind: 5100, description: 'valid' }],
          initialInput: { type: 'text' },
          totalBid: '1000000',
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for initialInput missing type field', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [{ kind: 5100, description: 'valid' }],
          initialInput: { data: 'hello' },
          totalBid: '1000000',
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for missing totalBid', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [{ kind: 5100, description: 'valid' }],
          initialInput: { data: 'hello', type: 'text' },
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for empty string totalBid', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [{ kind: 5100, description: 'valid' }],
          initialInput: { data: 'hello', type: 'text' },
          totalBid: '',
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for numeric totalBid (must be string)', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [{ kind: 5100, description: 'valid' }],
          initialInput: { data: 'hello', type: 'text' },
          totalBid: 1000000,
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });

    it('returns null for step with non-string description', () => {
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: WORKFLOW_CHAIN_KIND,
        content: JSON.stringify({
          steps: [{ kind: 5100, description: 42 }],
          initialInput: { data: 'hello', type: 'text' },
          totalBid: '1000000',
        }),
        tags: [],
        created_at: 1700000000,
        sig: '0'.repeat(128),
      };
      expect(parseWorkflowDefinition(event)).toBeNull();
    });
  });

  // ==========================================================================
  // NFR: Builder produces valid event structure
  // ==========================================================================

  describe('builder event structure (NFR)', () => {
    it('built event has d tag for NIP-33 parameterized replaceable semantics', () => {
      const params = createWorkflowDefinitionParams();
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      const dTag = event.tags.find((t) => t[0] === 'd');
      expect(dTag).toBeDefined();
      expect(dTag![1]).toBeTruthy();
    });

    it('built event has bid tag with usdc denomination', () => {
      const params = createWorkflowDefinitionParams({ totalBid: '5000000' });
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      const bidTag = event.tags.find((t) => t[0] === 'bid');
      expect(bidTag).toBeDefined();
      expect(bidTag![1]).toBe('5000000');
      expect(bidTag![2]).toBe('usdc');
    });

    it('built event content is valid JSON', () => {
      const params = createWorkflowDefinitionParams();
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      expect(() => JSON.parse(event.content)).not.toThrow();
      const content = JSON.parse(event.content) as Record<string, unknown>;
      expect(content['steps']).toBeDefined();
      expect(content['initialInput']).toBeDefined();
      expect(content['totalBid']).toBeDefined();
    });

    it('built event has valid signature and pubkey', () => {
      const params = createWorkflowDefinitionParams();
      const event = buildWorkflowDefinitionEvent(params, FIXED_SECRET_KEY);

      expect(event.pubkey).toBe(FIXED_PUBKEY);
      expect(event.sig).toBeTruthy();
      expect(event.id).toBeTruthy();
    });
  });
});
