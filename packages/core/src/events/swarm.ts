/**
 * Event builders and parsers for DVM Agent Swarm events (Story 6.2).
 *
 * Swarm events extend NIP-90 DVM events with competitive bidding tags:
 * - `['swarm', maxProviders]` -- maximum number of providers in the swarm
 * - `['judge', judgeIdentifier]` -- who selects the winner (default: 'customer')
 *
 * Swarm request events are standard Kind 5xxx events with additional tags.
 * Non-swarm-aware providers can still participate via the standard Kind 5xxx path.
 *
 * Selection events are Kind 7000 feedback events with a `winner` tag
 * referencing the winning Kind 6xxx result event ID.
 *
 * Tag reference (swarm-specific additions):
 *
 * Kind 5xxx (Swarm Job Request):
 *   Standard NIP-90 tags + ['swarm', maxProviders], ['judge', judgeId]
 *
 * Kind 7000 (Swarm Selection):
 *   Standard NIP-90 feedback tags + ['winner', winnerResultEventId]
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { JOB_FEEDBACK_KIND } from '../constants.js';
import { ToonError } from '../errors.js';
import { buildJobRequestEvent, parseJobRequest } from './dvm.js';
import type { JobRequestParams, ParsedJobRequest } from './dvm.js';

// ---------- Validation Helpers ----------

/** Regex for 64-char lowercase hex string. */
const HEX_64_REGEX = /^[0-9a-f]{64}$/;

// ---------- Types ----------

/**
 * Parameters for building a swarm request event (Kind 5xxx with swarm tags).
 *
 * Extends `JobRequestParams` with swarm-specific fields:
 * - `maxProviders`: Maximum number of providers in the competitive swarm (>= 1).
 * - `judge`: Who selects the winner (default: 'customer'). Can be 'customer',
 *   'auto', or a specific pubkey.
 */
export interface SwarmRequestParams extends JobRequestParams {
  /** Maximum number of providers to collect submissions from (>= 1). */
  maxProviders: number;
  /** Who selects the winner (default: 'customer'). */
  judge?: string;
}

/**
 * Parameters for building a swarm selection event (Kind 7000 with winner tag).
 */
export interface SwarmSelectionParams {
  /** 64-char hex event ID of the original swarm request. */
  swarmRequestEventId: string;
  /** 64-char hex event ID of the winning Kind 6xxx result. */
  winnerResultEventId: string;
  /** 64-char hex pubkey of the customer who posted the swarm request. */
  customerPubkey: string;
}

/**
 * Parsed result from a Kind 5xxx swarm request event.
 * Extends `ParsedJobRequest` with swarm-specific fields.
 */
export interface ParsedSwarmRequest extends ParsedJobRequest {
  /** Maximum number of providers in the swarm. */
  maxProviders: number;
  /** Who selects the winner. */
  judge: string;
}

/**
 * Parsed result from a Kind 7000 swarm selection event.
 */
export interface ParsedSwarmSelection {
  /** Event ID of the original swarm request. */
  swarmRequestEventId: string;
  /** Event ID of the winning Kind 6xxx result. */
  winnerResultEventId: string;
}

// ---------- Builders ----------

/**
 * Builds a Kind 5xxx swarm request event.
 *
 * Delegates to `buildJobRequestEvent()` for the base NIP-90 event, then
 * appends swarm-specific tags: `swarm` (max providers) and `judge` (selector).
 *
 * The resulting event is a valid Kind 5xxx event that non-swarm-aware
 * providers can also parse via `parseJobRequest()`.
 *
 * @param params - The swarm request parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError if maxProviders < 1 or base params are invalid.
 */
export function buildSwarmRequestEvent(
  params: SwarmRequestParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate maxProviders: must be a positive integer
  if (!Number.isInteger(params.maxProviders) || params.maxProviders < 1) {
    throw new ToonError(
      `Swarm maxProviders must be a positive integer >= 1, got ${params.maxProviders}`,
      'DVM_SWARM_INVALID_MAX_PROVIDERS'
    );
  }

  // Build the base Kind 5xxx event (validates kind range, input, bid, output)
  const baseEvent = buildJobRequestEvent(params, secretKey);

  // Append swarm-specific tags
  const judge = params.judge ?? 'customer';
  const tags: string[][] = [
    ...baseEvent.tags,
    ['swarm', params.maxProviders.toString()],
    ['judge', judge],
  ];

  // Re-finalize with the additional tags
  return finalizeEvent(
    {
      kind: baseEvent.kind,
      content: baseEvent.content,
      tags,
      created_at: baseEvent.created_at,
    },
    secretKey
  );
}

