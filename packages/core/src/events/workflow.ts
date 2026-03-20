/**
 * Event builder and parser for Workflow Chain events (kind:10040).
 *
 * Workflow chains define multi-step DVM pipelines where each step's output
 * automatically feeds into the next step's input. The workflow definition
 * event contains an ordered list of steps, initial input, and a total bid
 * that is split across steps.
 *
 * Kind:10040 is in the TOON-specific replaceable range (10032-10099).
 * Each workflow instance uses a unique `d` tag to avoid unintentional
 * replacement of in-progress workflows.
 *
 * Tag reference (kind:10040):
 *   Content: JSON-serialized workflow definition body
 *   Required: ['d', uniqueWorkflowId], ['bid', totalBid, 'usdc']
 *   Content JSON: { steps: WorkflowStep[], initialInput: { data, type }, totalBid }
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { WORKFLOW_CHAIN_KIND } from '../constants.js';
import { ToonError } from '../errors.js';

/** Regex for 64-char lowercase hex string (matches dvm.ts validation). */
const HEX_64_REGEX = /^[0-9a-f]{64}$/;

// Re-export constant for convenient co-located imports (follows dvm.ts pattern)
export { WORKFLOW_CHAIN_KIND };

// ---------- Types ----------

/**
 * A single step in a workflow chain.
 *
 * Each step specifies a DVM kind (5000-5999) and a description.
 * Optionally, a step can target a specific provider and allocate
 * an explicit portion of the total bid.
 */
export interface WorkflowStep {
  /** DVM job request kind (5000-5999 range). */
  kind: number;
  /** Human-readable description of the step's purpose. */
  description: string;
  /** Optional 64-char hex pubkey of a specific target provider. */
  targetProvider?: string;
  /** Optional explicit bid allocation in USDC micro-units as string. */
  bidAllocation?: string;
}

/**
 * Parameters for building a kind:10040 Workflow Chain event.
 */
export interface WorkflowDefinitionParams {
  /** Ordered list of workflow steps (at least one required). */
  steps: WorkflowStep[];
  /** Initial input for the first step. */
  initialInput: {
    /** The input data (text, JSON, etc.). */
    data: string;
    /** Input type identifier (e.g., 'text', 'json'). */
    type: string;
  };
  /** Total bid for the entire workflow in USDC micro-units as string. */
  totalBid: string;
  /** Optional body text for the event content field. */
  content?: string;
  /** Optional workflow ID for deterministic `d` tag (defaults to timestamp-based). */
  workflowId?: string;
}

/**
 * Parsed result from a kind:10040 Workflow Chain event.
 */
export interface ParsedWorkflowDefinition {
  /** Ordered list of workflow steps. */
  steps: WorkflowStep[];
  /** Initial input for the first step. */
  initialInput: {
    /** The input data. */
    data: string;
    /** Input type identifier. */
    type: string;
  };
  /** Total bid for the entire workflow in USDC micro-units as string. */
  totalBid: string;
  /** Event content field (JSON-serialized workflow body). */
  content: string;
}

// ---------- Builder ----------

/**
 * Builds a kind:10040 Workflow Chain event.
 *
 * Validates steps, initial input, total bid, and per-step bid allocations
 * (if provided). Serializes the workflow definition as JSON content.
 *
 * @param params - The workflow definition parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError if validation fails.
 */
