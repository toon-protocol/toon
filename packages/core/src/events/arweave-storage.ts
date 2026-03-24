/**
 * Event builders and parsers for kind:5094 Blob Storage DVM requests.
 *
 * Kind 5094 is a NIP-90 DVM job request for permanent blob storage (Arweave).
 * The blob data is base64-encoded in the `i` tag with type `blob`.
 * Payment is carried in the ILP PREPARE packet (prepaid model, D7-001).
 *
 * Tag layout:
 *   Required: ['i', base64Blob, 'blob'], ['bid', amount, 'usdc'], ['output', contentType]
 *   Optional: ['param', 'uploadId', uuid], ['param', 'chunkIndex', idx],
 *             ['param', 'totalChunks', total], ['param', 'contentType', type]
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  BLOB_STORAGE_REQUEST_KIND,
  BLOB_STORAGE_RESULT_KIND,
} from '../constants.js';
import { ToonError } from '../errors.js';

// Re-export constants for convenient co-located imports
export { BLOB_STORAGE_REQUEST_KIND, BLOB_STORAGE_RESULT_KIND };

// ---------- Types ----------

/**
 * Parameters for building a kind:5094 Blob Storage DVM request event.
 */
export interface BlobStorageRequestParams {
  /** The raw blob data to store. */
  blobData: Buffer;
  /** MIME type of the blob (default: 'application/octet-stream'). */
  contentType?: string;
  /** Bid amount in USDC micro-units as string (bigint-compatible). */
  bid: string;
  /** Optional key-value parameters (e.g., uploadId, chunkIndex, totalChunks). */
  params?: { key: string; value: string }[];
}

/**
 * Parsed result from a kind:5094 Blob Storage DVM request event.
 */
export interface ParsedBlobStorageRequest {
  /** The decoded blob data. */
  blobData: Buffer;
  /** MIME type of the blob. */
  contentType: string;
  /** Upload ID for chunked uploads. */
  uploadId?: string;
  /** Chunk index for chunked uploads. */
  chunkIndex?: number;
  /** Total number of chunks for chunked uploads. */
  totalChunks?: number;
}

// ---------- Validation ----------

/** Regex for valid base64 strings (standard alphabet, optional padding). */
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

/** Regex for UUID v4 format (used for uploadId validation). */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates that a string is valid base64 and can be decoded.
 */
function isValidBase64(str: string): boolean {
  if (str.length === 0) return false;
  if (!BASE64_REGEX.test(str)) return false;
  try {
    Buffer.from(str, 'base64');
    return true;
  } catch {
    return false;
  }
}

// ---------- Builder ----------

/**
 * Builds a kind:5094 Blob Storage DVM request event.
 *
 * Constructs a signed Nostr event with the blob base64-encoded in the `i` tag,
 * a `bid` tag for payment declaration, and an `output` tag for content type.
 *
 * @param params - The blob storage request parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError if required params are missing.
 */
export function buildBlobStorageRequest(
  params: BlobStorageRequestParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate blobData
  if (!params.blobData || params.blobData.length === 0) {
    throw new ToonError(
      'Blob storage request blobData is required and must not be empty',
      'DVM_MISSING_INPUT'
    );
  }

  // Validate bid
  if (typeof params.bid !== 'string' || params.bid === '') {
    throw new ToonError(
      'Blob storage request bid must be a non-empty string (USDC micro-units)',
      'DVM_INVALID_BID'
    );
  }

  const contentType = params.contentType ?? 'application/octet-stream';
  const base64Blob = params.blobData.toString('base64');

  // Build tags
  const tags: string[][] = [];

  // Required: ['i', base64Blob, 'blob']
  tags.push(['i', base64Blob, 'blob']);

  // Required: ['bid', amount, 'usdc']
  tags.push(['bid', params.bid, 'usdc']);

  // Required: ['output', contentType]
  tags.push(['output', contentType]);

  // Optional: ['param', key, value] for each param
  if (params.params !== undefined) {
    for (const p of params.params) {
      tags.push(['param', p.key, p.value]);
    }
  }

  return finalizeEvent(
    {
      kind: BLOB_STORAGE_REQUEST_KIND,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

// ---------- Parser ----------

/**
 * Parses a kind:5094 event into a ParsedBlobStorageRequest.
 *
 * Validates the event kind is 5094, extracts the base64-encoded blob from the
 * `i` tag, the content type from the `output` tag, and optional chunked upload
 * params from `param` tags.
 *
 * Returns `null` for malformed events (wrong kind, missing required tags,
 * invalid base64). Follows the lenient parse pattern.
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed blob storage request, or null if invalid.
 */
export function parseBlobStorageRequest(
  event: NostrEvent
): ParsedBlobStorageRequest | null {
  // Validate kind
  if (event.kind !== BLOB_STORAGE_REQUEST_KIND) {
    return null;
  }

  // Extract required 'i' tag: ['i', base64Blob, 'blob']
  const iTag = event.tags.find((t: string[]) => t[0] === 'i');
  if (!iTag) return null;
  const base64Data = iTag[1];
  const inputType = iTag[2];
  if (base64Data === undefined || base64Data === '') return null;
  if (inputType !== 'blob') return null;

  // Validate base64
  if (!isValidBase64(base64Data)) {
    return null;
  }

  // Extract required 'bid' tag: ['bid', amount, 'usdc']
  const bidTag = event.tags.find((t: string[]) => t[0] === 'bid');
  if (!bidTag) return null;
  const bidAmount = bidTag[1];
  if (bidAmount === undefined || bidAmount === '') return null;

  // Extract content type from 'output' tag (default: 'application/octet-stream')
  const outputTag = event.tags.find((t: string[]) => t[0] === 'output');
  const contentType =
    outputTag?.[1] && outputTag[1] !== ''
      ? outputTag[1]
      : 'application/octet-stream';

  // Decode blob
  const blobData = Buffer.from(base64Data, 'base64');

  // Extract optional chunked upload params
  const paramTags = event.tags.filter((t: string[]) => t[0] === 'param');
  const paramMap = new Map<string, string>();
  for (const pt of paramTags) {
    const key = pt[1];
    const value = pt[2];
    if (key !== undefined && value !== undefined) {
      paramMap.set(key, value);
    }
  }

  const result: ParsedBlobStorageRequest = {
    blobData,
    contentType,
  };

  const uploadId = paramMap.get('uploadId');
  if (uploadId !== undefined && UUID_REGEX.test(uploadId)) {
    result.uploadId = uploadId;
  }

  const chunkIndexStr = paramMap.get('chunkIndex');
  if (chunkIndexStr !== undefined) {
    const chunkIndex = parseInt(chunkIndexStr, 10);
    if (!isNaN(chunkIndex) && chunkIndex >= 0) {
      result.chunkIndex = chunkIndex;
    }
  }

  const totalChunksStr = paramMap.get('totalChunks');
  if (totalChunksStr !== undefined) {
    const totalChunks = parseInt(totalChunksStr, 10);
    if (!isNaN(totalChunks) && totalChunks > 0) {
      result.totalChunks = totalChunks;
    }
  }

  return result;
}
