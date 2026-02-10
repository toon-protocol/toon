/**
 * SPSP server for handling encrypted SPSP requests via Nostr.
 */

import { SimplePool, type SubCloser } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { SPSP_REQUEST_KIND } from '../constants.js';
import { buildSpspResponseEvent, parseSpspRequest } from '../events/index.js';
import type {
  SpspInfo,
  Subscription,
  SpspResponse,
  SpspRequest,
  ConnectorChannelClient,
  SettlementNegotiationConfig,
} from '../types.js';
import { negotiateAndOpenChannel } from './negotiateAndOpenChannel.js';

/**
 * Server for handling encrypted SPSP requests via NIP-44 encrypted Nostr messages.
 */
export class NostrSpspServer {
  private readonly relayUrls: string[];
  private readonly secretKey: Uint8Array;
  private readonly pool: SimplePool;
  private readonly settlementConfig?: SettlementNegotiationConfig;
  private readonly channelClient?: ConnectorChannelClient;

  /**
   * Creates a new NostrSpspServer instance.
   *
   * @param relayUrls - Array of relay WebSocket URLs to publish to
   * @param secretKey - The 32-byte secret key for signing events
   * @param pool - Optional SimplePool instance (creates new one if not provided)
   * @param settlementConfig - Optional settlement negotiation configuration
   * @param channelClient - Optional connector channel client for opening payment channels
   */
  constructor(
    relayUrls: string[],
    secretKey: Uint8Array,
    pool?: SimplePool,
    settlementConfig?: SettlementNegotiationConfig,
    channelClient?: ConnectorChannelClient
  ) {
    this.relayUrls = relayUrls;
    this.secretKey = secretKey;
    this.pool = pool ?? new SimplePool();
    this.settlementConfig = settlementConfig;
    this.channelClient = channelClient;
  }

  /**
   * Handles incoming SPSP requests and responds with fresh parameters.
   *
   * Subscribes to kind:23194 events addressed to this server's pubkey.
   * For each incoming request, calls the generator function to produce
   * fresh SpspInfo, then sends an encrypted response.
   *
   * @param generator - Function that produces fresh SpspInfo for each request
   * @returns A Subscription object with unsubscribe() method to stop handling requests
   */
  handleSpspRequests(
    generator: () => SpspInfo | Promise<SpspInfo>
  ): Subscription {
    const myPubkey = getPublicKey(this.secretKey);

    const filter: Filter = {
      kinds: [SPSP_REQUEST_KIND],
      '#p': [myPubkey],
    };

    const sub: SubCloser = this.pool.subscribeMany(this.relayUrls, filter, {
      onevent: (event) => {
        // Handle each request in a non-throwing way
        this.processRequest(event, generator).catch(() => {
          // Silently ignore all errors - never throw from subscription callback
        });
      },
    });

    return {
      unsubscribe: () => {
        sub.close();
      },
    };
  }

  /**
   * Processes a single SPSP request event.
   * All errors are caught and logged silently.
   */
  private async processRequest(
    event: { id: string; pubkey: string; kind: number; content: string; tags: string[][]; created_at: number; sig: string },
    generator: () => SpspInfo | Promise<SpspInfo>
  ): Promise<void> {
    // Extract sender pubkey from event
    const senderPubkey = event.pubkey;

    // Decrypt and parse request
    let request: SpspRequest;
    try {
      request = parseSpspRequest(event, this.secretKey, senderPubkey);
    } catch {
      // Invalid request - silently ignore
      return;
    }

    // Call generator to get fresh SpspInfo
    let spspInfo: SpspInfo;
    try {
      spspInfo = await Promise.resolve(generator());
    } catch {
      // Generator error - silently ignore
      return;
    }

    // Build response
    const response: SpspResponse = {
      requestId: request.requestId,
      destinationAccount: spspInfo.destinationAccount,
      sharedSecret: spspInfo.sharedSecret,
    };

    // Attempt settlement negotiation if enabled
    if (this.settlementConfig && this.channelClient && request.supportedChains) {
      await this.negotiateSettlement(request, senderPubkey, response);
    }

    // Build and publish encrypted response event
    const responseEvent = buildSpspResponseEvent(
      response,
      senderPubkey,
      this.secretKey,
      event.id
    );

    try {
      const publishPromises = this.pool.publish(this.relayUrls, responseEvent);
      await Promise.any(publishPromises);
    } catch {
      // Publish error - silently ignore
      return;
    }
  }

  /**
   * Performs settlement negotiation and mutates the response with settlement fields on success.
   * On any failure, the response is left unchanged (graceful degradation).
   */
  private async negotiateSettlement(
    request: SpspRequest,
    senderPubkey: string,
    response: SpspResponse
  ): Promise<void> {
    const config = this.settlementConfig;
    const channelClient = this.channelClient;

    if (!config || !channelClient || !request.supportedChains) {
      return;
    }

    try {
      const result = await negotiateAndOpenChannel({
        request,
        config,
        channelClient,
        senderPubkey,
      });

      if (result) {
        response.negotiatedChain = result.negotiatedChain;
        response.settlementAddress = result.settlementAddress;
        response.tokenAddress = result.tokenAddress;
        response.tokenNetworkAddress = result.tokenNetworkAddress;
        response.channelId = result.channelId;
        response.settlementTimeout = result.settlementTimeout;
      }
    } catch {
      // Any error — graceful degradation (no settlement fields added)
    }
  }
}
