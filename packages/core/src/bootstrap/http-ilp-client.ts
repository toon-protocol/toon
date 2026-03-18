/**
 * HTTP-based client for sending ILP packets via the connector API.
 *
 * Calls the connector's packet handling endpoint over HTTP.
 */

import { BootstrapError } from './BootstrapService.js';
import type { IlpClient, IlpSendResult } from './types.js';

/**
 * Creates an IlpClient that sends ILP packets via HTTP.
 *
 * @param connectorUrl - Base URL of the connector (e.g., "http://connector:8080")
 * @returns An IlpClient instance
 *
 * @example
 * ```typescript
 * const ilpClient = createHttpIlpClient('http://localhost:8081');
 *
 * const result = await ilpClient.sendIlpPacket({
 *   destination: 'g.toon.peer2',
 *   amount: '1000',
 *   data: base64EncodedToon,
 * });
 * ```
 */
export function createHttpIlpClient(connectorUrl: string): IlpClient {
  const baseUrl = connectorUrl.replace(/\/$/, '');

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

        const result = (await response.json()) as Record<string, unknown>;

        // Map HTTP response to IlpSendResult
        if (result['accept'] || result['accepted']) {
          return {
            accepted: true,
            fulfillment: result['fulfillment'] as string | undefined,
            data: result['data'] as string | undefined,
          };
        } else {
          return {
            accepted: false,
            code: (result['code'] as string) || 'T00',
            message: (result['message'] as string) || 'Unknown error',
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
