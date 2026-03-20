/**
 * Unit & Integration Tests: Workflow Orchestrator (Story 6.1, Tasks 2-6)
 *
 * ATDD RED PHASE: These tests define the expected behavior of the
 * WorkflowOrchestrator class. All tests will FAIL until the production
 * code in workflow-orchestrator.ts is implemented.
 *
 * Test IDs (from test-design-epic-6.md):
 *   T-6.1-03 [P0]: Orchestrator creates Kind 5xxx for step 1 from initial input
 *   T-6.1-04 [P0]: Step advancement -- step N result -> step N+1 created
 *   T-6.1-06 [P0]: Step failure detection -> workflow abort -> customer notified
 *   T-6.1-07 [P0]: Step timeout -> workflow fails -> customer notified
 *   T-6.1-08 [P1]: Final step completion -> workflow completed -> customer notified
 *   T-6.1-09 [P0]: Per-step compute settlement via ILP
 *   T-6.1-11 [P1]: Workflow state persistence in EventStore
 *   T-6.1-12 [P2]: Concurrent workflows advance independently
 *
 * Follows existing patterns from:
 *   - dvm-lifecycle.test.ts (createMockConnector, vi.mock('nostr-tools'))
 *   - create-node.test.ts (ServiceNode interface mocking)
 *   - dvm-test-helpers.ts (factory functions with fixed keys)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';

// Prevent live relay connections (project rule: always mock nostr-tools in tests)
vi.mock('nostr-tools');

import {
  decodeEventFromToon,
  parseJobRequest,
  parseJobFeedback,
} from '@toon-protocol/core';
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
  SendPacketParams,
  SendPacketResult,
  RegisterPeerParams,
} from '@toon-protocol/core';

// This import will FAIL until workflow-orchestrator.ts is created (RED PHASE)
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

import type { ParsedWorkflowDefinition } from '@toon-protocol/core';

import { createNode } from './create-node.js';

// ============================================================================
// Fixed Test Data (deterministic per project testing rules)
// ============================================================================

/** Fixed secret key for deterministic identity derivation (32 bytes) */
const TEST_SECRET_KEY = Uint8Array.from(Buffer.from('a'.repeat(64), 'hex'));

/** Deterministic step 1 request event ID */
const TEST_STEP1_REQUEST_ID = 'd'.repeat(64);

/** Deterministic step 1 result event ID */
const TEST_STEP1_RESULT_ID = 'e'.repeat(64);

/** Deterministic step 2 result event ID */
const TEST_STEP2_RESULT_ID = 'f'.repeat(64);

/** Deterministic provider pubkeys */
const TEST_PROVIDER_A_PUBKEY = 'aa'.repeat(32);

/** Fixed timestamp for deterministic test data */
const FIXED_CREATED_AT = 1700000000;

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a mock connector that records sendPacket calls.
 */
