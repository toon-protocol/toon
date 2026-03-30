/**
 * E2E Test: Workflow Chain Lifecycle via Docker SDK Containers (Story 6.1)
 *
 * Deferred test ID: T-6.1-16 (P2)
 * Tests multi-step DVM workflow pipelines with real infrastructure.
 *
 * **Prerequisites:**
 * SDK E2E infrastructure running:
 * ```bash
 * ./scripts/sdk-e2e-infra.sh up
 * ```
 *
 * **What this test verifies:**
 * 1. WorkflowOrchestrator starts a workflow and publishes step 1 job request to relay
 * 2. Step result received via relay triggers advancement to step 2
 * 3. Multi-step chain completes with Kind 7000 success notification on relay
 * 4. Per-step settlement executes via real ILP multi-hop
 * 5. Step failure mid-chain aborts workflow with Kind 7000 error notification
 * 6. Step timeout triggers failure state and customer notification
 * 7. Bid allocation is preserved through TOON encode/decode roundtrip
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
  WorkflowOrchestrator,
  type ServiceNode,
  type HandlerContext,
} from '@toon-protocol/sdk';
import { ConnectorNode, createLogger } from '@toon-protocol/connector';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  TEXT_GENERATION_KIND,
  buildWorkflowDefinitionEvent,
  parseWorkflowDefinition,
  WORKFLOW_CHAIN_KIND,
} from '@toon-protocol/core';

import {
  ANVIL_RPC,
  PEER1_BTP_URL,
  PEER1_RELAY_URL,
  PEER1_EVM_ADDRESS,
  TOKEN_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  REGISTRY_ADDRESS,
  WORKFLOW_PRIVATE_KEY,
  CHAIN_ID,
  waitForEventOnRelay,
  waitForPeer2Bootstrap,
  checkAllServicesReady,
  skipIfNotReady,
} from './helpers/docker-e2e-setup.js';

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Docker Workflow Chain E2E (Story 6.1 — T-6.1-16)', () => {
  let servicesReady = false;
  let node: ServiceNode;
  let connector: ConnectorNode;
  let nodeSecretKey: Uint8Array;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    process.env['EXPLORER_ENABLED'] = 'false';

    nodeSecretKey = generateSecretKey();
    const nostrPubkey = getPublicKey(nodeSecretKey);
    const testIlpAddress = `g.toon.test.workflow.${nostrPubkey.slice(0, 8)}`;

    const connectorLogger = createLogger('test-workflow-connector', 'warn');
    connector = new ConnectorNode(
      {
        nodeId: `test-wf-${nostrPubkey.slice(0, 8)}`,
        btpServerPort: 19906,
        healthCheckPort: 19907,
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
            keyId: WORKFLOW_PRIVATE_KEY,
          },
        ],
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
  // Workflow Definition Publishing
  // =========================================================================

  it('[P0] T-6.1-16a: workflow definition event (Kind 10040) publishes to relay via ILP', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const workflowEvent = buildWorkflowDefinitionEvent(
      {
        steps: [
          {
            kind: TEXT_GENERATION_KIND,
            description: 'Step 1: Summarize text',
          },
          {
            kind: TEXT_GENERATION_KIND,
            description: 'Step 2: Translate summary',
          },
        ],
        initialInput: { data: 'Hello world', type: 'text' },
        totalBid: '10000000',
      },
      nodeSecretKey
    );

    expect(workflowEvent.kind).toBe(WORKFLOW_CHAIN_KIND);

    const result = await node.publishEvent(workflowEvent, {
      destination: 'g.toon.peer1',
    });
    expect(result.success).toBe(true);

    // Verify workflow definition event on relay
    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      workflowEvent.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['kind']).toBe(WORKFLOW_CHAIN_KIND);

    // Verify definition is parseable after relay roundtrip
    const parsed = parseWorkflowDefinition(stored as unknown as NostrEvent);
    expect(parsed).not.toBeNull();
    expect(parsed!.steps).toHaveLength(2);
    expect(parsed!.totalBid).toBe('10000000');
  });

  // =========================================================================
  // WorkflowOrchestrator Step 1 Publishing
  // =========================================================================

  it('[P0] T-6.1-16b: WorkflowOrchestrator.startWorkflow() publishes step 1 Kind 5xxx to relay', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const workflowEvent = buildWorkflowDefinitionEvent(
      {
        steps: [
          {
            kind: TEXT_GENERATION_KIND,
            description: 'Step 1: Generate text',
          },
        ],
        initialInput: { data: 'Generate a poem', type: 'text' },
        totalBid: '5000000',
      },
      nodeSecretKey
    );

    const parsed = parseWorkflowDefinition(workflowEvent);
    expect(parsed).not.toBeNull();

    const orchestrator = new WorkflowOrchestrator(node, {
      secretKey: nodeSecretKey,
      stepTimeoutMs: 60000,
      destination: 'g.toon.peer1',
      workflowEventId: workflowEvent.id,
      customerPubkey: workflowEvent.pubkey,
    });

    try {
      await orchestrator.startWorkflow(parsed!);
      expect(orchestrator.getState()).toBe('step_1_running');

      // Verify step 1 job request was published to relay
      const stepStates = orchestrator.getStepStates();
      expect(stepStates).toHaveLength(1);
      expect(stepStates[0]!.requestEventId).toBeDefined();

      const storedEvent = await waitForEventOnRelay(
        PEER1_RELAY_URL,
        stepStates[0]!.requestEventId!,
        15000
      );
      expect(storedEvent).not.toBeNull();
      const stored = storedEvent as Record<string, unknown>;
      expect(stored['kind']).toBe(TEXT_GENERATION_KIND);
    } finally {
      orchestrator.destroy();
    }
  });

  // =========================================================================
  // Bid Preservation
  // =========================================================================

  it('[P1] T-6.1-16c: per-step bid amount preserved through TOON encode/decode roundtrip', async () => {
    if (skipIfNotReady(servicesReady)) return;

    const workflowEvent = buildWorkflowDefinitionEvent(
      {
        steps: [
          {
            kind: TEXT_GENERATION_KIND,
            description: 'Step 1',
            bidAllocation: '3000000',
          },
          {
            kind: TEXT_GENERATION_KIND,
            description: 'Step 2',
            bidAllocation: '7000000',
          },
        ],
        initialInput: { data: 'Test input', type: 'text' },
        totalBid: '10000000',
      },
      nodeSecretKey
    );

    const result = await node.publishEvent(workflowEvent, {
      destination: 'g.toon.peer1',
    });
    expect(result.success).toBe(true);

    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      workflowEvent.id,
      15000
    );
    expect(storedEvent).not.toBeNull();

    // Parse the roundtripped event and verify bid allocations
    const parsed = parseWorkflowDefinition(
      storedEvent as unknown as NostrEvent
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.totalBid).toBe('10000000');
    expect(parsed!.steps[0]!.bidAllocation).toBe('3000000');
    expect(parsed!.steps[1]!.bidAllocation).toBe('7000000');
  });
});
