/**
 * HTTP-based client for connector admin operations.
 *
 * Calls the connector's Admin API over HTTP to register/remove peers.
 */

import { BootstrapError } from './BootstrapService.js';
import type { ConnectorAdminClient } from './types.js';

/**
 * Creates a ConnectorAdminClient that calls the Connector Admin API via HTTP.
 *
 * @param adminUrl - Base URL of the connector admin API (e.g., "http://connector:8081")
 * @param btpSecret - Shared secret for BTP authentication
 * @returns A ConnectorAdminClient that manages peers via HTTP
 *
 * @example
 * ```typescript
 * const adminClient = createHttpConnectorAdmin('http://localhost:8091', 'secret');
 *
 * await adminClient.addPeer({
 *   id: 'peer2',
 *   url: 'ws://connector-peer2:3000',
 *   authToken: JSON.stringify({ peerId: 'peer2', secret: 'secret' }),
 *   routes: [{ prefix: 'g.crosstown.peer2', priority: 0 }],
 *   settlement: {
 *     preference: 'evm',
 *     evmAddress: '0x...',
 *     chainId: 31337,
 *   },
 * });
 * ```
 */
export function createHttpConnectorAdmin(
  adminUrl: string,
  btpSecret: string,
): ConnectorAdminClient {
  const baseUrl = adminUrl.replace(/\/$/, ''); // Remove trailing slash

  return {
    async addPeer(config) {
      try {
        const payload = {
          id: config.id,
          url: config.url,
          authToken: config.authToken || JSON.stringify({
            peerId: config.id,
            secret: btpSecret,
          }),
          routes: config.routes,
          settlement: config.settlement,
        };

        const response = await fetch(`${baseUrl}/admin/peers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        // Success - peer registered
      } catch (error) {
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Failed to register peer ${config.id} via HTTP`,
          error instanceof Error ? error : undefined
        );
      }
    },

    async removePeer(peerId) {
      try {
        const response = await fetch(`${baseUrl}/admin/peers/${peerId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        // Success - peer removed
      } catch (error) {
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Failed to remove peer ${peerId} via HTTP`,
          error instanceof Error ? error : undefined
        );
      }
    },
  };
}
