import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentHandlerBridge } from './payment-handler-bridge.js';
import type { HandlerRegistry } from './handler-registry.js';

// ATDD Red Phase - tests will fail until implementation exists

/**
 * Creates a mock HandlerRegistry for testing the bridge.
 */
function createMockRegistry() {
  return {
    dispatch: vi.fn().mockResolvedValue({ accept: true, fulfillment: 'mock-fulfillment' }),
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

  it.skip('[P0] isTransit=true invokes handler fire-and-forget (non-blocking)', async () => {
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

  it.skip('[P0] isTransit=false awaits handler response', async () => {
    // Arrange
    const expectedResponse = { accept: true, fulfillment: 'real-fulfillment' };
    (mockRegistry.dispatch as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResponse);
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

  it.skip('[P0] unhandled exception in handler produces T00 internal error', async () => {
    // Arrange
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
  });
});
