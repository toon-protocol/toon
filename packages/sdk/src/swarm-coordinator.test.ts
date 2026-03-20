/**
 * Unit & Integration Tests: SwarmCoordinator (Story 6.2, Tasks 2-3)
 *
 * ATDD RED PHASE: These tests define the expected behavior of the
 * SwarmCoordinator class. All tests will FAIL until the production
 * code in swarm-coordinator.ts is implemented.
 *
 * Test IDs (from test-design-epic-6.md):
 *   T-6.2-02 [P0]: Provider submission collection
 *   T-6.2-03 [P0]: Timeout-based collection
 *   T-6.2-04 [P0]: Zero submissions
 *   T-6.2-05 [P0]: Winner selection and payment
 *   T-6.2-06 [P1]: Loser outcome transparency
 *   T-6.2-07 [P0]: Duplicate selection idempotency
 *   T-6.2-08 [P1]: Late submission handling
 *   T-6.2-09 [P1]: Timeout boundary
 *   T-6.2-10 [P1]: Max submissions reached
 *   T-6.2-11 [P2]: Single submission
 *
 * Follows existing patterns from:
 *   - workflow-orchestrator.test.ts (createMockConnector, ServiceNode mocking)
 *   - dvm-lifecycle.test.ts (vi.mock('nostr-tools'))
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';

// Prevent live relay connections (project rule: always mock nostr-tools in tests)
vi.mock('nostr-tools');

import { decodeEventFromToon, ToonError } from '@toon-protocol/core';
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
  SendPacketParams,
  SendPacketResult,
  RegisterPeerParams,
} from '@toon-protocol/core';

// This import will FAIL until swarm-coordinator.ts is created (RED PHASE)
import { SwarmCoordinator } from './swarm-coordinator.js';

import { createNode } from './create-node.js';
import type { WorkflowEventStore } from './workflow-orchestrator.js';

// ============================================================================
// Fixed Test Data (deterministic per project testing rules)
// ============================================================================

/** Fixed secret key for deterministic identity derivation (32 bytes) */
const TEST_SECRET_KEY = Uint8Array.from(Buffer.from('a'.repeat(64), 'hex'));

/** Deterministic swarm request event ID */
const TEST_SWARM_REQUEST_ID = 'aa'.repeat(32);

/** Deterministic provider pubkeys */
const TEST_PROVIDER_A_PUBKEY = 'a1'.repeat(32);
const TEST_PROVIDER_B_PUBKEY = 'b2'.repeat(32);
const TEST_PROVIDER_C_PUBKEY = 'c3'.repeat(32);

/** Deterministic result event IDs */
const TEST_RESULT_A_ID = 'da'.repeat(32);
const TEST_RESULT_B_ID = 'db'.repeat(32);
const TEST_RESULT_C_ID = 'dc'.repeat(32);

/** Fixed timestamp for deterministic test data */
const FIXED_CREATED_AT = 1700000000;

/** Default timeout for swarm tests (10 minutes = 600_000ms) */
const DEFAULT_TIMEOUT_MS = 600_000;

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
 * Creates a mock swarm request event (Kind 5xxx with swarm/judge tags).
 */
function createMockSwarmRequest(
  overrides: {
    id?: string;
    maxProviders?: number;
    judge?: string;
    kind?: number;
    bid?: string;
  } = {}
): NostrEvent {
  return {
    id: overrides.id ?? TEST_SWARM_REQUEST_ID,
    pubkey: 'cd'.repeat(32),
    created_at: FIXED_CREATED_AT,
    kind: overrides.kind ?? 5100,
    content: 'Generate a poem about the ocean',
    tags: [
      ['i', 'Generate a poem about the ocean', 'text'],
      ['bid', overrides.bid ?? '5000000', 'usdc'],
      ['output', 'text/plain'],
      ['swarm', String(overrides.maxProviders ?? 3)],
      ['judge', overrides.judge ?? 'customer'],
    ],
    sig: 'a'.repeat(128),
  };
}

/**
 * Creates a mock Kind 6xxx result event (provider submission).
 */
