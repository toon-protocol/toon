/**
 * Direct BLS HTTP client for bootstrap operations.
 *
 * Sends ILP packets directly to a peer's BLS HTTP endpoint, bypassing
 * connector routing. This is necessary for bootstrap because peer
 * announcements must happen BEFORE BTP connections are established.
 *
 * After bootstrap completes and payment channels are open, normal ILP
 * routing through connectors can be used.
 */

import type { IlpClient, IlpSendResult } from './types.js';

export interface DirectBlsClientConfig {
  /** BLS HTTP endpoint (e.g., 'http://toon-peer1:3100') */
  blsUrl: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Creates a runtime client that sends packets directly to a peer's BLS.
 *
 * Use this ONLY for bootstrap operations. After bootstrap, use
 * the HttpRuntimeClient to send through connectors.
 *
 * @example
 * ```typescript
 * const client = createDirectBlsClient({
 *   blsUrl: 'http://toon-peer1:3100'
 * });
 *
 * const result = await client.sendIlpPacket({
 *   destination: 'g.toon.peer1',
 *   amount: '0',
 *   data: base64ToonEvent,
 * });
 * ```
 */
export function createDirectBlsClient(
  config: DirectBlsClientConfig
): IlpClient {
  const baseUrl = config.blsUrl.replace(/\/$/, '');
  const timeout = config.timeout ?? 30000;

  return {
    async sendIlpPacket(params: {
      destination: string;
      amount: string;
      data: string;
      timeout?: number;
    }): Promise<IlpSendResult> {
      const requestTimeout = params.timeout ?? timeout;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

      try {
        const response = await fetch(`${baseUrl}/handle-packet`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            destination: params.destination,
            amount: params.amount,
            data: params.data,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const text = await response.text();
          return {
            accepted: false,
            code: `HTTP_${response.status}`,
            message: text || response.statusText,
          };
        }

        const result = (await response.json()) as Record<string, unknown>;

        // BLS returns {accept, fulfillment, data, code, message}
        return {
          accepted: (result['accept'] as boolean) ?? false,
          fulfillment: result['fulfillment'] as string | undefined,
          data: result['data'] as string | undefined,
          code: result['code'] as string | undefined,
          message: result['message'] as string | undefined,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === 'AbortError') {
          return {
            accepted: false,
            code: 'T00',
            message: `Request timeout after ${requestTimeout}ms`,
          };
        }

        return {
          accepted: false,
          code: 'T00',
          message: `HTTP request failed: ${error instanceof Error ? error.message : 'Unknown'}`,
        };
      }
    },
  };
}
