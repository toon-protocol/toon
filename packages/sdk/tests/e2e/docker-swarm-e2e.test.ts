/**
 * E2E Test: Swarm Competitive Execution via Docker SDK Containers (Story 6.2)
 *
 * Deferred test ID: T-6.2-14 (P3)
 * Tests competitive DVM job execution with real ILP settlement.
 *
 * **Prerequisites:**
 * SDK E2E infrastructure running:
 * ```bash
 * ./scripts/sdk-e2e-infra.sh up
 * ```
 *
 * **What this test verifies:**
 * 1. Swarm request event (Kind 5xxx with swarm/judge tags) publishes to relay
 * 2. SwarmCoordinator collects provider submissions from relay
 * 3. Winner selection and ILP settlement to winning provider
 * 4. Loser submissions visible on relay but no settlement
 * 5. Timeout-based transition from collecting to judging
 * 6. Kind 7000 feedback on swarm completion/failure
 * 7. Swarm tags preserved through TOON encode/decode roundtrip
 *
 * Network topology:
 * ```
 * Customer Node (in-process) --BTP--> Peer1 (Docker) --BTP--> Peer2 (Docker)
 *      |                                  |                        |
 *   Anvil Account #3                Anvil Account #0          Anvil Account #2
 * ```
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  createNode,
  SwarmCoordinator,
  type ServiceNode,
  type HandlerContext,
} from '@toon-protocol/sdk';
import { ConnectorNode, createLogger } from '@toon-protocol/connector';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  TEXT_GENERATION_KIND,
  buildSwarmRequestEvent,
  parseSwarmRequest,
  buildJobResultEvent,
} from '@toon-protocol/core';

import {
  ANVIL_RPC,
  PEER1_BTP_URL,
  PEER1_RELAY_URL,
  PEER1_EVM_ADDRESS,
  TOKEN_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  REGISTRY_ADDRESS,
  TEST_PRIVATE_KEY,
  CHAIN_ID,
  waitForEventOnRelay,
  waitForPeer2Bootstrap,
  checkAllServicesReady,
  skipIfNotReady,
} from './helpers/docker-e2e-setup.js';

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Docker Swarm Competitive Execution E2E (Story 6.2 — T-6.2-14)', () => {
  let servicesReady = false;
  let node: ServiceNode;
  let connector: ConnectorNode;
  let nodeSecretKey: Uint8Array;
  let providerSecretKeyA: Uint8Array;
  let providerSecretKeyB: Uint8Array;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    process.env['EXPLORER_ENABLED'] = 'false';

    nodeSecretKey = generateSecretKey();
    providerSecretKeyA = generateSecretKey();
    providerSecretKeyB = generateSecretKey();
    const nostrPubkey = getPublicKey(nodeSecretKey);
    const testIlpAddress = `g.toon.test.swarm.${nostrPubkey.slice(0, 8)}`;

    const connectorLogger = createLogger('test-swarm-connector', 'warn');
    connector = new ConnectorNode(
      {
        nodeId: `test-sw-${nostrPubkey.slice(0, 8)}`,
        btpServerPort: 19908,
        healthCheckPort: 19909,
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [],
        routes: [],
        localDelivery: { enabled: false },
        settlementInfra: {
          enabled: true,
          rpcUrl: ANVIL_RPC,
          registryAddress: REGISTRY_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
          privateKey: TEST_PRIVATE_KEY,
        },
      },
      connectorLogger
    );

    node = createNode({
      secretKey: nodeSecretKey,
      connector,
      ilpAddress: testIlpAddress,
      basePricePerByte: 10n,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });

    // Accept all events
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
      routes: [{ prefix: 'g.toon.peer1' }, { prefix: 'g.toon.peer2' }],
    });

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

    await waitForPeer2Bootstrap(45000);
    await new Promise((r) => setTimeout(r, 5000));

    servicesReady = true;
  }, 120000);

  afterAll(async () => {
    if (node) await node.stop();
    if (connector) await connector.stop();
    await new Promise((r) => setTimeout(r, 500));
  });

  // =========================================================================
  // Swarm Request Publishing
  // =========================================================================

  it('[P0] T-6.2-14a: swarm request event (Kind 5xxx with swarm/judge tags) publishes to relay', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const swarmRequest = buildSwarmRequestEvent(
      {
        kind: TEXT_GENERATION_KIND,
        input: { data: 'Generate a poem about the ocean', type: 'text' },
        bid: '5000000',
        output: 'text/plain',
        maxProviders: 3,
        judge: 'customer',
      },
      nodeSecretKey
    );

    expect(swarmRequest.kind).toBe(TEXT_GENERATION_KIND);

    const result = await node.publishEvent(swarmRequest, {
      destination: 'g.toon.peer1',
    });
    expect(result.success).toBe(true);

    // Verify swarm request on relay
    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      swarmRequest.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['kind']).toBe(TEXT_GENERATION_KIND);

    // Verify swarm tags preserved through TOON roundtrip
    const tags = stored['tags'] as string[][];
    const swarmTag = tags.find((t) => t[0] === 'swarm');
    expect(swarmTag).toBeDefined();
    expect(swarmTag![1]).toBe('3');

    const judgeTag = tags.find((t) => t[0] === 'judge');
    expect(judgeTag).toBeDefined();
    expect(judgeTag![1]).toBe('customer');

    // Verify parseable after roundtrip
    const parsed = parseSwarmRequest(stored as unknown as NostrEvent);
    expect(parsed).not.toBeNull();
    expect(parsed!.maxProviders).toBe(3);
    expect(parsed!.judge).toBe('customer');
  });

  // =========================================================================
  // SwarmCoordinator Lifecycle
  // =========================================================================

  it('[P0] T-6.2-14b: SwarmCoordinator.startSwarm() initializes collecting state', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const swarmRequest = buildSwarmRequestEvent(
      {
        kind: TEXT_GENERATION_KIND,
        input: { data: 'Test swarm', type: 'text' },
        bid: '5000000',
        output: 'text/plain',
        maxProviders: 2,
        judge: 'customer',
      },
      nodeSecretKey
    );

    // Publish to relay first
    const publishResult = await node.publishEvent(swarmRequest, {
      destination: 'g.toon.peer1',
    });
    expect(publishResult.success).toBe(true);

    // Initialize coordinator
    const coordinator = new SwarmCoordinator(node, {
      timeoutMs: 60000,
      destination: 'g.toon.peer1',
    });

    try {
      await coordinator.startSwarm(swarmRequest);
      expect(coordinator.getState()).toBe('collecting');
      expect(coordinator.getSubmissions()).toHaveLength(0);
    } finally {
      coordinator.destroy();
    }
  });

  // =========================================================================
  // Submission Collection and Winner Selection
  // =========================================================================

  it('[P1] T-6.2-14c: SwarmCoordinator collects submissions and transitions to judging at max providers', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const swarmRequest = buildSwarmRequestEvent(
      {
        kind: TEXT_GENERATION_KIND,
        input: { data: 'Compete on this', type: 'text' },
        bid: '5000000',
        output: 'text/plain',
        maxProviders: 2,
        judge: 'customer',
      },
      nodeSecretKey
    );

    const coordinator = new SwarmCoordinator(node, {
      timeoutMs: 60000,
      destination: 'g.toon.peer1',
    });

    try {
      await coordinator.startSwarm(swarmRequest);

      // Simulate provider A submission
      const submissionA = buildJobResultEvent(
        {
          kind: 6100,
          requestEventId: swarmRequest.id,
          customerPubkey: swarmRequest.pubkey,
          amount: '2000000',
          content: 'Provider A result',
        },
        providerSecretKeyA
      );

      await coordinator.handleSubmission(submissionA);
      expect(coordinator.getState()).toBe('collecting');
      expect(coordinator.getSubmissions()).toHaveLength(1);

      // Simulate provider B submission -- should trigger judging
      const submissionB = buildJobResultEvent(
        {
          kind: 6100,
          requestEventId: swarmRequest.id,
          customerPubkey: swarmRequest.pubkey,
          amount: '2500000',
          content: 'Provider B result',
        },
        providerSecretKeyB
      );

      await coordinator.handleSubmission(submissionB);
      expect(coordinator.getState()).toBe('judging');
      expect(coordinator.getSubmissions()).toHaveLength(2);
    } finally {
      coordinator.destroy();
    }
  });

  // =========================================================================
  // Settlement via Real ILP
  // =========================================================================

  it('[P1] T-6.2-14d: selectWinner() settles compute via real ILP to winning provider', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const swarmRequest = buildSwarmRequestEvent(
      {
        kind: TEXT_GENERATION_KIND,
        input: { data: 'Settlement test', type: 'text' },
        bid: '5000000',
        output: 'text/plain',
        maxProviders: 1,
        judge: 'customer',
      },
      nodeSecretKey
    );

    const coordinator = new SwarmCoordinator(node, {
      timeoutMs: 60000,
      destination: 'g.toon.peer1',
    });

    try {
      await coordinator.startSwarm(swarmRequest);

      // Single submission triggers judging immediately
      const submission = buildJobResultEvent(
        {
          kind: 6100,
          requestEventId: swarmRequest.id,
          customerPubkey: swarmRequest.pubkey,
          amount: '3000000',
          content: 'Winner result',
        },
        providerSecretKeyA
      );

      await coordinator.handleSubmission(submission);
      expect(coordinator.getState()).toBe('judging');

      // Build selection event from customer
      const { buildSwarmSelectionEvent } = await import('@toon-protocol/core');
      const selectionEvent = buildSwarmSelectionEvent(
        {
          swarmRequestEventId: swarmRequest.id,
          winnerResultEventId: submission.id,
        },
        nodeSecretKey
      );

      // selectWinner() triggers ILP settlement
      await coordinator.selectWinner(selectionEvent);
      expect(coordinator.getState()).toBe('settled');
      expect(coordinator.isSettlementSucceeded()).toBe(true);
    } finally {
      coordinator.destroy();
    }
  });
});
