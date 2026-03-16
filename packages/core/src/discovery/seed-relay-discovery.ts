/**
 * Seed Relay Discovery -- discovers peers via kind:10036 seed relay list events.
 *
 * Uses raw `ws` WebSocket connections to avoid the `ReferenceError: window is
 * not defined` issue that occurs with nostr-tools pool utilities in Node.js
 * containers.
 *
 * Discovery flow:
 *   1. Connect to public Nostr relays and query for kind:10036 events.
 *   2. Parse seed relay entries from kind:10036 event content.
 *   3. Connect to seed relays sequentially (fallback on failure).
 *   4. Subscribe to kind:10032 on the first connected seed relay.
 *   5. Return discovered peers as IlpPeerInfo[].
 */

import WebSocket from 'ws';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { PeerDiscoveryError } from '../errors.js';
import { SEED_RELAY_LIST_KIND, ILP_PEER_INFO_KIND } from '../constants.js';
import {
  parseSeedRelayList,
  buildSeedRelayListEvent,
} from '../events/seed-relay.js';
import { parseIlpPeerInfo } from '../events/parsers.js';
import type { IlpPeerInfo } from '../types.js';
import type { SeedRelayEntry } from '../events/seed-relay.js';

// Re-export types for consumer convenience
export type { SeedRelayEntry } from '../events/seed-relay.js';

// ---------- Types ----------

/** Configuration for seed relay discovery. */
export interface SeedRelayDiscoveryConfig {
  /** Public Nostr relay URLs to query for kind:10036 events. */
  publicRelays: string[];
  /** Timeout for relay connections in ms (default: 10000). */
  connectionTimeout?: number;
  /** Timeout for kind:10036 queries in ms (default: 5000). */
  queryTimeout?: number;
}

/** Result of seed relay discovery. */
export interface SeedRelayDiscoveryResult {
  /** Number of seed relays successfully connected to. */
  seedRelaysConnected: number;
  /** Total seed relays attempted. */
  attemptedSeeds: number;
  /** WebSocket URLs of connected seed relays. */
  connectedUrls: string[];
  /** Peers discovered via kind:10032 from seed relays. */
  discoveredPeers: IlpPeerInfo[];
}

/** Configuration for publishing a seed relay entry. */
export interface PublishSeedRelayConfig {
  /** Secret key for signing the event. */
  secretKey: Uint8Array;
  /** This node's WebSocket relay URL (e.g., wss://my-relay.example.com). */
  relayUrl: string;
  /** Public Nostr relay URLs to publish to. */
  publicRelays: string[];
  /** Optional metadata. */
  metadata?: SeedRelayEntry['metadata'];
}

// ---------- Constants ----------

/** Default connection timeout for publish operations (ms). */
const DEFAULT_PUBLISH_CONNECTION_TIMEOUT = 10000;

/** Default timeout for waiting for OK acknowledgment on publish (ms). */
const DEFAULT_PUBLISH_OK_TIMEOUT = 5000;

// ---------- Helpers ----------

/**
 * Generate a random subscription ID for Nostr protocol REQ messages.
 */
function generateSubId(): string {
  return `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Connect to a WebSocket URL with a timeout.
 * Returns the connected WebSocket or throws on failure.
 */
function connectWebSocket(url: string, timeout: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection timeout after ${timeout}ms: ${url}`));
    }, timeout);

    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`WebSocket error connecting to ${url}: ${err.message}`));
    });
  });
}

/**
 * Subscribe to a Nostr relay and collect events matching a filter.
 * Returns collected events when EOSE is received or timeout expires.
 */
