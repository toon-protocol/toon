/**
 * Direct (in-process) client for sending ILP packets via a ConnectorNode.
 *
 * Unlike the HTTP-based createHttpIlpClient(), this factory wraps a
 * ConnectorNode's sendPacket() method as an IlpClient, enabling
 * zero-latency embedded mode without network overhead.
 */

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
  data?: Uint8Array;
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
 * (13 = FULFILL, 14 = REJECT) used by @toon-protocol/connector@2.0.0+.
 */
export type SendPacketResult =
  | {
      type: 'fulfill';
      data?: Uint8Array | Buffer;
    }
  | { type: 13; data?: Uint8Array | Buffer }
  | {
      type: 'reject';
      code: string;
      message: string;
      data?: Uint8Array | Buffer;
    }
  | { type: 14; code: string; message: string; data?: Uint8Array | Buffer };

/**
 * Structural interface matching ConnectorNode's sendPacket() method.
 *
 * Consumers pass a `@toon-protocol/connector` ConnectorNode instance without
 * needing to import `@toon-protocol/connector` as a dependency.
 * TypeScript's structural type system handles compatibility automatically.
 */
export interface ConnectorNodeLike {
  sendPacket(params: SendPacketParams): Promise<SendPacketResult>;
}

/**
 * @deprecated No longer used. Kept for backward compatibility.
 */
export interface DirectRuntimeClientConfig {
  /** @deprecated No longer used. */
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
  _config?: DirectRuntimeClientConfig
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

        // Call connector.sendPacket()
        // expiresAt is required by ConnectorNode.sendPacket() even though the
        // interface marks it optional. Default to 30 seconds from now.
        const result = await connector.sendPacket({
          destination: params.destination,
          amount,
          data,
          expiresAt: new Date(Date.now() + 30000),
        });

        // Map result to IlpSendResult
        // ConnectorNode returns PacketType enum (13=FULFILL, 14=REJECT)
        if (result.type === 'fulfill' || result.type === 13) {
          return {
            accepted: true,
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
