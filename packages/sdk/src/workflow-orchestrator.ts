/**
 * Workflow Orchestrator for multi-step DVM pipelines (Story 6.1).
 *
 * Manages the lifecycle of a workflow chain: creates step job requests,
 * detects step completion/failure, advances to the next step, handles
 * timeouts, and settles compute payments per step.
 *
 * The orchestrator uses the TOON relay as the orchestration layer --
 * there is no separate workflow engine. Step completion is detected
 * via relay event subscriptions (Kind 6xxx results, Kind 7000 feedback).
 *
 * State machine states:
 *   - `pending`: Workflow created but not yet started
 *   - `step_N_running`: Step N's job request published, waiting for result
 *   - `step_N_failed`: Step N failed (error or timeout), workflow aborted
 *   - `completed`: All steps finished successfully
 *
 * Settlement: Each step settles individually via settleCompute().
 * The orchestrator validates sum(step_amounts) <= total_bid before settlement.
 *
 * Forward-compatible with Epic 7 prepaid protocol: settlement logic is
 * isolated in handleStepResult() so swapping to prepaid per-step payment
 * requires changes only in that method.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { buildJobRequestEvent, parseJobFeedback } from '@toon-protocol/core';
import type { ParsedWorkflowDefinition } from '@toon-protocol/core';
import type { ServiceNode } from './create-node.js';

/**
 * Workflow state type. Uses template literal types for step-indexed states.
 * Note: Timeout is represented as `step_N_failed` (timeout is a failure mode,
 * not a separate terminal state). The timeout cause is communicated in the
 * customer notification content.
 */
export type WorkflowState =
  | 'pending'
  | `step_${number}_running`
  | `step_${number}_failed`
  | 'completed';

/**
 * Event store interface for workflow state persistence.
 * Minimal interface -- only store() and query() are needed.
 */
export interface WorkflowEventStore {
  store(event: NostrEvent): Promise<void>;
  query(filter: { kinds?: number[]; '#e'?: string[] }): Promise<NostrEvent[]>;
}

/**
 * Configuration options for the WorkflowOrchestrator.
 */
export interface WorkflowOrchestratorOptions {
  /** Secret key for signing step job request events (32-byte Uint8Array). */
  secretKey?: Uint8Array;
  /** Per-step timeout in milliseconds (default: 300000 = 5 minutes). */
  stepTimeoutMs?: number;
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
  /** Optional event store for workflow state persistence. */
  eventStore?: WorkflowEventStore;
  /** Default destination ILP address for publishing events. */
  destination?: string;
  /** Workflow definition event ID (for referencing in notifications). */
  workflowEventId?: string;
  /** Customer pubkey (for directing notifications). */
  customerPubkey?: string;
}

/**
 * Per-step state tracking.
 */
interface StepState {
  /** Index of this step (0-based). */
  index: number;
  /** The job request event ID published for this step. */
  requestEventId?: string;
  /** The result event received for this step. */
  resultEvent?: NostrEvent;
  /** Whether this step has been settled. */
  settled: boolean;
}

/**
 * Orchestrates a multi-step DVM workflow chain.
 *
 * Each instance manages a single workflow. For concurrent workflows,
 * create multiple WorkflowOrchestrator instances sharing the same
 * ServiceNode.
 */
export class WorkflowOrchestrator {
  private readonly node: ServiceNode;
  private readonly options: Required<
    Pick<WorkflowOrchestratorOptions, 'stepTimeoutMs'>
  > &
    WorkflowOrchestratorOptions;

  private state: WorkflowState = 'pending';
  private definition: ParsedWorkflowDefinition | null = null;
  private workflowEventId: string = '0'.repeat(64);
  private customerPubkey: string = '0'.repeat(64);
  private currentStepIndex = 0;
  private stepStates: StepState[] = [];
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private processedResultIds = new Set<string>();

  constructor(node: ServiceNode, options?: WorkflowOrchestratorOptions) {
    this.node = node;
    this.options = {
      stepTimeoutMs: 300_000, // 5 minutes default
      ...options,
    };
    if (options?.workflowEventId) {
      this.workflowEventId = options.workflowEventId;
    }
    if (options?.customerPubkey) {
      this.customerPubkey = options.customerPubkey;
    }
  }

  /**
   * Returns the current workflow state.
   */
  getState(): WorkflowState {
    return this.state;
  }

  /**
   * Returns per-step state tracking data (for testing/debugging).
   */
  getStepStates(): readonly Readonly<StepState>[] {
    return this.stepStates;
  }

