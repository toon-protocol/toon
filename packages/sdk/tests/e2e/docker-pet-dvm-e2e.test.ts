/**
 * E2E tests for Story 11.7: Pet DVM E2E Test
 *
 * These tests require the SDK E2E Docker infrastructure:
 *   ./scripts/sdk-e2e-infra.sh up
 *
 * They verify the full optimistic pipeline: client sends Kind 5900 pet
 * interaction via ILP -> Pet DVM handler processes interaction through
 * PetGameEngine + PetBrain -> Kind 14919 optimistic event published to relay.
 *
 * NOTE: The Docker image may not include the napi-rs binary for
 * @toon-protocol/memvid-node. If the Pet DVM handler fails with T00
 * ("Brain storage unavailable"), this indicates the native addon is missing
 * from the Docker build -- not a test bug. The test validates that the
 * wiring is correct; extending the Docker build pipeline to include the
 * native addon is a separate concern.
 *
 * Proof settlement (ZK proof generation + Mina settlement) is OUT OF SCOPE.
 * This story tests the optimistic path only.
 *
 * AC covered:
 * - AC #1: E2E test file structure (describe.skipIf, beforeAll, Account #10)
 * - AC #2: Kind 5900 event construction
 * - AC #3: ILP payment + DVM processing
 * - AC #4: Kind 14919 optimistic event on relay
 * - AC #5: Multiple interactions with state accumulation
 * - AC #6: Service discovery (petDvm.enabled)
 * - AC #7: Error handling (malformed request)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools/pure';
import WebSocket from 'ws';
import {
  createNode,
  type ServiceNode,
  type HandlerContext,
} from '@toon-protocol/sdk';
import { PET_INTERACTION_REQUEST_KIND } from '@toon-protocol/core';

import {
  PEER1_BTP_URL,
  PEER1_RELAY_URL,
  PEER1_BLS_URL,
  PET_DVM_PRIVATE_KEY,
  checkAllServicesReady,
  skipIfNotReady,
  waitForServiceHealth,
} from './helpers/docker-e2e-setup.js';

// E2E tests require SDK_E2E_DOCKER=1 env var (set by caller, not by the script).
const SKIP_E2E = !process.env['SDK_E2E_DOCKER'];

// Peer1's deterministic pubkey (derived from NOSTR_SECRET_KEY in docker-compose)
const PEER1_PUBKEY =
  'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Wait for a Kind 14919 pet interaction event on the relay matching a blobbiId.
 * Returns the raw event object or null on timeout.
 */
function waitForPetEvent(
  relayUrl: string,
  blobbiId: string,
  timeoutMs = 10000
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(relayUrl);
    const subId = `pet-${Date.now()}`;
    const cleanup = () => {
      clearTimeout(timer);
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
      } catch {
        /* ignore */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(
        JSON.stringify(['REQ', subId, { kinds: [14919], '#d': [blobbiId] }])
      );
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (
          Array.isArray(msg) &&
          msg[0] === 'EVENT' &&
          msg[1] === subId &&
          msg[2]
        ) {
          cleanup();
          resolve(msg[2] as Record<string, unknown>);
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('error', () => {
      cleanup();
      resolve(null);
    });
  });
}

/**
 * Build a Kind 5900 pet interaction event.
 */
function buildPetInteractionEvent(
  secretKey: Uint8Array,
  blobbiId: string,
  actionType: number,
  itemId: number,
  cost: number,
  isSleeping = false
): Record<string, unknown> {
  const template: EventTemplate = {
    kind: PET_INTERACTION_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', blobbiId],
      ['action', String(actionType)],
      ['item', String(itemId)],
      ['cost', String(cost)],
      ['sleeping', String(isSleeping)],
    ],
    content: '',
  };
  return finalizeEvent(template, secretKey) as unknown as Record<
    string,
    unknown
  >;
}

/**
 * Extract a tag value from a Nostr event.
 */
function getTagValue(
  event: Record<string, unknown>,
  tagName: string
): string | undefined {
  const tags = event['tags'] as string[][] | undefined;
  if (!tags) return undefined;
  for (const tag of tags) {
    if (tag[0] === tagName) return tag[1];
  }
  return undefined;
}

// ============================================================================
// Test Suite
// ============================================================================

