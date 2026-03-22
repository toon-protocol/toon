/**
 * ATDD tests for Story 8.0: Client-Side Upload Helpers
 *
 * Test IDs: 8.0-UNIT-013, 8.0-UNIT-014, 8.0-UNIT-015
 *
 * AC covered:
 * - AC #8: Chunk splitting (client side)
 */

import { describe, it, expect, vi } from 'vitest';

import { uploadBlob, uploadBlobChunked } from './chunked-upload.js';

// ============================================================================
// Test Helpers
// ============================================================================

const FIXED_SECRET_KEY = new Uint8Array(32).fill(7);

/**
 * Creates a mock ServiceNode for testing.
 */
function createMockServiceNode() {
  return {
    publishEvent: vi.fn().mockResolvedValue({
      success: true,
      eventId: 'a'.repeat(64),
      data: 'mock-arweave-tx-id-from-fulfill',
    }),
  };
}

function createTestBlob(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = i % 256;
  }
  return buf;
}

// ============================================================================
// 8.0-UNIT-013: Single-Packet Upload Helper (AC #8)
// ============================================================================

describe('Client-Side Upload Helpers (Story 8.0)', () => {
  describe('uploadBlob() single-packet (8.0-UNIT-013)', () => {
    it('[P0] small blob -> calls publishEvent() once with correct amount override -> returns txId', async () => {
      // Arrange
      const node = createMockServiceNode();
      const blob = createTestBlob(1024); // 1KB, well under chunk threshold
      const destination = 'g.toon.arweave-provider';

      // Act
      const txId = await uploadBlob(node, blob, destination, {
        contentType: 'text/plain',
        secretKey: FIXED_SECRET_KEY,
        pricePerByte: 10n,
      });

      // Assert
      expect(node.publishEvent).toHaveBeenCalledTimes(1);
      expect(txId).toBe('mock-arweave-tx-id-from-fulfill');
      // Verify amount override was passed (D7-007)
      const callArgs = node.publishEvent.mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        destination,
        amount: BigInt(1024) * 10n,
      });
    });
  });

  // ==========================================================================
  // uploadBlob() failure handling (AC #8)
  // ==========================================================================

  describe('uploadBlob() failure handling (AC #8)', () => {
    it('[P0] throws when publishEvent returns success: false', async () => {
      // Arrange
      const node = createMockServiceNode();
      node.publishEvent.mockResolvedValue({
        success: false,
        eventId: '',
        message: 'F04: Insufficient payment',
      });
      const blob = createTestBlob(512);
      const destination = 'g.toon.arweave-provider';

      // Act & Assert
      await expect(
        uploadBlob(node, blob, destination, {
          secretKey: FIXED_SECRET_KEY,
          pricePerByte: 10n,
        })
      ).rejects.toThrow(/Blob upload failed/);
      expect(node.publishEvent).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // uploadBlobChunked() failure handling (AC #8)
  // ==========================================================================

  describe('uploadBlobChunked() failure on intermediate chunk (AC #8)', () => {
    it('[P0] throws when an intermediate chunk publish fails', async () => {
      // Arrange: first chunk succeeds, second fails
      const node = createMockServiceNode();
      node.publishEvent
        .mockResolvedValueOnce({
          success: true,
          eventId: 'a'.repeat(64),
          data: 'ack:0',
        })
        .mockResolvedValueOnce({
          success: false,
          eventId: '',
          message: 'T00: Timeout',
        });
      const blob = createTestBlob(1_200_000);
      const destination = 'g.toon.arweave-provider';

      // Act & Assert
      await expect(
        uploadBlobChunked(node, blob, destination, {
          chunkSize: 500_000,
          secretKey: FIXED_SECRET_KEY,
        })
      ).rejects.toThrow(/Chunk 1\/3 upload failed/);
      // Should stop after the failed chunk (no third call)
      expect(node.publishEvent).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // uploadBlobChunked() empty blob validation (AC #8)
  // ==========================================================================

  describe('uploadBlobChunked() empty blob validation (AC #8)', () => {
    it('[P0] throws clear error for empty blob', async () => {
      const node = createMockServiceNode();
      const emptyBlob = Buffer.alloc(0);
      const destination = 'g.toon.arweave-provider';

      await expect(
        uploadBlobChunked(node, emptyBlob, destination, {
          secretKey: FIXED_SECRET_KEY,
        })
      ).rejects.toThrow(/Cannot upload empty blob/);
      expect(node.publishEvent).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 8.0-UNIT-014: Chunked Upload Splitting (AC #8)
  // ==========================================================================

  describe('uploadBlobChunked() splitting (8.0-UNIT-014)', () => {
    it('[P0] splits blob into correct number of chunks with uploadId, chunkIndex, totalChunks', async () => {
      // Arrange: 1.5MB blob with 500KB chunk size = 3 chunks
      const node = createMockServiceNode();
      const blob = createTestBlob(1_500_000);
      const destination = 'g.toon.arweave-provider';

      // Act
      await uploadBlobChunked(node, blob, destination, {
        chunkSize: 500_000,
        secretKey: FIXED_SECRET_KEY,
        pricePerByte: 10n,
      });

      // Assert: 3 chunks sent
      expect(node.publishEvent).toHaveBeenCalledTimes(3);

      // Verify each call has correct chunk params in the event tags
      for (let i = 0; i < 3; i++) {
        const event = node.publishEvent.mock.calls[i][0];
        const paramTags = event.tags.filter((t: string[]) => t[0] === 'param');
        const paramMap = new Map(paramTags.map((t: string[]) => [t[1], t[2]]));

        expect(paramMap.get('chunkIndex')).toBe(String(i));
        expect(paramMap.get('totalChunks')).toBe('3');
        expect(paramMap.has('uploadId')).toBe(true);
      }
    });

    it('[P1] all chunks share the same uploadId (UUID)', async () => {
      // Arrange
      const node = createMockServiceNode();
      const blob = createTestBlob(1_200_000);
      const destination = 'g.toon.arweave-provider';

      // Act
      await uploadBlobChunked(node, blob, destination, {
        chunkSize: 500_000,
        secretKey: FIXED_SECRET_KEY,
      });

      // Assert: extract uploadId from each call, verify all same
      const uploadIds = node.publishEvent.mock.calls.map((call: unknown[]) => {
        const event = call[0] as { tags: string[][] };
        const uploadIdTag = event.tags.find(
          (t: string[]) => t[0] === 'param' && t[1] === 'uploadId'
        );
        return uploadIdTag?.[2];
      });
      const unique = new Set(uploadIds);
      expect(unique.size).toBe(1);
      expect(uploadIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      ); // UUID format
    });
  });

  // ==========================================================================
  // 8.0-UNIT-015: Chunked Upload Returns Final txId (AC #8)
  // ==========================================================================

  describe('uploadBlobChunked() returns txId from final chunk (8.0-UNIT-015)', () => {
    it('[P0] returns txId from the final chunk FULFILL data', async () => {
      // Arrange: mock node returns 'ack:0', 'ack:1', then 'final-tx-id'
      const node = createMockServiceNode();
      node.publishEvent
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
          data: 'arweave-final-tx-id',
        });
      const blob = createTestBlob(1_200_000);
      const destination = 'g.toon.arweave-provider';

      // Act
      const txId = await uploadBlobChunked(node, blob, destination, {
        chunkSize: 500_000,
        secretKey: FIXED_SECRET_KEY,
      });

      // Assert
      expect(txId).toBe('arweave-final-tx-id');
    });
  });
});