export function buildWorkflowDefinitionEvent(
  params: WorkflowDefinitionParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate steps non-empty
  if (!params.steps || params.steps.length === 0) {
    throw new ToonError(
      'Workflow definition must have at least one step',
      'DVM_WORKFLOW_INVALID_STEPS'
    );
  }

  // Validate each step kind in 5000-5999 range and optional targetProvider format
  for (const step of params.steps) {
    if (step.kind < 5000 || step.kind > 5999) {
      throw new ToonError(
        `Workflow step kind must be in range 5000-5999, got ${step.kind}`,
        'DVM_WORKFLOW_INVALID_STEPS'
      );
    }
    if (typeof step.description !== 'string' || step.description === '') {
      throw new ToonError(
        'Workflow step description must be a non-empty string',
        'DVM_WORKFLOW_INVALID_STEPS'
      );
    }
    if (
      step.targetProvider !== undefined &&
      !HEX_64_REGEX.test(step.targetProvider)
    ) {
      throw new ToonError(
        'Workflow step targetProvider must be a 64-character lowercase hex string',
        'DVM_WORKFLOW_INVALID_PROVIDER'
      );
    }
  }

  // Validate initial input data is a string.
  // Empty string is intentionally allowed per NIP-90 convention (same as
  // buildJobRequestEvent). Only non-string types are rejected.
  if (typeof params.initialInput.data !== 'string') {
    throw new ToonError(
      'Workflow definition initial input data must be a string',
      'DVM_WORKFLOW_MISSING_INPUT'
    );
  }

  // Validate initial input type is non-empty
  if (!params.initialInput.type) {
    throw new ToonError(
      'Workflow definition initial input type is required',
      'DVM_WORKFLOW_MISSING_INPUT'
    );
  }

  // Validate totalBid is non-empty string
  if (typeof params.totalBid !== 'string' || params.totalBid === '') {
    throw new ToonError(
      'Workflow definition totalBid must be a non-empty string (USDC micro-units)',
      'DVM_WORKFLOW_INVALID_BID'
    );
  }

  // Validate per-step bid allocations: sum(allocations) <= totalBid
  const stepsWithAllocation = params.steps.filter(
    (s) => s.bidAllocation !== undefined
  );
  if (stepsWithAllocation.length > 0) {
    let allocationSum: bigint;
    let totalBidBigInt: bigint;
    try {
      allocationSum = 0n;
      for (const step of stepsWithAllocation) {
        allocationSum += BigInt(step.bidAllocation as string);
      }
      totalBidBigInt = BigInt(params.totalBid);
    } catch {
      throw new ToonError(
        'Workflow bid amounts must be valid numeric strings (USDC micro-units)',
        'DVM_WORKFLOW_INVALID_BID'
      );
    }
    if (allocationSum > totalBidBigInt) {
      throw new ToonError(
        `Sum of step bid allocations (${allocationSum}) exceeds total bid (${totalBidBigInt})`,
        'DVM_WORKFLOW_BID_OVERFLOW'
      );
    }
  }

  // Build content JSON
  const contentBody = {
    steps: params.steps.map((step) => {
      const s: Record<string, unknown> = {
        kind: step.kind,
        description: step.description,
      };
      if (step.targetProvider !== undefined) {
        s['targetProvider'] = step.targetProvider;
      }
      if (step.bidAllocation !== undefined) {
        s['bidAllocation'] = step.bidAllocation;
      }
      return s;
    }),
    initialInput: params.initialInput,
    totalBid: params.totalBid,
  };

  const contentJson = JSON.stringify(contentBody);

  // Build tags
  const tags: string[][] = [];

  // Unique `d` tag for NIP-33 parameterized replaceable semantics.
  // Use explicit workflowId if provided (deterministic), otherwise
  // fall back to timestamp-based identifier.
  const dTag = params.workflowId ?? `wf-${Date.now()}-${params.steps.length}`;
  tags.push(['d', dTag]);

  // Total bid tag for easy extraction without full JSON parse
  tags.push(['bid', params.totalBid, 'usdc']);

  return finalizeEvent(
    {
      kind: WORKFLOW_CHAIN_KIND,
      content: contentJson,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

// ---------- Parser ----------

/**
 * Parses a kind:10040 event into a ParsedWorkflowDefinition.
 *
 * Validates the event kind, parses JSON content, validates the steps
 * array, initialInput, and totalBid. Returns `null` for malformed events.
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed workflow definition, or null if invalid.
 */
export function parseWorkflowDefinition(
  event: NostrEvent
): ParsedWorkflowDefinition | null {
  // Validate kind
  if (event.kind !== WORKFLOW_CHAIN_KIND) {
    return null;
  }

  // Parse content JSON
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch {
    return null;
  }

  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const obj = body as Record<string, unknown>;

  // Validate steps array
  const rawSteps = obj['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return null;
  }

  const steps: WorkflowStep[] = [];
  for (const rawStep of rawSteps) {
    if (typeof rawStep !== 'object' || rawStep === null) {
      return null;
    }
    const stepObj = rawStep as Record<string, unknown>;
    const kind = stepObj['kind'];
    const description = stepObj['description'];
    if (typeof kind !== 'number' || typeof description !== 'string') {
      return null;
    }
    if (kind < 5000 || kind > 5999) {
      return null;
    }

    const step: WorkflowStep = { kind, description };

    const targetProvider = stepObj['targetProvider'];
    if (typeof targetProvider === 'string' && targetProvider.length > 0) {
      step.targetProvider = targetProvider;
    }

    const bidAllocation = stepObj['bidAllocation'];
    if (typeof bidAllocation === 'string' && bidAllocation.length > 0) {
      step.bidAllocation = bidAllocation;
    }

    steps.push(step);
  }

  // Validate initialInput
  const rawInput = obj['initialInput'];
  if (typeof rawInput !== 'object' || rawInput === null) {
    return null;
  }
  const inputObj = rawInput as Record<string, unknown>;
  const inputData = inputObj['data'];
  const inputType = inputObj['type'];
  if (typeof inputData !== 'string' || typeof inputType !== 'string') {
    return null;
  }

  // Validate totalBid
  const totalBid = obj['totalBid'];
  if (typeof totalBid !== 'string' || totalBid === '') {
    return null;
  }

  return {
    steps,
    initialInput: { data: inputData, type: inputType },
    totalBid,
    content: event.content,
  };
}
