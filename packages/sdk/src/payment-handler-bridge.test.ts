import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentHandlerBridge } from './payment-handler-bridge.js';
import type { HandlerRegistry } from './handler-registry.js';

// ATDD tests for Story 1.6 -- payment handler bridge

/**
 * Creates a mock HandlerRegistry for testing the bridge.
 */
function createMockRegistry() {
  return {
    dispatch: vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'mock-fulfillment' }),
    on: vi.fn(),
    onDefault: vi.fn(),
  } as unknown as HandlerRegistry;
}

/**
 * Creates a minimal PaymentRequest-like object.
 */
function createPaymentRequest(overrides: Record<string, unknown> = {}) {
  return {
    paymentId: 'pay-123',
    destination: 'g.test.receiver',
    amount: '5000',
    data: Buffer.from('mock-toon-data').toString('base64'),
    isTransit: false,
    ...overrides,
  };
}

describe('PaymentHandler Bridge', () => {
  let mockRegistry: ReturnType<typeof createMockRegistry>;

  beforeEach(() => {
    mockRegistry = createMockRegistry();
  });

  it('[P0] isTransit=true invokes handler fire-and-forget (non-blocking)', async () => {
    // Arrange
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: true });

    // Simulate a slow handler
    let handlerResolved = false;
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<{ accept: boolean }>((resolve) => {
          setTimeout(() => {
            handlerResolved = true;
            resolve({ accept: true });
          }, 100);
        })
    );

    // Act
    const response = await bridge.handlePayment(request);

    // Assert
    // Bridge should return immediately for transit packets
    expect(response.accept).toBe(true);
    // Handler may not have resolved yet (fire-and-forget)
    expect(handlerResolved).toBe(false);
  });

  it('[P0] isTransit=false awaits handler response', async () => {
    // Arrange
    const expectedResponse = { accept: true, fulfillment: 'real-fulfillment' };
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue(
      expectedResponse
    );
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: false });

    // Act
    const response = await bridge.handlePayment(request);

    // Assert
    expect(response).toEqual(expect.objectContaining({ accept: true }));
    expect(mockRegistry.dispatch).toHaveBeenCalledTimes(1);
  });

  it('[P0] unhandled exception in handler produces T00 internal error', async () => {
    // Arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Handler exploded')
    );
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: false });

    // Act
    const response = await bridge.handlePayment(request);

    // Assert
    expect(response.accept).toBe(false);
    expect(response.code).toBe('T00');
    expect(response.message).toBeDefined();

    // Cleanup
    errorSpy.mockRestore();
  });

  it('[P1] handler async rejection produces T00 internal error', async () => {
    // Arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Async handler failure')
    );
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: false });

    // Act
    const response = await bridge.handlePayment(request);

    // Assert
    expect(response.accept).toBe(false);
    expect(response.code).toBe('T00');
    expect(response.message).toBeDefined();

    // Cleanup
    errorSpy.mockRestore();
  });

  // --- Gap-fill tests: coverage for AC gaps not addressed by ATDD tests ---

  it('[P1] isTransit=true actually invokes dispatch (AC #1 - handler IS invoked)', async () => {
    // Arrange -- the default mock resolves immediately
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: true });

    // Act
    await bridge.handlePayment(request);

    // Assert -- dispatch must have been called even for fire-and-forget
    expect(mockRegistry.dispatch).toHaveBeenCalledTimes(1);
  });

  it('[P1] synchronous throw in handler produces T00 internal error (AC #3)', async () => {
    // Arrange -- mockImplementation with synchronous throw (not mockRejectedValue)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('Synchronous handler explosion');
      }
    );
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: false });

    // Act
    const response = await bridge.handlePayment(request);

    // Assert
    expect(response.accept).toBe(false);
    expect(response.code).toBe('T00');
    expect(response.message).toBe('Internal error');

    // Cleanup
    errorSpy.mockRestore();
  });

  it('[P1] handler exception is logged via console.error (AC #3)', async () => {
    // Arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlerError = new Error('Logged handler failure');
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
      handlerError
    );
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: false });

    // Act
    await bridge.handlePayment(request);

    // Assert -- error must be logged
    expect(errorSpy).toHaveBeenCalledWith('Handler error:', handlerError);

    // Cleanup
    errorSpy.mockRestore();
  });

  it('[P2] transit handler error is caught and logged (AC #1 - no unhandled rejection)', async () => {
    // Arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transitError = new Error('Transit handler crashed');
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
      transitError
    );
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: true });

    // Act
    const response = await bridge.handlePayment(request);

    // The bridge should still accept for transit (fire-and-forget)
    expect(response.accept).toBe(true);

    // Wait for the fire-and-forget promise's .catch() to execute
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Assert -- error should be logged via .catch(), not leaked as unhandled rejection
    expect(errorSpy).toHaveBeenCalledWith(
      'Transit handler error:',
      transitError
    );

    // Cleanup
    errorSpy.mockRestore();
  });

  it('[P1] invalid amount string produces T00 without crashing', async () => {
    // Arrange -- amount is not a valid BigInt string
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ amount: 'not-a-number' });

    // Act
    const response = await bridge.handlePayment(request);

    // Assert -- should return T00, not throw
    expect(response.accept).toBe(false);
    expect(response.code).toBe('T00');
    expect(response.message).toBe('Invalid payment amount');
    // dispatch should NOT have been called
    expect(mockRegistry.dispatch).not.toHaveBeenCalled();
  });

  it('[P2] non-Error throw produces T00 with generic message (AC #3)', async () => {
    // Arrange -- handler throws a non-Error value (string)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
      'string-error-value'
    );
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ isTransit: false });

    // Act
    const response = await bridge.handlePayment(request);

    // Assert -- should still produce T00 with generic message
    expect(response.accept).toBe(false);
    expect(response.code).toBe('T00');
    expect(response.message).toBe('Internal error');

    // Cleanup
    errorSpy.mockRestore();
  });
});
