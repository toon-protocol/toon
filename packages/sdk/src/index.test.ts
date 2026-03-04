// @ts-nocheck — ATDD Red Phase: imports reference exports that don't exist yet
import { describe, it, expect } from 'vitest';
import * as sdk from './index.js';

// ATDD Red Phase - tests will fail until implementation exists

describe('@crosstown/sdk public API exports', () => {
  it.skip('[P0] exports createNode function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createNode).toBe('function');
  });

  it.skip('[P0] exports generateMnemonic function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.generateMnemonic).toBe('function');
  });

  it.skip('[P0] exports fromMnemonic function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.fromMnemonic).toBe('function');
  });

  it.skip('[P0] exports fromSecretKey function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.fromSecretKey).toBe('function');
  });

  it.skip('[P1] exports HandlerContext type (verify via createHandlerContext)', () => {
    // Arrange & Act & Assert
    // HandlerContext is a type -- we verify the factory function exists
    expect(typeof sdk.createHandlerContext).toBe('function');
  });

  it.skip('[P1] exports HandlerRegistry class', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.HandlerRegistry).toBe('function');
  });

  it.skip('[P1] exports createVerificationPipeline function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createVerificationPipeline).toBe('function');
  });

  it.skip('[P1] exports createPricingValidator function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createPricingValidator).toBe('function');
  });

  it.skip('[P2] exports createPaymentHandlerBridge function', () => {
    // Arrange & Act & Assert
    expect(typeof sdk.createPaymentHandlerBridge).toBe('function');
  });
});
