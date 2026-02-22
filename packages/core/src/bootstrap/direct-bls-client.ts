/**
 * Direct BLS HTTP client for bootstrap SPSP handshakes.
 *
 * Sends ILP packets directly to a peer's BLS HTTP endpoint, bypassing
 * connector routing. This is necessary for bootstrap because SPSP
 * handshakes must happen BEFORE BTP connections are established.
 *
 * After bootstrap completes and payment channels are open, normal ILP
 * routing through connectors can be used.
 */

import type { AgentRuntimeClient, IlpSendResult } from './types.js';

export interface DirectBlsClientConfig {
  /** BLS HTTP endpoint (e.g., 'http://crosstown-peer1:3100') */
  blsUrl: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Creates a runtime client that sends packets directly to a peer's BLS.
 *
 * Use this ONLY for bootstrap SPSP handshakes. After bootstrap, use
 * the HttpRuntimeClient to send through connectors.
 *
 * @example
 * ```typescript
 * const client = createDirectBlsClient({
 *   blsUrl: 'http://crosstown-peer1:3100'
 * });
 *
 * const result = await client.sendIlpPacket({
 *   destination: 'g.crosstown.peer1',
 *   amount: '0',
 *   data: base64ToonEvent,
 * });
 * ```
 */
export function createDirectBlsClient(config: DirectBlsClientConfig): AgentRuntimeClient {
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

        const result: any = await response.json();

        // BLS returns {accept, fulfillment, data, code, message}
        return {
          accepted: result.accept ?? false,
          fulfillment: result.fulfillment,
          data: result.data,
          code: result.code,
          message: result.message,
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