/**
 * Builds a Kind 7000 swarm selection event.
 *
 * Creates a feedback event with `status: 'success'`, an `e` tag referencing
 * the swarm request, and a `winner` tag referencing the winning result.
 *
 * @param params - The swarm selection parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError if event IDs or pubkey are not valid 64-char hex.
 */
export function buildSwarmSelectionEvent(
  params: SwarmSelectionParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate swarmRequestEventId
  if (!HEX_64_REGEX.test(params.swarmRequestEventId)) {
    throw new ToonError(
      'Swarm selection swarmRequestEventId must be a 64-character lowercase hex string',
      'DVM_INVALID_EVENT_ID'
    );
  }

  // Validate winnerResultEventId
  if (!HEX_64_REGEX.test(params.winnerResultEventId)) {
    throw new ToonError(
      'Swarm selection winnerResultEventId must be a 64-character lowercase hex string',
      'DVM_INVALID_EVENT_ID'
    );
  }

  // Validate customerPubkey
  if (!HEX_64_REGEX.test(params.customerPubkey)) {
    throw new ToonError(
      'Swarm selection customerPubkey must be a 64-character lowercase hex string',
      'DVM_INVALID_PUBKEY'
    );
  }

  const tags: string[][] = [
    ['e', params.swarmRequestEventId],
    ['p', params.customerPubkey],
    ['status', 'success'],
    ['winner', params.winnerResultEventId],
  ];

  return finalizeEvent(
    {
      kind: JOB_FEEDBACK_KIND,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

// ---------- Parsers ----------

/**
 * Parses a Kind 5xxx event into a ParsedSwarmRequest.
 *
 * Delegates to `parseJobRequest()` for base fields, then extracts the
 * `swarm` and `judge` tags. Returns `null` if the event is not a valid
 * swarm request (missing `swarm` tag, invalid kind range, etc.).
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed swarm request, or null if invalid/not a swarm request.
 */
export function parseSwarmRequest(
  event: NostrEvent
): ParsedSwarmRequest | null {
  // Parse base job request fields
  const base = parseJobRequest(event);
  if (!base) return null;

  // Extract swarm tag: ['swarm', maxProviders]
  const swarmTag = event.tags.find((t: string[]) => t[0] === 'swarm');
  if (!swarmTag) return null;
  const maxProvidersStr = swarmTag[1];
  if (maxProvidersStr === undefined) return null;
  const maxProviders = parseInt(maxProvidersStr, 10);
  if (isNaN(maxProviders) || maxProviders < 1) return null;

  // Extract judge tag: ['judge', judgeId] (default: 'customer')
  const judgeTag = event.tags.find((t: string[]) => t[0] === 'judge');
  const judge = judgeTag?.[1] ?? 'customer';

  return {
    ...base,
    maxProviders,
    judge,
  };
}

/**
 * Parses a Kind 7000 event into a ParsedSwarmSelection.
 *
 * Validates the event kind is exactly 7000 and extracts the `winner` tag
 * and `e` tag (swarm request reference). Returns `null` if the event is
 * not a valid swarm selection (missing `winner` tag, wrong kind, etc.).
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed swarm selection, or null if invalid.
 */
export function parseSwarmSelection(
  event: NostrEvent
): ParsedSwarmSelection | null {
  // Validate kind is exactly 7000
  if (event.kind !== JOB_FEEDBACK_KIND) return null;

  // Extract winner tag: ['winner', winnerResultEventId]
  const winnerTag = event.tags.find((t: string[]) => t[0] === 'winner');
  if (!winnerTag) return null;
  const winnerResultEventId = winnerTag[1];
  if (
    winnerResultEventId === undefined ||
    !HEX_64_REGEX.test(winnerResultEventId)
  )
    return null;

  // Extract e tag: ['e', swarmRequestEventId]
  const eTag = event.tags.find((t: string[]) => t[0] === 'e');
  if (!eTag) return null;
  const swarmRequestEventId = eTag[1];
  if (
    swarmRequestEventId === undefined ||
    !HEX_64_REGEX.test(swarmRequestEventId)
  )
    return null;

  return {
    swarmRequestEventId,
    winnerResultEventId,
  };
}
