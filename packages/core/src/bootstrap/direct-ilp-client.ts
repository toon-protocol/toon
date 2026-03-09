/**
 * Direct (in-process) client for sending ILP packets via a ConnectorNode.
 *
 * Unlike the HTTP-based createHttpIlpClient(), this factory wraps a
 * ConnectorNode's sendPacket() method as an IlpClient, enabling
 * zero-latency embedded mode without network overhead.
 */

import { createHash } from 'node:crypto';
import { BootstrapError } from './BootstrapService.js';
import type { IlpClient, IlpSendResult } from './types.js';

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
 *
 * Accepts both string discriminants ('fulfill'/'reject') for backward
 * compatibility with test mocks, and numeric PacketType enum values
 * (13 = FULFILL, 14 = REJECT) used by @crosstown/connector@1.6.0+.
 */
export type SendPacketResult =
  | { type: 'fulfill'; fulfillment: Uint8Array | Buffer; data?: Uint8Array | Buffer }
  | { type: 13; fulfillment: Uint8Array | Buffer; data?: Uint8Array | Buffer }
  | { type: 'reject'; code: string; message: string; data?: Uint8Array | Buffer }
  | { type: 14; code: string; message: string; data?: Uint8Array | Buffer };

/**
 * Structural interface matching ConnectorNode's sendPacket() method.
 *
 * Consumers pass a `@crosstown/connector` ConnectorNode instance without
 * needing to import `@crosstown/connector` as a dependency.
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
 * Creates an IlpClient that sends ILP packets by calling
 * `connector.sendPacket()` directly (no HTTP).
 *
 * @param connector - A ConnectorNode-like object with a sendPacket() method
 * @param config - Optional configuration (e.g., toonDecoder for condition computation)
 * @returns An IlpClient instance
 */
export function createDirectIlpClient(
  connector: ConnectorNodeLike,
  config?: DirectRuntimeClientConfig
): IlpClient {
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
          const fulfillment = createHash('sha256').update(decoded.id).digest();
          executionCondition = createHash('sha256')
            .update(fulfillment)
            .digest();
        }

        // Call connector.sendPacket()
        // expiresAt is required by ConnectorNode.sendPacket() even though the
        // interface marks it optional. Default to 30 seconds from now.
        const result = await connector.sendPacket({
          destination: params.destination,
          amount,
          data,
          executionCondition,
          expiresAt: new Date(Date.now() + 30000),
        });

        // Map result to IlpSendResult
        // ConnectorNode returns PacketType enum (13=FULFILL, 14=REJECT)
        if (result.type === 'fulfill' || result.type === 13) {
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
          error instanceof Error ? error : undefined
        );
      }
    },
  };
}

/**
 * @deprecated Use createDirectIlpClient instead
 */
export const createDirectRuntimeClient = createDirectIlpClient;
