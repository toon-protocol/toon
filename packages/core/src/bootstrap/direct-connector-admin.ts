import { BootstrapError } from './BootstrapService.js';
import type { ConnectorAdminClient } from './types.js';

/**
 * Parameters for registering a peer on the connector.
 * Maps to ConnectorNode.registerPeer() params in @agent-runtime/connector.
 */
export interface RegisterPeerParams {
  id: string;
  url: string;
  authToken?: string;
  routes?: { prefix: string; priority?: number }[];
  settlement?: Record<string, unknown>;
}

/**
 * Structural interface for ConnectorNode admin methods.
 *
 * This is a structural interface — consumers pass an `@agent-runtime/connector`
 * ConnectorNode instance without importing it as a dependency. The ConnectorNode's
 * `registerPeer()` and `removePeer()` methods match this shape, allowing
 * zero-dependency coupling for embedded mode.
 */
export interface ConnectorAdminLike {
  registerPeer(params: RegisterPeerParams): Promise<void>;
  removePeer(peerId: string): Promise<void>;
}

/**
 * Creates a ConnectorAdminClient that calls ConnectorNode methods directly
 * instead of making HTTP requests.
 *
 * Used for embedded mode where the ConnectorNode runs in-process.
 * The returned client conforms to the ConnectorAdminClient interface,
 * making it a drop-in replacement for the HTTP-based admin client.
 *
 * @param connector - A ConnectorNode instance (or any object matching ConnectorAdminLike)
 * @returns A ConnectorAdminClient that manages peers via direct function calls
 *
 * @example
 * ```typescript
 * import { ConnectorNode } from '@agent-runtime/connector';
 * import { createDirectConnectorAdmin } from '@crosstown/core/bootstrap';
 *
 * const connector = new ConnectorNode({ ... });
 * const adminClient = createDirectConnectorAdmin(connector);
 *
 * await adminClient.addPeer({
 *   id: 'peer1',
 *   url: 'btp+ws://peer1.example.com',
 *   authToken: 'secret',
 *   routes: [{ prefix: 'g.alice', priority: 1 }],
 * });
 * ```
 */
export function createDirectConnectorAdmin(
  connector: ConnectorAdminLike
): ConnectorAdminClient {
  return {
    async addPeer(config) {
      try {
        await connector.registerPeer({
          id: config.id,
          url: config.url,
          authToken: config.authToken,
          routes: config.routes,
          settlement: config.settlement,
        });
      } catch (error) {
        // Re-throw BootstrapError as-is; wrap other errors
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Failed to register peer ${config.id}`,
          error instanceof Error ? error : undefined
        );
      }
    },

    async removePeer(peerId) {
      try {
        await connector.removePeer(peerId);
      } catch (error) {
        // Re-throw BootstrapError as-is; wrap other errors
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Failed to remove peer ${peerId}`,
          error instanceof Error ? error : undefined
        );
      }
    },
  };
}
