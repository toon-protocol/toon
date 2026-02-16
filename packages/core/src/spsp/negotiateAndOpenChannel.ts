/**
 * Shared settlement negotiation and channel opening logic.
 * Used by both NostrSpspServer (direct Nostr SPSP) and BLS /handle-packet (ILP-routed SPSP).
 */

import type {
  SpspRequest,
  ConnectorChannelClient,
  SettlementNegotiationConfig,
  SettlementNegotiationResult,
} from '../types.js';
import { negotiateSettlementChain, resolveTokenForChain } from './settlement.js';

/**
 * Parameters for the shared negotiation function.
 */
export interface NegotiateAndOpenChannelParams {
  /** The SPSP request containing settlement fields */
  request: SpspRequest;
  /** Settlement configuration for this node */
  config: SettlementNegotiationConfig;
  /** Channel client for opening payment channels */
  channelClient: ConnectorChannelClient;
  /** Nostr pubkey of the sender (used to derive peerId) */
  senderPubkey: string;
}

/**
 * Negotiates settlement chain, resolves token, opens a payment channel,
 * and polls until the channel is open or timeout.
 *
 * @returns SettlementNegotiationResult on success, null on graceful degradation
 *          (no chain intersection, missing peer address).
 * @throws On channel open failure or channel open timeout.
 */
export async function negotiateAndOpenChannel(
  params: NegotiateAndOpenChannelParams
): Promise<SettlementNegotiationResult | null> {
  const { request, config, channelClient, senderPubkey } = params;

  const supportedChains = request.supportedChains;
  if (!supportedChains) {
    return null;
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
    return null;
  }

  // Resolve peer address from requester's settlement addresses
  const peerAddress = request.settlementAddresses?.[negotiatedChain];
  if (!peerAddress) {
    // Missing peer address — graceful degradation
    return null;
  }

  // Resolve token
  const token = resolveTokenForChain(
    negotiatedChain,
    request.preferredTokens,
    config.ownPreferredTokens
  );

  // Derive peerId from sender pubkey
  const peerId = `nostr-${senderPubkey.slice(0, 16)}`;

  // Open channel via connector Admin API — propagate errors to caller
  const result = await channelClient.openChannel({
    peerId,
    chain: negotiatedChain,
    token,
    tokenNetwork: config.ownTokenNetworks?.[negotiatedChain],
    peerAddress,
    initialDeposit: config.initialDeposit ?? '0',
    settlementTimeout: config.settlementTimeout ?? 86400,
  });
  const channelId = result.channelId;

  // Poll for channel to become open
  const timeout = config.channelOpenTimeout ?? 30000;
  const pollInterval = config.pollInterval ?? 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const state = await channelClient.getChannelState(channelId);
    if (state.status === 'open') {
      return {
        negotiatedChain,
        settlementAddress: config.ownSettlementAddresses[negotiatedChain] ?? '',
        tokenAddress: token,
        tokenNetworkAddress: config.ownTokenNetworks?.[negotiatedChain],
        channelId,
        settlementTimeout: config.settlementTimeout ?? 86400,
      };
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout — throw so caller can decide how to handle
  throw new Error(`Channel ${channelId} did not reach open status within ${timeout}ms`);
}