function createMockSubmission(
  overrides: {
    id?: string;
    providerPubkey?: string;
    requestEventId?: string;
    kind?: number;
    content?: string;
    amount?: string;
  } = {}
): NostrEvent {
  return {
    id: overrides.id ?? TEST_RESULT_A_ID,
    pubkey: overrides.providerPubkey ?? TEST_PROVIDER_A_PUBKEY,
    created_at: FIXED_CREATED_AT,
    kind: overrides.kind ?? 6100,
    content: overrides.content ?? 'A poem about the vast ocean...',
    tags: [
      ['e', overrides.requestEventId ?? TEST_SWARM_REQUEST_ID],
      ['p', 'cd'.repeat(32)],
      ['amount', overrides.amount ?? '2000000', 'usdc'],
    ],
    sig: 'a'.repeat(128),
  };
}

/**
 * Creates a mock EventStore for state persistence tests.
 */
function createMockEventStore(): WorkflowEventStore & {
  events: NostrEvent[];
} {
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
 * Creates a mock Kind 7000 swarm selection event.
 */
function createMockSelectionEvent(
  overrides: {
    id?: string;
    winnerResultId?: string;
    swarmRequestId?: string;
  } = {}
): NostrEvent {
  return {
    id: overrides.id ?? 'ee'.repeat(32),
    pubkey: 'cd'.repeat(32),
    created_at: FIXED_CREATED_AT + 60,
    kind: 7000,
    content: '',
    tags: [
      ['e', overrides.swarmRequestId ?? TEST_SWARM_REQUEST_ID],
      ['p', 'cd'.repeat(32)],
      ['status', 'success'],
      ['winner', overrides.winnerResultId ?? TEST_RESULT_A_ID],
    ],
    sig: 'b'.repeat(128),
  };
}

/**
 * Extracts TOON-decoded Nostr events from captured sendPacket calls.
 * Settlement packets have empty data; publish packets have TOON-encoded data.
 */
function extractPublishedEvents(calls: SendPacketParams[]): NostrEvent[] {
  const events: NostrEvent[] = [];
  for (const call of calls) {
    if (call.data.length > 0) {
      try {
        events.push(decodeEventFromToon(call.data));
      } catch {
        // Skip non-TOON packets
      }
    }
  }
  return events;
}

// ============================================================================
// Tests
// ============================================================================

describe('SwarmCoordinator (Story 6.2)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ==========================================================================
  // T-6.2-02 [P0]: Provider submission collection
  // ==========================================================================

  describe('provider submission collection (T-6.2-02)', () => {
    it('[P0] 3 providers submit Kind 6xxx results, all stored and associated via e tag', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      // Act
      await coordinator.startSwarm(swarmRequest);

      const submissionA = createMockSubmission({
        id: TEST_RESULT_A_ID,
        providerPubkey: TEST_PROVIDER_A_PUBKEY,
        content: 'Poem A',
      });
      const submissionB = createMockSubmission({
        id: TEST_RESULT_B_ID,
        providerPubkey: TEST_PROVIDER_B_PUBKEY,
        content: 'Poem B',
      });
      const submissionC = createMockSubmission({
        id: TEST_RESULT_C_ID,
        providerPubkey: TEST_PROVIDER_C_PUBKEY,
        content: 'Poem C',
      });

      await coordinator.handleSubmission(submissionA);
      await coordinator.handleSubmission(submissionB);
      await coordinator.handleSubmission(submissionC);

      // Assert: all 3 submissions collected
      const submissions = coordinator.getSubmissions();
      expect(submissions).toHaveLength(3);
      expect(submissions.map((s) => s.id)).toEqual(
        expect.arrayContaining([
          TEST_RESULT_A_ID,
          TEST_RESULT_B_ID,
          TEST_RESULT_C_ID,
        ])
      );
    });

    it('[P0] submissions are validated via e tag referencing swarm request', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Act: submission with wrong request event ID
      const wrongSubmission = createMockSubmission({
        id: TEST_RESULT_A_ID,
        requestEventId: 'ff'.repeat(32), // wrong request ID
      });
      await coordinator.handleSubmission(wrongSubmission);

      // Assert: submission rejected (not in collected set)
      expect(coordinator.getSubmissions()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // T-6.2-03 [P0]: Timeout-based collection
  // ==========================================================================

  describe('timeout-based collection (T-6.2-03)', () => {
    it('[P0] max_providers=5 but only 2 respond, timeout fires, judging proceeds with 2', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 5 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Only 2 providers submit
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
        })
      );

      expect(coordinator.getState()).toBe('collecting');

      // Act: advance time past timeout
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

      // Assert: state transitions to judging with 2 submissions
      expect(coordinator.getState()).toBe('judging');
      expect(coordinator.getSubmissions()).toHaveLength(2);
    });
  });

  // ==========================================================================
  // T-6.2-04 [P0]: Zero submissions
  // ==========================================================================

  describe('zero submissions (T-6.2-04)', () => {
    it('[P0] no providers respond within timeout -> failed state', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Act: advance time past timeout with no submissions
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

      // Assert: failed state
      expect(coordinator.getState()).toBe('failed');
    });

    it('[P0] customer receives Kind 7000 feedback with "no submissions" on zero-submission timeout', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);
      connector.sendPacketCalls.length = 0;

      // Act: advance time past timeout
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

      // Assert: a Kind 7000 notification was published
      expect(connector.sendPacketCalls.length).toBeGreaterThanOrEqual(1);

      // Decode and verify the notification content
      const publishedEvents = extractPublishedEvents(connector.sendPacketCalls);
      const feedbackEvents = publishedEvents.filter((e) => e.kind === 7000);
      expect(feedbackEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('[P0] no ILP payment initiated on zero submissions', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);
      connector.sendPacketCalls.length = 0;

      // Act: advance time past timeout
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

      // Assert: no settlement packets (empty data = settlement)
      const settlementCalls = connector.sendPacketCalls.filter(
        (call) => call.data.length === 0
      );
      expect(settlementCalls).toHaveLength(0);
    });
  });

  // ==========================================================================
  // T-6.2-05 [P0]: Winner selection and payment
  // ==========================================================================

  describe('winner selection and payment (T-6.2-05)', () => {
    it('[P0] customer publishes selection -> settleCompute() pays winning provider only', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Submit 3 results
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
          content: 'Poem A',
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
          content: 'Poem B',
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_C_ID,
          providerPubkey: TEST_PROVIDER_C_PUBKEY,
          content: 'Poem C',
        })
      );

      // State should be judging (max providers reached)
      expect(coordinator.getState()).toBe('judging');

      connector.sendPacketCalls.length = 0;

      // Act: select winner (provider B)
      await coordinator.selectWinner(
        createMockSelectionEvent({ winnerResultId: TEST_RESULT_B_ID })
      );

      // Assert: state settled
      expect(coordinator.getState()).toBe('settled');

      // Assert: settlement was made (at least one sendPacket call with empty data)
      const settlementCalls = connector.sendPacketCalls.filter(
        (call) => call.data.length === 0
      );
      expect(settlementCalls).toHaveLength(1);
    });
  });

  // ==========================================================================
  // T-6.2-06 [P1]: Loser outcome transparency
  // ==========================================================================

  describe('loser outcome transparency (T-6.2-06)', () => {
    it('[P1] 3 providers submit, 1 selected, 2 losers get no compute payment', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Submit 3 results
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_C_ID,
          providerPubkey: TEST_PROVIDER_C_PUBKEY,
        })
      );

      connector.sendPacketCalls.length = 0;

      // Act: select provider A as winner
      await coordinator.selectWinner(createMockSelectionEvent());

      // Assert: exactly 1 settlement (winner only, not 3)
      const settlementCalls = connector.sendPacketCalls.filter(
        (call) => call.data.length === 0
      );
      expect(settlementCalls).toHaveLength(1);
    });

    it('[P1] losing providers submissions remain accessible via getSubmissions', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_C_ID,
          providerPubkey: TEST_PROVIDER_C_PUBKEY,
        })
      );

      // Select winner A
      await coordinator.selectWinner(createMockSelectionEvent());

      // Assert: all 3 submissions still accessible (losers remain on relay)
      const submissions = coordinator.getSubmissions();
      expect(submissions).toHaveLength(3);
    });
  });

  // ==========================================================================
  // T-6.2-07 [P0]: Duplicate selection idempotency
  // ==========================================================================

  describe('duplicate selection idempotency (T-6.2-07)', () => {
    it('[P0] second selection event rejected, single payment only', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 2 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
        })
      );

      // First selection -- should succeed
      await coordinator.selectWinner(createMockSelectionEvent());
      expect(coordinator.getState()).toBe('settled');
      const callsAfterFirst = connector.sendPacketCalls.length;

      // Act: second selection -- should be rejected
      await expect(
        coordinator.selectWinner(
          createMockSelectionEvent({
            id: 'ff'.repeat(32),
            winnerResultId: TEST_RESULT_B_ID,
          })
        )
      ).rejects.toThrow('already been settled');

      // Assert: no additional payments sent
      expect(connector.sendPacketCalls.length).toBe(callsAfterFirst);
    });
  });

  // ==========================================================================
  // T-6.2-08 [P1]: Late submission handling
  // ==========================================================================

  describe('late submission handling (T-6.2-08)', () => {
    it('[P1] submission after timeout stored but not eligible for winner selection', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 5 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // One submission before timeout
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );

      // Advance past timeout -> judging state
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);
      expect(coordinator.getState()).toBe('judging');

      // Act: late submission arrives
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
          content: 'Late poem',
        })
      );

      // Assert: late submission is not in the eligible submissions
      const eligibleSubmissions = coordinator.getSubmissions();
      expect(eligibleSubmissions).toHaveLength(1);
      expect(eligibleSubmissions[0]!.id).toBe(TEST_RESULT_A_ID);
    });

    it('[P1] submission after max-reached stored but not eligible', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 2 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Fill up max providers
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
        })
      );
      expect(coordinator.getState()).toBe('judging');

      // Act: third submission after max reached
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_C_ID,
          providerPubkey: TEST_PROVIDER_C_PUBKEY,
          content: 'Too late poem',
        })
      );

      // Assert: still only 2 eligible
      expect(coordinator.getSubmissions()).toHaveLength(2);
    });
  });

  // ==========================================================================
  // T-6.2-09 [P1]: Timeout boundary
  // ==========================================================================

  describe('timeout boundary (T-6.2-09)', () => {
    it('[P1] result at timeout-1ms accepted', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 5 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Advance to 1ms before timeout -- timer has not fired yet
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS - 1);
      expect(coordinator.getState()).toBe('collecting');

      // Act: submit at timeout - 1ms (state is still collecting)
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );

      // Assert: submission accepted
      expect(coordinator.getSubmissions()).toHaveLength(1);
      expect(coordinator.getState()).toBe('collecting');
    });

    it('[P1] result at timeout+1ms rejected', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 5 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Advance past timeout
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

      // Act: submit after timeout
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );

      // Assert: submission not in eligible set
      expect(coordinator.getSubmissions()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // T-6.2-10 [P1]: Max submissions reached
  // ==========================================================================

  describe('max submissions reached (T-6.2-10)', () => {
    it('[P1] max_providers=2, exactly 2 submit, judging starts immediately', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 2 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Act: exactly 2 providers submit
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      expect(coordinator.getState()).toBe('collecting');

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
        })
      );

      // Assert: immediately transitions to judging without waiting for timeout
      expect(coordinator.getState()).toBe('judging');
    });
  });

  // ==========================================================================
  // T-6.2-11 [P2]: Single submission
  // ==========================================================================

  describe('single submission (T-6.2-11)', () => {
    it('[P2] 1 provider responds, timeout fires, customer can select the single submission', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Only 1 provider submits
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
          content: 'Only poem',
        })
      );

      // Advance past timeout
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);
      expect(coordinator.getState()).toBe('judging');
      expect(coordinator.getSubmissions()).toHaveLength(1);

      // Act: customer selects the single submission
      await coordinator.selectWinner(createMockSelectionEvent());

      // Assert: settled with single winner
      expect(coordinator.getState()).toBe('settled');
    });
  });

  // ==========================================================================
  // Gap-fill: Error code verification (AC #3 idempotency)
  // ==========================================================================

  describe('error code verification', () => {
    it('duplicate selection throws with DVM_SWARM_ALREADY_SETTLED error code', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 1 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );

      await coordinator.selectWinner(createMockSelectionEvent());

      // Act & Assert: second selection has specific error code
      try {
        await coordinator.selectWinner(createMockSelectionEvent());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_SWARM_ALREADY_SETTLED');
      }
    });

    it('selectWinner with unknown submission throws DVM_SWARM_INVALID_SELECTION code', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 1 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );

      try {
        await coordinator.selectWinner(
          createMockSelectionEvent({ winnerResultId: 'ff'.repeat(32) })
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToonError);
        expect((err as ToonError).code).toBe('DVM_SWARM_INVALID_SELECTION');
      }
    });
  });

  // ==========================================================================
  // Gap-fill: Selection in failed state rejected (AC #4)
  // ==========================================================================

  describe('selection in failed state', () => {
    it('selectWinner rejected when swarm is in failed state (zero submissions timeout)', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Advance past timeout with no submissions -> failed
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);
      expect(coordinator.getState()).toBe('failed');

      // Act & Assert: cannot select in failed state
      await expect(
        coordinator.selectWinner(createMockSelectionEvent())
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Gap-fill: Duplicate provider submission (AC #2)
  // ==========================================================================

  describe('duplicate provider submission', () => {
    it('same event ID submitted twice is deduplicated', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 5 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Act: submit the exact same event twice (same ID)
      const submission = createMockSubmission({
        id: TEST_RESULT_A_ID,
        providerPubkey: TEST_PROVIDER_A_PUBKEY,
        content: 'Poem version 1',
      });
      await coordinator.handleSubmission(submission);
      await coordinator.handleSubmission(submission);

      // Assert: deduplicated by event ID -- only one submission stored
      expect(coordinator.getSubmissions()).toHaveLength(1);
    });

    it('same provider submitting twice results in two stored submissions', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 5 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Act: same provider submits two different results
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
          content: 'Poem version 1',
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY, // same provider
          content: 'Poem version 2',
        })
      );

      // Assert: both submissions stored (no dedup by pubkey)
      expect(coordinator.getSubmissions()).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Gap-fill: Loser submissions persisted in EventStore (AC #5)
  // ==========================================================================

  describe('loser submissions in EventStore (AC #5 transparency)', () => {
    it('all submissions (winners and losers) persist in EventStore after settlement', async () => {
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
      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        eventStore,
      });
      await coordinator.startSwarm(swarmRequest);

      // Submit 3 results
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_B_ID,
          providerPubkey: TEST_PROVIDER_B_PUBKEY,
        })
      );
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_C_ID,
          providerPubkey: TEST_PROVIDER_C_PUBKEY,
        })
      );

      // Select winner A
      await coordinator.selectWinner(createMockSelectionEvent());

      // Assert: all 3 submissions + swarm request + selection event in EventStore
      // (1 swarm request + 3 submissions + 1 selection = 5)
      expect(eventStore.events.length).toBe(5);

      // Assert: loser submission IDs present in store
      const storedIds = eventStore.events.map((e) => e.id);
      expect(storedIds).toContain(TEST_RESULT_A_ID); // winner
      expect(storedIds).toContain(TEST_RESULT_B_ID); // loser
      expect(storedIds).toContain(TEST_RESULT_C_ID); // loser
    });
  });

  // ==========================================================================
  // Gap-fill: Submission with wrong kind range rejected (AC #2)
  // ==========================================================================

  describe('submission kind validation', () => {
    it('submission with kind outside 6000-6999 range is rejected', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Act: submit with wrong kind (5100 instead of 6100)
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
          kind: 5100, // wrong kind range
        })
      );

      // Assert: not accepted
      expect(coordinator.getSubmissions()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // State machine invariants
  // ==========================================================================

  describe('state machine invariants', () => {
    it('initial state is collecting after startSwarm', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest();
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      // Act
      await coordinator.startSwarm(swarmRequest);

      // Assert
      expect(coordinator.getState()).toBe('collecting');
    });

    it('selectWinner throws DVM_SWARM_INVALID_SELECTION for unknown submission', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 1 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      expect(coordinator.getState()).toBe('judging');

      // Act & Assert: select a submission that was never submitted
      await expect(
        coordinator.selectWinner(
          createMockSelectionEvent({ winnerResultId: 'ff'.repeat(32) })
        )
      ).rejects.toThrow('not found in collected submissions');
    });

    it('selectWinner is rejected when state is collecting', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 5 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Submit 1 (not enough to trigger judging)
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      expect(coordinator.getState()).toBe('collecting');

      // Act & Assert: cannot select while collecting
      await expect(
        coordinator.selectWinner(createMockSelectionEvent())
      ).rejects.toThrow();
    });

    it('handleSubmission before startSwarm is a safe no-op', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      // Act: call handleSubmission without starting
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );

      // Assert: no crash, no submissions
      expect(coordinator.getSubmissions()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Resource cleanup
  // ==========================================================================

  describe('resource cleanup', () => {
    it('destroy() clears pending timeout to prevent timer leak', async () => {
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

      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      // Act: destroy while collecting
      coordinator.destroy();

      // Advance time past what would have been the timeout
      vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

      // Assert: state should still be collecting (timeout was cleared, not fired)
      expect(coordinator.getState()).toBe('collecting');
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

      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(createMockSwarmRequest());

      // Act: double destroy should not throw
      coordinator.destroy();
      expect(() => coordinator.destroy()).not.toThrow();
    });
  });

  // ==========================================================================
  // EventStore persistence
  // ==========================================================================

  describe('EventStore persistence', () => {
    it('submissions stored in EventStore when provided', async () => {
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
      const swarmRequest = createMockSwarmRequest({ maxProviders: 3 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        eventStore,
      });
      await coordinator.startSwarm(swarmRequest);

      // Act
      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );

      // Assert: submission stored in event store
      expect(eventStore.events.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Authorization: selection pubkey must match customer
  // ==========================================================================

  describe('selection authorization', () => {
    it('rejects selection from non-customer pubkey', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 1 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      expect(coordinator.getState()).toBe('judging');

      // Act: selection from a different pubkey (attacker)
      const attackerSelection = {
        ...createMockSelectionEvent(),
        pubkey: 'ab'.repeat(32), // not the customer
      };

      // Assert: rejected
      await expect(coordinator.selectWinner(attackerSelection)).rejects.toThrow(
        'pubkey does not match'
      );
    });
  });

  // ==========================================================================
  // Swarm reference: selection must reference this swarm
  // ==========================================================================

  describe('swarm reference validation', () => {
    it('rejects selection referencing a different swarm request ID', async () => {
      // Arrange
      const connector = createMockConnector();
      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 1 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      expect(coordinator.getState()).toBe('judging');

      // Act: selection referencing a different swarm
      const wrongSwarmSelection = createMockSelectionEvent({
        swarmRequestId: 'ff'.repeat(32), // different swarm
      });

      // Assert: rejected
      await expect(
        coordinator.selectWinner(wrongSwarmSelection)
      ).rejects.toThrow('references swarm');
    });
  });

  // ==========================================================================
  // Settlement failure: state remains judging for retry
  // ==========================================================================

  describe('settlement failure handling', () => {
    it('settlement failure keeps state in judging for retry', async () => {
      // Arrange: connector that rejects settlement
      const failingConnector = createMockConnector({
        type: 'reject',
        code: 'F00',
        message: 'settlement failed',
        triggeredBy: '',
        data: Buffer.alloc(0),
      } as any);
      // Override sendPacket to throw
      failingConnector.sendPacket = async () => {
        throw new Error('Settlement RPC error');
      };

      const node = createNode({
        secretKey: TEST_SECRET_KEY,
        connector: failingConnector,
        basePricePerByte: 10n,
        knownPeers: [],
      });
      await node.start();

      const swarmRequest = createMockSwarmRequest({ maxProviders: 1 });
      const coordinator = new SwarmCoordinator(node, {
        secretKey: TEST_SECRET_KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      await coordinator.startSwarm(swarmRequest);

      await coordinator.handleSubmission(
        createMockSubmission({
          id: TEST_RESULT_A_ID,
          providerPubkey: TEST_PROVIDER_A_PUBKEY,
        })
      );
      expect(coordinator.getState()).toBe('judging');

      // Act: settlement fails
      await expect(
        coordinator.selectWinner(createMockSelectionEvent())
      ).rejects.toThrow('Settlement failed');

      // Assert: state remains judging (retryable)
      expect(coordinator.getState()).toBe('judging');
      expect(coordinator.isSettlementSucceeded()).toBe(false);
    });
  });
});
