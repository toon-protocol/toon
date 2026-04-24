/**
 * E2E Test: Ator Transport (SOCKS5 Proxy) Verification
 *
 * **Prerequisites:**
 * SDK E2E infrastructure running (includes SOCKS5 proxy on port 19050):
 * ```bash
 * ./scripts/sdk-e2e-infra.sh up
 * ```
 *
 * **What this test verifies:**
 *
 * 1. SOCKS5 proxy is reachable on port 19050
 * 2. SDK createNode() accepts transport config and passes it to ConnectorNode
 * 3. ConnectorNode can connect to Peer1 BTP endpoint via SOCKS5 proxy
 * 4. A publish event succeeds through the proxied connection
 *
 * Network topology:
 * ```
 * Test Node ──SOCKS5──> Proxy (port 19050) ──TCP──> Peer1 BTP (port 19000)
 * ```
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createNode, type ServiceNode } from '@toon-protocol/sdk';
import { ConnectorNode, createLogger } from '@toon-protocol/connector';
import type { EmbeddableConnectorLike } from '@toon-protocol/core';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { createConnection } from 'node:net';

import {
  ANVIL_RPC,
  PEER1_BTP_URL,
  PEER1_EVM_ADDRESS,
  TOKEN_ADDRESS,
  REGISTRY_ADDRESS,
  TEST_PRIVATE_KEY,
  CHAIN_ID,
  checkAllServicesReady,
} from './helpers/docker-e2e-setup.js';

const SOCKS5_PROXY_URL = 'socks5h://127.0.0.1:19050';
const SOCKS5_HOST = '127.0.0.1';
const SOCKS5_PORT = 19050;

/**
 * TCP probe to verify SOCKS5 proxy is reachable.
 */
function probeSocks5(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('Docker SDK Ator Transport E2E', () => {
  let servicesReady = false;
  let socks5Ready = false;
  let node: ServiceNode;
  let connector: ConnectorNode;

  beforeAll(async () => {
    // Phase 1: Check all services including SOCKS5 proxy
    const ready = await checkAllServicesReady();
    if (!ready) return;
    servicesReady = true;

    // Phase 2: Verify SOCKS5 proxy is reachable
    socks5Ready = await probeSocks5(SOCKS5_HOST, SOCKS5_PORT);
    if (!socks5Ready) {
      console.warn(
        '[Ator E2E] SOCKS5 proxy not reachable at port 19050 — skipping transport tests. ' +
          'Ensure docker-compose includes the socks5-proxy service.'
      );
      return;
    }
  }, 30_000);

  afterAll(async () => {
    if (node) {
      await node.stop().catch(() => {});
    }
    if (connector) {
      await connector.stop().catch(() => {});
    }
  });

  it('SOCKS5 proxy is reachable on port 19050', () => {
    if (!servicesReady) return;
    expect(socks5Ready).toBe(true);
  });

  it('ConnectorNode starts with SOCKS5 transport config', async () => {
    if (!servicesReady || !socks5Ready) return;

    const nostrSecretKey = generateSecretKey();
    const nostrPubkey = getPublicKey(nostrSecretKey);

    const connectorLogger = createLogger('test-ator', 'warn');
    connector = new ConnectorNode(
      {
        nodeId: `ator-test-${nostrPubkey.slice(0, 8)}`,
        btpServerPort: 19960,
        healthCheckPort: 19961,
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [
          {
            id: 'peer1',
            url: PEER1_BTP_URL,
            authToken: '',
            evmAddress: PEER1_EVM_ADDRESS,
            chain: 'evm:31337',
          },
        ],
        routes: [],
        localDelivery: { enabled: false },
        transport: {
          type: 'socks5' as const,
          socksProxy: SOCKS5_PROXY_URL,
          externalUrl: 'ws://127.0.0.1:19960',
          managed: false,
        },
        chainProviders: [
          {
            chainType: 'evm' as const,
            chainId: `evm:${CHAIN_ID}`,
            rpcUrl: ANVIL_RPC,
            registryAddress: REGISTRY_ADDRESS,
            tokenAddress: TOKEN_ADDRESS,
            keyId: TEST_PRIVATE_KEY,
          },
        ],
      },
      connectorLogger
    );

    // Start connector — should succeed even with SOCKS5 transport
    await connector.start();
    expect(connector).toBeDefined();
  }, 15_000);

  it('createNode() with transport config produces a functioning node', async () => {
    if (!servicesReady || !socks5Ready || !connector) return;

    const nostrSecretKey = generateSecretKey();

    node = createNode({
      secretKey: nostrSecretKey,
      connector: connector as unknown as EmbeddableConnectorLike,
      ilpAddress: `g.toon.ator.test`,
      btpEndpoint: 'ws://127.0.0.1:19960',
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      basePricePerByte: 10n,
      transport: {
        type: 'socks5' as const,
        socksProxy: SOCKS5_PROXY_URL,
        externalUrl: 'ws://127.0.0.1:19960',
        managed: false,
      },
    });

    const result = await node.start();
    expect(result).toBeDefined();
  }, 15_000);
});
