/**
 * HTTP client for the agent-runtime POST /ilp/send endpoint.
 */

import { BootstrapError } from './BootstrapService.js';
import type { AgentRuntimeClient, IlpSendResult } from './types.js';

/**
 * Creates an AgentRuntimeClient that sends ILP packets via HTTP.
 *
 * @param baseUrl - Base URL of the agent-runtime (e.g., "http://localhost:3000")
 * @returns An AgentRuntimeClient instance
 * @throws BootstrapError if baseUrl is not a valid URL
 */
export function createAgentRuntimeClient(baseUrl: string): AgentRuntimeClient {
  // Validate baseUrl is a valid URL
  try {
    new URL(baseUrl);
  } catch {
    throw new BootstrapError(`Invalid agent-runtime base URL: ${baseUrl}`);
  }

  // Normalize: remove trailing slash
  const normalizedUrl = baseUrl.replace(/\/+$/, '');

  return {
    async sendIlpPacket(params: {
      destination: string;
      amount: string;
      data: string;
      timeout?: number;
    }): Promise<IlpSendResult> {
      let response: Response;
      try {
        response = await fetch(`${normalizedUrl}/ilp/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            destination: params.destination,
            amount: params.amount,
            data: params.data,
            ...(params.timeout !== undefined && { timeout: params.timeout }),
          }),
        });
      } catch (error) {
        throw new BootstrapError(
          `Network error sending ILP packet: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error instanceof Error ? error : undefined
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        throw new BootstrapError(
          `Agent-runtime error (${response.status}): ${text}`
        );
      }

      const data = (await response.json()) as Record<string, unknown>;
      return {
        accepted: (data['accepted'] ?? data['fulfilled'] ?? false) as boolean,
        fulfillment: data['fulfillment'] as string | undefined,
        data: data['data'] as string | undefined,
        code: data['code'] as string | undefined,
        message: data['message'] as string | undefined,
      };
    },
  };
}
