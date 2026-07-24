import { describe, it, expect, vi } from 'vitest';
import type { EmbeddableConnectorLike } from '@toon-protocol/core';
import { createNode, type NodeConfig } from './index.js';

// ATDD tests for Story 1.8 -- connector direct methods API

/**
 * Narrows a possibly-null/undefined connector to EmbeddableConnectorLike.
 * Both `node.connector` (ConnectorApi | null) and `config.connector`
 * (optional on NodeConfig) are always set in these tests via
 * createTestConfig()/createMockConnector(); this asserts that invariant
 * without a non-null assertion (`!`), which the lint gate forbids here.
 */
function requireConnector(
  connector: EmbeddableConnectorLike | null | undefined
): EmbeddableConnectorLike {
  if (!connector) {
    throw new Error('expected connector to be defined');
  }
  return connector;
}

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
  it('[P2] node.connector exposes registerPeer method', () => {
    // Arrange
    const config = createTestConfig();

    // Act
    const node = createNode(config);

    // Assert
    expect(node.connector).toBeDefined();
    const connector = requireConnector(node.connector);
    expect(typeof connector.registerPeer).toBe('function');
  });

  it('[P2] node.connector exposes removePeer method', () => {
    // Arrange
    const config = createTestConfig();

    // Act
    const node = createNode(config);

    // Assert
    const connector = requireConnector(node.connector);
    expect(typeof connector.removePeer).toBe('function');
  });

  it('[P2] node.channelClient is null when connector lacks channel support', () => {
    // Arrange
    const config = createTestConfig(); // No openChannel/getChannelState

    // Act
    const node = createNode(config);

    // Assert
    expect(node.channelClient).toBeNull();
  });

  it('[P2] node.channelClient is available when connector has channel methods', () => {
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

  it('[P2] node.connector exposes sendPacket method', () => {
    // Arrange
    const config = createTestConfig();

    // Act
    const node = createNode(config);

    // Assert
    const connector = requireConnector(node.connector);
    expect(typeof connector.sendPacket).toBe('function');
  });

  // ---------------------------------------------------------------------------
  // Gap-filling tests: pass-through invocation and wrapping verification
  // ---------------------------------------------------------------------------

  it('[P2] node.connector is the same object reference as config.connector (no wrapping)', () => {
    // Arrange
    const config = createTestConfig();

    // Act
    const node = createNode(config);

    // Assert -- identity check proves no wrapper/proxy was introduced
    expect(node.connector).toBe(config.connector);
  });

  it('[P2] node.connector.registerPeer delegates to the underlying connector', async () => {
    // Arrange
    const config = createTestConfig();
    const node = createNode(config);
    const params = {
      id: 'test-peer-1',
      url: 'btp+wss://peer1.example.com',
      authToken: 'secret-token',
    };

    // Act
    const connector = requireConnector(node.connector);
    await connector.registerPeer(params);

    // Assert
    const configConnector = requireConnector(config.connector);
    expect(configConnector.registerPeer).toHaveBeenCalledWith(params);
    expect(configConnector.registerPeer).toHaveBeenCalledTimes(1);
  });

  it('[P2] node.connector.removePeer delegates to the underlying connector', async () => {
    // Arrange
    const config = createTestConfig();
    const node = createNode(config);

    // Act
    const connector = requireConnector(node.connector);
    await connector.removePeer('peer-to-remove');

    // Assert
    const configConnector = requireConnector(config.connector);
    expect(configConnector.removePeer).toHaveBeenCalledWith('peer-to-remove');
    expect(configConnector.removePeer).toHaveBeenCalledTimes(1);
  });

  it('[P2] node.connector.sendPacket delegates to the underlying connector', async () => {
    // Arrange
    const config = createTestConfig();
    const node = createNode(config);
    const params = {
      destination: 'g.test.destination',
      amount: 1000n,
      data: new Uint8Array([0x01, 0x02, 0x03]),
    };

    // Act
    const connector = requireConnector(node.connector);
    const result = await connector.sendPacket(params);

    // Assert
    const configConnector = requireConnector(config.connector);
    expect(configConnector.sendPacket).toHaveBeenCalledWith(params);
    expect(configConnector.sendPacket).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      type: 'fulfill',
      fulfillment: new Uint8Array(32),
    });
  });

  it('[P2] node.channelClient.openChannel delegates to connector and returns result', async () => {
    // Arrange
    const openChannelMock = vi
      .fn()
      .mockResolvedValue({ channelId: 'ch-42', status: 'open' });
    const getChannelStateMock = vi.fn().mockResolvedValue({
      channelId: 'ch-42',
      status: 'open',
      chain: 'evm:base:31337',
    });
    const config = createTestConfig({
      openChannel: openChannelMock,
      getChannelState: getChannelStateMock,
    });
    const node = createNode(config);
    const params = {
      peerId: 'test-peer-1',
      chain: 'evm:base:31337',
      peerAddress: '0x1234567890abcdef1234567890abcdef12345678',
    };

    // Act
    const result = await node.channelClient!.openChannel(params);

    // Assert
    expect(openChannelMock).toHaveBeenCalledWith(params);
    expect(openChannelMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ channelId: 'ch-42', status: 'open' });
  });

  it('[P2] node.channelClient.getChannelState delegates to connector and returns result', async () => {
    // Arrange
    const openChannelMock = vi
      .fn()
      .mockResolvedValue({ channelId: 'ch-42', status: 'open' });
    const getChannelStateMock = vi.fn().mockResolvedValue({
      channelId: 'ch-42',
      status: 'open',
      chain: 'evm:base:31337',
    });
    const config = createTestConfig({
      openChannel: openChannelMock,
      getChannelState: getChannelStateMock,
    });
    const node = createNode(config);

    // Act
    const result = await node.channelClient!.getChannelState('ch-42');

    // Assert
    expect(getChannelStateMock).toHaveBeenCalledWith('ch-42');
    expect(getChannelStateMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      channelId: 'ch-42',
      status: 'open',
      chain: 'evm:base:31337',
    });
  });

  it('[P2] node.channelClient is null when connector has openChannel but lacks getChannelState', () => {
    // Arrange -- only one of the two required methods present
    const config = createTestConfig({
      openChannel: vi
        .fn()
        .mockResolvedValue({ channelId: 'ch-1', status: 'open' }),
      // intentionally no getChannelState
    });

    // Act
    const node = createNode(config);

    // Assert -- both methods must be present for channelClient to be non-null
    expect(node.channelClient).toBeNull();
  });

  it('[P2] node.channelClient is null when connector has getChannelState but lacks openChannel', () => {
    // Arrange -- only one of the two required methods present
    const config = createTestConfig({
      // intentionally no openChannel
      getChannelState: vi.fn().mockResolvedValue({
        channelId: 'ch-1',
        status: 'open',
        chain: 'evm:base:31337',
      }),
    });

    // Act
    const node = createNode(config);

    // Assert -- both methods must be present for channelClient to be non-null
    expect(node.channelClient).toBeNull();
  });
});
