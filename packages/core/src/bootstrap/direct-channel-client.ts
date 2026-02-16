/**
 * Direct (in-process) client for payment channel operations via a ConnectorNode.
 *
 * Unlike HTTP-based channel clients, this factory wraps a ConnectorNode's
 * openChannel() and getChannelState() methods as a ConnectorChannelClient,
 * enabling zero-latency embedded mode without network overhead.
 *
 * Requires @agent-society/connector >=1.2.0 which exposes these methods
 * as public API on ConnectorNode.
 */

import { BootstrapError } from './BootstrapService.js';
import type {
  ConnectorChannelClient,
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
} from '../types.js';

/**
 * Structural interface matching ConnectorNode's channel methods.
 *
 * Consumers pass an `@agent-society/connector` ConnectorNode instance without
 * agent-society needing to import `@agent-society/connector` as a dependency.
 * TypeScript's structural type system handles compatibility automatically.
 */
export interface ConnectorChannelLike {
  openChannel(params: {
    peerId: string;
    chain: string;
    token?: string;
    tokenNetwork?: string;
    peerAddress: string;
    initialDeposit?: string;
    settlementTimeout?: number;
  }): Promise<{ channelId: string; status: string }>;

  getChannelState(channelId: string): Promise<{
    channelId: string;
    status: 'opening' | 'open' | 'closed' | 'settled';
    chain: string;
  }>;
}

/**
 * Creates a ConnectorChannelClient that calls ConnectorNode methods directly
 * instead of making HTTP requests.
 *
 * Used for embedded mode where the ConnectorNode runs in-process.
 * The returned client conforms to the ConnectorChannelClient interface,
 * making it a drop-in replacement for the HTTP-based channel client.
 *
 * @param connector - A ConnectorNode instance (or any object matching ConnectorChannelLike)
 * @returns A ConnectorChannelClient that manages channels via direct function calls
 *
 * @example
 * ```typescript
 * import { ConnectorNode } from '@agent-society/connector';
 * import { createDirectChannelClient } from '@agent-society/core/bootstrap';
 *
 * const connector = new ConnectorNode({ ... });
 * const channelClient = createDirectChannelClient(connector);
 *
 * const result = await channelClient.openChannel({
 *   peerId: 'nostr-54dad746e52dab00',
 *   chain: 'evm:base:84532',
 *   peerAddress: '0x6AFbC4...',
 * });
 * ```
 */
export function createDirectChannelClient(
  connector: ConnectorChannelLike,
): ConnectorChannelClient {
  return {
    async openChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
      try {
        return await connector.openChannel(params);
      } catch (error) {
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Failed to open channel for peer ${params.peerId}`,
          error instanceof Error ? error : undefined,
        );
      }
    },

    async getChannelState(channelId: string): Promise<ChannelState> {
      try {
        return await connector.getChannelState(channelId);
      } catch (error) {
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Failed to get channel state for ${channelId}`,
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
}
