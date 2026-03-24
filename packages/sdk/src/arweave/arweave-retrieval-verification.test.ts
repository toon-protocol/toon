/**
 * ATDD tests for Story 8.0: Arweave Retrieval Verification (AC #7)
 *
 * Test ID: 8.0-UNIT-017
 *
 * AC covered:
 * - AC #7: Arweave retrieval verification — handler returns correct txId
 *          AND client helper extracts it correctly from FULFILL data.
 *
 * Note: Actual Arweave gateway fetch has indexing latency, so this uses
 * mock-based unit tests to verify the full path from handler -> FULFILL data
 * -> client extraction.
 */

import { describe, it, expect, vi } from 'vitest';

import { createArweaveDvmHandler } from './arweave-dvm-handler.js';
import { uploadBlob, uploadBlobChunked } from './chunked-upload.js';
import type { ArweaveUploadAdapter } from './turbo-adapter.js';
import type { ChunkManager } from './chunk-manager.js';
import type { HandlerContext } from '../handler-context.js';

// ============================================================================
// Test Helpers
// ============================================================================

const KNOWN_TX_ID = 'abc123XYZ_arweave_tx_id_for_retrieval';
const FIXED_SECRET_KEY = new Uint8Array(32).fill(7);

function createMockTurboAdapter(): ArweaveUploadAdapter & {
  upload: ReturnType<typeof vi.fn>;
} {
  return {
    upload: vi.fn().mockResolvedValue({ txId: KNOWN_TX_ID }),
  };
}

function createMockChunkManager() {
  return {
    addChunk: vi.fn().mockReturnValue({ complete: false }),
    isComplete: vi.fn().mockReturnValue(false),
    cleanup: vi.fn(),
  } as unknown as ChunkManager & {
    addChunk: ReturnType<typeof vi.fn>;
  };
}

function createMockHandlerContext(blobData: Buffer): HandlerContext {
  return {
    toon: 'mock-toon-string',
    kind: 5094,
    pubkey: 'ab'.repeat(32),
    amount: 1000000n,
    destination: 'g.toon.provider',
    decode: vi.fn().mockReturnValue({
      id: 'a'.repeat(64),
      pubkey: 'ab'.repeat(32),
      kind: 5094,
      content: '',
      tags: [
        ['i', blobData.toString('base64'), 'blob'],
        ['bid', '1000000', 'usdc'],
        ['output', 'application/octet-stream'],
      ],
      created_at: Math.floor(Date.now() / 1000),
      sig: '0'.repeat(128),
    }),
    accept: vi.fn().mockReturnValue({ accept: true }),
    reject: vi
      .fn()
      .mockReturnValue({ accept: false, code: 'F00', message: 'rejected' }),
  };
}

// ============================================================================
// 8.0-UNIT-017: Arweave Retrieval Verification (AC #7)
// ============================================================================

describe('Arweave Retrieval Verification (Story 8.0, AC #7)', () => {
  it('[P0] handler returns txId in data field that maps to arweave.net/<txId> retrieval URL', async () => {
    // Arrange: known blob and known txId
    const originalBlob = Buffer.from('hello arweave world');
    const turboAdapter = createMockTurboAdapter();
    const chunkManager = createMockChunkManager();
    const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
    const ctx = createMockHandlerContext(originalBlob);

    // Act
    const result = await handler(ctx);

    // Assert: handler returns the txId in data field
    expect(result.accept).toBe(true);
    expect((result as { data?: string }).data).toBe(KNOWN_TX_ID);

    // Verify the adapter received the original blob bytes
    expect(turboAdapter.upload).toHaveBeenCalledWith(
      originalBlob,
      expect.any(Object)
    );

    // Verify the retrieval URL can be constructed from the returned txId
    const retrievalUrl = `https://arweave.net/${(result as { data?: string }).data}`;
    expect(retrievalUrl).toBe(`https://arweave.net/${KNOWN_TX_ID}`);
  });

  it('[P0] client uploadBlob() extracts txId from handler FULFILL data field', async () => {
    // Arrange: mock node that simulates the full FULFILL path
    // The handler returns { accept: true, data: txId }, which becomes
    // PublishEventResult.data in the ILP send result
    const node = {
      publishEvent: vi.fn().mockResolvedValue({
        success: true,
        eventId: 'a'.repeat(64),
        data: KNOWN_TX_ID, // This is what the handler returns in data field
      }),
    };
    const blob = Buffer.from('test blob for retrieval');

    // Act
    const txId = await uploadBlob(node, blob, 'g.toon.arweave-provider', {
      secretKey: FIXED_SECRET_KEY,
      pricePerByte: 10n,
    });

    // Assert: client correctly extracts the txId from FULFILL data
    expect(txId).toBe(KNOWN_TX_ID);
    // The retrieval URL arweave.net/<txId> would return the original bytes
    expect(`https://arweave.net/${txId}`).toBe(
      `https://arweave.net/${KNOWN_TX_ID}`
    );
  });

  it('[P0] chunked upload: client extracts txId from final chunk FULFILL data', async () => {
    // Arrange: simulate intermediate ack responses + final txId
    const node = {
      publishEvent: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          eventId: 'a'.repeat(64),
          data: 'ack:0',
        })
        .mockResolvedValueOnce({
          success: true,
          eventId: 'a'.repeat(64),
          data: 'ack:1',
        })
        .mockResolvedValueOnce({
          success: true,
          eventId: 'a'.repeat(64),
          data: KNOWN_TX_ID, // Final chunk returns real txId
        }),
    };
    const blob = Buffer.alloc(1_200_000, 0x42); // 1.2MB -> 3 chunks at 500KB

    // Act
    const txId = await uploadBlobChunked(
      node,
      blob,
      'g.toon.arweave-provider',
      {
        chunkSize: 500_000,
        secretKey: FIXED_SECRET_KEY,
        pricePerByte: 10n,
      }
    );

    // Assert: final txId extracted from last FULFILL, not intermediate acks
    expect(txId).toBe(KNOWN_TX_ID);
    expect(`https://arweave.net/${txId}`).toBe(
      `https://arweave.net/${KNOWN_TX_ID}`
    );
  });

  it('[P1] handler data field is a string (not object) suitable for URL construction', async () => {
    // Verify the handler returns a plain string txId, not a JSON object,
    // ensuring it can be directly appended to the gateway URL
    const turboAdapter = createMockTurboAdapter();
    const chunkManager = createMockChunkManager();
    const handler = createArweaveDvmHandler({ turboAdapter, chunkManager });
    const ctx = createMockHandlerContext(Buffer.from('test'));

    const result = await handler(ctx);

    const data = (result as { data?: string }).data;
    expect(typeof data).toBe('string');
    // Must not be JSON
    expect(() => JSON.parse(data!)).toThrow();
    // Must be a valid URL path segment (no spaces, no special chars that need encoding)
    expect(data).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