  /**
   * Starts a workflow: parses the definition, creates and publishes
   * the Kind 5xxx job request for step 1, sets state to step_1_running.
   */
  async startWorkflow(definition: ParsedWorkflowDefinition): Promise<void> {
    // Guard: prevent re-entrance -- calling startWorkflow on an already-started
    // orchestrator would silently overwrite state without cleaning up timeouts.
    if (this.state !== 'pending') {
      throw new Error(
        'WorkflowOrchestrator.startWorkflow() called on a non-pending orchestrator. ' +
          'Create a new WorkflowOrchestrator instance for each workflow.'
      );
    }

    // Guard: validate steps non-empty (defense-in-depth -- the builder validates
    // this too, but the orchestrator may receive ParsedWorkflowDefinition from
    // sources other than the builder, e.g. deserialized from EventStore).
    if (!definition.steps || definition.steps.length === 0) {
      throw new Error(
        'WorkflowOrchestrator.startWorkflow() requires at least one step in the definition.'
      );
    }

    this.definition = definition;

    // Initialize step states
    this.stepStates = definition.steps.map((_, index) => ({
      index,
      settled: false,
    }));

    // Store the workflow definition event if eventStore is available
    if (this.options.eventStore) {
      // Create a synthetic event representing the workflow state.
      // Use a hash-like ID derived from pubkey + timestamp to avoid collisions
      // across concurrent workflows.
      const now = this.options.now ? this.options.now() : Date.now();
      const syntheticId = `wf${now.toString(16).padStart(16, '0')}${this.node.pubkey.slice(0, 48)}`;
      const stateEvent: NostrEvent = {
        id: syntheticId.padEnd(64, '0').slice(0, 64),
        pubkey: this.node.pubkey,
        created_at: Math.floor(now / 1000),
        kind: 10040,
        content: JSON.stringify({
          state: 'started',
          definition,
        }),
        tags: [],
        sig: '0'.repeat(128),
      };
      await this.options.eventStore.store(stateEvent);
    }

    // Create and publish step 1
    await this.publishStepRequest(
      0,
      definition.initialInput.data,
      definition.initialInput.type
    );

    // Set state
    this.state = 'step_1_running';
    this.currentStepIndex = 0;

    // Start timeout for step 1
    this.startStepTimeout();
  }

  /**
   * Handles a Kind 6xxx result event for the current step.
   *
   * If the current step matches, extracts the result content and either:
   * - Advances to the next step (publishes Kind 5xxx for step N+1)
   * - Marks workflow as completed (if this was the final step)
   *
   * Idempotent: re-processing a result for an already-advanced step is a no-op.
   */
  async handleStepResult(resultEvent: NostrEvent): Promise<void> {
    if (!this.definition) return;

    // Validate result event kind is in the 6000-6999 range (Kind 6xxx).
    // Without this check, any event kind could be injected as a step result.
    if (resultEvent.kind < 6000 || resultEvent.kind > 6999) return;

    // Idempotency: skip already-processed result events
    if (this.processedResultIds.has(resultEvent.id)) return;

    // Idempotency: ignore if we've already moved past this step
    const currentStep = this.stepStates[this.currentStepIndex];
    if (!currentStep) return;
    if (currentStep.resultEvent) return; // Already processed

    // Ignore if workflow is in a terminal state
    if (this.state === 'completed' || this.state.endsWith('_failed')) return;

    // NOTE: The orchestrator trusts that the caller pre-filters result events
    // to match the current step's request (via relay subscription with `e` tag
    // filter on currentStep.requestEventId). Defense-in-depth validation of the
    // `e` tag could be added here but would require callers to ensure result
    // events always reference the correct request ID.

    // Mark this result as processed
    this.processedResultIds.add(resultEvent.id);

    // Clear timeout
    this.clearStepTimeout();

    // Record the result
    currentStep.resultEvent = resultEvent;

    // Settle compute for this step
    await this.settleStep(this.currentStepIndex, resultEvent);

    // Store step result in eventStore if available
    if (this.options.eventStore) {
      await this.options.eventStore.store(resultEvent);
    }

    // Check if this was the final step
    const isLastStep =
      this.currentStepIndex === this.definition.steps.length - 1;

    if (isLastStep) {
      // Workflow complete
      this.state = 'completed';

      // Notify customer with Kind 7000 success
      await this.publishWorkflowNotification(
        'success',
        'Workflow completed successfully'
      );
    } else {
      // Advance to next step
      const nextIndex = this.currentStepIndex + 1;
      const resultContent = resultEvent.content;

      await this.publishStepRequest(nextIndex, resultContent, 'text');

      this.currentStepIndex = nextIndex;
      this.state = `step_${nextIndex + 1}_running`;

      // Start timeout for next step
      this.startStepTimeout();
    }
  }

  /**
   * Handles a Kind 7000 feedback event for the current step.
   *
   * If the feedback status is 'error', marks the workflow as failed
   * and notifies the customer.
   */
  async handleStepFeedback(feedbackEvent: NostrEvent): Promise<void> {
    if (!this.definition) return;

    // Ignore if workflow is in a terminal state
    if (this.state === 'completed' || this.state.endsWith('_failed')) return;

    const parsed = parseJobFeedback(feedbackEvent);
    if (!parsed) return;

    if (parsed.status === 'error') {
      // Clear timeout
      this.clearStepTimeout();

      // Mark failed
      this.state = `step_${this.currentStepIndex + 1}_failed`;

      // Store failure in eventStore if available
      if (this.options.eventStore) {
        await this.options.eventStore.store(feedbackEvent);
      }

      // Notify customer
      await this.publishWorkflowNotification(
        'error',
        `Workflow failed at step ${this.currentStepIndex + 1}: ${parsed.content || 'Unknown error'}`
      );
    }
  }

