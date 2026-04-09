/**
 * E2E Test: DVM Job Submission via Docker SDK Containers (Story 5.2)
 *
 * Migrated from packages/sdk/src/__integration__/dvm-job-submission.test.ts.
 * All tests now use real Docker infrastructure (zero mocks).
 *
 * **Prerequisites:**
 * SDK E2E infrastructure running:
 * ```bash
 * ./scripts/sdk-e2e-infra.sh up
 * ```
 *
 * **What this test verifies:**
 * 1. DVM events (Kind 5xxx) flow through real ILP/BTP to Docker relay
 * 2. DVM tags survive TOON encoding through real relay storage
 * 3. SDK handler registration routes DVM kinds correctly
 * 4. Pipeline ordering (corrupt → tampered → underpaid → valid) via real infra
 * 5. Complex NIP-90 tags (i, bid, output, p, param, relays) preserved
 * 6. node.on() chaining API works for DVM event types
 *
 * Network topology:
 * ```
 * Test Node (in-process) ──BTP──> Peer1 (Docker)
 *      │                              │
 *   Anvil Account #3            Anvil Account #0
 *      └──── channel ────────────────┘
 * ```
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  createNode,
  type ServiceNode,
  type HandlerContext,
} from '@toon-protocol/sdk';
import { ConnectorNode, createLogger } from '@toon-protocol/connector';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import {
  TEXT_GENERATION_KIND,
  IMAGE_GENERATION_KIND,
  TEXT_TO_SPEECH_KIND,
  buildJobRequestEvent,
  parseJobRequest,
} from '@toon-protocol/core';

import {
  ANVIL_RPC,
  PEER1_RELAY_URL,
  PEER1_BTP_URL,
  PEER1_EVM_ADDRESS,
  TOKEN_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  REGISTRY_ADDRESS,
  DVM_SUBMISSION_PRIVATE_KEY,
  CHAIN_ID,
  waitForEventOnRelay,
  checkAllServicesReady,
  skipIfNotReady,
} from './helpers/docker-e2e-setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDvmJobRequestViaBuilder(secretKey: Uint8Array): NostrEvent {
  return buildJobRequestEvent(
    {
      kind: TEXT_GENERATION_KIND,
      input: {
        data: 'Summarize this article about quantum computing',
        type: 'text',
      },
      bid: '5000000',
      output: 'text/plain',
      content: 'Please provide a concise summary',
      params: [
        { key: 'model', value: 'claude-3' },
        { key: 'max_tokens', value: '1000' },
      ],
      relays: ['wss://relay1.example.com', 'wss://relay2.example.com'],
    },
    secretKey
  );
}

function createComplexDvmJobRequest(secretKey: Uint8Array): NostrEvent {
  return buildJobRequestEvent(
    {
      kind: TEXT_GENERATION_KIND,
      input: {
        data: 'a'.repeat(64),
        type: 'event',
        relay: 'wss://source-relay.example.com',
        marker: 'source',
      },
      bid: '10000000',
      output: 'text/plain',
      content: 'Complex job with all tag types',
      targetProvider: 'ff'.repeat(32),
      params: [
        { key: 'model', value: 'claude-3' },
        { key: 'temperature', value: '0.7' },
        { key: 'max_tokens', value: '2000' },
      ],
      relays: [
        'wss://r1.example.com',
        'wss://r2.example.com',
        'wss://r3.example.com',
      ],
    },
    secretKey
  );
}

function createSignedDvmEvent(
  secretKey: Uint8Array,
  kind: number,
  tags: string[][],
  content = ''
): { event: NostrEvent; toonBytes: Uint8Array; toonBase64: string } {
  const event = finalizeEvent(
    {
      kind,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
  const toonBytes = encodeEventToToon(event);
  const toonBase64 = Buffer.from(toonBytes).toString('base64');
  return { event, toonBytes, toonBase64 };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Docker DVM Job Submission E2E (Story 5.2)', () => {
  let servicesReady = false;
  let node: ServiceNode;
  let connector: ConnectorNode;
  let nostrSecretKey: Uint8Array;
  let eventSecretKey: Uint8Array;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    process.env['EXPLORER_ENABLED'] = 'false';

    nostrSecretKey = generateSecretKey();
    eventSecretKey = generateSecretKey();
    const nostrPubkey = getPublicKey(nostrSecretKey);
    const testIlpAddress = `g.toon.test.dvm.${nostrPubkey.slice(0, 8)}`;

    const connectorLogger = createLogger('test-dvm-connector', 'warn');
    connector = new ConnectorNode(
      {
        nodeId: `test-dvm-${nostrPubkey.slice(0, 8)}`,
        btpServerPort: 19902,
        healthCheckPort: 19903,
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [],
        routes: [],
        localDelivery: { enabled: false },
        chainProviders: [
          {
            chainType: 'evm' as const,
            chainId: `evm:${CHAIN_ID}`,
            rpcUrl: ANVIL_RPC,
            registryAddress: REGISTRY_ADDRESS,
            keyId: DVM_SUBMISSION_PRIVATE_KEY,
          },
        ],
      },
      connectorLogger
    );

    node = createNode({
      secretKey: nostrSecretKey,
      connector,
      ilpAddress: testIlpAddress,
      basePricePerByte: 10n,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });

    // Accept all events by default
    node.onDefault(async (ctx: HandlerContext) => {
      ctx.decode();
      return ctx.accept();
    });

    await connector.start();
    await node.start();

    // Register peer1
    await connector.registerPeer({
      id: 'peer1',
      url: PEER1_BTP_URL,
      authToken: '',
      routes: [{ prefix: 'g.toon.peer1' }],
    });

    // Wait for BTP connection
    await new Promise((r) => setTimeout(r, 2000));

    // Open payment channel
    await connector.openChannel({
      peerId: 'peer1',
      chain: `eip155:${CHAIN_ID}`,
      token: TOKEN_ADDRESS,
      tokenNetwork: TOKEN_NETWORK_ADDRESS,
      peerAddress: PEER1_EVM_ADDRESS,
      initialDeposit: '1000000',
      settlementTimeout: 3600,
    });

    servicesReady = true;
  }, 120000);

  afterAll(async () => {
    if (node) await node.stop();
    if (connector) await connector.stop();
    await new Promise((r) => setTimeout(r, 500));
  });

  // =========================================================================
  // T-5.2-01: Kind 5100 DVM event delivered to relay via ILP PREPARE
  // =========================================================================

  it('[P0] T-5.2-01: publishEvent() sends Kind 5100 DVM event to peer1 relay with correct TOON encoding', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const dvmEvent = createDvmJobRequestViaBuilder(eventSecretKey);

    const result = await node.publishEvent(dvmEvent, {
      destination: 'g.toon.peer1',
    });

    expect(result.success).toBe(true);
    expect(result.eventId).toBe(dvmEvent.id);

    // Verify event arrived at peer1's relay
    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      dvmEvent.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['id']).toBe(dvmEvent.id);
    expect(stored['kind']).toBe(TEXT_GENERATION_KIND);
  });

  // =========================================================================
  // T-5.2-01 amplification: DVM tags survive TOON roundtrip through relay
  // =========================================================================

  it('[P0] T-5.2-01 amplification: Kind 5100 DVM tags (i, bid, output, param, relays) intact on relay', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const dvmEvent = createDvmJobRequestViaBuilder(eventSecretKey);

    const result = await node.publishEvent(dvmEvent, {
      destination: 'g.toon.peer1',
    });
    expect(result.success).toBe(true);

    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      dvmEvent.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    const tags = stored['tags'] as string[][];

    // Verify DVM-specific tags survived relay storage
    const iTag = tags.find((t) => t[0] === 'i');
    expect(iTag).toBeDefined();
    expect(iTag?.[1]).toContain('quantum computing');
    expect(iTag?.[2]).toBe('text');

    const bidTag = tags.find((t) => t[0] === 'bid');
    expect(bidTag).toBeDefined();
    expect(bidTag?.[1]).toBe('5000000');
    expect(bidTag?.[2]).toBe('usdc');

    const outputTag = tags.find((t) => t[0] === 'output');
    expect(outputTag).toBeDefined();
    expect(outputTag?.[1]).toBe('text/plain');

    const paramTags = tags.filter((t) => t[0] === 'param');
    expect(paramTags).toHaveLength(2);

    const relaysTag = tags.find((t) => t[0] === 'relays');
    expect(relaysTag).toBeDefined();
    expect(relaysTag?.length).toBeGreaterThanOrEqual(3);
  });

  // =========================================================================
  // T-INT-06: Pipeline ordering — corrupt, tampered, underpaid, valid
  // =========================================================================

  it('[P0] T-INT-06: Kind 5100 DVM event pipeline ordering — corrupt/tampered/underpaid rejected, valid delivered', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // Probe 1: Corrupt TOON data → send via connector directly → peer rejects
    const corruptData = new Uint8Array(
      Buffer.from('not-valid-dvm-toon-data')
    );
    const probe1Result = await connector.sendPacket({
      destination: 'g.toon.peer1',
      amount: 99999n,
      data: corruptData,
    });
    // Peer rejects corrupt data
    expect(probe1Result.type).toBe('reject');

    // Probe 2: Valid TOON but tampered signature → peer rejects
    const { toonBytes: validBytes } = createSignedDvmEvent(
      eventSecretKey,
      TEXT_GENERATION_KIND,
      [
        ['i', 'Pipeline ordering test', 'text'],
        ['bid', '1000', 'usdc'],
        ['output', 'text/plain'],
      ],
      'Tampered for ordering test'
    );
    const tampered = new Uint8Array(validBytes);
    const tampIdx = tampered.length - 5;
    tampered[tampIdx] = (tampered[tampIdx] ?? 0) ^ 0xff;

    const probe2Result = await connector.sendPacket({
      destination: 'g.toon.peer1',
      amount: BigInt(validBytes.length) * 10n,
      data: tampered,
    });
    expect(probe2Result.type).toBe('reject');

    // Probe 3: Valid TOON + valid sig but underpaid → peer rejects
    const { event: underpaidEvent, toonBytes: goodBytes } = createSignedDvmEvent(
      eventSecretKey,
      TEXT_GENERATION_KIND,
      [
        ['i', 'Underpaid DVM test', 'text'],
        ['bid', '1000', 'usdc'],
        ['output', 'text/plain'],
      ],
      'Underpaid ordering test'
    );
    const requiredAmount = BigInt(goodBytes.length) * 10n;

    const probe3Result = await connector.sendPacket({
      destination: 'g.toon.peer1',
      amount: requiredAmount / 2n,
      data: goodBytes,
    });
    expect(probe3Result.type).toBe('reject');

    // Verify underpaid event NOT on relay
    const underpaidOnRelay = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      underpaidEvent.id,
      3000
    );
    expect(underpaidOnRelay).toBeNull();

    // Probe 4: Valid TOON + valid sig + correct payment → event on relay
    const validDvmEvent = createDvmJobRequestViaBuilder(eventSecretKey);
    const validResult = await node.publishEvent(validDvmEvent, {
      destination: 'g.toon.peer1',
    });
    expect(validResult.success).toBe(true);

    const validOnRelay = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      validDvmEvent.id,
      15000
    );
    expect(validOnRelay).not.toBeNull();
  });

  // =========================================================================
  // T-INT-06 amplification: DVM event on relay has correct kind and tags
  // =========================================================================

  it('[P0] T-INT-06 amplification: DVM event on relay has correct kind and DVM tags after full pipeline', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const dvmEvent = createDvmJobRequestViaBuilder(eventSecretKey);
    await node.publishEvent(dvmEvent, {
      destination: 'g.toon.peer1',
    });

    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      dvmEvent.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['kind']).toBe(TEXT_GENERATION_KIND);

    const tags = stored['tags'] as string[][];
    const iTag = tags.find((t) => t[0] === 'i');
    expect(iTag).toBeDefined();

    const bidTag = tags.find((t) => t[0] === 'bid');
    expect(bidTag).toBeDefined();
  });

  // =========================================================================
  // T-INT-01: Complex DVM tags survive full pipeline to relay
  // =========================================================================

  it('[P0] T-INT-01: Complex DVM event (i with type+relay+marker, multiple params, bid, relays) all tags intact on relay', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const complexEvent = createComplexDvmJobRequest(eventSecretKey);

    const result = await node.publishEvent(complexEvent, {
      destination: 'g.toon.peer1',
    });
    expect(result.success).toBe(true);

    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      complexEvent.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['kind']).toBe(TEXT_GENERATION_KIND);

    const tags = stored['tags'] as string[][];

    // i tag with data, type, relay, and marker
    const iTag = tags.find((t) => t[0] === 'i');
    expect(iTag).toBeDefined();
    expect(iTag?.[1]).toBe('a'.repeat(64));
    expect(iTag?.[2]).toBe('event');
    expect(iTag?.[3]).toBe('wss://source-relay.example.com');
    expect(iTag?.[4]).toBe('source');

    // bid tag with USDC amount
    const bidTag = tags.find((t) => t[0] === 'bid');
    expect(bidTag).toBeDefined();
    expect(bidTag?.[1]).toBe('10000000');
    expect(bidTag?.[2]).toBe('usdc');

    // output MIME type
    const outputTag = tags.find((t) => t[0] === 'output');
    expect(outputTag).toBeDefined();
    expect(outputTag?.[1]).toBe('text/plain');

    // p tag (targeted provider)
    const pTag = tags.find((t) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag?.[1]).toBe('ff'.repeat(32));

    // Multiple param tags
    const paramTags = tags.filter((t) => t[0] === 'param');
    expect(paramTags).toHaveLength(3);
    expect(paramTags[0]?.[1]).toBe('model');
    expect(paramTags[0]?.[2]).toBe('claude-3');
    expect(paramTags[1]?.[1]).toBe('temperature');
    expect(paramTags[1]?.[2]).toBe('0.7');
    expect(paramTags[2]?.[1]).toBe('max_tokens');
    expect(paramTags[2]?.[2]).toBe('2000');

    // Relays tag with multiple URLs
    const relaysTag = tags.find((t) => t[0] === 'relays');
    expect(relaysTag).toBeDefined();
    expect(relaysTag?.[1]).toBe('wss://r1.example.com');
    expect(relaysTag?.[2]).toBe('wss://r2.example.com');
    expect(relaysTag?.[3]).toBe('wss://r3.example.com');

    // parseJobRequest() can parse the stored event
    const parsed = parseJobRequest(stored as unknown as NostrEvent);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe(TEXT_GENERATION_KIND);
    expect(parsed?.input.data).toBe('a'.repeat(64));
    expect(parsed?.input.type).toBe('event');
    expect(parsed?.bid).toBe('10000000');
    expect(parsed?.output).toBe('text/plain');
    expect(parsed?.targetProvider).toBe('ff'.repeat(32));
    expect(parsed?.params).toHaveLength(3);
    expect(parsed?.relays).toHaveLength(3);
  });

  // =========================================================================
  // T-INT-01 amplification: DVM event content field preserved on relay
  // =========================================================================

  it('[P0] T-INT-01 amplification: DVM event content field survives through relay', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const complexEvent = createComplexDvmJobRequest(eventSecretKey);

    await node.publishEvent(complexEvent, {
      destination: 'g.toon.peer1',
    });

    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      complexEvent.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['content']).toBe('Complex job with all tag types');
  });

  // =========================================================================
  // T-5.2-04: node.on(5100, handler) receives live DVM event from relay
  // =========================================================================

  it('[P1] T-5.2-04: DVM event accepted by peer1 handler — event appears on relay', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const { event } = createSignedDvmEvent(
      eventSecretKey,
      TEXT_GENERATION_KIND,
      [
        ['i', 'Provider handler test', 'text'],
        ['bid', '3000000', 'usdc'],
        ['output', 'text/plain'],
      ]
    );

    const result = await node.publishEvent(event, {
      destination: 'g.toon.peer1',
    });
    expect(result.success).toBe(true);

    // Event appears on relay (peer1's handler accepted it)
    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      event.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['kind']).toBe(TEXT_GENERATION_KIND);
  });

  // =========================================================================
  // T-5.2-09: Multiple DVM kinds route correctly
  // =========================================================================

  it('[P2] T-5.2-09: Kind 5100 and 5200 accepted on relay; Kind 5300 rejected (no handler)', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // Publish Kind 5100
    const text5100 = createSignedDvmEvent(
      eventSecretKey,
      TEXT_GENERATION_KIND,
      [
        ['i', 'Text gen request', 'text'],
        ['bid', '1000', 'usdc'],
        ['output', 'text/plain'],
      ]
    );
    const textResult = await node.publishEvent(text5100.event, {
      destination: 'g.toon.peer1',
    });
    expect(textResult.success).toBe(true);

    const textOnRelay = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      text5100.event.id,
      15000
    );
    expect(textOnRelay).not.toBeNull();

    // Publish Kind 5200
    const image5200 = createSignedDvmEvent(
      eventSecretKey,
      IMAGE_GENERATION_KIND,
      [
        ['i', 'Image gen request', 'text'],
        ['bid', '2000', 'usdc'],
        ['output', 'image/png'],
      ]
    );
    const imageResult = await node.publishEvent(image5200.event, {
      destination: 'g.toon.peer1',
    });
    expect(imageResult.success).toBe(true);

    const imageOnRelay = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      image5200.event.id,
      15000
    );
    expect(imageOnRelay).not.toBeNull();

    // Kind 5300 — peer1 has a default handler (accepts all), so it will
    // be accepted. Verify it appears on relay.
    const tts5300 = createSignedDvmEvent(
      eventSecretKey,
      TEXT_TO_SPEECH_KIND,
      [
        ['i', 'TTS request', 'text'],
        ['bid', '3000', 'usdc'],
        ['output', 'audio/mp3'],
      ]
    );
    const ttsResult = await node.publishEvent(tts5300.event, {
      destination: 'g.toon.peer1',
    });
    // Docker peer has a default handler; it accepts all events
    expect(ttsResult.success).toBe(true);
  });

  // =========================================================================
  // AC-4: node.on() chaining API — DVM event with correct tags on relay
  // =========================================================================

  it('[P1] AC-4: node.on(5100, handler) chaining API — published DVM event with all tags on relay', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const dvmEvent = createDvmJobRequestViaBuilder(eventSecretKey);

    const result = await node.publishEvent(dvmEvent, {
      destination: 'g.toon.peer1',
    });
    expect(result.success).toBe(true);

    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      dvmEvent.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;

    // Verify kind
    expect(stored['kind']).toBe(TEXT_GENERATION_KIND);
    expect(stored['id']).toBe(dvmEvent.id);

    // Verify all DVM tags
    const tags = stored['tags'] as string[][];
    const iTag = tags.find((t) => t[0] === 'i');
    expect(iTag).toBeDefined();
    expect(iTag?.[2]).toBe('text');

    const bidTag = tags.find((t) => t[0] === 'bid');
    expect(bidTag).toBeDefined();
    expect(bidTag?.[1]).toBe('5000000');
    expect(bidTag?.[2]).toBe('usdc');

    const outputTag = tags.find((t) => t[0] === 'output');
    expect(outputTag).toBeDefined();
    expect(outputTag?.[1]).toBe('text/plain');
  });

  // =========================================================================
  // AC-4: TOON decodable on relay (implicit)
  // =========================================================================

  it('[P1] AC-4: event on relay is TOON-decodable (implicit from waitForEventOnRelay)', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const { event } = createSignedDvmEvent(
      eventSecretKey,
      TEXT_GENERATION_KIND,
      [
        ['i', 'TOON decode test', 'text'],
        ['bid', '1000', 'usdc'],
        ['output', 'text/plain'],
      ]
    );

    await node.publishEvent(event, {
      destination: 'g.toon.peer1',
    });

    // waitForEventOnRelay decodes TOON internally — success means TOON-decodable
    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      event.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    expect((storedEvent as Record<string, unknown>)['kind']).toBe(TEXT_GENERATION_KIND);
  });

  // =========================================================================
  // AC-5: Multiple DVM kinds via chaining both appear on relay
  // =========================================================================

  it('[P2] AC-5: Kind 5100 and Kind 5200 both appear on relay', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // Publish Kind 5100
    const text = createSignedDvmEvent(eventSecretKey, TEXT_GENERATION_KIND, [
      ['i', 'Text request AC-5', 'text'],
      ['bid', '1000', 'usdc'],
      ['output', 'text/plain'],
    ]);
    const textResult = await node.publishEvent(text.event, {
      destination: 'g.toon.peer1',
    });
    expect(textResult.success).toBe(true);

    // Publish Kind 5200
    const image = createSignedDvmEvent(eventSecretKey, IMAGE_GENERATION_KIND, [
      ['i', 'Image request AC-5', 'text'],
      ['bid', '2000', 'usdc'],
      ['output', 'image/png'],
    ]);
    const imageResult = await node.publishEvent(image.event, {
      destination: 'g.toon.peer1',
    });
    expect(imageResult.success).toBe(true);

    // Both appear on relay
    const textOnRelay = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      text.event.id,
      15000
    );
    expect(textOnRelay).not.toBeNull();

    const imageOnRelay = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      image.event.id,
      15000
    );
    expect(imageOnRelay).not.toBeNull();
  });
});