// NOTE: Tests in this suite are SEQUENTIALLY DEPENDENT. E2E-003 verifies
// the relay event created by E2E-002, and E2E-004 builds on the pet state
// accumulated by E2E-002 (expects cycle to start at 2). Do not shuffle or
// run tests in isolation -- they must execute in declaration order.
describe.skipIf(SKIP_E2E)('Pet DVM E2E (Story 11.7)', () => {
  let servicesReady = false;
  let node: ServiceNode;
  let nostrSecretKey: Uint8Array;
  const blobbiId = `blobbi-e2e-${Date.now()}`;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    nostrSecretKey = generateSecretKey();

    // Create a lightweight client node with auto-created embedded connector.
    // Uses Anvil Account #10 for settlement (dedicated to pet-dvm-e2e).
    node = createNode({
      secretKey: nostrSecretKey,
      chain: 'anvil',
      btpServerPort: 19910,
      settlementPrivateKey: PET_DVM_PRIVATE_KEY,
      basePricePerByte: 10n,
      knownPeers: [
        {
          pubkey: PEER1_PUBKEY,
          relayUrl: PEER1_RELAY_URL,
          btpEndpoint: PEER1_BTP_URL,
        },
      ],
    });

    // Accept all events by default (client, not a provider)
    node.onDefault(async (ctx: HandlerContext) => {
      ctx.decode();
      return ctx.accept();
    });

    await node.start();

    // Wait for bootstrap to complete (peer registered + channel opened)
    await waitForServiceHealth(`${PEER1_BLS_URL}/health`, 15000);
    // Give bootstrap time to register peer and open channel
    await new Promise((r) => setTimeout(r, 3000));

    servicesReady = true;
  }, 120000);

  afterAll(async () => {
    if (node) await node.stop();
    await new Promise((r) => setTimeout(r, 500));
  });

  // ==========================================================================
  // AC-6: Service discovery -- Peer1 advertises Pet DVM capability
  // ==========================================================================

  it('11.7-E2E-001: Peer1 health endpoint reports petDvm.enabled === true', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const res = await fetch(`${PEER1_BLS_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.ok).toBe(true);

    const health = (await res.json()) as Record<string, unknown>;
    const petDvm = health['petDvm'] as Record<string, unknown> | undefined;
    expect(petDvm).toBeDefined();
    expect(petDvm?.['enabled']).toBe(true);
  }, 30000);

  // ==========================================================================
  // AC-2, AC-3: Kind 5900 event construction + ILP payment + DVM processing
  // ==========================================================================

  it('11.7-E2E-002: client sends Kind 5900 pet interaction via ILP -> DVM returns new state', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // New pets start at stage EGG (0). Feed/Play are NOT allowed for eggs.
    // Use Clean action (2) with soap shop item (itemId 15, cost 15) -- allowed for eggs.
    const petEvent = buildPetInteractionEvent(
      nostrSecretKey,
      blobbiId,
      2,
      15,
      15,
      false
    );

    const result = await node.publishEvent(
      petEvent as Parameters<typeof node.publishEvent>[0],
      { destination: 'g.toon.peer1' }
    );

    // ILP FULFILL returned
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    // Decode base64 JSON response payload
    const payload = JSON.parse(
      Buffer.from(result.data!, 'base64').toString()
    ) as Record<string, unknown>;

    // First interaction -> cycle 1
    expect(payload['cycle']).toBe(1);

    // Cleaning with soap increases hygiene. Genesis hygiene=100, but massive decay
    // (lastInteraction=0 -> elapsed ~years) clamps hygiene to 1 before action.
    // Soap adds +30 hygiene -> expect ~31 (clamped to [1, 100]).
    const stats = payload['stats'] as Record<string, number> | undefined;
    expect(stats).toBeDefined();
    expect(stats?.['hygiene']).toBeGreaterThanOrEqual(2);

    // Brain hash is a 64-char hex string (256-bit BLAKE3)
    const brainHash = payload['brainHash'] as string | undefined;
    expect(brainHash).toBeDefined();
    expect(brainHash).toMatch(/^[0-9a-f]{64}$/);

    // Valid stage
    const stage = payload['stage'] as number | undefined;
    expect(stage).toBeDefined();
    expect(stage).toBeGreaterThanOrEqual(0);
  }, 30000);

  // ==========================================================================
  // AC-4: Kind 14919 optimistic event on relay
  // ==========================================================================

  it('11.7-E2E-003: Kind 14919 optimistic event appears on Peer1 relay after interaction', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // The previous test (E2E-002) should have triggered a Kind 14919 event.
    // Query the relay for it.
    const event = await waitForPetEvent(PEER1_RELAY_URL, blobbiId, 10000);

    expect(event).not.toBeNull();

    // Verify tags
    expect(getTagValue(event!, 'd')).toBe(blobbiId);
    expect(getTagValue(event!, 'action')).toBe('2'); // clean
    expect(getTagValue(event!, 'cycle')).toBe('1');

    const brainHashTag = getTagValue(event!, 'brain_hash');
    expect(brainHashTag).toBeDefined();
    expect(brainHashTag).toMatch(/^[0-9a-f]{64}$/);
  }, 30000);

  // ==========================================================================
  // AC-5: Multiple interactions -- state accumulation
  // ==========================================================================

  it('11.7-E2E-004: multiple interactions accumulate state with incrementing cycles and changing brainHash', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // New pets start at stage EGG (0). Feed(0)/Play(1) are NOT allowed for eggs.
    // Use egg-allowed actions: Warm(4), Check(5), Talk(7), Medicine(8).
    // Each uses base action (itemId 0, cost 0) to avoid shop item dependencies.
    // Use egg-allowed actions with base (free) variants, plus one shop item
    // to exercise the token-cost validation path in the game engine.
    const interactions = [
      { action: 4, item: 0, cost: 0 }, // warm (base action)
      { action: 5, item: 0, cost: 0 }, // check (base action)
      { action: 7, item: 0, cost: 0 }, // talk (base action)
      { action: 8, item: 9, cost: 40 }, // medicine vitamins (shop item, exercises cost path)
    ];

    const brainHashes: string[] = [];
    let previousCycle = 1; // cycle 1 was from E2E-002

    for (const interaction of interactions) {
      // Small delay to ensure unique timestamps (DVM requires strictly increasing)
      await new Promise((r) => setTimeout(r, 1100));

      const petEvent = buildPetInteractionEvent(
        nostrSecretKey,
        blobbiId,
        interaction.action,
        interaction.item,
        interaction.cost,
        false
      );

      const result = await node.publishEvent(
        petEvent as Parameters<typeof node.publishEvent>[0],
        { destination: 'g.toon.peer1' }
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const payload = JSON.parse(
        Buffer.from(result.data!, 'base64').toString()
      ) as Record<string, unknown>;

      const cycle = payload['cycle'] as number;
      expect(cycle).toBe(previousCycle + 1);
      previousCycle = cycle;

      const brainHash = payload['brainHash'] as string;
      expect(brainHash).toBeDefined();
      expect(brainHash).toMatch(/^[0-9a-f]{64}$/);
      brainHashes.push(brainHash);
    }

    // Verify cycles incremented to 5 (1 from E2E-002 + 4 here)
    expect(previousCycle).toBe(5);

    // Verify brain hash changes between interactions (brain state evolves)
    const uniqueHashes = new Set(brainHashes);
    expect(uniqueHashes.size).toBeGreaterThan(1);
  }, 60000);

  // ==========================================================================
  // AC-7: Error handling -- malformed Kind 5900
  // ==========================================================================

  it('11.7-E2E-005: malformed Kind 5900 event (missing d tag) is rejected', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // Build a malformed event: missing the required 'd' tag
    const template: EventTemplate = {
      kind: PET_INTERACTION_REQUEST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        // No 'd' tag -- intentionally malformed
        ['action', '0'],
        ['item', '1'],
        ['cost', '10'],
        ['sleeping', 'false'],
      ],
      content: '',
    };
    const malformedEvent = finalizeEvent(
      template,
      nostrSecretKey
    ) as unknown as Record<string, unknown>;

    const result = await node.publishEvent(
      malformedEvent as Parameters<typeof node.publishEvent>[0],
      { destination: 'g.toon.peer1' }
    );

    // Should be rejected (F00 -- malformed request)
    expect(result.success).toBe(false);
    // Verify the error code indicates malformed request (AC-7)
    expect(result.code).toBe('F00');
  }, 30000);
});
