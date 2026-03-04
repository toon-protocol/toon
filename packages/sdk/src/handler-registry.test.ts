import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HandlerRegistry } from './handler-registry.js';
import type { HandlerContext } from './handler-context.js';

// ATDD Red Phase - tests will fail until implementation exists

/**
 * Factory for creating a minimal mock HandlerContext.
 */
function createMockContext(
  overrides: Partial<HandlerContext> = {}
): HandlerContext {
  return {
    toon: 'mock-toon-string',
    kind: 1,
    pubkey: 'ab'.repeat(32),
    amount: 1000n,
    destination: 'g.test.receiver',
    decode: vi.fn().mockReturnValue({
      id: 'a'.repeat(64),
      pubkey: 'ab'.repeat(32),
      kind: 1,
      content: 'test',
      tags: [],
      created_at: 1234567890,
      sig: 'c'.repeat(128),
    }),
    accept: vi.fn().mockReturnValue({ accept: true, fulfillment: 'mock' }),
    reject: vi
      .fn()
      .mockReturnValue({ accept: false, code: 'F00', message: 'rejected' }),
    ...overrides,
  } as HandlerContext;
}

describe('HandlerRegistry', () => {
  let registry: HandlerRegistry;

  beforeEach(() => {
    registry = new HandlerRegistry();
  });

  it.skip('[P0] .on(kind, handler) dispatches to the correct handler for that kind', async () => {
    // Arrange
    const handler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'f' });
    registry.on(30617, handler);
    const ctx = createMockContext({ kind: 30617 });

    // Act
    await registry.dispatch(ctx);

    // Assert
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx);
  });

  it.skip('[P0] multiple kind registrations each dispatch to their own handler', async () => {
    // Arrange
    const handler1 = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'f1' });
    const handler2 = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'f2' });
    registry.on(1, handler1);
    registry.on(30617, handler2);
    const ctx1 = createMockContext({ kind: 1 });
    const ctx2 = createMockContext({ kind: 30617 });

    // Act
    await registry.dispatch(ctx1);
    await registry.dispatch(ctx2);

    // Assert
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler1).toHaveBeenCalledWith(ctx1);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledWith(ctx2);
  });

  it.skip('[P0] .onDefault() fallback is invoked for an unknown kind', async () => {
    // Arrange
    const defaultHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'df' });
    registry.onDefault(defaultHandler);
    const ctx = createMockContext({ kind: 99999 });

    // Act
    await registry.dispatch(ctx);

    // Assert
    expect(defaultHandler).toHaveBeenCalledTimes(1);
    expect(defaultHandler).toHaveBeenCalledWith(ctx);
  });

  it.skip('[P0] no handler and no default produces F00 rejection', async () => {
    // Arrange
    const ctx = createMockContext({ kind: 99999 });

    // Act
    const result = await registry.dispatch(ctx);

    // Assert
    expect(result).toEqual(
      expect.objectContaining({
        accept: false,
        code: 'F00',
      })
    );
  });

  it.skip('[P1] duplicate .on() for the same kind replaces the previous handler', async () => {
    // Arrange
    const originalHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'old' });
    const replacementHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'new' });
    registry.on(1, originalHandler);
    registry.on(1, replacementHandler);
    const ctx = createMockContext({ kind: 1 });

    // Act
    await registry.dispatch(ctx);

    // Assert
    expect(originalHandler).not.toHaveBeenCalled();
    expect(replacementHandler).toHaveBeenCalledTimes(1);
  });
});
