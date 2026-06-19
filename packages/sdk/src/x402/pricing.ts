import type { X402PricingConfig } from './types.js';

/**
 * Computes the required USDC micro-unit payment for an x402 request.
 *
 * Formula: basePricePerByte * payloadBytes + routingBuffer
 *
 * Pure math — no chain calls or I/O.
 */
export function computeX402RequiredAmount(
  payloadBytes: number,
  config: X402PricingConfig,
): bigint {
  return BigInt(payloadBytes) * config.basePricePerByte + config.routingBuffer;
}
