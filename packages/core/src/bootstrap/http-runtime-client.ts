/**
 * HTTP-based client for sending ILP packets via connector runtime API.
 *
 * Calls the connector's packet handling endpoint over HTTP.
 */

import { BootstrapError } from './BootstrapService.js';
import type { AgentRuntimeClient, IlpSendResult } from './types.js';

/**
 * Creates an AgentRuntimeClient that sends ILP packets via HTTP.
 *
 * @param runtimeUrl - Base URL of the connector runtime (e.g., "http://connector:8080")
 * @returns An AgentRuntimeClient instance
 *
 * @example
 * ```typescript
 * const runtimeClient = createHttpRuntimeClient('http://localhost:8081');
 *
 * const result = await runtimeClient.sendIlpPacket({
 *   destination: 'g.crosstown.peer2',
 *   amount: '1000',
 *   data: base64EncodedToon,
 * });
 * ```
 */
export function createHttpRuntimeClient(runtimeUrl: string): AgentRuntimeClient {
  const baseUrl = runtimeUrl.replace(/\/$/, '');

  return {
    async sendIlpPacket(params: {
      destination: string;
      amount: string;
      data: string;
      timeout?: number;
    }): Promise<IlpSendResult> {
      try {
        const response = await fetch(`${baseUrl}/send-packet`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            destination: params.destination,
            amount: params.amount,
            data: params.data,
          }),
          signal: params.timeout
            ? AbortSignal.timeout(params.timeout)
            : undefined,
        });

        if (!response.ok) {
          const text = await response.text();
          return {
            accepted: false,
            code: 'T00',
            message: `HTTP ${response.status}: ${text}`,
          };
        }

        const result: any = await response.json();

        // Map HTTP response to IlpSendResult
        if (result.accept || result.accepted) {
          return {
            accepted: true,
            fulfillment: result.fulfillment,
            data: result.data,
          };
        } else {
          return {
            accepted: false,
            code: result.code || 'T00',
            message: result.message || 'Unknown error',
          };
        }
      } catch (error) {
        if (error instanceof BootstrapError) {
          throw error;
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
