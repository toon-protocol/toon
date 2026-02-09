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
import { negotiateSettlementChain, resolveTokenForChain } from './settlement.js';

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
    const supportedChains = request.supportedChains;

    if (!config || !channelClient || !supportedChains) {
      return;
    }

    // Negotiate chain
    const negotiatedChain = negotiateSettlementChain(
      supportedChains,
      config.ownSupportedChains,
      request.preferredTokens,
      config.ownPreferredTokens
    );

    if (negotiatedChain === null) {
      // No chain intersection — graceful degradation
      return;
    }

    // Resolve peer address from requester's settlement addresses
    const peerAddress = request.settlementAddresses?.[negotiatedChain];
    if (!peerAddress) {
      // Missing peer address — graceful degradation
      return;
    }

    // Resolve token
    const token = resolveTokenForChain(
      negotiatedChain,
      request.preferredTokens,
      config.ownPreferredTokens
    );

    // Derive peerId from sender pubkey
    const peerId = `nostr-${senderPubkey.slice(0, 16)}`;

    // Open channel via connector Admin API
    let channelId: string;
    try {
      const result = await channelClient.openChannel({
        peerId,
        chain: negotiatedChain,
        token,
        tokenNetwork: config.ownTokenNetworks?.[negotiatedChain],
        peerAddress,
        initialDeposit: config.initialDeposit ?? '0',
        settlementTimeout: config.settlementTimeout ?? 86400,
      });
      channelId = result.channelId;
    } catch {
      // Channel open failure — graceful degradation
      return;
    }

    // Poll for channel to become open
    const timeout = config.channelOpenTimeout ?? 30000;
    const pollInterval = config.pollInterval ?? 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const state = await channelClient.getChannelState(channelId);
        if (state.status === 'open') {
          // Channel is open — add settlement fields to response
          response.negotiatedChain = negotiatedChain;
          response.settlementAddress = config.ownSettlementAddresses[negotiatedChain];
          response.tokenAddress = token;
          response.tokenNetworkAddress = config.ownTokenNetworks?.[negotiatedChain];
          response.channelId = channelId;
          response.settlementTimeout = config.settlementTimeout ?? 86400;
          return;
        }
      } catch {
        // getChannelState error — graceful degradation
        return;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout — graceful degradation (no settlement fields added)
  }
}
