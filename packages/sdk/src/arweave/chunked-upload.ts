/**
 * Client-side helpers for uploading blobs to an Arweave DVM provider.
 *
 * - uploadBlob(): single-packet upload for blobs under the chunk threshold
 * - uploadBlobChunked(): multi-packet upload that splits large blobs into chunks
 *
 * Both use publishEvent() with the amount override (Story 7.6, D7-007).
 */

import { randomUUID } from 'node:crypto';
import type { NostrEvent } from 'nostr-tools/pure';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import type { PublishEventResult } from '../create-node.js';

/**
 * Minimal interface for publishing events. Matches ServiceNode.publishEvent().
 */
export interface PublishableNode {
  publishEvent(
    event: NostrEvent,
    options?: { destination: string; amount?: bigint }
  ): Promise<
    Pick<PublishEventResult, 'success' | 'eventId' | 'data' | 'message'>
  >;
}

/**
 * Options for single-packet blob upload.
 */
export interface UploadBlobOptions {
  /** MIME type of the blob (default: 'application/octet-stream'). */
  contentType?: string;
  /** Secret key for signing the event. */
  secretKey: Uint8Array;
  /** Price per byte in USDC micro-units for amount calculation. */
  pricePerByte?: bigint;
}

/**
 * Options for chunked blob upload.
 */
export interface UploadBlobChunkedOptions {
  /** Chunk size in bytes (default: 500_000, under 512KB threshold). */
  chunkSize?: number;
  /** MIME type of the blob (default: 'application/octet-stream'). */
  contentType?: string;
  /** Secret key for signing events. */
  secretKey: Uint8Array;
  /** Price per byte in USDC micro-units for amount calculation. */
  pricePerByte?: bigint;
}

/**
 * Upload a blob to an Arweave DVM provider in a single ILP packet.
 *
 * Uses publishEvent() with amount override (D7-007) to send the blob
 * and payment in one ILP PREPARE.
 *
 * @param node - The ServiceNode (or compatible) to publish through.
 * @param blob - The raw blob data to upload.
 * @param destination - The provider's ILP address.
 * @param options - Upload options including secretKey for signing.
 * @returns The Arweave transaction ID from the FULFILL data field.
 */
export async function uploadBlob(
  node: PublishableNode,
  blob: Buffer,
  destination: string,
  options: UploadBlobOptions
): Promise<string> {
  const contentType = options.contentType ?? 'application/octet-stream';
  const pricePerByte = options.pricePerByte ?? 10n;
  const amount = BigInt(blob.length) * pricePerByte;

  const event = buildBlobStorageRequest(
    {
      blobData: blob,
      contentType,
      bid: amount.toString(),
    },
    options.secretKey
  );

  const result = await node.publishEvent(event, { destination, amount });

  if (!result.success) {
    throw new Error(`Blob upload failed: ${result.message ?? 'unknown error'}`);
  }

  // The tx ID is returned in the FULFILL data field, propagated via
  // PublishEventResult.data. Falls back to eventId if data is absent.
  return result.data ?? result.eventId;
}

/**
 * Upload a large blob to an Arweave DVM provider using chunked uploads.
 *
 * Splits the blob into chunks, each sent as a separate kind:5094 ILP PREPARE
 * with uploadId, chunkIndex, and totalChunks params. Each chunk carries its
 * own payment. The final chunk's FULFILL data contains the Arweave tx ID.
 *
 * @param node - The ServiceNode (or compatible) to publish through.
 * @param blob - The raw blob data to upload.
 * @param destination - The provider's ILP address.
 * @param options - Chunked upload options including secretKey for signing.
 * @returns The Arweave transaction ID from the final chunk's FULFILL data.
 */
export async function uploadBlobChunked(
  node: PublishableNode,
  blob: Buffer,
  destination: string,
  options: UploadBlobChunkedOptions
): Promise<string> {
  if (blob.length === 0) {
    throw new Error('Cannot upload empty blob via chunked upload');
  }

  const chunkSize = options.chunkSize ?? 500_000;
  const contentType = options.contentType ?? 'application/octet-stream';
  const pricePerByte = options.pricePerByte ?? 10n;
  const uploadId = randomUUID();

  // Split blob into chunks
  const totalChunks = Math.ceil(blob.length / chunkSize);
  let lastResult: PublishEventResult | undefined;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, blob.length);
    const chunkData = blob.subarray(start, end);
    const amount = BigInt(chunkData.length) * pricePerByte;

    const event = buildBlobStorageRequest(
      {
        blobData: Buffer.from(chunkData),
        contentType,
        bid: amount.toString(),
        params: [
          { key: 'uploadId', value: uploadId },
          { key: 'chunkIndex', value: String(i) },
          { key: 'totalChunks', value: String(totalChunks) },
        ],
      },
      options.secretKey
    );

    lastResult = await node.publishEvent(event, { destination, amount });

    if (!lastResult.success) {
      throw new Error(
        `Chunk ${i}/${totalChunks} upload failed: ${lastResult.message ?? 'unknown error'}`
      );
    }
  }

  // The final chunk's FULFILL data contains the Arweave tx ID
  // lastResult is guaranteed to be set since totalChunks >= 1
  if (!lastResult) {
    throw new Error('No chunks were uploaded');
  }
  return lastResult.data ?? lastResult.eventId;
}
