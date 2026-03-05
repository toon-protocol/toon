import { describe, it, expect } from 'vitest';
import { createVerificationPipeline } from './verification-pipeline.js';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import { encodeEventToToon, shallowParseToon } from '@crosstown/core/toon';

// ATDD tests for Story 1.4 -- verification pipeline

/**
 * Helper to create a properly signed Nostr event and encode to TOON.
 * Uses real nostr-tools crypto -- no mocking.
 */
/** Deterministic timestamp for reproducible tests (2026-01-01T00:00:00Z) */
const TEST_CREATED_AT = 1767225600;

function createSignedToonPayload(kind = 1, content = 'test') {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind,
      content,
      tags: [],
      created_at: TEST_CREATED_AT,
    },
    sk
  );
  const toonBytes = encodeEventToToon(event);
  const meta = shallowParseToon(toonBytes);
  const toonBase64 = Buffer.from(toonBytes).toString('base64');
  return { event, sk, toonBytes, toonBase64, meta, pubkey: getPublicKey(sk) };
}

/**
 * Helper to create a TOON payload with a tampered signature.
 */
function createTamperedToonPayload() {
  const { event, toonBytes, meta, toonBase64 } = createSignedToonPayload();
  // Tamper the signature by flipping a character
  const tamperedMeta = {
    ...meta,
    sig: 'ff'.repeat(64), // Invalid signature
  };
  return { event, toonBytes, toonBase64, meta: tamperedMeta };
}

describe('Verification Pipeline', () => {
  it('[P0] valid Schnorr signature allows event dispatch to handler', async () => {
    // Arrange
    const { meta, toonBase64 } = createSignedToonPayload();
    const pipeline = createVerificationPipeline({ devMode: false });

    // Act
    const result = await pipeline.verify(meta, toonBase64);

    // Assert
    expect(result.verified).toBe(true);
  });

  it('[P0] invalid signature produces F06 rejection and handler is never called', async () => {
    // Arrange
    const { meta } = createTamperedToonPayload();
    const pipeline = createVerificationPipeline({ devMode: false });

    // Act
    const result = await pipeline.verify(meta, 'irrelevant');

    // Assert
    expect(result.verified).toBe(false);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.code).toBe('F06');
    expect(result.rejection!.accept).toBe(false);
  });

  it('[P0] devMode: true skips verification for invalid signature', async () => {
    // Arrange
    const { meta } = createTamperedToonPayload();
    const pipeline = createVerificationPipeline({ devMode: true });

    // Act
    const result = await pipeline.verify(meta, 'irrelevant');

    // Assert
    expect(result.verified).toBe(true);
  });

  it('[P0] verification uses only shallow-parsed fields (no full decode)', async () => {
    // Arrange
    const { meta } = createSignedToonPayload();
    const pipeline = createVerificationPipeline({ devMode: false });

    // Act
    const result = await pipeline.verify(meta, 'test-data');

    // Assert
    // If verification succeeds, it only needed id, pubkey, sig from meta
    // (no ctx.decode() was needed)
    expect(result.verified).toBe(true);
  });

  it('[P0] tampered event content causes signature mismatch and F06 rejection', async () => {
    // Arrange
    const { meta, toonBase64 } = createSignedToonPayload();
    // Tamper the id (simulates content change that invalidates signature)
    const tamperedMeta = {
      ...meta,
      id: 'aa'.repeat(32), // Different event id = different message hash
    };
    const pipeline = createVerificationPipeline({ devMode: false });

    // Act
    const result = await pipeline.verify(tamperedMeta, toonBase64);

    // Assert
    expect(result.verified).toBe(false);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.code).toBe('F06');
  });

  it('[P0] devMode explicitly false -- invalid signature produces F06 (no bypass leak)', async () => {
    // Arrange
    const { meta } = createTamperedToonPayload();
    const pipeline = createVerificationPipeline({ devMode: false });

    // Act
    const result = await pipeline.verify(meta, 'irrelevant');

    // Assert
    expect(result.verified).toBe(false);
    expect(result.rejection).toBeDefined();
    expect(result.rejection!.code).toBe('F06');
    expect(result.rejection!.message).toBeDefined();
  });
});
