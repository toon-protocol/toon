/**
 * Payment handler bridge for @crosstown/sdk.
 *
 * Bridges between ILP packet handling and the handler registry,
 * performing verification, pricing validation, and handler dispatch.
 */

import type { HandlerRegistry } from './handler-registry.js';

export interface PaymentHandlerBridgeConfig {
  registry: HandlerRegistry;
  devMode: boolean;
  ownPubkey: string;
  basePricePerByte: bigint;
}

export interface PaymentRequest {
  paymentId: string;
  destination: string;
  amount: string;
  data: string;
  isTransit: boolean;
}

export interface PaymentResponse {
  accept: boolean;
  fulfillment?: string;
  code?: string;
  message?: string;
  data?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Creates a payment handler bridge that connects ILP packets to the handler registry.
 */
export function createPaymentHandlerBridge(
  _config: PaymentHandlerBridgeConfig
) {
  return {
    async handlePayment(_request: unknown): Promise<PaymentResponse> {
      // Stub implementation -- will be filled in when SDK is implemented
      return {
        accept: false,
        code: 'T00',
        message: 'Not yet implemented',
      };
    },
  };
}
