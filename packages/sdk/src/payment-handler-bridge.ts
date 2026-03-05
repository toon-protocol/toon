/**
 * Payment handler bridge for @crosstown/sdk.
 *
 * Bridges between ILP packet handling and the handler registry,
 * using isTransit to distinguish fire-and-forget from await semantics.
 */

import type { HandlerRegistry } from './handler-registry.js';
import { createHandlerContext } from './handler-context.js';
import type { ToonRoutingMeta } from '@crosstown/core/toon';

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
export function createPaymentHandlerBridge(config: PaymentHandlerBridgeConfig) {
  const { registry } = config;

  return {
    async handlePayment(request: PaymentRequest): Promise<PaymentResponse> {
      let amount: bigint;
      try {
        amount = BigInt(request.amount);
      } catch {
        return {
          accept: false,
          code: 'T00',
          message: 'Invalid payment amount',
        };
      }

      const ctx = createHandlerContext({
        toon: request.data,
        meta: {
          kind: 0,
          pubkey: '',
          id: '',
          sig: '',
          rawBytes: new Uint8Array(0),
        } as ToonRoutingMeta,
        amount,
        destination: request.destination,
        toonDecoder: () => {
          throw new Error('decode not available in bridge');
        },
      });

      if (request.isTransit) {
        void registry.dispatch(ctx).catch((err: unknown) => {
          // Log only the error message, not the full error object (which may contain payload data)
          const errMsg = err instanceof Error ? err.message : 'Unknown error';
          console.error('Transit handler error:', errMsg);
        });
        return { accept: true };
      }

      try {
        return await registry.dispatch(ctx);
      } catch (err: unknown) {
        // Log only the error message, not the full error object (which may contain payload data)
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        console.error('Handler error:', errMsg);
        return {
          accept: false,
          code: 'T00',
          message: 'Internal error',
        };
      }
    },
  };
}
