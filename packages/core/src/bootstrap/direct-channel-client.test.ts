/**
 * Tests for createDirectChannelClient (direct / in-process channel client).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createDirectChannelClient,
  type ConnectorChannelLike,
} from './direct-channel-client.js';
import { BootstrapError } from './BootstrapService.js';

/** Helper: build a mock ConnectorChannelLike */
function mockConnectorChannel(
  openChannelResult?: { channelId: string; status: string },
  openChannelError?: Error,
  getChannelStateResult?: {
    channelId: string;
    status: 'opening' | 'open' | 'closed' | 'settled';
    chain: string;
  },
  getChannelStateError?: Error,
): ConnectorChannelLike {
  const openChannel = openChannelError
    ? vi.fn().mockRejectedValue(openChannelError)
    : vi.fn().mockResolvedValue(
        openChannelResult ?? { channelId: 'ch-001', status: 'opening' },
      );

  const getChannelState = getChannelStateError
    ? vi.fn().mockRejectedValue(getChannelStateError)
    : vi.fn().mockResolvedValue(
        getChannelStateResult ?? {
          channelId: 'ch-001',
          status: 'open' as const,
          chain: 'evm:base:84532',
        },
      );

  return { openChannel, getChannelState };
}

describe('createDirectChannelClient', () => {
  it('should create a client with openChannel and getChannelState functions', () => {
    const connector = mockConnectorChannel();
    const client = createDirectChannelClient(connector);

    expect(client).toBeDefined();
    expect(client.openChannel).toBeInstanceOf(Function);
    expect(client.getChannelState).toBeInstanceOf(Function);
  });

  describe('openChannel', () => {
    it('should call connector.openChannel() with all params', async () => {
      const connector = mockConnectorChannel({
        channelId: 'ch-abc',
        status: 'opening',
      });
      const client = createDirectChannelClient(connector);

      const result = await client.openChannel({
        peerId: 'nostr-54dad746e52dab00',
        chain: 'evm:base:84532',
        token: '0x39eaF99Cd4965A28DFe8B1455DD42aB49D0836B9',
        tokenNetwork: '0x733b89888eb811174018ce49d0eac0fa52b47554',
        peerAddress: '0x6AFbC48BDd',
        initialDeposit: '0',
        settlementTimeout: 86400,
      });

      expect(connector.openChannel).toHaveBeenCalledWith({
        peerId: 'nostr-54dad746e52dab00',
        chain: 'evm:base:84532',
        token: '0x39eaF99Cd4965A28DFe8B1455DD42aB49D0836B9',
        tokenNetwork: '0x733b89888eb811174018ce49d0eac0fa52b47554',
        peerAddress: '0x6AFbC48BDd',
        initialDeposit: '0',
        settlementTimeout: 86400,
      });

      expect(result.channelId).toBe('ch-abc');
      expect(result.status).toBe('opening');
    });

    it('should handle minimal params (no optional fields)', async () => {
      const connector = mockConnectorChannel({
        channelId: 'ch-min',
        status: 'opening',
      });
      const client = createDirectChannelClient(connector);

      await client.openChannel({
        peerId: 'peer1',
        chain: 'evm:base:84532',
        peerAddress: '0xabc123',
      });

      expect(connector.openChannel).toHaveBeenCalledWith({
        peerId: 'peer1',
        chain: 'evm:base:84532',
        peerAddress: '0xabc123',
      });
    });

    it('should wrap openChannel errors in BootstrapError', async () => {
      const connector = mockConnectorChannel(
        undefined,
        new Error('Channel manager not initialized'),
      );
      const client = createDirectChannelClient(connector);

      await expect(
        client.openChannel({
          peerId: 'peer1',
          chain: 'evm:base:84532',
          peerAddress: '0xabc',
        }),
      ).rejects.toThrow(BootstrapError);

      await expect(
        client.openChannel({
          peerId: 'peer1',
          chain: 'evm:base:84532',
          peerAddress: '0xabc',
        }),
      ).rejects.toThrow(/Failed to open channel for peer peer1/);
    });

    it('should not double-wrap BootstrapError instances', async () => {
      const originalError = new BootstrapError('Already a BootstrapError');
      const connector = mockConnectorChannel(undefined, originalError);
      const client = createDirectChannelClient(connector);

      let caughtError: unknown;
      try {
        await client.openChannel({
          peerId: 'peer1',
          chain: 'evm:base:84532',
          peerAddress: '0xabc',
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBe(originalError);
      expect(caughtError).toBeInstanceOf(BootstrapError);
      expect((caughtError as BootstrapError).message).toBe(
        'Already a BootstrapError',
      );
    });
  });

  describe('getChannelState', () => {
    it('should call connector.getChannelState() with channelId', async () => {
      const connector = mockConnectorChannel(undefined, undefined, {
        channelId: 'ch-001',
        status: 'open',
        chain: 'evm:base:84532',
      });
      const client = createDirectChannelClient(connector);

      const result = await client.getChannelState('ch-001');

      expect(connector.getChannelState).toHaveBeenCalledWith('ch-001');
      expect(result.channelId).toBe('ch-001');
      expect(result.status).toBe('open');
      expect(result.chain).toBe('evm:base:84532');
    });

    it('should return opening status correctly', async () => {
      const connector = mockConnectorChannel(undefined, undefined, {
        channelId: 'ch-002',
        status: 'opening',
        chain: 'evm:base:84532',
      });
      const client = createDirectChannelClient(connector);

      const result = await client.getChannelState('ch-002');

      expect(result.status).toBe('opening');
    });

    it('should wrap getChannelState errors in BootstrapError', async () => {
      const connector = mockConnectorChannel(
        undefined,
        undefined,
        undefined,
        new Error('Channel not found'),
      );
      const client = createDirectChannelClient(connector);

      await expect(client.getChannelState('ch-unknown')).rejects.toThrow(
        BootstrapError,
      );

      await expect(client.getChannelState('ch-unknown')).rejects.toThrow(
        /Failed to get channel state for ch-unknown/,
      );
    });

    it('should not double-wrap BootstrapError instances', async () => {
      const originalError = new BootstrapError('Already a BootstrapError');
      const connector = mockConnectorChannel(
        undefined,
        undefined,
        undefined,
        originalError,
      );
      const client = createDirectChannelClient(connector);

      let caughtError: unknown;
      try {
        await client.getChannelState('ch-001');
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBe(originalError);
      expect(caughtError).toBeInstanceOf(BootstrapError);
      expect((caughtError as BootstrapError).message).toBe(
        'Already a BootstrapError',
      );
    });
  });
});
