/**
 * Swarm Coordinator for competitive DVM bidding (Story 6.2).
 *
 * Manages the lifecycle of a competitive swarm: collects provider
 * submissions, handles timeout-based judging deadlines, validates
 * winner selection, and settles compute payment to the winner only.
 *
 * The coordinator uses the TOON relay as the orchestration layer --
 * there is no separate swarm engine. Submission arrival is detected
 * via relay event subscriptions (Kind 6xxx results).
 *
 * State machine states:
 *   - `collecting`: Waiting for provider submissions (Kind 6xxx results)
 *   - `judging`: Timeout or max submissions reached; customer selects winner
 *   - `settled`: Winner paid via settleCompute(); swarm complete
 *   - `failed`: No submissions within timeout or error
 *
 * Settlement: Only the winning provider receives compute payment.
 * Losing providers paid relay write fees (sunk cost) but receive
 * no compute payment -- this is by design to incentivize quality.
 *
 * Forward-compatible with Epic 7 prepaid protocol: settlement logic
 * is isolated in selectWinner() so swapping to prepaid per-winner
 * payment requires changes only in that method.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import {
  ToonError,
  parseSwarmRequest,
  parseSwarmSelection,
} from '@toon-protocol/core';
import type { ServiceNode } from './create-node.js';
import type { WorkflowEventStore } from './workflow-orchestrator.js';

/**
 * Swarm state type.
 * - `collecting`: Waiting for provider submissions.
 * - `judging`: Timeout or max submissions reached; awaiting winner selection.
 * - `settled`: Winner paid; swarm complete.
 * - `failed`: No submissions within timeout or error.
 */
export type SwarmState = 'collecting' | 'judging' | 'settled' | 'failed';

/**
 * Configuration options for the SwarmCoordinator.
 */
export interface SwarmCoordinatorOptions {
  /** Secret key for signing events (32-byte Uint8Array). */
  secretKey?: Uint8Array;
  /** Swarm collection timeout in milliseconds (default: 600000 = 10 minutes). */
  timeoutMs?: number;
  /** Injectable time source for deterministic testing. */
  now?: () => number;
  /**
   * Injectable timer factory for deterministic testing.
   * Defaults to global setTimeout. Inject a custom implementation
   * to control timer advancement in tests without vi.useFakeTimers().
   */
  setTimer?: (
    callback: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  /**
   * Injectable timer cancellation for deterministic testing.
   * Defaults to global clearTimeout. Must pair with setTimer.
   */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Optional event store for swarm state persistence. */
  eventStore?: WorkflowEventStore;
  /** Default destination ILP address for publishing events. */
  destination?: string;
}

/**
 * Coordinates a competitive DVM swarm.
 *
 * Each instance manages a single swarm. For concurrent swarms,
 * create multiple SwarmCoordinator instances sharing the same
 * ServiceNode.
 */
export class SwarmCoordinator {
  private readonly node: ServiceNode;
  private readonly options: Required<
    Pick<SwarmCoordinatorOptions, 'timeoutMs'>
  > &
    SwarmCoordinatorOptions;

  private state: SwarmState = 'collecting';
  private swarmRequestId = '';
  private customerPubkey = '';
  private maxProviders = 0;
  private submissions: NostrEvent[] = [];
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private settlementSucceeded = false;
  private submissionIds = new Set<string>();

  constructor(node: ServiceNode, options?: SwarmCoordinatorOptions) {
    this.node = node;
    this.options = {
      timeoutMs: 600_000, // 10 minutes default
      ...options,
    };
  }

  /**
   * Returns the current swarm state.
   */
  getState(): SwarmState {
    return this.state;
  }

  /**
   * Returns whether settlement was successfully completed.
   * Only meaningful when state is 'settled' (returns true).
   * If settlement fails, the state remains 'judging' and this returns false.
   */
  isSettlementSucceeded(): boolean {
    return this.settlementSucceeded;
  }

  /**
   * Returns the collected eligible submissions.
   */
  getSubmissions(): readonly NostrEvent[] {
    return this.submissions;
  }

  /**
   * Starts a swarm: parses the swarm request, initializes collection,
   * and starts the timeout timer.
   */
  async startSwarm(swarmRequest: NostrEvent): Promise<void> {
    const parsed = parseSwarmRequest(swarmRequest);
    if (!parsed) {
      throw new ToonError(
        'Invalid swarm request event: missing swarm tag or invalid Kind 5xxx',
        'DVM_INVALID_KIND'
      );
    }

    this.swarmRequestId = swarmRequest.id;
    this.customerPubkey = swarmRequest.pubkey;
    this.maxProviders = parsed.maxProviders;
    this.state = 'collecting';
    this.submissions = [];
    this.submissionIds = new Set<string>();
    this.started = true;

    // Store the swarm request in EventStore if available
    if (this.options.eventStore) {
      await this.options.eventStore.store(swarmRequest);
    }

    // Start timeout timer
    this.startTimeout();
  }

