/**
 * ATDD tests for Story 8.0: Arweave Storage DVM Event Builder/Parser
 *
 * Test IDs: 8.0-UNIT-001, 8.0-UNIT-002, 8.0-UNIT-003
 *
 * AC covered:
 * - AC #1: kind:5094 event builder
 * - AC #2: kind:5094 event parser
 * - AC #3: Chunked upload params
 */

import { describe, it, expect } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';

import {
  buildBlobStorageRequest,
  parseBlobStorageRequest,
} from './arweave-storage.js';
import { BLOB_STORAGE_REQUEST_KIND } from '../constants.js';

// ============================================================================
// Test Helpers
// ============================================================================

const FIXED_SECRET_KEY = new Uint8Array(32).fill(3);
const FIXED_PUBKEY = getPublicKey(FIXED_SECRET_KEY);

/**
 * Creates a small test blob (deterministic).
 */
function createTestBlob(size = 64): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = i % 256;
  }
  return buf;
}

// ============================================================================
// 8.0-UNIT-001: Builder/Parser Roundtrip (AC #1, #2)
// ============================================================================

describe('Arweave Storage Event Builder/Parser (Story 8.0)', () => {
  describe('buildBlobStorageRequest + parseBlobStorageRequest roundtrip (8.0-UNIT-001)', () => {
    it('[P0] build -> parse roundtrip returns original { blobData, contentType }', () => {
      // Arrange
      const blobData = createTestBlob(128);
      const contentType = 'application/octet-stream';

      // Act
      const event = buildBlobStorageRequest(
        { blobData, contentType, bid: '50000' },
        FIXED_SECRET_KEY
      );
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(Buffer.from(parsed!.blobData)).toEqual(blobData);
      expect(parsed!.contentType).toBe(contentType);
    });

    it('[P0] built event has kind 5094', () => {
      // Arrange
      const blobData = createTestBlob(64);

      // Act
      const event = buildBlobStorageRequest(
        { blobData, contentType: 'image/png', bid: '100000' },
        FIXED_SECRET_KEY
      );

      // Assert
      expect(event.kind).toBe(5094);
      expect(event.kind).toBe(BLOB_STORAGE_REQUEST_KIND);
    });

    it('[P0] built event has correct tags: i (base64 blob), bid (usdc), output', () => {
      // Arrange
      const blobData = createTestBlob(32);
      const contentType = 'text/plain';
      const bid = '25000';

      // Act
      const event = buildBlobStorageRequest(
        { blobData, contentType, bid },
        FIXED_SECRET_KEY
      );

      // Assert: i tag with base64-encoded blob and type 'blob'
      const iTag = event.tags.find((t: string[]) => t[0] === 'i');
      expect(iTag).toBeDefined();
      expect(iTag![2]).toBe('blob');
      const decodedBlob = Buffer.from(iTag![1], 'base64');
      expect(decodedBlob).toEqual(blobData);

      // Assert: bid tag with usdc denomination
      const bidTag = event.tags.find((t: string[]) => t[0] === 'bid');
      expect(bidTag).toEqual(['bid', bid, 'usdc']);

      // Assert: output tag with content type
      const outputTag = event.tags.find((t: string[]) => t[0] === 'output');
      expect(outputTag).toEqual(['output', contentType]);
    });

    it('[P1] roundtrip with custom contentType preserves the type', () => {
      // Arrange
      const blobData = createTestBlob(48);
      const contentType = 'image/webp';

      // Act
      const event = buildBlobStorageRequest(
        { blobData, contentType, bid: '30000' },
        FIXED_SECRET_KEY
      );
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.contentType).toBe('image/webp');
    });

    it('[P1] default contentType is application/octet-stream when not provided', () => {
      // Arrange
      const blobData = createTestBlob(16);

      // Act
      const event = buildBlobStorageRequest(
        { blobData, bid: '10000' },
        FIXED_SECRET_KEY
      );
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.contentType).toBe('application/octet-stream');
    });
  });

  // ==========================================================================
  // Builder Validation Errors (AC #1)
  // ==========================================================================

  describe('buildBlobStorageRequest validation errors (AC #1)', () => {
    it('[P0] throws ToonError for empty blobData', () => {
      expect(() =>
        buildBlobStorageRequest(
          { blobData: Buffer.alloc(0), bid: '1000' },
          FIXED_SECRET_KEY
        )
      ).toThrow(/blobData is required/);
    });

    it('[P0] throws ToonError for empty bid string', () => {
      expect(() =>
        buildBlobStorageRequest(
          { blobData: createTestBlob(16), bid: '' },
          FIXED_SECRET_KEY
        )
      ).toThrow(/bid must be a non-empty string/);
    });
  });

  // ==========================================================================
  // 8.0-UNIT-002: Parser Rejects Malformed Events (AC #2)
  // ==========================================================================

  describe('parseBlobStorageRequest rejects malformed events (8.0-UNIT-002)', () => {
    it('[P0] returns null for missing i tag', () => {
      // Arrange: event with no i tag
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: 5094,
        content: '',
        tags: [
          ['bid', '1000', 'usdc'],
          ['output', 'application/octet-stream'],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P0] returns null for invalid base64 in i tag', () => {
      // Arrange: event with non-base64 data in i tag
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: 5094,
        content: '',
        tags: [
          ['i', '!!!not-valid-base64!!!', 'blob'],
          ['bid', '1000', 'usdc'],
          ['output', 'application/octet-stream'],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P0] returns null for wrong kind (not 5094)', () => {
      // Arrange: valid tags but wrong kind
      const blobBase64 = Buffer.from('hello').toString('base64');
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: 5100, // wrong kind
        content: '',
        tags: [
          ['i', blobBase64, 'blob'],
          ['bid', '1000', 'usdc'],
          ['output', 'text/plain'],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P0] returns null for i tag with wrong type (not blob)', () => {
      // Arrange: i tag type is 'url' instead of 'blob'
      const blobBase64 = Buffer.from('hello').toString('base64');
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: 5094,
        content: '',
        tags: [
          ['i', blobBase64, 'url'], // wrong type
          ['bid', '1000', 'usdc'],
          ['output', 'text/plain'],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P1] returns null for empty base64 string in i tag', () => {
      // Arrange
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: 5094,
        content: '',
        tags: [
          ['i', '', 'blob'], // empty base64
          ['bid', '1000', 'usdc'],
          ['output', 'text/plain'],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });

    it('[P1] returns null for missing bid tag', () => {
      // Arrange
      const blobBase64 = Buffer.from('hello').toString('base64');
      const event = {
        id: '0'.repeat(64),
        pubkey: FIXED_PUBKEY,
        kind: 5094,
        content: '',
        tags: [
          ['i', blobBase64, 'blob'],
          ['output', 'text/plain'],
        ],
        created_at: Math.floor(Date.now() / 1000),
        sig: '0'.repeat(128),
      };

      // Act
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).toBeNull();
    });
  });

  // ==========================================================================
  // 8.0-UNIT-003: Chunked Params Roundtrip (AC #3)
  // ==========================================================================

  describe('Chunked upload params roundtrip (8.0-UNIT-003)', () => {
    it('[P0] uploadId, chunkIndex, totalChunks roundtrip correctly', () => {
      // Arrange
      const blobData = createTestBlob(256);
      const uploadId = '550e8400-e29b-41d4-a716-446655440000';
      const chunkIndex = 2;
      const totalChunks = 10;

      // Act
      const event = buildBlobStorageRequest(
        {
          blobData,
          contentType: 'application/octet-stream',
          bid: '500000',
          params: [
            { key: 'uploadId', value: uploadId },
            { key: 'chunkIndex', value: String(chunkIndex) },
            { key: 'totalChunks', value: String(totalChunks) },
          ],
        },
        FIXED_SECRET_KEY
      );
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.uploadId).toBe(uploadId);
      expect(parsed!.chunkIndex).toBe(chunkIndex);
      expect(parsed!.totalChunks).toBe(totalChunks);
    });

    it('[P1] parser returns undefined for optional chunk params when not present', () => {
      // Arrange: event without chunk params
      const blobData = createTestBlob(64);

      // Act
      const event = buildBlobStorageRequest(
        { blobData, contentType: 'text/plain', bid: '10000' },
        FIXED_SECRET_KEY
      );
      const parsed = parseBlobStorageRequest(event);

      // Assert
      expect(parsed).not.toBeNull();
      expect(parsed!.uploadId).toBeUndefined();
      expect(parsed!.chunkIndex).toBeUndefined();
      expect(parsed!.totalChunks).toBeUndefined();
    });

    it('[P1] param tags are correctly structured as [param, key, value]', () => {
      // Arrange
      const blobData = createTestBlob(32);
      const uploadId = 'test-upload-id';

      // Act
      const event = buildBlobStorageRequest(
        {
          blobData,
          contentType: 'application/octet-stream',
          bid: '5000',
          params: [{ key: 'uploadId', value: uploadId }],
        },
        FIXED_SECRET_KEY
      );

      // Assert: check tag structure
      const paramTag = event.tags.find(
        (t: string[]) => t[0] === 'param' && t[1] === 'uploadId'
      );
      expect(paramTag).toEqual(['param', 'uploadId', uploadId]);
    });
  });
});
