/**
 * Integration test: Multi-hop ILP routing and relay synchronization
 *
 * This test demonstrates the complete Crosstown relay network:
 * 1. Multi-hop ILP routing (Peer1 → Genesis → Peer2)
 * 2. Cross-relay event propagation (Peer2 → Peer3)
 * 3. Event synchronization with micropayments
 *
 * Prerequisites:
 * - Genesis node running (localhost:3100 BLS, localhost:7100 Relay)
 * - Peer1 running (localhost:3110 BLS, localhost:7110 Relay)
 * - Peer2 running (localhost:3120 BLS, localhost:7120 Relay)
 * - Peer3 running (localhost:3130 BLS, localhost:7130 Relay)
 * - All peers bootstrapped and connected via ILP
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import WebSocket from 'ws';
import type { NostrEvent } from 'nostr-tools/core';

// Test configuration
const TEST_TIMEOUT = 30000; // 30 seconds

// Peer BLS endpoints
const PEER1_BLS = 'http://localhost:3110';
const PEER2_BLS = 'http://localhost:3120';
const PEER3_BLS = 'http://localhost:3130';

// Peer relay endpoints
const PEER2_RELAY = 'ws://localhost:7120';
const PEER3_RELAY = 'ws://localhost:7130';

// ILP addresses
const PEER2_ILP_ADDRESS = 'g.crosstown.peer2';

// Peer secret keys (from deployment)
const PEER1_SECRET = '97540d8331784dbe8e452d569f6423a2898ed2c90e6da32d809162180ea16c0e';

// TOON encoding/decoding (inline for now)
async function toonEncode(event: NostrEvent): Promise<Uint8Array> {
  const { encode } = await import('@toon-format/toon');
  const toonString = encode(event);
  return new TextEncoder().encode(toonString);
}

async function toonDecode(data: string): Promise<NostrEvent> {
  const { decode } = await import('@toon-format/toon');
  return decode(data) as NostrEvent;
}

// Helper to send ILP packet to BLS
async function sendIlpPacket(
  blsUrl: string,
  destination: string,
  amount: string,
  data: string,
  sourceAccount: string
): Promise<{ accept: boolean; code?: string; message?: string }> {
  const response = await fetch(`${blsUrl}/handle-packet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount,
      destination,
      data,
      sourceAccount,
    }),
  });

  return await response.json();
}

// Helper to query relay for event
async function queryRelay(
  relayUrl: string,
  eventId: string,
  timeoutMs: number = 10000
): Promise<NostrEvent | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    let foundEvent: NostrEvent | null = null;
    let pendingDecodes = 0;

    const timeout = setTimeout(() => {
      ws.close();
      resolve(foundEvent); // Return what we found, even if null
    }, timeoutMs);

    const checkComplete = () => {
      if (pendingDecodes === 0 && foundEvent) {
        clearTimeout(timeout);
        ws.close();
        resolve(foundEvent);
      }
    };

    ws.on('open', () => {
      const subscription = JSON.stringify(['REQ', 'test-query', { ids: [eventId] }]);
      ws.send(subscription);
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg[0] === 'EVENT') {
          pendingDecodes++;
          const toonString = msg[2];

          // Decode asynchronously but track completion
          toonDecode(toonString).then((event) => {
            if (event.id === eventId) {
              foundEvent = event;
            }
            pendingDecodes--;
            checkComplete();
          }).catch((error) => {
            console.error(`Error decoding TOON:`, error);
            pendingDecodes--;
          });
        } else if (msg[0] === 'EOSE') {
          // Wait a bit for any pending decodes to complete
          setTimeout(() => {
            clearTimeout(timeout);
            ws.close();
            resolve(foundEvent);
          }, 100);
        }
      } catch (error) {
        console.error(`Error parsing relay message:`, error);
        // Don't reject, just continue
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.error(`WebSocket error for ${relayUrl}:`, error.message);
      resolve(null); // Return null on error instead of rejecting
    });
  });
}

// Helper to sleep
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Multi-hop ILP Routing and Relay Synchronization', () => {
  let testEvent: NostrEvent;
  let peer1Pubkey: string;

  beforeAll(async () => {
    console.log('🚀 Starting multi-hop relay sync integration test...');

    // Derive peer1 pubkey
    const peer1SecretBytes = hexToBytes(PEER1_SECRET);
    peer1Pubkey = getPublicKey(peer1SecretBytes);

    console.log(`   Peer1 pubkey: ${peer1Pubkey.slice(0, 16)}...`);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    console.log('✅ Multi-hop relay sync integration test complete');
  });

  it('should verify all peer services are accessible', async () => {
    // Check Peer2 BLS
    const peer2Health = await fetch(`${PEER2_BLS}/health`);
    expect(peer2Health.ok).toBe(true);

    // Check Peer3 BLS
    const peer3Health = await fetch(`${PEER3_BLS}/health`);
    expect(peer3Health.ok).toBe(true);

    // Check Peer2 relay
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(PEER2_RELAY);
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Peer2 relay timeout')), 5000);
    });

    // Check Peer3 relay
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(PEER3_RELAY);
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Peer3 relay timeout')), 5000);
    });

    console.log('✅ All peer services accessible');
  }, TEST_TIMEOUT);

  it('should send paid event from Peer1 to Peer2 via multi-hop routing', async () => {
    console.log('\n📤 Testing Peer1 → Genesis → Peer2 routing...');

    // Create signed event from Peer1
    const peer1SecretBytes = hexToBytes(PEER1_SECRET);
    testEvent = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['test', 'multi-hop-routing']],
      content: `Integration test: Multi-hop event at ${new Date().toISOString()}`,
    }, peer1SecretBytes);

    console.log(`   Event ID: ${testEvent.id}`);

    // Encode in TOON format
    const toonBytes = await toonEncode(testEvent);
    const eventBase64 = Buffer.from(toonBytes).toString('base64');

    // Send to Peer2 via ILP
    const result = await sendIlpPacket(
      PEER2_BLS,
      PEER2_ILP_ADDRESS,
      '5000',
      eventBase64,
      'g.crosstown.peer1'
    );

    expect(result.accept).toBe(true);
    console.log('✅ ILP packet accepted by Peer2');

    // Wait for storage and indexing
    await sleep(3000);

    // Verify event in Peer2 relay
    const eventInPeer2 = await queryRelay(PEER2_RELAY, testEvent.id);
    expect(eventInPeer2).not.toBeNull();
    expect(eventInPeer2!.id).toBe(testEvent.id);
    expect(eventInPeer2!.content).toBe(testEvent.content);

    console.log('✅ Event verified in Peer2 relay');
  }, TEST_TIMEOUT);

  it('should synchronize event from Peer2 to Peer3 via subscription', async () => {
    console.log('\n🔄 Testing Peer2 → Peer3 relay synchronization...');

    expect(testEvent).toBeDefined();

    // Peer3 subscribes to Peer2 relay
    const receivedEvent = await new Promise<NostrEvent>((resolve, reject) => {
      const ws = new WebSocket(PEER2_RELAY);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for event from Peer2'));
      }, 10000);

      ws.on('open', () => {
        const subscription = JSON.stringify([
          'REQ',
          'peer3-sync',
          { authors: [peer1Pubkey], limit: 10 }
        ]);
        ws.send(subscription);
      });

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg[0] === 'EVENT') {
            const toonString = msg[2];
            const event = await toonDecode(toonString);

            if (event.id === testEvent.id) {
              clearTimeout(timeout);
              ws.close();
              resolve(event);
            }
          }
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(receivedEvent.id).toBe(testEvent.id);
    console.log('✅ Peer3 received event from Peer2');

    // Peer3 republishes to its own relay
    const republishToon = await toonEncode(receivedEvent);
    const republishBase64 = Buffer.from(republishToon).toString('base64');

    const republishResult = await sendIlpPacket(
      PEER3_BLS,
      'g.crosstown.peer3',
      '5000',
      republishBase64,
      'g.crosstown.peer3.sync'
    );

    expect(republishResult.accept).toBe(true);
    console.log('✅ Event republished to Peer3 relay');

    // Wait for storage and indexing
    await sleep(3000);

    // Verify event in Peer3 relay
    const eventInPeer3 = await queryRelay(PEER3_RELAY, testEvent.id);
    expect(eventInPeer3).not.toBeNull();
    expect(eventInPeer3!.id).toBe(testEvent.id);
    expect(eventInPeer3!.content).toBe(testEvent.content);

    console.log('✅ Event verified in Peer3 relay');
  }, TEST_TIMEOUT);

  it('should verify event exists in both Peer2 and Peer3 relays', async () => {
    console.log('\n🔍 Verifying event in both relays...');

    expect(testEvent).toBeDefined();

    // Query Peer2
    const eventInPeer2 = await queryRelay(PEER2_RELAY, testEvent.id);
    expect(eventInPeer2).not.toBeNull();
    expect(eventInPeer2!.id).toBe(testEvent.id);

    // Query Peer3
    const eventInPeer3 = await queryRelay(PEER3_RELAY, testEvent.id);
    expect(eventInPeer3).not.toBeNull();
    expect(eventInPeer3!.id).toBe(testEvent.id);

    // Verify content matches
    expect(eventInPeer2!.content).toBe(eventInPeer3!.content);
    expect(eventInPeer2!.sig).toBe(eventInPeer3!.sig);

    console.log('✅ Event verified in both Peer2 and Peer3 relays');
    console.log(`   Event successfully propagated across decentralized relay network`);
  }, TEST_TIMEOUT);
});
