/**
 * SPSP client for querying peer SPSP parameters via Nostr.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import { getPublicKey } from 'nostr-tools/pure';
import { SpspError, SpspTimeoutError, InvalidEventError } from '../errors.js';
import { parseSpspInfo, parseSpspResponse, buildSpspRequestEvent } from '../events/index.js';
import { SPSP_INFO_KIND, SPSP_RESPONSE_KIND } from '../constants.js';
import type { SpspInfo } from '../types.js';

/** Regular expression for validating 64-character lowercase hex pubkeys */
const PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/**
 * Client for querying SPSP parameters published via Nostr kind:10047 events.
 * Supports both static queries (getSpspInfo) and dynamic requests (requestSpspInfo).
 */
export class NostrSpspClient {
  private readonly relayUrls: string[];
  private readonly pool: SimplePool;
  private readonly secretKey?: Uint8Array;
  private readonly pubkey?: string;

  /**
   * Creates a new NostrSpspClient instance.
   *
   * @param relayUrls - Array of relay WebSocket URLs to query
   * @param pool - Optional SimplePool instance (creates new one if not provided)
   * @param secretKey - Optional secret key for sending encrypted SPSP requests
   */
  constructor(relayUrls: string[], pool?: SimplePool, secretKey?: Uint8Array) {
    this.relayUrls = relayUrls;
    this.pool = pool ?? new SimplePool();
    this.secretKey = secretKey;
    if (secretKey) {
      this.pubkey = getPublicKey(secretKey);
    }
  }

  /**
   * Retrieves SPSP parameters for a given pubkey.
   *
   * Queries kind:10047 events from configured relays and returns the parsed
   * SPSP info from the most recent event.
   *
   * @param pubkey - The 64-character hex pubkey to get SPSP info for
   * @returns SpspInfo if found, null if no valid SPSP info exists
   * @throws SpspError if pubkey format is invalid or relay query fails
   */
  async getSpspInfo(pubkey: string): Promise<SpspInfo | null> {
    if (!PUBKEY_REGEX.test(pubkey)) {
      throw new SpspError(
        'Invalid pubkey format: must be 64-character lowercase hex string'
      );
    }

    const filter: Filter = {
      kinds: [SPSP_INFO_KIND],
      authors: [pubkey],
    };

    let events;
    try {
      events = await this.pool.querySync(this.relayUrls, filter);
    } catch (error) {
      throw new SpspError(
        'Failed to query relays for SPSP info',
        error instanceof Error ? error : undefined
      );
    }

    if (events.length === 0) {
      return null;
    }

    // Sort by created_at descending and use the most recent
    const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
    const mostRecent = sortedEvents[0];

    // This should never happen since we check length above, but TypeScript needs it
    if (!mostRecent) {
      return null;
    }

    try {
      return parseSpspInfo(mostRecent);
    } catch (error) {
      if (error instanceof InvalidEventError) {
        // Malformed event = no valid SPSP info
        return null;
      }
      throw new SpspError(
        'Failed to parse SPSP info',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Requests fresh SPSP parameters from a peer via encrypted Nostr messages.
   *
   * Sends a kind:23194 encrypted SPSP request and waits for a kind:23195 response.
   * This enables dynamic SPSP handshakes where the recipient generates unique
   * payment parameters for each request.
   *
   * @param recipientPubkey - The 64-character hex pubkey of the recipient
   * @param options - Optional configuration
   * @param options.timeout - Timeout in milliseconds (default: 10000)
   * @returns SpspInfo with fresh destination account and shared secret
   * @throws SpspError if secret key not provided, invalid pubkey, or publish fails
   * @throws SpspTimeoutError if no response received within timeout
   */
  async requestSpspInfo(
    recipientPubkey: string,
    options?: { timeout?: number }
  ): Promise<SpspInfo> {
    const timeout = options?.timeout ?? 10000;

    // Validate secret key is provided
    if (!this.secretKey || !this.pubkey) {
      throw new SpspError(
        'Secret key required for requestSpspInfo. Provide secretKey in constructor.'
      );
    }

    // Validate recipient pubkey format
    if (!PUBKEY_REGEX.test(recipientPubkey)) {
      throw new SpspError(
        'Invalid recipientPubkey format: must be 64-character lowercase hex string'
      );
    }

    // Build the encrypted request event
    const { event, requestId } = buildSpspRequestEvent(recipientPubkey, this.secretKey);

    // Publish request to relays
    try {
      const publishPromises = this.relayUrls.map((url) =>
        this.pool.publish([url], event)
      );
      await Promise.any(publishPromises);
    } catch (error) {
      throw new SpspError(
        'Failed to publish SPSP request to relays',
        error instanceof Error ? error : undefined
      );
    }

    // Set up response subscription and timeout
    const myPubkey = this.pubkey;
    const mySecretKey = this.secretKey;

    return new Promise<SpspInfo>((resolve, reject) => {
      let resolved = false;

      // Subscribe for kind:23195 events tagged with our pubkey
      const filter: Filter = {
        kinds: [SPSP_RESPONSE_KIND],
        '#p': [myPubkey],
        since: Math.floor(Date.now() / 1000) - 5,
      };

      const sub = this.pool.subscribeMany(this.relayUrls, filter, {
        onevent: (responseEvent) => {
          if (resolved) return;

          try {
            // Parse and decrypt the response
            const response = parseSpspResponse(
              responseEvent,
              mySecretKey,
              responseEvent.pubkey
            );

            // Verify requestId matches
            if (response.requestId !== requestId) {
              // Not our response, ignore
              return;
            }

            // Success - clean up and resolve
            resolved = true;
            clearTimeout(timeoutId);
            sub.close();

            resolve({
              destinationAccount: response.destinationAccount,
              sharedSecret: response.sharedSecret,
            });
          } catch {
            // Invalid response, ignore and continue waiting
          }
        },
      });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (resolved) return;

        resolved = true;
        sub.close();

        reject(
          new SpspTimeoutError(
            `SPSP request timed out after ${timeout}ms waiting for response from ${recipientPubkey}`,
            recipientPubkey
          )
        );
      }, timeout);
    });
  }
}
