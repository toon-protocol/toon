/**
 * HTTP-based client for payment channel operations.
 *
 * Calls the connector's Admin API to open channels and query channel state.
 */

import { BootstrapError } from './BootstrapService.js';
import type {
  ConnectorChannelClient,
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
} from '../types.js';

/**
 * Creates a ConnectorChannelClient that calls the Connector Admin API via HTTP.
 *
 * @param adminUrl - Base URL of the connector admin API (e.g., "http://connector:8081")
 * @returns A ConnectorChannelClient that manages channels via HTTP
 *
 * @example
 * ```typescript
 * const channelClient = createHttpChannelClient('http://localhost:8091');
 *
 * const result = await channelClient.openChannel({
 *   peerId: 'peer2',
 *   chain: 'evm:base:31337',
 *   peerAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
 *   initialDeposit: '100000',
 * });
 * ```
 */
export function createHttpChannelClient(adminUrl: string): ConnectorChannelClient {
  const baseUrl = adminUrl.replace(/\/$/, '');

  return {
    async openChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
      try {
        const response = await fetch(`${baseUrl}/admin/channels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            peerId: params.peerId,
            chain: params.chain,
            token: params.token,
            tokenNetwork: params.tokenNetwork,
            peerAddress: params.peerAddress,
            initialDeposit: params.initialDeposit,
            settlementTimeout: params.settlementTimeout,
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const result: any = await response.json();
        return {
          channelId: result.channelId,
          status: result.status,
        };
      } catch (error) {
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Failed to open channel for peer ${params.peerId} via HTTP`,
          error instanceof Error ? error : undefined
        );
      }
    },

    async getChannelState(channelId: string): Promise<ChannelState> {
      try {
        const response = await fetch(`${baseUrl}/admin/channels/${channelId}`);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const result: any = await response.json();
        return {
          channelId: result.channelId,
          status: result.status,
          chain: result.chain,
        };
      } catch (error) {
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Failed to get channel state for ${channelId} via HTTP`,
          error instanceof Error ? error : undefined
        );
      }
    },
  };
}
