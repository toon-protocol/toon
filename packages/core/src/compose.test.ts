/**
 * Integration tests for Agent Society Node composition API.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { createAgentSocietyNode } from './compose.js';
import type {
  AgentSocietyNodeConfig,
  EmbeddableConnectorLike,
  HandlePacketRequest,
  HandlePacketAcceptResponse,
  PacketHandler,
} from './compose.js';
import type { IlpPeerInfo } from './types.js';
import { BootstrapService } from './bootstrap/BootstrapService.js';
import { RelayMonitor } from './bootstrap/RelayMonitor.js';

describe('createAgentSocietyNode', () => {
  let mockConnector: EmbeddableConnectorLike;
  let mockHandlePacket: Mock;
  let baseConfig: AgentSocietyNodeConfig;

  beforeEach(() => {
    // Create mock connector
    mockConnector = {
      sendPacket: vi.fn().mockResolvedValue({
        type: 'fulfill',
        fulfillment: new Uint8Array(32),
      }),
      registerPeer: vi.fn().mockResolvedValue(undefined),
      removePeer: vi.fn().mockResolvedValue(undefined),
      setPacketHandler: vi.fn(),
    };

    // Create mock packet handler
    mockHandlePacket = vi.fn().mockReturnValue({
      accept: true,
      fulfillment: Buffer.from('a'.repeat(64), 'hex').toString('base64'),
    });

    // Base configuration for tests
    const secretKey = new Uint8Array(32);
    secretKey.fill(0x42);

    const ilpInfo: IlpPeerInfo = {
      ilpAddress: 'g.test.node',
      btpEndpoint: 'btp+ws://localhost:7000',
      assetCode: 'USD',
      assetScale: 6,
    };

    baseConfig = {
      connector: mockConnector,
      handlePacket: mockHandlePacket as unknown as PacketHandler,
      secretKey,
      ilpInfo,
      toonEncoder: (event: NostrEvent) => Buffer.from(JSON.stringify(event)),
      toonDecoder: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()) as NostrEvent,
      relayUrl: 'ws://localhost:7100',
      knownPeers: [], // Empty to avoid network calls
      ardriveEnabled: false, // Disable ArDrive to avoid HTTP requests
    };
  });

  it('returns an object with start, stop, bootstrapService, relayMonitor', () => {
    const node = createAgentSocietyNode(baseConfig);

    expect(node).toHaveProperty('start');
    expect(node).toHaveProperty('stop');
    expect(node).toHaveProperty('bootstrapService');
    expect(node).toHaveProperty('relayMonitor');
    expect(typeof node.start).toBe('function');
    expect(typeof node.stop).toBe('function');
  });

  it('start() calls connector.setPacketHandler() with the provided handlePacket callback', async () => {
    const node = createAgentSocietyNode(baseConfig);

    await node.start();

    expect(mockConnector.setPacketHandler).toHaveBeenCalledTimes(1);
    expect(mockConnector.setPacketHandler).toHaveBeenCalledWith(mockHandlePacket);
  });

  it('start() calls bootstrapService.bootstrap() and returns results', async () => {
    const node = createAgentSocietyNode(baseConfig);

    const result = await node.start();

    expect(result).toHaveProperty('bootstrapResults');
    expect(result).toHaveProperty('peerCount');
    expect(result).toHaveProperty('channelCount');
    expect(Array.isArray(result.bootstrapResults)).toBe(true);
    expect(result.peerCount).toBe(0); // No known peers
    expect(result.channelCount).toBe(0); // No channels
  });

  it('start() returns AgentSocietyNodeStartResult with peerCount and channelCount', async () => {
    const node = createAgentSocietyNode(baseConfig);

    const result = await node.start();

    expect(result.peerCount).toBe(0);
    expect(result.channelCount).toBe(0);
  });

  it('start() called twice throws BootstrapError (double-start guard)', async () => {
    const node = createAgentSocietyNode(baseConfig);

    await node.start();

    await expect(node.start()).rejects.toThrow('AgentSocietyNode already started');
  });

  it('stop() unsubscribes the relay monitor subscription', async () => {
    const node = createAgentSocietyNode(baseConfig);

    // Spy on relayMonitor.start to capture the returned subscription
    const unsubscribeSpy = vi.fn();
    vi.spyOn(node.relayMonitor, 'start').mockReturnValue({
      unsubscribe: unsubscribeSpy,
    });

    await node.start();
    await node.stop();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('stop() is safe to call when not started (no-op)', async () => {
    const node = createAgentSocietyNode(baseConfig);

    // Call stop without calling start
    await expect(node.stop()).resolves.toBeUndefined();
  });

  it('direct runtime client is wired correctly to bootstrapService', () => {
    const setClientSpy = vi.spyOn(BootstrapService.prototype, 'setAgentRuntimeClient');

    createAgentSocietyNode(baseConfig);

    expect(setClientSpy).toHaveBeenCalledTimes(1);
    expect(setClientSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sendIlpPacket: expect.any(Function) }),
    );

    setClientSpy.mockRestore();
  });

  it('direct admin client is wired correctly to bootstrapService', () => {
    const setAdminSpy = vi.spyOn(BootstrapService.prototype, 'setConnectorAdmin');

    createAgentSocietyNode(baseConfig);

    expect(setAdminSpy).toHaveBeenCalledTimes(1);
    expect(setAdminSpy).toHaveBeenCalledWith(
      expect.objectContaining({ addPeer: expect.any(Function), removePeer: expect.any(Function) }),
    );

    setAdminSpy.mockRestore();
  });

  it('start() passes bootstrapped peer pubkeys as excludePubkeys to relayMonitor.start()', async () => {
    const node = createAgentSocietyNode(baseConfig);

    // Spy on relayMonitor.start to check the excludePubkeys parameter
    const startSpy = vi.spyOn(node.relayMonitor, 'start');

    await node.start();

    // Should be called with empty array since no peers were bootstrapped
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith([]);
  });

  it('handles bootstrap errors gracefully (wraps in BootstrapError)', async () => {
    // Create a config that will cause bootstrap to fail
    const failingConfig = {
      ...baseConfig,
      connector: {
        ...mockConnector,
        setPacketHandler: vi.fn(() => {
          throw new Error('Connector failure');
        }),
      },
    };

    const node = createAgentSocietyNode(failingConfig);

    await expect(node.start()).rejects.toThrow('Failed to start AgentSocietyNode');
  });

  it('allows attaching event listeners before start()', async () => {
    const node = createAgentSocietyNode(baseConfig);

    const bootstrapListener = vi.fn();
    const relayListener = vi.fn();

    // Attach listeners before start
    node.bootstrapService.on(bootstrapListener);
    node.relayMonitor.on(relayListener);

    await node.start();

    // Listeners should be registered (we can't verify they're called without
    // triggering events, but we can verify they don't throw)
    expect(bootstrapListener).toBeDefined();
    expect(relayListener).toBeDefined();
  });

  it('uses default values for optional config parameters', async () => {
    const testSecretKey = new Uint8Array(32);
    testSecretKey.fill(0x42); // Valid non-zero secret key

    const minimalConfig: AgentSocietyNodeConfig = {
      connector: mockConnector,
      handlePacket: mockHandlePacket as unknown as PacketHandler,
      secretKey: testSecretKey,
      ilpInfo: {
        ilpAddress: 'g.test',
        btpEndpoint: 'btp+ws://localhost:7000',
        assetCode: 'USD',
        assetScale: 6,
      },
      toonEncoder: (event: NostrEvent) => Buffer.from(JSON.stringify(event)),
      toonDecoder: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()) as NostrEvent,
      ardriveEnabled: false, // Disable to avoid network calls
    };

    const node = createAgentSocietyNode(minimalConfig);

    await expect(node.start()).resolves.toBeDefined();
  });

  it('passes through all config parameters to BootstrapService', () => {
    const customConfig: AgentSocietyNodeConfig = {
      ...baseConfig,
      basePricePerByte: 42n,
      queryTimeout: 10000,
      defaultRelayUrl: 'ws://custom-relay:7200',
    };

    const node = createAgentSocietyNode(customConfig);

    // Verify node is created successfully with custom config
    expect(node).toBeDefined();
    expect(node.bootstrapService).toBeDefined();
  });

  it('passes through config parameters to RelayMonitor', () => {
    const customConfig: AgentSocietyNodeConfig = {
      ...baseConfig,
      relayUrl: 'ws://custom-relay:7300',
      basePricePerByte: 99n,
    };

    const node = createAgentSocietyNode(customConfig);

    // Verify node is created successfully with custom config
    expect(node).toBeDefined();
    expect(node.relayMonitor).toBeDefined();
  });

  it('channelClient is null when connector lacks openChannel/getChannelState', () => {
    const node = createAgentSocietyNode(baseConfig);
    expect(node.channelClient).toBeNull();
  });

  it('channelClient is created when connector has openChannel and getChannelState', () => {
    const connectorWithChannels = {
      ...mockConnector,
      openChannel: vi.fn().mockResolvedValue({ channelId: 'ch-1', status: 'open' }),
      getChannelState: vi.fn().mockResolvedValue({
        channelId: 'ch-1',
        status: 'open' as const,
        chain: 'evm:base:84532',
      }),
    };

    const node = createAgentSocietyNode({
      ...baseConfig,
      connector: connectorWithChannels,
    });

    expect(node.channelClient).not.toBeNull();
    expect(node.channelClient!.openChannel).toBeInstanceOf(Function);
    expect(node.channelClient!.getChannelState).toBeInstanceOf(Function);
  });

  it('channelClient delegates to connector openChannel/getChannelState', async () => {
    const openChannelResult = { channelId: 'ch-test', status: 'opening' };
    const channelState = { channelId: 'ch-test', status: 'open' as const, chain: 'evm:base:84532' };

    const connectorWithChannels = {
      ...mockConnector,
      openChannel: vi.fn().mockResolvedValue(openChannelResult),
      getChannelState: vi.fn().mockResolvedValue(channelState),
    };

    const node = createAgentSocietyNode({
      ...baseConfig,
      connector: connectorWithChannels,
    });

    const openResult = await node.channelClient!.openChannel({
      peerId: 'nostr-abc123',
      chain: 'evm:base:84532',
      peerAddress: '0x123',
    });
    expect(openResult).toEqual(openChannelResult);
    expect(connectorWithChannels.openChannel).toHaveBeenCalledWith({
      peerId: 'nostr-abc123',
      chain: 'evm:base:84532',
      peerAddress: '0x123',
    });

    const state = await node.channelClient!.getChannelState('ch-test');
    expect(state).toEqual(channelState);
    expect(connectorWithChannels.getChannelState).toHaveBeenCalledWith('ch-test');
  });
});
