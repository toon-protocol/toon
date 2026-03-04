// @ts-nocheck — ATDD Red Phase: imports reference exports that don't exist yet
import { describe, it, expect, vi } from 'vitest';
import { createNode, type NodeConfig } from './index.js';

// ATDD Red Phase - tests will fail until implementation exists

/**
 * Creates a minimal mock connector for testing the API surface.
 */
function createMockConnector(overrides: Record<string, unknown> = {}) {
  return {
    sendPacket: vi
      .fn()
      .mockResolvedValue({ type: 'fulfill', fulfillment: new Uint8Array(32) }),
    registerPeer: vi.fn().mockResolvedValue(undefined),
    removePeer: vi.fn().mockResolvedValue(undefined),
    setPacketHandler: vi.fn(),
    ...overrides,
  };
}

/**
 * Creates a minimal NodeConfig for testing.
 */
function createTestConfig(
  connectorOverrides: Record<string, unknown> = {}
): NodeConfig {
  const secretKey = new Uint8Array(32);
  secretKey.fill(0x42);

  return {
    secretKey,
    connector: createMockConnector(connectorOverrides),
    ilpAddress: 'g.test.node',
    assetCode: 'USD',
    assetScale: 6,
  };
}

describe('Connector Direct Methods API', () => {
  it.skip('[P0] node.connector exposes registerPeer method', () => {
    // Arrange
    const config = createTestConfig();

    // Act
    const node = createNode(config);

    // Assert
    expect(node.connector).toBeDefined();
    expect(typeof node.connector.registerPeer).toBe('function');
  });

  it.skip('[P0] node.connector exposes removePeer method', () => {
    // Arrange
    const config = createTestConfig();

    // Act
    const node = createNode(config);

    // Assert
    expect(typeof node.connector.removePeer).toBe('function');
  });

  it.skip('[P1] node.channelClient is null when connector lacks channel support', () => {
    // Arrange
    const config = createTestConfig(); // No openChannel/getChannelState

    // Act
    const node = createNode(config);

    // Assert
    expect(node.channelClient).toBeNull();
  });

  it.skip('[P1] node.channelClient is available when connector has channel methods', () => {
    // Arrange
    const config = createTestConfig({
      openChannel: vi
        .fn()
        .mockResolvedValue({ channelId: 'ch-1', status: 'open' }),
      getChannelState: vi.fn().mockResolvedValue({
        channelId: 'ch-1',
        status: 'open',
        chain: 'evm:base:31337',
      }),
    });

    // Act
    const node = createNode(config);

    // Assert
    expect(node.channelClient).not.toBeNull();
    expect(typeof node.channelClient!.openChannel).toBe('function');
    expect(typeof node.channelClient!.getChannelState).toBe('function');
  });
});
