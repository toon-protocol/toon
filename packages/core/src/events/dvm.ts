/**
 * Event builders and parsers for NIP-90 DVM (Data Vending Machine) events.
 *
 * NIP-90 defines three event categories for the DVM protocol:
 * - Kind 5000-5999: Job requests (each task type has a unique kind)
 * - Kind 6000-6999: Job results (result kind = request kind + 1000)
 * - Kind 7000: Job feedback (single kind for all status updates)
 *
 * TOON adopts NIP-90 kinds for cross-network interoperability with the
 * broader Nostr DVM ecosystem. The `bid` and `amount` tags extend NIP-90
 * with a third element ('usdc') for explicit currency declaration. NIP-90
 * uses satoshis; TOON uses USDC micro-units (6 decimals).
 *
 * DVM events are standard Nostr events with specific kinds. They flow
 * through the same SDK processing pipeline as all other events: shallow
 * parse -> verify -> price -> dispatch. No special-casing required.
 *
 * Tag reference:
 *
 * Kind 5xxx (Job Request):
 *   Required: ['i', data, type, relay?, marker?], ['bid', amount, 'usdc'], ['output', mimeType]
 *   Optional: ['p', providerPubkey], ['param', key, value], ['relays', url1, ...]
 *
 * Kind 6xxx (Job Result):
 *   Required: ['e', requestEventId], ['p', customerPubkey], ['amount', cost, 'usdc']
 *   Content: result data
 *
 * Kind 7000 (Job Feedback):
 *   Required: ['e', requestEventId], ['p', customerPubkey], ['status', statusValue]
 *   Content: optional status details
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  JOB_REQUEST_KIND_BASE,
  JOB_RESULT_KIND_BASE,
  JOB_FEEDBACK_KIND,
  TEXT_GENERATION_KIND,
  IMAGE_GENERATION_KIND,
  TEXT_TO_SPEECH_KIND,
  TRANSLATION_KIND,
} from '../constants.js';
import { ToonError } from '../errors.js';

// Re-export constants for convenient co-located imports
export {
  JOB_REQUEST_KIND_BASE,
  JOB_RESULT_KIND_BASE,
  JOB_FEEDBACK_KIND,
  TEXT_GENERATION_KIND,
  IMAGE_GENERATION_KIND,
  TEXT_TO_SPEECH_KIND,
  TRANSLATION_KIND,
};

// ---------- Validation Helpers ----------

/** Regex for 64-char lowercase hex string. */
const HEX_64_REGEX = /^[0-9a-f]{64}$/;

/** Valid DVM job status values per NIP-90. */
const VALID_STATUSES = new Set<string>([
  'processing',
  'error',
  'success',
  'partial',
]);

// ---------- Types ----------

/**
 * DVM job status values per NIP-90.
 * - `'processing'`: Job is currently being processed.
 * - `'error'`: Job failed with an error.
 * - `'success'`: Job completed successfully.
 * - `'partial'`: Job returned partial results (more to come).
 */
export type DvmJobStatus = 'processing' | 'error' | 'success' | 'partial';

/**
 * Parameters for building a Kind 5xxx DVM job request event.
 *
 * The `kind` field must be in the 5000-5999 range (NIP-90 job request range).
 * The `bid` field is the amount the requester is willing to pay, expressed as
 * a string of USDC micro-units (6 decimals) for bigint compatibility.
 */
export interface JobRequestParams {
  /** Event kind in 5000-5999 range (e.g., 5100 for text generation). */
  kind: number;
  /** Input data with type classification. */
  input: {
    /** The input data (text, URL, event ID, etc.). */
    data: string;
    /** Input type identifier (e.g., 'text', 'url', 'event', 'job'). */
    type: string;
    /** Optional relay URL where the input data can be found. */
    relay?: string;
    /** Optional marker for input disambiguation. */
    marker?: string;
  };
  /** Bid amount in USDC micro-units as string (bigint-compatible). */
  bid: string;
  /** Expected output MIME type (e.g., 'text/plain', 'image/png'). */
  output: string;
  /** Optional body text for the event content field. */
  content?: string;
  /** Optional 64-char hex pubkey of a specific target provider. */
  targetProvider?: string;
  /** Optional key-value parameters for the job (repeatable). */
  params?: { key: string; value: string }[];
  /** Optional preferred relay URLs for result delivery. */
  relays?: string[];
}