function subscribeAndCollect(
  ws: WebSocket,
  filter: Record<string, unknown>,
  timeout: number
): Promise<NostrEvent[]> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    const subId = generateSubId();
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      ws.removeListener('message', messageHandler);
    };

    const messageHandler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(String(data)) as unknown[];
        if (!Array.isArray(msg)) return;

        const msgType = msg[0];

        if (msgType === 'EVENT' && msg[1] === subId && msg[2]) {
          events.push(msg[2] as NostrEvent);
        }

        if (msgType === 'EOSE' && msg[1] === subId) {
          clearTimeout(timer);
          cleanup();
          // Send CLOSE to clean up subscription on the relay
          try {
            ws.send(JSON.stringify(['CLOSE', subId]));
          } catch {
            // Ignore send errors during cleanup
          }
          resolve(events);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      // Send CLOSE to clean up subscription
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
      } catch {
        // Ignore send errors during cleanup
      }
      resolve(events);
    }, timeout);

    ws.on('message', messageHandler);

    // Send the REQ
    ws.send(JSON.stringify(['REQ', subId, filter]));
  });
}

// ---------- SeedRelayDiscovery ----------

/**
 * Discovers peers via the seed relay list model.
 *
 * Queries public Nostr relays for kind:10036 events, parses seed relay
 * entries, connects to seed relays, and subscribes to kind:10032 events
 * to discover network peers.
 */
export class SeedRelayDiscovery {
  private readonly config: SeedRelayDiscoveryConfig;
  private readonly connectionTimeout: number;
  private readonly queryTimeout: number;
  private readonly openSockets: WebSocket[] = [];

  constructor(config: SeedRelayDiscoveryConfig) {
    this.config = config;
    this.connectionTimeout = config.connectionTimeout ?? 10000;
    this.queryTimeout = config.queryTimeout ?? 5000;
  }

  /**
   * Discover peers via seed relay list.
   *
   * 1. Query publicRelays for kind:10036 events
   * 2. Parse seed relay entries
   * 3. Connect to seed relays sequentially (fallback on failure)
   * 4. Subscribe to kind:10032 on connected seed relay
   * 5. Return discovered peers
   *
   * @throws PeerDiscoveryError if all seed relays are exhausted
   */
  async discover(): Promise<SeedRelayDiscoveryResult> {
    // Step 1: Query public relays for kind:10036 events
    const seedRelayEntries = await this.querySeedRelayLists();

    if (seedRelayEntries.length === 0) {
      throw new PeerDiscoveryError(
        'All seed relays exhausted -- unable to bootstrap. ' +
          `Tried 0 seed relays from 0 kind:10036 events. ` +
          `Queried ${this.config.publicRelays.length} public relay(s).`
      );
    }

    // Step 2: Deduplicate seed entries by URL
    const uniqueEntries = this.deduplicateByUrl(seedRelayEntries);

    // Step 3: Try connecting to seed relays sequentially
    let connectedSocket: WebSocket | undefined;
    let connectedUrl = '';
    let attemptedSeeds = 0;

    for (const entry of uniqueEntries) {
      attemptedSeeds++;
      try {
        const ws = await connectWebSocket(entry.url, this.connectionTimeout);
        connectedSocket = ws;
        connectedUrl = entry.url;
        this.openSockets.push(ws);
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.warn(
          `[SeedRelayDiscovery] Failed to connect to seed relay ${entry.url}: ${msg}`
        );
      }
    }

    if (!connectedSocket) {
      throw new PeerDiscoveryError(
        'All seed relays exhausted -- unable to bootstrap. ' +
          `Tried ${attemptedSeeds} seed relays from ${seedRelayEntries.length} kind:10036 events.`
      );
    }

    // Step 4: Subscribe to kind:10032 on the connected seed relay
    const peerEvents = await subscribeAndCollect(
      connectedSocket,
      { kinds: [ILP_PEER_INFO_KIND] },
      this.queryTimeout
    );

    // Step 5: Parse kind:10032 events into IlpPeerInfo[]
    const discoveredPeers: IlpPeerInfo[] = [];
    for (const event of peerEvents) {
      try {
        // Verify event signature before trusting content (CWE-345)
        if (!verifyEvent(event)) {
          console.warn(
            `[SeedRelayDiscovery] Skipping kind:10032 event with invalid signature: ${event.id}`
          );
          continue;
        }
        const info = parseIlpPeerInfo(event);
        // Set pubkey from the event's outer pubkey field
        // (parseIlpPeerInfo does NOT populate pubkey from event content)
        info.pubkey = event.pubkey;
        discoveredPeers.push(info);
      } catch {
        // Skip malformed kind:10032 events
      }
    }

    return {
      seedRelaysConnected: 1,
      attemptedSeeds,
      connectedUrls: [connectedUrl],
      discoveredPeers,
    };
  }

