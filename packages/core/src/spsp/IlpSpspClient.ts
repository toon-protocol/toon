/**
 * ILP-based SPSP client that sends handshake requests as ILP packets
 * via agent-runtime's POST /ilp/send endpoint.
 *
 * Works for both bootstrap (0-amount) and post-bootstrap (paid) handshakes.
 */

import { SpspError, SpspTimeoutError } from '../errors.js';
import {
  buildSpspRequestEvent,
  parseSpspResponse,
  type SpspRequestSettlementInfo,
} from '../events/index.js';
import { PUBKEY_REGEX } from '../bootstrap/types.js';
import type { AgentRuntimeClient } from '../bootstrap/types.js';
import type { NostrEvent } from 'nostr-tools/pure';
import type { SpspInfo, SettlementNegotiationResult } from '../types.js';

/**
 * Configuration for IlpSpspClient.
 */
export interface IlpSpspClientConfig {
  /** Default timeout in ms (default: 30000, accounts for on-chain channel opening) */
  defaultTimeout?: number;
  /** TOON encoder: converts a Nostr event to TOON bytes (injected via DI) */
  toonEncoder: (event: NostrEvent) => Uint8Array;
  /** TOON decoder: converts TOON bytes back to a Nostr event (injected via DI) */
  toonDecoder: (bytes: Uint8Array) => NostrEvent;
}

/**
 * Options for a single requestSpspInfo call.
 */
export interface IlpSpspRequestOptions {
  /** ILP amount ('0' for bootstrap, calculated price for post-bootstrap) */
  amount?: string;
  /** Per-handshake timeout in ms */
  timeout?: number;
  /** Settlement preferences to include in the request */
  settlementInfo?: SpspRequestSettlementInfo;
}

/**
 * Client for sending SPSP requests as ILP packets via agent-runtime.
 * Supports both 0-amount bootstrap handshakes and paid post-bootstrap handshakes.
 */
export class IlpSpspClient {
  private readonly agentRuntimeClient: AgentRuntimeClient;
  private readonly secretKey: Uint8Array;
  private readonly defaultTimeout: number;
  private readonly toonEncoder: (event: NostrEvent) => Uint8Array;
  private readonly toonDecoder: (bytes: Uint8Array) => NostrEvent;

  constructor(
    agentRuntimeClient: AgentRuntimeClient,
    secretKey: Uint8Array,
    config: IlpSpspClientConfig
  ) {
    if (!config.toonEncoder) {
      throw new SpspError('toonEncoder is required in IlpSpspClient config');
    }
    if (!config.toonDecoder) {
      throw new SpspError('toonDecoder is required in IlpSpspClient config');
    }

    this.agentRuntimeClient = agentRuntimeClient;
    this.secretKey = secretKey;
    this.defaultTimeout = config.defaultTimeout ?? 30000;
    this.toonEncoder = config.toonEncoder;
    this.toonDecoder = config.toonDecoder;
  }

  /**
   * Request SPSP info from a peer by sending an ILP packet via agent-runtime.
   *
   * @param recipientPubkey - 64-char lowercase hex pubkey of the recipient
   * @param peerIlpAddress - ILP address of the peer (destination for the ILP packet)
   * @param options - Optional amount, timeout, and settlement preferences
   * @returns SpspInfo with optional settlement negotiation result
   */
  async requestSpspInfo(
    recipientPubkey: string,
    peerIlpAddress: string,
    options?: IlpSpspRequestOptions
  ): Promise<SpspInfo & { settlement?: SettlementNegotiationResult }> {
    // Validate recipient pubkey format
    if (!PUBKEY_REGEX.test(recipientPubkey)) {
      throw new SpspError(
        'Invalid recipientPubkey format: must be 64-character lowercase hex string'
      );
    }

    const amount = options?.amount ?? '0';
    const timeout = options?.timeout ?? this.defaultTimeout;

    // Build kind:23194 SPSP request event
    const { event: spspRequestEvent } = buildSpspRequestEvent(
      recipientPubkey,
      this.secretKey,
      options?.settlementInfo
    );

    // TOON-encode the event
    const toonBytes = this.toonEncoder(spspRequestEvent);
    const base64Toon = Buffer.from(toonBytes).toString('base64');

    // Attempt to send with one retry on timeout/network errors
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ilpResult = await this.agentRuntimeClient.sendIlpPacket({
          destination: peerIlpAddress,
          amount,
          data: base64Toon,
          timeout,
        });

        // Explicit REJECT — throw immediately, no retry
        if (!ilpResult.accepted) {
          throw new SpspError(
            `SPSP handshake rejected: ${ilpResult.code ?? 'unknown'} ${ilpResult.message ?? 'no message'}`
          );
        }

        // FULFILL — decode response
        return this.decodeFulfillResponse(ilpResult.data, recipientPubkey);
      } catch (error) {
        // If it's an SpspError (explicit REJECT or decode failure), throw immediately
        if (error instanceof SpspError) {
          throw error;
        }

        // Network/timeout error — retry once
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === 0) {
          console.warn(
            `[IlpSpspClient] Timeout/network error sending SPSP request to ${recipientPubkey.slice(0, 16)}..., retrying`
          );
        }
      }
    }

    // Retry exhausted
    throw new SpspTimeoutError(
      `SPSP request timed out after retry for ${recipientPubkey.slice(0, 16)}...`,
      recipientPubkey,
      lastError
    );
  }

  /**
   * Decode FULFILL response data: base64 -> TOON -> Nostr event -> parseSpspResponse.
   */
  private decodeFulfillResponse(
    data: string | undefined,
    recipientPubkey: string
  ): SpspInfo & { settlement?: SettlementNegotiationResult } {
    if (!data) {
      throw new SpspError('FULFILL response missing data field');
    }

    let responseEvent: NostrEvent;
    try {
      const responseBytes = Uint8Array.from(Buffer.from(data, 'base64'));
      responseEvent = this.toonDecoder(responseBytes);
    } catch (error) {
      throw new SpspError(
        'Failed to decode TOON response data',
        error instanceof Error ? error : undefined
      );
    }

    let spspResponse;
    try {
      spspResponse = parseSpspResponse(
        responseEvent,
        this.secretKey,
        recipientPubkey
      );
    } catch (error) {
      throw new SpspError(
        'Failed to parse SPSP response',
        error instanceof Error ? error : undefined
      );
    }

    const result: SpspInfo & { settlement?: SettlementNegotiationResult } = {
      destinationAccount: spspResponse.destinationAccount,
      sharedSecret: spspResponse.sharedSecret,
    };

    // Include settlement result if present
    if (spspResponse.negotiatedChain && spspResponse.settlementAddress) {
      result.settlement = {
        negotiatedChain: spspResponse.negotiatedChain,
        settlementAddress: spspResponse.settlementAddress,
        tokenAddress: spspResponse.tokenAddress,
        tokenNetworkAddress: spspResponse.tokenNetworkAddress,
        channelId: spspResponse.channelId,
        settlementTimeout: spspResponse.settlementTimeout,
      };
    }

    return result;
  }
}
