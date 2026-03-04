import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentHandlerBridge } from './payment-handler-bridge.js';
import type { HandlerRegistry } from './handler-registry.js';

// ATDD Red Phase - tests will fail until implementation exists

/**
 * Creates a mock HandlerRegistry for testing dev mode behavior.
 */
function createMockRegistry() {
  return {
    dispatch: vi.fn().mockResolvedValue({ accept: true, fulfillment: 'mock' }),
    on: vi.fn(),
    onDefault: vi.fn(),
  } as unknown as HandlerRegistry;
}

/**
 * Creates a minimal PaymentRequest-like object.
 */
function createPaymentRequest(overrides: Record<string, unknown> = {}) {
  return {
    paymentId: 'pay-dev-1',
    destination: 'g.test.receiver',
    amount: '0', // Zero payment to test bypass
    data: Buffer.from('mock-toon-data').toString('base64'),
    isTransit: false,
    ...overrides,
  };
}

describe('Dev Mode', () => {
  let mockRegistry: ReturnType<typeof createMockRegistry>;

  beforeEach(() => {
    mockRegistry = createMockRegistry();
  });

  it.skip('[P0] devMode skips signature verification for invalid signatures', async () => {
    // Arrange
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: true,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest();

    // Act
    const result = await bridge.handlePayment(request);

    // Assert
    // In dev mode, even invalid/missing signatures are accepted
    expect(result.accept).toBe(true);
    expect(mockRegistry.dispatch).toHaveBeenCalled();
  });

  it.skip('[P0] devMode logs incoming packets to console', async () => {
    // Arrange
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: true,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest();

    // Act
    await bridge.handlePayment(request);

    // Assert
    expect(consoleSpy).toHaveBeenCalled();
    const logCalls = consoleSpy.mock.calls.flat().join(' ');
    // Should log packet details (kind, pubkey, amount, destination)
    expect(logCalls).toContain('g.test.receiver');

    consoleSpy.mockRestore();
  });

  it.skip('[P0] devMode bypasses pricing validation (zero payment accepted)', async () => {
    // Arrange
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: true,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    // Zero payment with non-trivial data (would fail pricing in production)
    const request = createPaymentRequest({ amount: '0' });

    // Act
    const result = await bridge.handlePayment(request);

    // Assert
    expect(result.accept).toBe(true);
    expect(mockRegistry.dispatch).toHaveBeenCalled();
  });

  it.skip('[P0] production mode rejects invalid signature with F06', async () => {
    // Arrange
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    // Data that will fail signature verification
    const request = createPaymentRequest({ amount: '99999' });

    // Act
    const result = await bridge.handlePayment(request);

    // Assert
    // In production, invalid signatures are rejected
    // (the mock toon data has no valid Schnorr signature)
    expect(result.accept).toBe(false);
    expect(mockRegistry.dispatch).not.toHaveBeenCalled();
  });

  it.skip('[P1] production mode rejects underpaid event with F04', async () => {
    // Arrange
    // This test needs a validly-signed event but underpaid amount.
    // The bridge should reject at pricing stage.
    const bridge = createPaymentHandlerBridge({
      registry: mockRegistry as unknown as HandlerRegistry,
      devMode: false,
      ownPubkey: 'ff'.repeat(32),
      basePricePerByte: 10n,
    });
    const request = createPaymentRequest({ amount: '1' }); // Way too little

    // Act
    const result = await bridge.handlePayment(request);

    // Assert
    expect(result.accept).toBe(false);
  });
});
