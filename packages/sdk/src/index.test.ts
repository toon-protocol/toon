import { describe, it, expect } from 'vitest';
import * as sdk from './index.js';

// Stories 1.7, 1.9: All exports implemented and available

describe('@crosstown/sdk public API exports', () => {
  it('[P0] exports createNode function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createNode).toBe('function');
  });

  it('[P0] exports generateMnemonic function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.generateMnemonic).toBe('function');
  });

  it('[P0] exports fromMnemonic function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.fromMnemonic).toBe('function');
  });

  it('[P0] exports fromSecretKey function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.fromSecretKey).toBe('function');
  });

  it('[P1] exports HandlerContext type (verify via createHandlerContext)', () => {
    // Arrange & Act & Assert
    // HandlerContext is a type -- we verify the factory function exists
    expect(typeof sdk.createHandlerContext).toBe('function');
  });

  it('[P1] exports HandlerRegistry class', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.HandlerRegistry).toBe('function');
  });

  it('[P1] exports createVerificationPipeline function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createVerificationPipeline).toBe('function');
  });

  it('[P1] exports createPricingValidator function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createPricingValidator).toBe('function');
  });

  it('[P2] exports createPaymentHandlerBridge function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createPaymentHandlerBridge).toBe('function');
  });

  // Story 1.9: Bootstrap type re-exports
  // BootstrapEvent and BootstrapEventListener are type-only exports.
  // TypeScript compilation (tsc --noEmit) validates they are re-exported.
  // Runtime verification: createNode().on('bootstrap', listener) accepts
  // BootstrapEventListener-typed callback, tested in create-node.test.ts.

  it('[P2] exports NodeError class for lifecycle error handling', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.NodeError).toBe('function');
  });
});