/**
 * Parameters for building a Kind 6xxx DVM job result event.
 *
 * The `kind` field must be in the 6000-6999 range. Result kind = request
 * kind + 1000 (e.g., Kind 5100 request -> Kind 6100 result).
 * The `amount` field is the actual compute cost in USDC micro-units.
 */
export interface JobResultParams {
  /** Event kind in 6000-6999 range (= request kind + 1000). */
  kind: number;
  /** 64-char hex event ID of the original Kind 5xxx request. */
  requestEventId: string;
  /** 64-char hex pubkey of the customer who posted the request. */
  customerPubkey: string;
  /** Compute cost in USDC micro-units as string (bigint-compatible). */
  amount: string;
  /** Result data (text, URL, etc.). */
  content: string;
}

/**
 * Parameters for building a Kind 7000 DVM job feedback event.
 *
 * Feedback events carry status updates about in-progress jobs. The `status`
 * field must be one of the four NIP-90 status values.
 */
export interface JobFeedbackParams {
  /** 64-char hex event ID of the original Kind 5xxx request. */
  requestEventId: string;
  /** 64-char hex pubkey of the customer who posted the request. */
  customerPubkey: string;
  /** Job status value. */
  status: DvmJobStatus;
  /** Optional status details or error message. */
  content?: string;
}

/**
 * Parsed result from a Kind 5xxx DVM job request event.
 */
export interface ParsedJobRequest {
  /** Event kind (5000-5999). */
  kind: number;
  /** Input data with type classification. */
  input: {
    /** The input data. */
    data: string;
    /** Input type identifier. */
    type: string;
    /** Optional relay URL. */
    relay?: string;
    /** Optional marker. */
    marker?: string;
  };
  /** Bid amount in USDC micro-units as string. */
  bid: string;
  /** Expected output MIME type. */
  output: string;
  /** Event content field (may be empty string). */
  content: string;
  /** Target provider pubkey if this is a targeted request. */
  targetProvider?: string;
  /** Key-value parameters (may be empty array). */
  params: { key: string; value: string }[];
  /** Preferred relay URLs (may be empty array). */
  relays: string[];
}

/**
 * Parsed result from a Kind 6xxx DVM job result event.
 */
export interface ParsedJobResult {
  /** Event kind (6000-6999). */
  kind: number;
  /** Event ID of the original request. */
  requestEventId: string;
  /** Pubkey of the customer who posted the request. */
  customerPubkey: string;
  /** Compute cost in USDC micro-units as string. */
  amount: string;
  /** Result data from the content field. */
  content: string;
}

/**
 * Parsed result from a Kind 7000 DVM job feedback event.
 */
export interface ParsedJobFeedback {
  /** Event ID of the original request. */
  requestEventId: string;
  /** Pubkey of the customer who posted the request. */
  customerPubkey: string;
  /** Job status value. */
  status: DvmJobStatus;
  /** Status details from the content field (may be empty string). */
  content: string;
}

// ---------- Builders ----------

/**
 * Builds a Kind 5xxx DVM job request event (NIP-90).
 *
 * Constructs a signed Nostr event with NIP-90 required tags: `i` (input),
 * `bid` (payment offer), and `output` (expected MIME type). Optional tags
 * include `p` (target provider), `param` (key-value pairs), and `relays`
 * (preferred relay URLs).
 *
 * @param params - The job request parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError if required params are missing or kind is out of range.
 */