  /**
   * Stop discovery and close all open WebSocket connections.
   */
  async close(): Promise<void> {
    for (const ws of this.openSockets) {
      try {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      } catch {
        // Ignore close errors
      }
    }
    this.openSockets.length = 0;
  }

  /**
   * Query public relays for kind:10036 events and parse seed relay entries.
   */
  private async querySeedRelayLists(): Promise<SeedRelayEntry[]> {
    const allEntries: SeedRelayEntry[] = [];

    for (const relayUrl of this.config.publicRelays) {
      try {
        const ws = await connectWebSocket(relayUrl, this.connectionTimeout);
        this.openSockets.push(ws);

        const events = await subscribeAndCollect(
          ws,
          { kinds: [SEED_RELAY_LIST_KIND] },
          this.queryTimeout
        );

        for (const event of events) {
          // Verify event signature before trusting content (CWE-345:
          // Insufficient Verification of Data Authenticity)
          if (!verifyEvent(event)) {
            console.warn(
              `[SeedRelayDiscovery] Skipping kind:10036 event with invalid signature: ${event.id}`
            );
            continue;
          }
          const entries = parseSeedRelayList(event);
          allEntries.push(...entries);
        }

        // Close connection to public relay after querying and remove
        // from tracked sockets (already closed, no need for close() cleanup)
        ws.close();
        const idx = this.openSockets.indexOf(ws);
        if (idx !== -1) {
          this.openSockets.splice(idx, 1);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.warn(
          `[SeedRelayDiscovery] Failed to query public relay ${relayUrl}: ${msg}`
        );
      }
    }

    return allEntries;
  }

  /**
   * Deduplicate seed relay entries by URL, keeping the first occurrence.
   */
  private deduplicateByUrl(entries: SeedRelayEntry[]): SeedRelayEntry[] {
    const seen = new Set<string>();
    const unique: SeedRelayEntry[] = [];

    for (const entry of entries) {
      if (!seen.has(entry.url)) {
        seen.add(entry.url);
        unique.push(entry);
      }
    }

    return unique;
  }
}

// ---------- publishSeedRelayEntry ----------

/**
 * Publish a kind:10036 event advertising this node as a seed relay.
 * Connects to each publicRelay and publishes the event.
 * Returns the number of relays the event was published to.
 *
 * @param config - Configuration for publishing the seed relay entry.
 * @returns The count of successful publishes and the event ID.
 */
export async function publishSeedRelayEntry(
  config: PublishSeedRelayConfig
): Promise<{ publishedTo: number; eventId: string }> {
  const pubkey = getPublicKey(config.secretKey);

  const entry: SeedRelayEntry = {
    url: config.relayUrl,
    pubkey,
    ...(config.metadata && { metadata: config.metadata }),
  };

  const event = buildSeedRelayListEvent(config.secretKey, [entry]);
  let publishedTo = 0;

  for (const relayUrl of config.publicRelays) {
    try {
      const ws = await connectWebSocket(
        relayUrl,
        DEFAULT_PUBLISH_CONNECTION_TIMEOUT
      );

      // Publish the event
      const published = await new Promise<boolean>((resolve) => {
        let settled = false;

        const cleanup = () => {
          if (settled) return;
          settled = true;
          ws.removeListener('message', messageHandler);
        };

        const timer = setTimeout(() => {
          cleanup();
          resolve(false);
        }, DEFAULT_PUBLISH_OK_TIMEOUT);

        const messageHandler = (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(String(data)) as unknown[];
            if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
              clearTimeout(timer);
              cleanup();
              resolve(msg[2] === true);
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.on('message', messageHandler);
        ws.send(JSON.stringify(['EVENT', event]));
      });

      if (published) {
        publishedTo++;
      }

      ws.close();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn(
        `[SeedRelayDiscovery] Failed to publish to ${relayUrl}: ${msg}`
      );
    }
  }

  return { publishedTo, eventId: event.id };
}
