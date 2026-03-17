import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HandlerRegistry } from './handler-registry.js';
import type { HandlerContext } from './handler-context.js';

// Story 1.2: Handler Registry with Kind-Based Routing

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

  it('[P0] .on(kind, handler) dispatches to the correct handler for that kind', async () => {
    // Arrange
    const handler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'f' });
    registry.on(30617, handler);
    const ctx = createMockContext({ kind: 30617 });

    // Act
    const result = await registry.dispatch(ctx);

    // Assert
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx);
    expect(result).toEqual({ accept: true, fulfillment: 'f' });
  });

  it('[P0] multiple kind registrations each dispatch to their own handler', async () => {
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

  it('[P0] .onDefault() fallback is invoked for an unknown kind', async () => {
    // Arrange
    const defaultHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'df' });
    registry.onDefault(defaultHandler);
    const ctx = createMockContext({ kind: 99999 });

    // Act
    const result = await registry.dispatch(ctx);

    // Assert
    expect(defaultHandler).toHaveBeenCalledTimes(1);
    expect(defaultHandler).toHaveBeenCalledWith(ctx);
    expect(result).toEqual({ accept: true, fulfillment: 'df' });
  });

  it('[P0] no handler and no default produces F00 rejection', async () => {
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

  it('[P1] duplicate .on() for the same kind replaces the previous handler', async () => {
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
    const result = await registry.dispatch(ctx);

    // Assert
    expect(originalHandler).not.toHaveBeenCalled();
    expect(replacementHandler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accept: true, fulfillment: 'new' });
  });

  it('[P0] multiple kind registrations route to correct handler only (no cross-dispatch)', async () => {
    // Arrange -- register two kind handlers
    const handler1 = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'f1' });
    const handler2 = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'f2' });
    registry.on(1, handler1);
    registry.on(30617, handler2);

    // Act -- dispatch kind 30617 only
    const result = await registry.dispatch(createMockContext({ kind: 30617 }));

    // Assert -- handler2 invoked, handler1 NOT invoked, return value from handler2
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler1).not.toHaveBeenCalled();
    expect(result).toEqual({ accept: true, fulfillment: 'f2' });
  });

  it('[P0] .onDefault() is NOT invoked when a specific kind handler matches', async () => {
    // Arrange -- register both a kind handler and a default handler
    const kindHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'kind' });
    const defaultHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'default' });
    registry.on(1, kindHandler);
    registry.onDefault(defaultHandler);

    // Act -- dispatch the kind that has a specific handler
    const result = await registry.dispatch(createMockContext({ kind: 1 }));

    // Assert -- kind handler invoked, default handler NOT invoked, return from kind handler
    expect(kindHandler).toHaveBeenCalledTimes(1);
    expect(defaultHandler).not.toHaveBeenCalled();
    expect(result).toEqual({ accept: true, fulfillment: 'kind' });
  });

  it('[P0] F00 rejection includes a descriptive message', async () => {
    // Arrange -- no handlers registered
    const ctx = createMockContext({ kind: 42 });

    // Act
    const result = await registry.dispatch(ctx);

    // Assert -- message field exists and mentions the kind
    expect(result).toEqual(
      expect.objectContaining({
        accept: false,
        code: 'F00',
      })
    );
    expect(result).toHaveProperty('message');
    expect('message' in result && typeof result.message).toBe('string');
    expect('message' in result && result.message).toMatch(/42/);
  });

  it('[P1] .on() returns this for chaining', () => {
    // Arrange
    const handler = vi.fn().mockResolvedValue({ accept: true });

    // Act
    const result = registry.on(1, handler);

    // Assert
    expect(result).toBe(registry);
  });

  it('[P1] .onDefault() returns this for chaining', () => {
    // Arrange
    const handler = vi.fn().mockResolvedValue({ accept: true });

    // Act
    const result = registry.onDefault(handler);

    // Assert
    expect(result).toBe(registry);
  });

  it('[P1] method chaining: .on().on().onDefault() registers all handlers', async () => {
    // Arrange
    const handler1 = vi.fn().mockResolvedValue({ accept: true });
    const handler2 = vi.fn().mockResolvedValue({ accept: true });
    const defaultHandler = vi.fn().mockResolvedValue({ accept: true });

    // Act -- chain registration
    const result = registry
      .on(1, handler1)
      .on(30617, handler2)
      .onDefault(defaultHandler);

    // Assert -- chaining returns the registry
    expect(result).toBe(registry);

    // Assert -- all registrations are active
    await registry.dispatch(createMockContext({ kind: 1 }));
    expect(handler1).toHaveBeenCalledTimes(1);

    await registry.dispatch(createMockContext({ kind: 30617 }));
    expect(handler2).toHaveBeenCalledTimes(1);

    await registry.dispatch(createMockContext({ kind: 99999 }));
    expect(defaultHandler).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Story 5.4: getRegisteredKinds() and getDvmKinds()
  // --------------------------------------------------------------------------

  describe('getRegisteredKinds() (T-5.4-17)', () => {
    it('[P1] returns all registered kinds sorted ascending', () => {
      // Arrange
      const handler = vi.fn().mockResolvedValue({ accept: true });
      registry.on(30617, handler);
      registry.on(1, handler);
      registry.on(5100, handler);

      // Act
      const kinds = registry.getRegisteredKinds();

      // Assert
      expect(kinds).toEqual([1, 5100, 30617]);
    });

    it('[P1] returns empty array when no handlers registered', () => {
      // Act
      const kinds = registry.getRegisteredKinds();

      // Assert
      expect(kinds).toEqual([]);
    });
  });

  describe('getDvmKinds() (T-5.4-18)', () => {
    it('[P1] returns only kinds in 5000-5999 range', () => {
      // Arrange
      const handler = vi.fn().mockResolvedValue({ accept: true });
      registry.on(1, handler);
      registry.on(5100, handler);
      registry.on(5200, handler);
      registry.on(6100, handler);
      registry.on(10032, handler);

      // Act
      const dvmKinds = registry.getDvmKinds();

      // Assert: only 5100 and 5200 are in DVM request range (5000-5999)
      expect(dvmKinds).toEqual([5100, 5200]);
    });

    it('[P1] returns empty array when no DVM handlers registered (T-5.4-19)', () => {
      // Arrange: register non-DVM kinds only
      const handler = vi.fn().mockResolvedValue({ accept: true });
      registry.on(1, handler);
      registry.on(10032, handler);

      // Act
      const dvmKinds = registry.getDvmKinds();

      // Assert
      expect(dvmKinds).toEqual([]);
    });

    it('[P1] register 5100 and 5200 -> getDvmKinds() returns [5100, 5200] (T-5.4-04)', () => {
      // Arrange: register DVM handlers via .on()
      const handler = vi.fn().mockResolvedValue({ accept: true });
      registry.on(5100, handler);
      registry.on(5200, handler);

      // Act
      const dvmKinds = registry.getDvmKinds();

      // Assert: exactly the registered DVM kinds
      expect(dvmKinds).toEqual([5100, 5200]);
    });

    it('[P1] includes boundary kinds 5000 and 5999', () => {
      // Arrange: register boundary kinds
      const handler = vi.fn().mockResolvedValue({ accept: true });
      registry.on(5000, handler);
      registry.on(5999, handler);

      // Act
      const dvmKinds = registry.getDvmKinds();

      // Assert: both boundary values included
      expect(dvmKinds).toEqual([5000, 5999]);
    });

    it('[P1] excludes kind 4999 and kind 6000', () => {
      // Arrange: register kinds just outside the DVM range
      const handler = vi.fn().mockResolvedValue({ accept: true });
      registry.on(4999, handler);
      registry.on(6000, handler);

      // Act
      const dvmKinds = registry.getDvmKinds();

      // Assert: both are outside the range
      expect(dvmKinds).toEqual([]);
    });
  });
});