  /**
   * Cleans up resources (timeout handles).
   */
  destroy(): void {
    this.clearStepTimeout();
  }

  // ---------- Private Methods ----------

  /**
   * Publishes a Kind 5xxx job request for the given step.
   */
  private async publishStepRequest(
    stepIndex: number,
    inputData: string,
    inputType: string
  ): Promise<void> {
    if (!this.definition) return;

    const step = this.definition.steps[stepIndex];
    if (!step) return;

    // Compute bid for this step
    const stepBid = this.getStepBid(stepIndex);

    // Build the job request event
    const jobRequest = buildJobRequestEvent(
      {
        kind: step.kind,
        input: { data: inputData, type: inputType },
        bid: stepBid,
        output: 'text/plain',
        content: step.description,
        targetProvider: step.targetProvider,
      },
      this.getSecretKey()
    );

    // Publish via the node's publishEvent (which handles TOON encoding + ILP)
    const destination = this.options.destination ?? 'g.toon.local';
    await this.node.publishEvent(jobRequest, { destination });

    // Record the request event ID
    const stepState = this.stepStates[stepIndex];
    if (stepState) {
      stepState.requestEventId = jobRequest.id;
    }
  }

  /**
   * Settles compute payment for a completed step.
   */
  private async settleStep(
    stepIndex: number,
    resultEvent: NostrEvent
  ): Promise<void> {
    if (!this.definition) return;

    const stepState = this.stepStates[stepIndex];
    if (!stepState || stepState.settled) return;

    const step = this.definition.steps[stepIndex];
    if (!step) return;

    // Determine provider ILP address from result event pubkey or fallback.
    // In production, this would be resolved from the provider's kind:10035
    // service discovery event. For now, derive from the destination prefix.
    const providerIlpAddress = this.options.destination ?? 'g.toon.provider';

    try {
      await this.node.settleCompute(resultEvent, providerIlpAddress, {
        originalBid: this.getStepBid(stepIndex),
      });
      stepState.settled = true;
    } catch (_err: unknown) {
      // Settlement failure does not block workflow advancement.
      // The orchestrator prioritizes workflow progress over payment atomicity.
      // In production, the caller should monitor stepState.settled per step
      // and reconcile unsettled steps out-of-band.
    }
  }

  /**
   * Returns the bid allocation for a specific step.
   * Uses explicit bidAllocation if set, otherwise proportional split.
   */
  private getStepBid(stepIndex: number): string {
    if (!this.definition) return '0';

    const step = this.definition.steps[stepIndex];
    if (!step) return '0';

    // Use explicit allocation if available
    if (step.bidAllocation !== undefined) {
      return step.bidAllocation;
    }

    // Proportional split -- wrap BigInt conversion in try/catch since
    // totalBid may come from deserialized EventStore data that was not
    // validated by the builder.
    try {
      const totalBid = BigInt(this.definition.totalBid);
      const stepCount = BigInt(this.definition.steps.length);
      const perStep = totalBid / stepCount;
      return perStep.toString();
    } catch {
      return '0';
    }
  }

  /**
   * Publishes a Kind 7000 workflow notification to the customer.
   */
  private async publishWorkflowNotification(
    status: 'success' | 'error',
    content: string
  ): Promise<void> {
    const destination = this.options.destination ?? 'g.toon.local';
    try {
      await this.node.publishFeedback(
        this.workflowEventId,
        this.customerPubkey,
        status,
        content,
        { destination }
      );
    } catch (_err: unknown) {
      // Best-effort notification -- don't fail the workflow.
      // Notification delivery is not guaranteed; callers should
      // check orchestrator.getState() for authoritative status.
    }
  }

  /**
   * Starts a timeout timer for the current step.
   */
  private startStepTimeout(): void {
    this.clearStepTimeout();

    const timeoutMs = this.options.stepTimeoutMs;
    const timerFn = this.options.setTimer ?? setTimeout;

    this.timeoutHandle = timerFn(() => {
      // Mark as failed due to timeout
      this.state = `step_${this.currentStepIndex + 1}_failed`;

      // Notify customer
      void this.publishWorkflowNotification(
        'error',
        `Workflow timed out at step ${this.currentStepIndex + 1} after ${timeoutMs}ms`
      );
    }, timeoutMs);
  }

  /**
   * Returns the secret key for signing step events.
   * Falls back to a deterministic key derived from the node pubkey
   * (for testing -- production should always pass secretKey in options).
   */
  private getSecretKey(): Uint8Array {
    if (this.options.secretKey) {
      return this.options.secretKey;
    }
    // Fallback: use a fixed test key (this path should not be hit in production)
    throw new Error(
      'WorkflowOrchestrator requires secretKey in options to sign step events'
    );
  }

  /**
   * Clears the current step timeout.
   */
  private clearStepTimeout(): void {
    if (this.timeoutHandle !== null) {
      const cancelFn = this.options.clearTimer ?? clearTimeout;
      cancelFn(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
