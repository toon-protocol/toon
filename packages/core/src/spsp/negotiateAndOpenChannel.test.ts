import { describe, it, expect, vi } from 'vitest';
import { negotiateAndOpenChannel } from './negotiateAndOpenChannel.js';
import type { ConnectorChannelClient, SettlementNegotiationConfig } from '../types.js';

function createMockChannelClient(overrides?: Partial<ConnectorChannelClient>): ConnectorChannelClient {
  return {
    openChannel: vi.fn().mockResolvedValue({ channelId: '0xCHANNEL1', status: 'opening' }),
    getChannelState: vi.fn().mockResolvedValue({ channelId: '0xCHANNEL1', status: 'open', chain: 'evm:base:8453' }),
    ...overrides,
  };
}

function createSettlementConfig(overrides?: Partial<SettlementNegotiationConfig>): SettlementNegotiationConfig {
  return {
    ownSupportedChains: ['evm:base:8453'],
    ownSettlementAddresses: { 'evm:base:8453': '0xOWN_ADDRESS' },
    ownPreferredTokens: { 'evm:base:8453': '0xTOKEN' },
    ownTokenNetworks: { 'evm:base:8453': '0xTOKEN_NETWORK' },
    initialDeposit: '0',
    settlementTimeout: 86400,
    channelOpenTimeout: 5000,
    pollInterval: 10,
    ...overrides,
  };
}

const SENDER_PUBKEY = 'a'.repeat(64);

describe('negotiateAndOpenChannel', () => {
  it('returns SettlementNegotiationResult when chains match and channel opens', async () => {
    const channelClient = createMockChannelClient();
    const config = createSettlementConfig();

    const result = await negotiateAndOpenChannel({
      request: {
        requestId: 'req-1',
        timestamp: Date.now(),
        supportedChains: ['evm:base:8453'],
        settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
        preferredTokens: { 'evm:base:8453': '0xTOKEN' },
      },
      config,
      channelClient,
      senderPubkey: SENDER_PUBKEY,
    });

    expect(result).toEqual({
      negotiatedChain: 'evm:base:8453',
      settlementAddress: '0xOWN_ADDRESS',
      tokenAddress: '0xTOKEN',
      tokenNetworkAddress: '0xTOKEN_NETWORK',
      channelId: '0xCHANNEL1',
      settlementTimeout: 86400,
    });

    expect(channelClient.openChannel).toHaveBeenCalledWith({
      peerId: `nostr-${SENDER_PUBKEY.slice(0, 16)}`,
      chain: 'evm:base:8453',
      token: '0xTOKEN',
      tokenNetwork: '0xTOKEN_NETWORK',
      peerAddress: '0xPEER_ADDR',
      initialDeposit: '0',
      settlementTimeout: 86400,
    });
  });

  it('returns null when no chain intersection', async () => {
    const channelClient = createMockChannelClient();
    const config = createSettlementConfig({ ownSupportedChains: ['xrp:mainnet'] });

    const result = await negotiateAndOpenChannel({
      request: {
        requestId: 'req-2',
        timestamp: Date.now(),
        supportedChains: ['evm:base:8453'],
        settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
      },
      config,
      channelClient,
      senderPubkey: SENDER_PUBKEY,
    });

    expect(result).toBeNull();
    expect(channelClient.openChannel).not.toHaveBeenCalled();
  });

  it('returns null when peer has no address for negotiated chain', async () => {
    const channelClient = createMockChannelClient();
    const config = createSettlementConfig();

    const result = await negotiateAndOpenChannel({
      request: {
        requestId: 'req-3',
        timestamp: Date.now(),
        supportedChains: ['evm:base:8453'],
        // No settlementAddresses for evm:base:8453
        settlementAddresses: {},
      },
      config,
      channelClient,
      senderPubkey: SENDER_PUBKEY,
    });

    expect(result).toBeNull();
    expect(channelClient.openChannel).not.toHaveBeenCalled();
  });

  it('throws when channelClient.openChannel() fails', async () => {
    const channelClient = createMockChannelClient({
      openChannel: vi.fn().mockRejectedValue(new Error('Failed to open channel: 500')),
    });
    const config = createSettlementConfig();

    await expect(
      negotiateAndOpenChannel({
        request: {
          requestId: 'req-4',
          timestamp: Date.now(),
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
        },
        config,
        channelClient,
        senderPubkey: SENDER_PUBKEY,
      })
    ).rejects.toThrow('Failed to open channel: 500');
  });

  it('throws when channel open times out', async () => {
    const channelClient = createMockChannelClient({
      getChannelState: vi.fn().mockResolvedValue({ channelId: '0xCH', status: 'opening', chain: 'evm:base:8453' }),
    });
    const config = createSettlementConfig({
      channelOpenTimeout: 50,
      pollInterval: 10,
    });

    await expect(
      negotiateAndOpenChannel({
        request: {
          requestId: 'req-5',
          timestamp: Date.now(),
          supportedChains: ['evm:base:8453'],
          settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
        },
        config,
        channelClient,
        senderPubkey: SENDER_PUBKEY,
      })
    ).rejects.toThrow('did not reach open status');
  });

  it('polls getChannelState() until status is "open"', async () => {
    const getChannelState = vi.fn()
      .mockResolvedValueOnce({ channelId: '0xCH', status: 'opening', chain: 'evm:base:8453' })
      .mockResolvedValueOnce({ channelId: '0xCH', status: 'opening', chain: 'evm:base:8453' })
      .mockResolvedValueOnce({ channelId: '0xCH', status: 'open', chain: 'evm:base:8453' });

    const channelClient = createMockChannelClient({ getChannelState });
    const config = createSettlementConfig({ pollInterval: 10 });

    const result = await negotiateAndOpenChannel({
      request: {
        requestId: 'req-6',
        timestamp: Date.now(),
        supportedChains: ['evm:base:8453'],
        settlementAddresses: { 'evm:base:8453': '0xPEER_ADDR' },
      },
      config,
      channelClient,
      senderPubkey: SENDER_PUBKEY,
    });

    expect(result).not.toBeNull();
    expect(result).toEqual(expect.objectContaining({ channelId: '0xCHANNEL1' }));
    expect(getChannelState).toHaveBeenCalledTimes(3);
  });

  it('returns null when request has no supportedChains', async () => {
    const channelClient = createMockChannelClient();
    const config = createSettlementConfig();

    const result = await negotiateAndOpenChannel({
      request: {
        requestId: 'req-7',
        timestamp: Date.now(),
        // No supportedChains
      },
      config,
      channelClient,
      senderPubkey: SENDER_PUBKEY,
    });

    expect(result).toBeNull();
    expect(channelClient.openChannel).not.toHaveBeenCalled();
  });
});
