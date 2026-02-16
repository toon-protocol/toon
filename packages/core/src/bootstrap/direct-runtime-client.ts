/**
 * Direct (in-process) client for sending ILP packets via a ConnectorNode.
 *
 * Unlike the HTTP-based createAgentRuntimeClient(), this factory wraps a
 * ConnectorNode's sendPacket() method as an AgentRuntimeClient, enabling
 * zero-latency embedded mode without network overhead.
 */

import { createHash } from 'node:crypto';
import { BootstrapError } from './BootstrapService.js';
import type { AgentRuntimeClient, IlpSendResult } from './types.js';

/**
 * Parameters accepted by ConnectorNode.sendPacket().
 */
export interface SendPacketParams {
  /** ILP destination address */
  destination: string;
  /** Amount as BigInt (not string) */
  amount: bigint;
  /** Binary data (not base64 string) */
  data: Uint8Array;
  /** 32-byte SHA-256 execution condition */
  executionCondition?: Uint8Array;
  /**
   * Packet expiration. Included for structural compatibility with ConnectorNode
   * but is not set by the direct client — callers or the connector provide it
   * if needed.
   */
  expiresAt?: Date;
}

/**
 * Result returned by ConnectorNode.sendPacket().
 */
export type SendPacketResult =
  | { type: 'fulfill'; fulfillment: Uint8Array; data?: Uint8Array }
  | { type: 'reject'; code: string; message: string; data?: Uint8Array };

/**
 * Structural interface matching ConnectorNode's sendPacket() method.
 *
 * Consumers pass an `@agent-runtime/connector` ConnectorNode instance without
 * agent-society needing to import `@agent-runtime/connector` as a dependency.
 * TypeScript's structural type system handles compatibility automatically.
 */
export interface ConnectorNodeLike {
  sendPacket(params: SendPacketParams): Promise<SendPacketResult>;
}

/**
 * Configuration options for the direct runtime client.
 */
export interface DirectRuntimeClientConfig {
  /**
   * Optional callback for extracting the Nostr event ID from TOON-encoded data.
   *
   * When provided, the client computes
   * `executionCondition = SHA256(SHA256(event.id))` and passes it to
   * `sendPacket()`.
   *
   * When omitted, no executionCondition is set (connector uses its default).
   *
   * Note: this is intentionally a narrower type than
   * `BootstrapServiceConfig.toonDecoder` (which returns a full `NostrEvent`).
   * Only the `id` field is needed for condition computation, so the interface
   * is minimal.
   */
  toonDecoder?: (bytes: Uint8Array) => { id: string };
}

/**
 * Creates an AgentRuntimeClient that sends ILP packets by calling
 * `connector.sendPacket()` directly (no HTTP).
 *
 * @param connector - A ConnectorNode-like object with a sendPacket() method
 * @param config - Optional configuration (e.g., toonDecoder for condition computation)
 * @returns An AgentRuntimeClient instance
 */
export function createDirectRuntimeClient(
  connector: ConnectorNodeLike,
  config?: DirectRuntimeClientConfig,
): AgentRuntimeClient {
  return {
    async sendIlpPacket(params: {
      destination: string;
      amount: string;
      data: string;
      timeout?: number;
    }): Promise<IlpSendResult> {
      try {
        // Convert string amount to BigInt
        const amount = BigInt(params.amount);

        // Convert base64 data to Uint8Array
        const data = Uint8Array.from(Buffer.from(params.data, 'base64'));

        // Compute execution condition if toonDecoder is provided
        let executionCondition: Uint8Array | undefined;
        if (config?.toonDecoder) {
          const decoded = config.toonDecoder(data);
          const fulfillment = createHash('sha256')
            .update(decoded.id)
            .digest();
          executionCondition = createHash('sha256')
            .update(fulfillment)
            .digest();
        }

        // Call connector.sendPacket()
        const result = await connector.sendPacket({
          destination: params.destination,
          amount,
          data,
          executionCondition,
        });

        // Map result to IlpSendResult
        if (result.type === 'fulfill') {
          return {
            accepted: true,
            fulfillment: Buffer.from(result.fulfillment).toString('base64'),
            data: result.data
              ? Buffer.from(result.data).toString('base64')
              : undefined,
          };
        }

        // Reject
        return {
          accepted: false,
          code: result.code,
          message: result.message,
          data: result.data
            ? Buffer.from(result.data).toString('base64')
            : undefined,
        };
      } catch (error) {
        if (error instanceof BootstrapError) {
          throw error;
        }
        throw new BootstrapError(
          `Direct ILP packet send failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
}
