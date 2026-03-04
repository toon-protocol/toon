import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHandlerContext } from './handler-context.js';
import type { NostrEvent } from 'nostr-tools/pure';
import type { ToonRoutingMeta } from '@crosstown/core/toon';

// Story 1.3: HandlerContext with TOON Passthrough and Lazy Decode

/**
 * Factory for creating a mock ToonRoutingMeta from shallow parse.
 */
function createMockMeta(
  overrides: Partial<ToonRoutingMeta> = {}
): ToonRoutingMeta {
  return {
    kind: 1,
    pubkey: 'ab'.repeat(32),
    id: 'a'.repeat(64),
    sig: 'c'.repeat(128),
    rawBytes: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

/**
 * Factory for creating a decoded NostrEvent.
 */
function createDecodedEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'ab'.repeat(32),
    kind: 1,
    content: 'Hello, world!',
    tags: [],
    created_at: 1234567890,
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

describe('HandlerContext', () => {
  const rawToon = 'base64-encoded-toon-data-here';
  const mockMeta = createMockMeta();
  const mockDecodedEvent = createDecodedEvent();
  const mockDecoder = vi.fn().mockReturnValue(mockDecodedEvent);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[P0] ctx.toon returns the raw TOON string without triggering decode', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act
    const toon = ctx.toon;

    // Assert
    expect(toon).toBe(rawToon);
    expect(mockDecoder).not.toHaveBeenCalled();
  });

  it('[P0] ctx.kind and ctx.pubkey come from shallow parse metadata', () => {
    // Arrange
    const meta = createMockMeta({ kind: 30617, pubkey: 'de'.repeat(32) });
    const ctx = createHandlerContext({
      toon: rawToon,
      meta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act & Assert
    expect(ctx.kind).toBe(30617);
    expect(ctx.pubkey).toBe('de'.repeat(32));
  });

  it('[P0] ctx.kind and ctx.pubkey do not trigger full decode (AC #2, #3)', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act - access kind and pubkey
    void ctx.kind;
    void ctx.pubkey;

    // Assert - decoder should NOT have been called
    expect(mockDecoder).not.toHaveBeenCalled();
  });

  it('[P0] ctx.amount is exposed as bigint', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 123456789012345n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act & Assert
    expect(ctx.amount).toBe(123456789012345n);
    expect(typeof ctx.amount).toBe('bigint');
  });

  it('[P0] ctx.destination contains the ILP destination address', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act & Assert
    expect(ctx.destination).toBe('g.test.receiver');
  });

  it('[P0] ctx.decode() performs lazy decode and caches the result', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act
    const first = ctx.decode();
    const second = ctx.decode();

    // Assert
    expect(mockDecoder).toHaveBeenCalledTimes(1);
    expect(mockDecoder).toHaveBeenCalledWith(rawToon);
    expect(first).toBe(second); // Same reference (cached)
    expect(first).toEqual(mockDecodedEvent);
  });

  it('[P0] ctx.accept() produces a HandlePacketAcceptResponse', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act
    const response = ctx.accept();

    // Assert
    expect(response.accept).toBe(true);
    expect(response).toHaveProperty('fulfillment');
    expect(typeof (response as { fulfillment: string }).fulfillment).toBe(
      'string'
    );
  });

  it('[P0] ctx.accept() without data does not include metadata property (AC #8)', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act
    const response = ctx.accept();

    // Assert - metadata should not be present when no data is passed
    expect(response.metadata).toBeUndefined();
    expect('metadata' in response).toBe(false);
  });

  it('[P1] ctx.accept(data) includes optional response data', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act
    const data = { eventId: 'a'.repeat(64), storedAt: 12345 };
    const response = ctx.accept(data);

    // Assert
    expect(response.accept).toBe(true);
    expect(response.metadata).toBeDefined();
    expect(response.metadata).toEqual(data);
  });

  it('[P0] ctx.reject(code, msg) produces a HandlePacketRejectResponse', () => {
    // Arrange
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: mockMeta,
      amount: 5000n,
      destination: 'g.test.receiver',
      toonDecoder: mockDecoder,
    });

    // Act
    const response = ctx.reject('F04', 'Insufficient payment');

    // Assert
    expect(response.accept).toBe(false);
    expect(response.code).toBe('F04');
    expect(response.message).toBe('Insufficient payment');
  });
});
