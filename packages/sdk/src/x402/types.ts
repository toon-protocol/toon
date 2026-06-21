/**
 * Shared TypeScript interfaces for x402 USDC-denominated payment flows.
 *
 * All amounts are in USDC micro-units (1 USDC = 1,000,000 micro-units).
 *
 * @module
 */

/** Configuration for computing x402 payment amounts. */
export interface X402PricingConfig {
  /** USDC micro-units charged per payload byte. */
  basePricePerByte: bigint;
  /** Flat routing buffer added on top of the per-byte cost. */
  routingBuffer: bigint;
}

/** Server response to a preflight request, telling the client what to pay. */
export interface X402PreflightResult {
  /** Total USDC micro-units the client must include in the payment. */
  requiredAmount: bigint;
  /** Unix timestamp (ms) after which this preflight result expires. */
  expiresAt: number;
}

/** Parameters the client sends when settling an x402 payment. */
export interface X402SettleParams {
  /** USDC micro-units being paid. */
  amount: bigint;
  /** Signed payment-channel claim authorizing the transfer. */
  claim: string;
  /** Chain/network identifier (e.g. "arbitrum-one", "arbitrum-sepolia"). */
  network: string;
}

/** Parameters received by the connector when validating an x402 ingress. */
export interface X402IngressParams {
  /** USDC micro-units the client claims to be paying. */
  amount: bigint;
  /** Payload size in bytes, used to verify the payment covers the cost. */
  payloadBytes: number;
  /** Pricing config against which the amount is validated. */
  config: X402PricingConfig;
}