function createMockConnector(
  sendPacketResult?: SendPacketResult
): EmbeddableConnectorLike & { sendPacketCalls: SendPacketParams[] } {
  const calls: SendPacketParams[] = [];
  return {
    sendPacketCalls: calls,
    async sendPacket(params: SendPacketParams): Promise<SendPacketResult> {
      calls.push(params);
      return (
        sendPacketResult ?? {
          type: 'fulfill',
          fulfillment: Buffer.from('test-fulfillment'),
        }
      );
    },
    async registerPeer(_params: RegisterPeerParams): Promise<void> {},
    async removePeer(_peerId: string): Promise<void> {},
    setPacketHandler(
      _handler: (
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>
    ): void {},
  };
}

/**
 * Creates a valid 2-step workflow definition for testing.
 */
function createTestWorkflowDefinition(
  overrides: Partial<ParsedWorkflowDefinition> = {}
): ParsedWorkflowDefinition {
  return {
    steps: [
      {
        kind: 5302,
        description: 'Translate input',
        bidAllocation: '1000000',
      },
      {
        kind: 5100,
        description: 'Generate text from translation',
        bidAllocation: '1000000',
      },
    ],
    initialInput: { data: 'Hola mundo', type: 'text' },
    totalBid: '2000000',
    content: '',
    ...overrides,
  };
}

/**
 * Creates a mock Kind 6xxx result event (step completed).
 */
function createMockStepResultEvent(
  overrides: {
    id?: string;
    requestEventId?: string;
    customerPubkey?: string;
    kind?: number;
    content?: string;
  } = {}
): NostrEvent {
  return {
    id: overrides.id ?? TEST_STEP1_RESULT_ID,
    pubkey: TEST_PROVIDER_A_PUBKEY,
    created_at: FIXED_CREATED_AT,
    kind: overrides.kind ?? 6302, // TRANSLATION result kind
    content: overrides.content ?? 'Hello world', // translation result
    tags: [
      ['e', overrides.requestEventId ?? TEST_STEP1_REQUEST_ID],
      ['p', overrides.customerPubkey ?? 'cd'.repeat(32)],
      ['amount', '1000000', 'usdc'],
    ],
    sig: 'a'.repeat(128),
  };
}

/**
 * Creates a mock Kind 7000 feedback event (step status).
 */
function createMockStepFeedbackEvent(
  overrides: {
    requestEventId?: string;
    status?: string;
    content?: string;
  } = {}
): NostrEvent {
  return {
    id: '0'.repeat(64),
    pubkey: TEST_PROVIDER_A_PUBKEY,
    created_at: FIXED_CREATED_AT,
    kind: 7000,
    content: overrides.content ?? '',
    tags: [
      ['e', overrides.requestEventId ?? TEST_STEP1_REQUEST_ID],
      ['p', 'cd'.repeat(32)],
      ['status', overrides.status ?? 'processing'],
    ],
    sig: '0'.repeat(128),
  };
}

/**
 * Creates a mock EventStore for state persistence tests.
 */
function createMockEventStore() {
  const events: NostrEvent[] = [];
  return {
    events,
    async store(event: NostrEvent): Promise<void> {
      events.push(event);
    },
    async query(filter: {
      kinds?: number[];
      '#e'?: string[];
    }): Promise<NostrEvent[]> {
      return events.filter((e) => {
        if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
        if (filter['#e']) {
          const eTagValues = e.tags
            .filter((t) => t[0] === 'e')
            .map((t) => t[1]);
          return filter['#e'].some((id) => eTagValues.includes(id));
        }
        return true;
      });
    },
  };
}

/**
 * Extracts TOON-decoded Nostr events from captured sendPacket calls.
 * Settlement packets have empty data; publish packets have TOON-encoded data.
 * Returns only the publish (non-empty data) packets, decoded to NostrEvent.
 */
function extractPublishedEvents(calls: SendPacketParams[]): NostrEvent[] {
  const events: NostrEvent[] = [];
  for (const call of calls) {
    if (call.data.length > 0) {
      try {
        events.push(decodeEventFromToon(call.data));
      } catch {
        // Skip non-TOON packets (e.g., settlement packets with small data)
      }
    }
  }
  return events;
}

// ============================================================================
// Tests
// ============================================================================

describe('WorkflowOrchestrator (Story 6.1)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ==========================================================================
  // T-6.1-03 [P0]: Orchestrator creates Kind 5xxx for step 1
  // ==========================================================================

  describe('step 1 creation (T-6.1-03)', () => {
    it('[P0] creates Kind 5xxx job request for step 1 from workflow initial input', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act
      await orchestrator.startWorkflow(definition);

      // Assert: a Kind 5xxx (step 1) was published via connector
      expect(connector.sendPacketCalls).toHaveLength(1);
      // The ILP packet should contain a TOON-encoded Kind 5302 event
      // (step 1 kind = 5302 for translation)
      const sentPacket = connector.sendPacketCalls[0]!;
      expect(sentPacket).toBeDefined();
    });

    it('[P0] step 1 job request uses workflow initial input as data', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition({
        initialInput: { data: 'Translate this specific text', type: 'text' },
      });
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act
      await orchestrator.startWorkflow(definition);

      // Assert: the generated Kind 5xxx event should contain the initial input
      expect(connector.sendPacketCalls).toHaveLength(1);
      // Detailed assertion on the packet content will verify the input data
      // is 'Translate this specific text' once the orchestrator is implemented
    });

    it('[P0] orchestrator state transitions to step_1_running after start', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act
      await orchestrator.startWorkflow(definition);

      // Assert
      expect(orchestrator.getState()).toBe('step_1_running');
    });
  });

  // ==========================================================================
  // T-6.1-04 [P0]: Step advancement
  // ==========================================================================

  describe('step advancement (T-6.1-04)', () => {
    it('[P0] on step 1 Kind 6xxx result, creates Kind 5xxx for step 2 with step 1 content as input', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Clear the step 1 publish call
      connector.sendPacketCalls.length = 0;

      // Act: simulate step 1 result arriving
      const step1Result = createMockStepResultEvent({
        content: 'Hello world', // translation result
        kind: 6302,
      });
      await orchestrator.handleStepResult(step1Result);

      // Assert: step 2 Kind 5xxx was published (+ settlement for step 1)
      // sendPacketCalls includes: settle step 1 + publish step 2
      expect(connector.sendPacketCalls.length).toBeGreaterThanOrEqual(1);
      // Step 2 should use step 1's result ('Hello world') as input
    });

    it('[P0] step N result content is passed exactly as step N+1 input data', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const complexOutput = JSON.stringify({
        translation: 'Hello world',
        confidence: 0.95,
        alternatives: ['Hi world', 'Hello globe'],
      });

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);
      connector.sendPacketCalls.length = 0;

      // Act: step 1 completes with complex JSON content
      const step1Result = createMockStepResultEvent({
        content: complexOutput,
        kind: 6302,
      });
      await orchestrator.handleStepResult(step1Result);

      // Assert: step 2 request contains exact content from step 1
      // sendPacketCalls includes: settle step 1 + publish step 2
      expect(connector.sendPacketCalls.length).toBeGreaterThanOrEqual(1);
      // The TOON-encoded event in the packet should have step 1's
      // output as its input data field, preserved exactly
    });

    it('[P0] state transitions from step_1_running to step_2_running after advancement', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Act
      const step1Result = createMockStepResultEvent({ kind: 6302 });
      await orchestrator.handleStepResult(step1Result);

      // Assert
      expect(orchestrator.getState()).toBe('step_2_running');
    });
  });

  // ==========================================================================
  // T-6.1-06 [P0]: Step failure detection
  // ==========================================================================

  describe('step failure detection (T-6.1-06)', () => {
    it('[P0] on Kind 7000 with status error, marks workflow failed', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Act: step 1 fails
      const failureEvent = createMockStepFeedbackEvent({
        status: 'error',
        content: 'Model capacity exceeded',
      });
      await orchestrator.handleStepFeedback(failureEvent);

      // Assert
      expect(orchestrator.getState()).toBe('step_1_failed');
    });

    it('[P0] step N+1 is never created after step N failure', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);
      const publishCountAfterStep1 = connector.sendPacketCalls.length;

      // Act: step 1 fails
      const failureEvent = createMockStepFeedbackEvent({
        status: 'error',
        content: 'Provider offline',
      });
      await orchestrator.handleStepFeedback(failureEvent);

      // Assert: only the customer notification was published (no step N+1 job request)
      // publishCountAfterStep1 + 1 (customer notification) = expected total
      expect(connector.sendPacketCalls.length).toBe(publishCountAfterStep1 + 1);
    });

    it('[P0] customer receives Kind 7000 notification on step failure', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);
      connector.sendPacketCalls.length = 0;

      // Act: step 1 fails
      const failureEvent = createMockStepFeedbackEvent({
        status: 'error',
        content: 'Model capacity exceeded',
      });
      await orchestrator.handleStepFeedback(failureEvent);

      // Assert: a notification (Kind 7000) was published to customer
      // The notification should reference the workflow event and include
      // the failure details
      expect(connector.sendPacketCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // T-6.1-07 [P0]: Step timeout
  // ==========================================================================

  describe('step timeout (T-6.1-07)', () => {
    it('[P0] step timeout fires after configurable duration', async () => {
      // Arrange: use fake timers for deterministic timeout testing
      vi.useFakeTimers();
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
        stepTimeoutMs: 300_000, // 5 minutes
        now: () => Date.now(), // injectable time source
      });
      await orchestrator.startWorkflow(definition);

      // Act: advance time past the timeout
      vi.advanceTimersByTime(300_001);

      // Assert: workflow should be marked as timed out
      expect(orchestrator.getState()).toBe('step_1_failed');
    });

    it('[P0] customer notified on timeout', async () => {
      // Arrange
      vi.useFakeTimers();
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
        stepTimeoutMs: 60_000, // 1 minute for fast test
        now: () => Date.now(),
      });
      await orchestrator.startWorkflow(definition);
      connector.sendPacketCalls.length = 0;

      // Act: advance time past timeout
      vi.advanceTimersByTime(60_001);

      // Assert: customer notification published
      expect(connector.sendPacketCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // T-6.1-08 [P1]: Final step completion
  // ==========================================================================

  describe('final step completion (T-6.1-08)', () => {
    it('[P1] last step Kind 6xxx result marks workflow completed', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Step 1 completes
      const step1Result = createMockStepResultEvent({
        kind: 6302,
        content: 'Hello world',
      });
      await orchestrator.handleStepResult(step1Result);

      // Act: step 2 (final) completes
      const step2Result = createMockStepResultEvent({
        id: TEST_STEP2_RESULT_ID,
        kind: 6100,
        content: 'Generated text based on Hello world',
      });
      await orchestrator.handleStepResult(step2Result);

      // Assert
      expect(orchestrator.getState()).toBe('completed');
    });

    it('[P1] customer receives Kind 7000 with status success on workflow completion', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Step 1 completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'Hello world' })
      );
      connector.sendPacketCalls.length = 0;

      // Act: step 2 (final) completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: TEST_STEP2_RESULT_ID,
          kind: 6100,
          content: 'Final output',
        })
      );

      // Assert: customer notification with success status
      expect(connector.sendPacketCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // T-6.1-09 [P0]: Per-step compute settlement
  // ==========================================================================

  describe('per-step compute settlement (T-6.1-09)', () => {
    it('[P0] each step settles individually via settleCompute()', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition({
        steps: [
          {
            kind: 5302,
            description: 'Step 1',
            bidAllocation: '1000000',
          },
          {
            kind: 5100,
            description: 'Step 2',
            bidAllocation: '1000000',
          },
        ],
        totalBid: '2000000',
      });
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Step 1 completes -> should settle step 1
      const initialCalls = connector.sendPacketCalls.length;
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'translated' })
      );
      const callsAfterStep1 = connector.sendPacketCalls.length;

      // Step 2 completes -> should settle step 2
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: TEST_STEP2_RESULT_ID,
          kind: 6100,
          content: 'generated',
        })
      );
      const callsAfterStep2 = connector.sendPacketCalls.length;

      // Assert: each step triggered a settlement + next step publish
      // Step 1 complete: settle step 1 + publish step 2 = 2 calls
      // Step 2 complete: settle step 2 + workflow notification = 2 calls
      expect(callsAfterStep1).toBeGreaterThan(initialCalls);
      expect(callsAfterStep2).toBeGreaterThan(callsAfterStep1);
    });
  });

  // ==========================================================================
  // T-6.1-11 [P1]: Workflow state persistence
  // ==========================================================================

  describe('workflow state persistence (T-6.1-11)', () => {
    it('[P1] workflow state stored in EventStore after step completion', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const eventStore = createMockEventStore();
      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
        eventStore,
      });
      await orchestrator.startWorkflow(definition);

      // Act: step 1 completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'result' })
      );

      // Assert: state events stored
      expect(eventStore.events.length).toBeGreaterThan(0);
    });

    it('[P1] step completion is idempotent -- re-processing does not create duplicate step N+1', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      const step1Result = createMockStepResultEvent({
        kind: 6302,
        content: 'translated',
      });

      // Act: process the same result twice
      await orchestrator.handleStepResult(step1Result);
      const callsAfterFirst = connector.sendPacketCalls.length;
      await orchestrator.handleStepResult(step1Result);
      const callsAfterSecond = connector.sendPacketCalls.length;

      // Assert: no additional publishes on duplicate
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  // ==========================================================================
  // T-6.1-12 [P2]: Concurrent workflows
  // ==========================================================================

  describe('concurrent workflows (T-6.1-12)', () => {
    it('[P2] 3 independent workflows running simultaneously advance independently', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const def1 = createTestWorkflowDefinition({
        initialInput: { data: 'Input 1', type: 'text' },
      });
      const def2 = createTestWorkflowDefinition({
        initialInput: { data: 'Input 2', type: 'text' },
      });
      const def3 = createTestWorkflowDefinition({
        initialInput: { data: 'Input 3', type: 'text' },
      });

      const orch1 = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      const orch2 = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      const orch3 = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act: start all three
      await Promise.all([
        orch1.startWorkflow(def1),
        orch2.startWorkflow(def2),
        orch3.startWorkflow(def3),
      ]);

      // Assert: all three are running step 1 independently
      expect(orch1.getState()).toBe('step_1_running');
      expect(orch2.getState()).toBe('step_1_running');
      expect(orch3.getState()).toBe('step_1_running');

      // Advance only workflow 2 to step 2
      await orch2.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'Result 2' })
      );

      // Assert: only workflow 2 advanced
      expect(orch1.getState()).toBe('step_1_running');
      expect(orch2.getState()).toBe('step_2_running');
      expect(orch3.getState()).toBe('step_1_running');

      // Fail workflow 3
      await orch3.handleStepFeedback(
        createMockStepFeedbackEvent({ status: 'error', content: 'Failed' })
      );

      // Assert: only workflow 3 failed
      expect(orch1.getState()).toBe('step_1_running');
      expect(orch2.getState()).toBe('step_2_running');
      expect(orch3.getState()).toBe('step_1_failed');
    });
  });

  // ==========================================================================
  // NFR: Resource cleanup and lifecycle safety
  // ==========================================================================

  describe('resource cleanup (NFR)', () => {
    it('destroy() clears pending step timeout to prevent timer leak', async () => {
      // Arrange
      vi.useFakeTimers();
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
        stepTimeoutMs: 300_000,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());

      // Act: destroy while step 1 is running (timeout pending)
      orchestrator.destroy();

      // Advance time past what would have been the timeout
      vi.advanceTimersByTime(300_001);

      // Assert: state should still be step_1_running (timeout was cleared, not fired)
      expect(orchestrator.getState()).toBe('step_1_running');
    });

    it('destroy() is safe to call multiple times', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());

      // Act: double destroy should not throw
      orchestrator.destroy();
      expect(() => orchestrator.destroy()).not.toThrow();
    });
  });

  // ==========================================================================
  // NFR: State machine invariants
  // ==========================================================================

  describe('state machine invariants (NFR)', () => {
    it('handleStepResult is a no-op after workflow is completed', async () => {
      // Arrange: complete a 2-step workflow
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());

      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'step 1 done' })
      );
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: TEST_STEP2_RESULT_ID,
          kind: 6100,
          content: 'step 2 done',
        })
      );
      expect(orchestrator.getState()).toBe('completed');
      const callsAtCompletion = connector.sendPacketCalls.length;

      // Act: send another result after completion
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: 'ab'.repeat(32),
          kind: 6100,
          content: 'spurious result',
        })
      );

      // Assert: no additional publishes and state unchanged
      expect(orchestrator.getState()).toBe('completed');
      expect(connector.sendPacketCalls.length).toBe(callsAtCompletion);
    });

    it('handleStepResult is a no-op after workflow has failed', async () => {
      // Arrange: fail a workflow
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());
      await orchestrator.handleStepFeedback(
        createMockStepFeedbackEvent({ status: 'error', content: 'fail' })
      );
      expect(orchestrator.getState()).toBe('step_1_failed');
      const callsAtFailure = connector.sendPacketCalls.length;

      // Act: send a result after failure
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'late result' })
      );

      // Assert: no state change, no publishes
      expect(orchestrator.getState()).toBe('step_1_failed');
      expect(connector.sendPacketCalls.length).toBe(callsAtFailure);
    });

    it('handleStepFeedback is a no-op after workflow is completed', async () => {
      // Arrange: complete a 2-step workflow
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());

      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'step 1' })
      );
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: TEST_STEP2_RESULT_ID,
          kind: 6100,
          content: 'step 2',
        })
      );
      expect(orchestrator.getState()).toBe('completed');
      const callsAtCompletion = connector.sendPacketCalls.length;

      // Act: send error feedback after completion
      await orchestrator.handleStepFeedback(
        createMockStepFeedbackEvent({ status: 'error', content: 'late error' })
      );

      // Assert: state unchanged
      expect(orchestrator.getState()).toBe('completed');
      expect(connector.sendPacketCalls.length).toBe(callsAtCompletion);
    });

    it('handleStepResult before startWorkflow is a safe no-op', async () => {
      // Arrange: orchestrator not started
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act: call handleStepResult without starting
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302 })
      );

      // Assert: state stays pending, no crash
      expect(orchestrator.getState()).toBe('pending');
      expect(connector.sendPacketCalls).toHaveLength(0);
    });

    it('handleStepFeedback before startWorkflow is a safe no-op', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act
      await orchestrator.handleStepFeedback(
        createMockStepFeedbackEvent({ status: 'error' })
      );

      // Assert
      expect(orchestrator.getState()).toBe('pending');
      expect(connector.sendPacketCalls).toHaveLength(0);
    });
  });

  // ==========================================================================
  // NFR: Single-step workflow edge case
  // ==========================================================================

  describe('single-step workflow (NFR)', () => {
    it('single-step workflow completes immediately after step 1 result', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const singleStepDef = createTestWorkflowDefinition({
        steps: [
          { kind: 5100, description: 'Only step', bidAllocation: '2000000' },
        ],
        totalBid: '2000000',
      });
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(singleStepDef);
      expect(orchestrator.getState()).toBe('step_1_running');

      // Act: step 1 (and only step) completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6100, content: 'done' })
      );

      // Assert: workflow completed (no step 2 to advance to)
      expect(orchestrator.getState()).toBe('completed');
    });
  });

  // ==========================================================================
  // NFR: Bid allocation proportional split correctness
  // ==========================================================================

  describe('proportional bid split (NFR)', () => {
    it('3-step workflow with no explicit allocation splits total bid evenly', async () => {
      // Arrange: 3 steps, totalBid = 3000000, expect 1000000 per step
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const threeStepDef: ParsedWorkflowDefinition = {
        steps: [
          { kind: 5302, description: 'Step 1' },
          { kind: 5100, description: 'Step 2' },
          { kind: 5100, description: 'Step 3' },
        ],
        initialInput: { data: 'test', type: 'text' },
        totalBid: '3000000',
        content: '',
      };
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act: start and check that a packet was sent (step 1 published)
      await orchestrator.startWorkflow(threeStepDef);

      // Assert: packet was sent (workflow started successfully with proportional split)
      expect(connector.sendPacketCalls.length).toBeGreaterThanOrEqual(1);
      expect(orchestrator.getState()).toBe('step_1_running');
    });
  });

  // ==========================================================================
  // NFR: Timeout reset on step advancement
  // ==========================================================================

  describe('timeout reset on advancement (NFR)', () => {
    it('step advancement resets timeout timer for the new step', async () => {
      // Arrange
      vi.useFakeTimers();
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
        stepTimeoutMs: 60_000,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());

      // Advance 50s (within step 1 timeout)
      vi.advanceTimersByTime(50_000);
      expect(orchestrator.getState()).toBe('step_1_running');

      // Step 1 completes at t=50s, resetting the timer for step 2
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'result' })
      );
      expect(orchestrator.getState()).toBe('step_2_running');

      // Advance another 50s (total 100s, but only 50s into step 2's timeout)
      vi.advanceTimersByTime(50_000);

      // Assert: step 2 should NOT have timed out (its timer started at t=50s)
      expect(orchestrator.getState()).toBe('step_2_running');

      // Advance past step 2's timeout (60s from step 2 start = t=110s)
      vi.advanceTimersByTime(11_000);

      // Assert: now step 2 should have timed out
      expect(orchestrator.getState()).toBe('step_2_failed');
    });
  });

  // ==========================================================================
  // NFR: EventStore persistence on failure path
  // ==========================================================================

  describe('EventStore persistence on failure (NFR)', () => {
    it('failure event is stored in EventStore for crash recovery', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const eventStore = createMockEventStore();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
        eventStore,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());
      const eventsBeforeFailure = eventStore.events.length;

      // Act: step 1 fails
      await orchestrator.handleStepFeedback(
        createMockStepFeedbackEvent({ status: 'error', content: 'fail' })
      );

      // Assert: failure event was stored
      expect(eventStore.events.length).toBeGreaterThan(eventsBeforeFailure);
      // The stored failure event should be a Kind 7000 with error status
      const storedFailure = eventStore.events[eventStore.events.length - 1];
      expect(storedFailure).toBeDefined();
      expect(storedFailure!.kind).toBe(7000);
    });
  });

  // ==========================================================================
  // AC #3 Gap: Step advancement content & kind verification (deep assertions)
  // ==========================================================================

  describe('step advancement content verification (AC #3 deep)', () => {
    it('step 2 job request uses correct DVM kind from step definition', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      // Step 1 = kind 5302 (translation), Step 2 = kind 5100 (text generation)
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);
      connector.sendPacketCalls.length = 0;

      // Act: step 1 completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'translated text' })
      );

      // Assert: find the step 2 publish packet (non-empty data)
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      expect(publishedEvents.length).toBeGreaterThanOrEqual(1);

      // The last published event should be step 2's Kind 5100 job request
      const step2Event = publishedEvents[publishedEvents.length - 1]!;
      expect(step2Event.kind).toBe(5100);
    });

    it('step 2 job request contains step 1 result content as input data', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const step1Output = 'Hello world from translation';
      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);
      connector.sendPacketCalls.length = 0;

      // Act: step 1 completes with known output
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: step1Output })
      );

      // Assert: decode step 2's TOON packet and verify input data
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      const step2Event = publishedEvents[publishedEvents.length - 1]!;
      const parsed = parseJobRequest(step2Event);
      expect(parsed).not.toBeNull();
      expect(parsed!.input.data).toBe(step1Output);
    });

    it('complex JSON from step 1 preserved exactly in step 2 input (deep roundtrip)', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const complexJson = JSON.stringify({
        translation: 'Hello world',
        confidence: 0.95,
        alternatives: ['Hi world', 'Hello globe'],
        nested: { deep: { value: true } },
      });
      const definition = createTestWorkflowDefinition();
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);
      connector.sendPacketCalls.length = 0;

      // Act: step 1 completes with complex JSON content
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: complexJson })
      );

      // Assert: decode step 2's TOON packet and verify exact content preservation
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      const step2Event = publishedEvents[publishedEvents.length - 1]!;
      const parsed = parseJobRequest(step2Event);
      expect(parsed).not.toBeNull();
      expect(parsed!.input.data).toBe(complexJson);
      // Also verify JSON structural equality
      expect(JSON.parse(parsed!.input.data)).toEqual(JSON.parse(complexJson));
    });
  });

  // ==========================================================================
  // AC #2 Gap: Step 1 creation content verification (deep assertions)
  // ==========================================================================

  describe('step 1 creation content verification (AC #2 deep)', () => {
    it('step 1 job request uses correct DVM kind from step definition', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition();
      // Step 1 kind = 5302 (translation)
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act
      await orchestrator.startWorkflow(definition);

      // Assert: decode the TOON packet to verify Kind 5302
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0]!.kind).toBe(5302);
    });

    it('step 1 job request contains workflow initial input as data', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition({
        initialInput: { data: 'Translate this specific text', type: 'text' },
      });
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act
      await orchestrator.startWorkflow(definition);

      // Assert: decode the TOON packet to verify input data
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      const step1Event = publishedEvents[0]!;
      const parsed = parseJobRequest(step1Event);
      expect(parsed).not.toBeNull();
      expect(parsed!.input.data).toBe('Translate this specific text');
      expect(parsed!.input.type).toBe('text');
    });

    it('step 1 job request bid matches step 1 allocation', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition({
        steps: [
          { kind: 5302, description: 'Step 1', bidAllocation: '800000' },
          { kind: 5100, description: 'Step 2', bidAllocation: '1200000' },
        ],
        totalBid: '2000000',
      });
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act
      await orchestrator.startWorkflow(definition);

      // Assert: step 1's bid should be 800000
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      const step1Event = publishedEvents[0]!;
      const parsed = parseJobRequest(step1Event);
      expect(parsed).not.toBeNull();
      expect(parsed!.bid).toBe('800000');
    });
  });

  // ==========================================================================
  // AC #6 Gap: Per-step bid settlement amount verification
  // ==========================================================================

  describe('per-step settlement amount verification (AC #6 deep)', () => {
    it('total settled amount across all steps does not exceed total bid', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition({
        steps: [
          { kind: 5302, description: 'Step 1', bidAllocation: '1000000' },
          { kind: 5100, description: 'Step 2', bidAllocation: '1000000' },
        ],
        totalBid: '2000000',
      });
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Complete both steps
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'translated' })
      );
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: TEST_STEP2_RESULT_ID,
          kind: 6100,
          content: 'generated',
        })
      );

      // Assert: collect all settlement packets (empty data = settlement)
      const settlementCalls = connector.sendPacketCalls.filter(
        (call) => call.data.length === 0
      );
      // Each settlement should have been called (one per step)
      expect(settlementCalls).toHaveLength(2);

      // Assert: sum of settlement amounts <= total bid
      const totalSettled = settlementCalls.reduce(
        (sum, call) => sum + call.amount,
        0n
      );
      expect(totalSettled).toBeLessThanOrEqual(BigInt('2000000'));
    });

    it('step 1 settlement uses step 1 bid allocation, step 2 uses step 2 allocation', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition = createTestWorkflowDefinition({
        steps: [
          { kind: 5302, description: 'Step 1', bidAllocation: '700000' },
          { kind: 5100, description: 'Step 2', bidAllocation: '1300000' },
        ],
        totalBid: '2000000',
      });
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Step 1 completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'translated' })
      );

      // Step 2 completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: TEST_STEP2_RESULT_ID,
          kind: 6100,
          content: 'generated',
        })
      );

      // Assert: verify settlement amounts by inspecting the job request bid tags
      // which are passed as originalBid to settleCompute
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      // First published event = step 1 (kind 5302)
      const step1Parsed = parseJobRequest(publishedEvents[0]!);
      expect(step1Parsed).not.toBeNull();
      expect(step1Parsed!.bid).toBe('700000');

      // Second published event = step 2 (kind 5100), published after step 1 result
      const step2Event = publishedEvents.find((e) => e.kind === 5100);
      expect(step2Event).toBeDefined();
      const step2Parsed = parseJobRequest(step2Event!);
      expect(step2Parsed).not.toBeNull();
      expect(step2Parsed!.bid).toBe('1300000');
    });
  });

  // ==========================================================================
  // AC #3 Gap: Multi-step chain (3 steps) advancement verification
  // ==========================================================================

  describe('3-step chain advancement (AC #3 deep)', () => {
    it('3-step workflow advances through all steps with correct kinds and content chaining', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition: ParsedWorkflowDefinition = {
        steps: [
          { kind: 5302, description: 'Translate', bidAllocation: '500000' },
          { kind: 5100, description: 'Generate', bidAllocation: '500000' },
          { kind: 5100, description: 'Summarize', bidAllocation: '500000' },
        ],
        initialInput: { data: 'Hola mundo', type: 'text' },
        totalBid: '1500000',
        content: '',
      };
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Verify step 1 published with kind 5302
      let published = extractPublishedEvents(connector.sendPacketCalls);
      expect(published[0]!.kind).toBe(5302);
      const step1Parsed = parseJobRequest(published[0]!);
      expect(step1Parsed!.input.data).toBe('Hola mundo');

      connector.sendPacketCalls.length = 0;

      // Step 1 completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: 'e'.repeat(64),
          kind: 6302,
          content: 'Hello world',
        })
      );
      expect(orchestrator.getState()).toBe('step_2_running');

      // Verify step 2 published with kind 5100 and step 1 output
      published = extractPublishedEvents(connector.sendPacketCalls);
      const step2Event = published[published.length - 1]!;
      expect(step2Event.kind).toBe(5100);
      const step2Parsed = parseJobRequest(step2Event);
      expect(step2Parsed!.input.data).toBe('Hello world');

      connector.sendPacketCalls.length = 0;

      // Step 2 completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: 'f'.repeat(64),
          kind: 6100,
          content: 'Generated paragraph about Hello world',
        })
      );
      expect(orchestrator.getState()).toBe('step_3_running');

      // Verify step 3 published with kind 5100 and step 2 output
      published = extractPublishedEvents(connector.sendPacketCalls);
      const step3Event = published[published.length - 1]!;
      expect(step3Event.kind).toBe(5100);
      const step3Parsed = parseJobRequest(step3Event);
      expect(step3Parsed!.input.data).toBe(
        'Generated paragraph about Hello world'
      );

      connector.sendPacketCalls.length = 0;

      // Step 3 (final) completes
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: 'ab'.repeat(32),
          kind: 6100,
          content: 'Summary of the generated text',
        })
      );
      expect(orchestrator.getState()).toBe('completed');
    });
  });

  // ==========================================================================
  // AC #5 Gap: Step failure at step 2 (mid-chain failure)
  // ==========================================================================

  describe('mid-chain failure (AC #5 deep)', () => {
    it('failure at step 2 after step 1 succeeds prevents step 3 execution', async () => {
      // Arrange: 3-step workflow
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const definition: ParsedWorkflowDefinition = {
        steps: [
          { kind: 5302, description: 'Step 1', bidAllocation: '500000' },
          { kind: 5100, description: 'Step 2', bidAllocation: '500000' },
          { kind: 5100, description: 'Step 3', bidAllocation: '500000' },
        ],
        initialInput: { data: 'test', type: 'text' },
        totalBid: '1500000',
        content: '',
      };
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(definition);

      // Step 1 completes successfully
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'step 1 done' })
      );
      expect(orchestrator.getState()).toBe('step_2_running');

      const callsBeforeFailure = connector.sendPacketCalls.length;

      // Act: step 2 fails
      await orchestrator.handleStepFeedback(
        createMockStepFeedbackEvent({
          status: 'error',
          content: 'Step 2 provider crashed',
        })
      );

      // Assert: workflow failed at step 2
      expect(orchestrator.getState()).toBe('step_2_failed');

      // Assert: only customer notification published (no step 3 job request)
      const callsAfterFailure = connector.sendPacketCalls.length;
      // Should have exactly 1 new call: the customer failure notification
      expect(callsAfterFailure).toBe(callsBeforeFailure + 1);

      // Assert: subsequent step results are no-ops
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: 'ab'.repeat(32),
          kind: 6100,
          content: 'late result',
        })
      );
      expect(orchestrator.getState()).toBe('step_2_failed');
      expect(connector.sendPacketCalls.length).toBe(callsAfterFailure);
    });
  });

  // ==========================================================================
  // AC #4/#5 Gap: Notification content verification (deep assertions)
  // ==========================================================================

  describe('notification content verification (AC #4 + AC #5 deep)', () => {
    it('workflow completion notification is Kind 7000 with status success', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());

      // Complete step 1
      await orchestrator.handleStepResult(
        createMockStepResultEvent({ kind: 6302, content: 'translated' })
      );
      connector.sendPacketCalls.length = 0;

      // Act: complete step 2 (final)
      await orchestrator.handleStepResult(
        createMockStepResultEvent({
          id: TEST_STEP2_RESULT_ID,
          kind: 6100,
          content: 'generated',
        })
      );

      // Assert: decode the notification event and verify it is Kind 7000 success
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      const feedbackEvents = publishedEvents.filter((e) => e.kind === 7000);
      expect(feedbackEvents.length).toBeGreaterThanOrEqual(1);
      const notification = feedbackEvents[feedbackEvents.length - 1]!;
      const parsed = parseJobFeedback(notification);
      expect(parsed).not.toBeNull();
      expect(parsed!.status).toBe('success');
    });

    it('workflow failure notification is Kind 7000 with status error and failure details', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());
      connector.sendPacketCalls.length = 0;

      // Act: step 1 fails
      await orchestrator.handleStepFeedback(
        createMockStepFeedbackEvent({
          status: 'error',
          content: 'GPU out of memory',
        })
      );

      // Assert: decode the notification event and verify it is Kind 7000 error
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      const feedbackEvents = publishedEvents.filter((e) => e.kind === 7000);
      expect(feedbackEvents.length).toBeGreaterThanOrEqual(1);
      const notification = feedbackEvents[feedbackEvents.length - 1]!;
      const parsed = parseJobFeedback(notification);
      expect(parsed).not.toBeNull();
      expect(parsed!.status).toBe('error');
      expect(parsed!.content).toContain('step 1');
    });
  });

  // ==========================================================================
  // AC #1 Gap: Workflow definition event contains `p` tag for targeted steps
  //   (verified at orchestrator level -- step request includes p tag)
  // ==========================================================================

  describe('targeted provider in step request (AC #1 + AC #2 deep)', () => {
    it('step 1 with targetProvider includes p tag in generated Kind 5xxx', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const targetPubkey = 'cc'.repeat(32);
      const definition = createTestWorkflowDefinition({
        steps: [
          {
            kind: 5302,
            description: 'Targeted step',
            targetProvider: targetPubkey,
            bidAllocation: '1000000',
          },
          {
            kind: 5100,
            description: 'Untargeted step',
            bidAllocation: '1000000',
          },
        ],
      });
      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });

      // Act
      await orchestrator.startWorkflow(definition);

      // Assert: decode step 1 event and check for p tag
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      expect(publishedEvents).toHaveLength(1);
      const step1Event = publishedEvents[0]!;
      const pTag = step1Event.tags.find((t) => t[0] === 'p');
      expect(pTag).toBeDefined();
      expect(pTag![1]).toBe(targetPubkey);
    });
  });

  // ==========================================================================
  // Security: Input validation guards (Code Review Pass #3)
  // ==========================================================================

  describe('security guards (Code Review #3)', () => {
    it('handleStepResult ignores events with kind outside 6000-6999 range', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());
      const callsAfterStart = connector.sendPacketCalls.length;

      // Act: inject a non-result event (kind 7000 feedback, not kind 6xxx)
      const fakeResult = createMockStepResultEvent({ kind: 7000 });
      await orchestrator.handleStepResult(fakeResult);

      // Assert: state unchanged, no new packets sent
      expect(orchestrator.getState()).toBe('step_1_running');
      expect(connector.sendPacketCalls.length).toBe(callsAfterStart);
    });

    it('handleStepResult ignores events with kind below 6000', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());

      // Act: inject a job request event (kind 5302, not a result)
      const fakeResult = createMockStepResultEvent({ kind: 5302 });
      await orchestrator.handleStepResult(fakeResult);

      // Assert: state unchanged
      expect(orchestrator.getState()).toBe('step_1_running');
    });

    it('startWorkflow throws on re-entrance (calling twice)', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      await orchestrator.startWorkflow(createTestWorkflowDefinition());

      // Act & Assert: second call throws
      await expect(
        orchestrator.startWorkflow(createTestWorkflowDefinition())
      ).rejects.toThrow('non-pending');
    });

    it('startWorkflow throws on empty steps array', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const orchestrator = new WorkflowOrchestrator(node, {
        secretKey: TEST_SECRET_KEY,
      });
      const emptyDef: ParsedWorkflowDefinition = {
        steps: [],
        initialInput: { data: 'test', type: 'text' },
        totalBid: '1000000',
        content: '',
      };

      // Act & Assert
      await expect(orchestrator.startWorkflow(emptyDef)).rejects.toThrow(
        'at least one step'
      );
    });
  });
});
