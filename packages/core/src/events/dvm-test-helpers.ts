/**
 * Shared test factories and constants for DVM test files.
 *
 * Extracted from dvm.test.ts during A4 split (Epic 6 start).
 * Used by dvm-builders.test.ts, dvm-parsers.test.ts, dvm-roundtrip.test.ts,
 * and dvm-constants.test.ts.
 */

import { getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import type {
  JobRequestParams,
  JobResultParams,
  JobFeedbackParams,
  DvmJobStatus,
} from './dvm.js';

// ============================================================================
// Fixed keys
// ============================================================================

/**
 * Fixed secret key for builder tests.
 * Used for event signing in builder test cases. Deterministic per project
 * testing rules (no random values in test fixtures).
 */
export const FIXED_BUILDER_SECRET_KEY = new Uint8Array(32).fill(2);
export const FIXED_BUILDER_PUBKEY = getPublicKey(FIXED_BUILDER_SECRET_KEY);

/**
 * Fixed secret key for parser test factories.
 * Used only for generating a valid pubkey in manually-constructed events
 * (not for signature verification). Deterministic per project testing rules.
 */
export const FIXED_FACTORY_SECRET_KEY = new Uint8Array(32).fill(1);
export const FIXED_FACTORY_PUBKEY = getPublicKey(FIXED_FACTORY_SECRET_KEY);

// ============================================================================
// Factories
// ============================================================================

/**
 * Creates a valid JobRequestParams for testing.
 * Uses deterministic values for reproducible tests.
 */
export function createJobRequestParams(
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
export function createJobResultParams(
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
export function createJobFeedbackParams(
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
export function createTestJobRequestEvent(
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
export function createTestJobResultEvent(
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
export function createTestJobFeedbackEvent(
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