  /**
   * Handles a Kind 6xxx result event (provider submission).
   *
   * Validates the `e` tag references the swarm request, adds to the
   * submissions list, and checks if max providers is reached.
   *
   * Late submissions (after timeout or max reached) are ignored.
   * Submissions before startSwarm() are silently ignored.
   */
  async handleSubmission(resultEvent: NostrEvent): Promise<void> {
    if (!this.started) return;

    // Only accept submissions during collecting state
    if (this.state !== 'collecting') return;

    // Validate result event kind is in the 6000-6999 range
    if (resultEvent.kind < 6000 || resultEvent.kind > 6999) return;

    // Validate e tag references our swarm request
    const eTag = resultEvent.tags.find((t: string[]) => t[0] === 'e');
    if (!eTag) return;
    const requestEventId = eTag[1];
    if (requestEventId === undefined || requestEventId !== this.swarmRequestId)
      return;

    // Deduplicate by event ID -- relay normally handles dedup, but the
    // coordinator must also guard against duplicate submissions reaching
    // the maxProviders threshold with the same event repeated.
    if (this.submissionIds.has(resultEvent.id)) return;
    this.submissionIds.add(resultEvent.id);

    // Add to submissions
    this.submissions.push(resultEvent);

    // Store in EventStore if available
    if (this.options.eventStore) {
      await this.options.eventStore.store(resultEvent);
    }

    // Check if max providers reached
    if (this.submissions.length >= this.maxProviders) {
      this.clearTimeout();
      this.state = 'judging';
    }
  }

  /**
   * Selects the winner and settles compute payment.
   *
   * Validates:
   * - Swarm is in `judging` state (not `collecting`, `settled`, or `failed`)
   * - Selection references a submission in the collected set
   * - Swarm has not already been settled (idempotency guard)
   *
   * @throws ToonError with code DVM_SWARM_ALREADY_SETTLED if already settled
   * @throws ToonError with code DVM_SWARM_INVALID_SELECTION if winner not in submissions
   */
  async selectWinner(selectionEvent: NostrEvent): Promise<void> {
    // Idempotency guard: reject if already settled
    if (this.state === 'settled') {
      throw new ToonError(
        'Swarm has already been settled; duplicate selection rejected',
        'DVM_SWARM_ALREADY_SETTLED'
      );
    }

    // Must be in judging state
    if (this.state !== 'judging') {
      throw new ToonError(
        `Cannot select winner in state '${this.state}'; swarm must be in 'judging' state`,
        'DVM_SWARM_INVALID_SELECTION'
      );
    }

    // Parse the selection event to extract the winner
    // Validate that the selection event is from the swarm's customer
    if (selectionEvent.pubkey !== this.customerPubkey) {
      throw new ToonError(
        'Selection event pubkey does not match the swarm request customer pubkey',
        'DVM_SWARM_INVALID_SELECTION'
      );
    }

    const parsed = parseSwarmSelection(selectionEvent);
    if (!parsed) {
      throw new ToonError(
        'Invalid swarm selection event: missing winner tag or invalid Kind 7000',
        'DVM_SWARM_INVALID_SELECTION'
      );
    }

    // Validate that the selection references this swarm (not a different one)
    if (parsed.swarmRequestEventId !== this.swarmRequestId) {
      throw new ToonError(
        `Selection event references swarm '${parsed.swarmRequestEventId}' but this swarm is '${this.swarmRequestId}'`,
        'DVM_SWARM_INVALID_SELECTION'
      );
    }

    // Validate the winner references a collected submission
    const winnerSubmission = this.submissions.find(
      (s) => s.id === parsed.winnerResultEventId
    );
    if (!winnerSubmission) {
      throw new ToonError(
        `Winner result event ID '${parsed.winnerResultEventId}' not found in collected submissions`,
        'DVM_SWARM_INVALID_SELECTION'
      );
    }

    // Settle compute payment to the winning provider only
    const providerIlpAddress = this.options.destination ?? 'g.toon.provider';
    try {
      await this.node.settleCompute(winnerSubmission, providerIlpAddress);
      this.settlementSucceeded = true;
    } catch (_err: unknown) {
      // Settlement failed -- remain in 'judging' state so the caller can
      // retry selectWinner() with the same or different selection event.
      // Do NOT transition to 'settled' because no payment was made.
      this.settlementSucceeded = false;
      throw new ToonError(
        'Settlement failed for winning provider; swarm remains in judging state for retry',
        'DVM_SWARM_SETTLEMENT_FAILED'
      );
    }

    // Store selection in EventStore if available
    if (this.options.eventStore) {
      await this.options.eventStore.store(selectionEvent);
    }

    this.state = 'settled';
  }

  /**
   * Cleans up resources (timeout handles).
   */
  destroy(): void {
    this.clearTimeout();
  }

  // ---------- Private Methods ----------

  /**
   * Starts the collection timeout timer.
   */
  private startTimeout(): void {
    this.clearTimeout();

    const timeoutMs = this.options.timeoutMs;
    const timerFn = this.options.setTimer ?? setTimeout;

    this.timeoutHandle = timerFn(() => {
      if (this.state !== 'collecting') return;

      if (this.submissions.length === 0) {
        // No submissions -- transition to failed
        this.state = 'failed';

        // Publish "no submissions" Kind 7000 feedback to customer
        void this.publishNoSubmissionsFeedback();
      } else {
        // Some submissions collected -- transition to judging
        this.state = 'judging';
      }
    }, timeoutMs);
  }

  /**
   * Publishes a Kind 7000 feedback event indicating no submissions were received.
   */
  private async publishNoSubmissionsFeedback(): Promise<void> {
    const destination = this.options.destination ?? 'g.toon.local';
    try {
      await this.node.publishFeedback(
        this.swarmRequestId,
        this.customerPubkey,
        'error',
        'Swarm timed out with no submissions',
        { destination }
      );
    } catch (_err: unknown) {
      // Best-effort notification -- don't fail the state transition.
    }
  }

  /**
   * Clears the current timeout timer.
   */
  private clearTimeout(): void {
    if (this.timeoutHandle !== null) {
      const cancelFn = this.options.clearTimer ?? clearTimeout;
      cancelFn(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