export function buildJobRequestEvent(
  params: JobRequestParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate kind range (5000-5999)
  if (params.kind < 5000 || params.kind > 5999) {
    throw new ToonError(
      `Job request kind must be in range 5000-5999, got ${params.kind}`,
      'DVM_INVALID_KIND'
    );
  }

  // Validate required input (allow empty string per NIP-90, reject undefined/null)
  if (params.input.data === undefined || params.input.data === null) {
    throw new ToonError(
      'Job request input data is required',
      'DVM_MISSING_INPUT'
    );
  }
  if (!params.input.type) {
    throw new ToonError(
      'Job request input type is required',
      'DVM_MISSING_INPUT'
    );
  }

  // Validate bid (non-empty string, bigint-compatible)
  if (typeof params.bid !== 'string' || params.bid === '') {
    throw new ToonError(
      'Job request bid must be a non-empty string (USDC micro-units)',
      'DVM_INVALID_BID'
    );
  }

  // Validate output (non-empty string)
  if (typeof params.output !== 'string' || params.output === '') {
    throw new ToonError(
      'Job request output MIME type must be a non-empty string',
      'DVM_MISSING_OUTPUT'
    );
  }

  // Build tags
  const tags: string[][] = [];

  // Required: ['i', data, type, relay?, marker?]
  const iTag: string[] = ['i', params.input.data, params.input.type];
  if (params.input.relay !== undefined) {
    iTag.push(params.input.relay);
  }
  if (params.input.marker !== undefined) {
    // If marker is set but relay is not, push empty relay placeholder
    if (params.input.relay === undefined) {
      iTag.push('');
    }
    iTag.push(params.input.marker);
  }
  tags.push(iTag);

  // Required: ['bid', amount, 'usdc']
  tags.push(['bid', params.bid, 'usdc']);

  // Required: ['output', mimeType]
  tags.push(['output', params.output]);

  // Optional: ['p', targetProvider] -- validate hex format if provided
  if (params.targetProvider !== undefined) {
    if (!HEX_64_REGEX.test(params.targetProvider)) {
      throw new ToonError(
        'Job request targetProvider must be a 64-character lowercase hex string',
        'DVM_INVALID_PUBKEY'
      );
    }
    tags.push(['p', params.targetProvider]);
  }

  // Optional: ['param', key, value] for each param
  if (params.params !== undefined) {
    for (const p of params.params) {
      tags.push(['param', p.key, p.value]);
    }
  }

  // Optional: ['relays', url1, url2, ...]
  if (params.relays !== undefined && params.relays.length > 0) {
    tags.push(['relays', ...params.relays]);
  }

  return finalizeEvent(
    {
      kind: params.kind,
      content: params.content ?? '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

/**
 * Builds a Kind 6xxx DVM job result event (NIP-90).
 *
 * Constructs a signed Nostr event with NIP-90 required tags: `e` (request
 * reference), `p` (customer pubkey), and `amount` (compute cost). The
 * content field carries the result data.
 *
 * @param params - The job result parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError if required params are missing or kind is out of range.
 */
export function buildJobResultEvent(
  params: JobResultParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate kind range (6000-6999)
  if (params.kind < 6000 || params.kind > 6999) {
    throw new ToonError(
      `Job result kind must be in range 6000-6999, got ${params.kind}`,
      'DVM_INVALID_KIND'
    );
  }

  // Validate requestEventId (64-char hex)
  if (!HEX_64_REGEX.test(params.requestEventId)) {
    throw new ToonError(
      'Job result requestEventId must be a 64-character lowercase hex string',
      'DVM_INVALID_EVENT_ID'
    );
  }

  // Validate customerPubkey (64-char hex)
  if (!HEX_64_REGEX.test(params.customerPubkey)) {
    throw new ToonError(
      'Job result customerPubkey must be a 64-character lowercase hex string',
      'DVM_INVALID_PUBKEY'
    );
  }

  // Validate amount (non-empty string, bigint-compatible)
  if (typeof params.amount !== 'string' || params.amount === '') {
    throw new ToonError(
      'Job result amount must be a non-empty string (USDC micro-units)',
      'DVM_INVALID_AMOUNT'
    );
  }

  // Validate content (string)
  if (typeof params.content !== 'string') {
    throw new ToonError(
      'Job result content must be a string',
      'DVM_MISSING_CONTENT'
    );
  }

  const tags: string[][] = [
    ['e', params.requestEventId],
    ['p', params.customerPubkey],
    ['amount', params.amount, 'usdc'],
  ];

  return finalizeEvent(
    {
      kind: params.kind,
      content: params.content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

/**
 * Builds a Kind 7000 DVM job feedback event (NIP-90).
 *
 * Constructs a signed Nostr event with NIP-90 required tags: `e` (request
 * reference), `p` (customer pubkey), and `status` (job state). The content
 * field carries optional status details or error messages.
 *
 * @param params - The job feedback parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError if required params are missing or status is invalid.
 */
export function buildJobFeedbackEvent(
  params: JobFeedbackParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate requestEventId (64-char hex)
  if (!HEX_64_REGEX.test(params.requestEventId)) {
    throw new ToonError(
      'Job feedback requestEventId must be a 64-character lowercase hex string',
      'DVM_INVALID_EVENT_ID'
    );
  }

  // Validate customerPubkey (64-char hex)
  if (!HEX_64_REGEX.test(params.customerPubkey)) {
    throw new ToonError(
      'Job feedback customerPubkey must be a 64-character lowercase hex string',
      'DVM_INVALID_PUBKEY'
    );
  }

  // Validate status
  if (!VALID_STATUSES.has(params.status)) {
    throw new ToonError(
      `Job feedback status must be one of: processing, error, success, partial. Got: ${String(params.status)}`,
      'DVM_INVALID_STATUS'
    );
  }

  const tags: string[][] = [
    ['e', params.requestEventId],
    ['p', params.customerPubkey],
    ['status', params.status],
  ];

  return finalizeEvent(
    {
      kind: JOB_FEEDBACK_KIND,
      content: params.content ?? '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

// ---------- Parsers ----------

/**
 * Parses a Kind 5xxx event into a ParsedJobRequest.
 *
 * Validates the event kind is in the 5000-5999 range and extracts required
 * NIP-90 tags: `i` (input), `bid` (amount + currency), and `output` (MIME
 * type). Also extracts optional tags: `p` (target provider), `param`
 * (key-value pairs), and `relays` (preferred URLs).
 *
 * Returns `null` for malformed events (missing required tags, invalid kind
 * range). Follows the lenient parse pattern established by
 * `parseServiceDiscovery()` and `parseAttestation()`.
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed job request, or null if invalid.
 */
export function parseJobRequest(event: NostrEvent): ParsedJobRequest | null {
  // Validate kind range
  if (event.kind < 5000 || event.kind > 5999) {
    return null;
  }

  // Extract required 'i' tag: ['i', data, type, relay?, marker?]
  const iTag = event.tags.find((t: string[]) => t[0] === 'i');
  if (!iTag) return null;
  const inputData = iTag[1];
  const inputType = iTag[2];
  if (inputData === undefined || inputType === undefined) return null;

  // Extract required 'bid' tag: ['bid', amount, 'usdc']
  const bidTag = event.tags.find((t: string[]) => t[0] === 'bid');
  if (!bidTag) return null;
  const bidAmount = bidTag[1];
  if (bidAmount === undefined || bidAmount === '') return null;

  // Extract required 'output' tag: ['output', mimeType]
  const outputTag = event.tags.find((t: string[]) => t[0] === 'output');
  if (!outputTag) return null;
  const outputMime = outputTag[1];
  if (outputMime === undefined || outputMime === '') return null;

  // Build input object with optional relay and marker
  const input: ParsedJobRequest['input'] = {
    data: inputData,
    type: inputType,
  };
  const inputRelay = iTag[3];
  if (inputRelay !== undefined && inputRelay !== '') {
    input.relay = inputRelay;
  }
  const inputMarker = iTag[4];
  if (inputMarker !== undefined && inputMarker !== '') {
    input.marker = inputMarker;
  }

  // Extract optional 'p' tag (target provider) -- validate hex format if present
  const pTag = event.tags.find((t: string[]) => t[0] === 'p');
  const targetProvider = pTag?.[1];
  if (targetProvider !== undefined && !HEX_64_REGEX.test(targetProvider))
    return null;

  // Extract optional 'param' tags (collect all)
  const paramTags = event.tags.filter((t: string[]) => t[0] === 'param');
  const params: { key: string; value: string }[] = [];
  for (const pt of paramTags) {
    const key = pt[1];
    const value = pt[2];
    if (key !== undefined && value !== undefined) {
      params.push({ key, value });
    }
  }

  // Extract optional 'relays' tag
  const relaysTag = event.tags.find((t: string[]) => t[0] === 'relays');
  const relays: string[] = [];
  if (relaysTag) {
    for (let i = 1; i < relaysTag.length; i++) {
      const url = relaysTag[i];
      if (url !== undefined) {
        relays.push(url);
      }
    }
  }

  const result: ParsedJobRequest = {
    kind: event.kind,
    input,
    bid: bidAmount,
    output: outputMime,
    content: event.content,
    params,
    relays,
  };

  if (targetProvider !== undefined) {
    result.targetProvider = targetProvider;
  }

  return result;
}

/**
 * Parses a Kind 6xxx event into a ParsedJobResult.
 *
 * Validates the event kind is in the 6000-6999 range and extracts required
 * NIP-90 tags: `e` (request event ID), `p` (customer pubkey), and `amount`
 * (compute cost + currency).
 *
 * Returns `null` for malformed events. Follows the lenient parse pattern.
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed job result, or null if invalid.
 */
export function parseJobResult(event: NostrEvent): ParsedJobResult | null {
  // Validate kind range
  if (event.kind < 6000 || event.kind > 6999) {
    return null;
  }

  // Extract required 'e' tag: ['e', requestEventId]
  const eTag = event.tags.find((t: string[]) => t[0] === 'e');
  if (!eTag) return null;
  const requestEventId = eTag[1];
  if (requestEventId === undefined || !HEX_64_REGEX.test(requestEventId))
    return null;

  // Extract required 'p' tag: ['p', customerPubkey]
  const pTag = event.tags.find((t: string[]) => t[0] === 'p');
  if (!pTag) return null;
  const customerPubkey = pTag[1];
  if (customerPubkey === undefined || !HEX_64_REGEX.test(customerPubkey))
    return null;

  // Extract required 'amount' tag: ['amount', cost, 'usdc']
  const amountTag = event.tags.find((t: string[]) => t[0] === 'amount');
  if (!amountTag) return null;
  const amount = amountTag[1];
  if (amount === undefined || amount === '') return null;

  // Validate amount is numeric (must be parseable as a non-negative integer).
  // USDC micro-units are always whole numbers; reject decimals, negatives,
  // and non-numeric strings to prevent downstream BigInt/arithmetic errors.
  if (!/^\d+$/.test(amount)) return null;

  return {
    kind: event.kind,
    requestEventId,
    customerPubkey,
    amount,
    content: event.content,
  };
}

/**
 * Parses a Kind 7000 event into a ParsedJobFeedback.
 *
 * Validates the event kind is exactly 7000 and extracts required NIP-90
 * tags: `e` (request event ID), `p` (customer pubkey), and `status`
 * (job state). The status value must be one of: `'processing'`, `'error'`,
 * `'success'`, `'partial'`.
 *
 * Returns `null` for malformed events or invalid status values.
 * Follows the lenient parse pattern.
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed job feedback, or null if invalid.
 */
export function parseJobFeedback(event: NostrEvent): ParsedJobFeedback | null {
  // Validate kind is exactly 7000
  if (event.kind !== JOB_FEEDBACK_KIND) {
    return null;
  }

  // Extract required 'e' tag: ['e', requestEventId]
  const eTag = event.tags.find((t: string[]) => t[0] === 'e');
  if (!eTag) return null;
  const requestEventId = eTag[1];
  if (requestEventId === undefined || !HEX_64_REGEX.test(requestEventId))
    return null;

  // Extract required 'p' tag: ['p', customerPubkey]
  const pTag = event.tags.find((t: string[]) => t[0] === 'p');
  if (!pTag) return null;
  const customerPubkey = pTag[1];
  if (customerPubkey === undefined || !HEX_64_REGEX.test(customerPubkey))
    return null;

  // Extract required 'status' tag: ['status', statusValue]
  const statusTag = event.tags.find((t: string[]) => t[0] === 'status');
  if (!statusTag) return null;
  const statusValue = statusTag[1];
  if (statusValue === undefined) return null;

  // Validate status value
  if (!VALID_STATUSES.has(statusValue)) {
    return null;
  }

  return {
    requestEventId,
    customerPubkey,
    status: statusValue as DvmJobStatus,
    content: event.content,
  };
}
