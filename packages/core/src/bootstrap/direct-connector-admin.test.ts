/**
 * Tests for createDirectConnectorAdmin (direct / in-process admin client).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createDirectConnectorAdmin,
  type ConnectorAdminLike,
  type RegisterPeerParams,
} from './direct-connector-admin.js';
import { BootstrapError } from './BootstrapService.js';

/** Helper: build a mock ConnectorAdminLike */
function mockConnectorAdmin(
  registerError?: Error,
  removeError?: Error
): ConnectorAdminLike {
  const registerPeer = registerError
    ? vi.fn().mockRejectedValue(registerError)
    : vi.fn().mockResolvedValue(undefined);

  const removePeer = removeError
    ? vi.fn().mockRejectedValue(removeError)
    : vi.fn().mockResolvedValue(undefined);

  return { registerPeer, removePeer };
}

describe('createDirectConnectorAdmin', () => {
  it('should create a client with addPeer and removePeer functions', () => {
    const connector = mockConnectorAdmin();
    const client = createDirectConnectorAdmin(connector);

    expect(client).toBeDefined();
    expect(client.addPeer).toBeInstanceOf(Function);
    expect(client.removePeer).toBeInstanceOf(Function);
  });

  describe('addPeer', () => {
    it('should call connector.registerPeer() with all mapped params', async () => {
      const connector = mockConnectorAdmin();
      const client = createDirectConnectorAdmin(connector);

      await client.addPeer({
        id: 'peer1',
        url: 'btp+ws://peer1.example.com',
        authToken: 'secret123',
        routes: [{ prefix: 'g.alice', priority: 1 }],
        settlement: {
          preference: 'ethereum',
          evmAddress: '0xabc123',
          chainId: 1,
        },
      });

      expect(connector.registerPeer).toHaveBeenCalledWith({
        id: 'peer1',
        url: 'btp+ws://peer1.example.com',
        authToken: 'secret123',
        routes: [{ prefix: 'g.alice', priority: 1 }],
        settlement: {
          preference: 'ethereum',
          evmAddress: '0xabc123',
          chainId: 1,
        },
      });
    });

    it('should pass routes through correctly', async () => {
      const connector = mockConnectorAdmin();
      const client = createDirectConnectorAdmin(connector);

      const routes = [
        { prefix: 'g.alice' },
        { prefix: 'g.bob', priority: 5 },
      ];

      await client.addPeer({
        id: 'peer1',
        url: 'btp+ws://peer1.example.com',
        authToken: 'token',
        routes,
      });

      const callArgs = (connector.registerPeer as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as RegisterPeerParams;
      expect(callArgs.routes).toEqual(routes);
    });

    it('should pass settlement config through correctly', async () => {
      const connector = mockConnectorAdmin();
      const client = createDirectConnectorAdmin(connector);

      const settlement = {
        preference: 'raiden',
        tokenAddress: '0xtoken',
        tokenNetworkAddress: '0xnetwork',
        channelId: 'channel123',
        initialDeposit: '1000000',
      };

      await client.addPeer({
        id: 'peer2',
        url: 'btp+ws://peer2.example.com',
        authToken: 'token',
        settlement,
      });

      const callArgs = (connector.registerPeer as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as RegisterPeerParams;
      expect(callArgs.settlement).toEqual(settlement);
    });

    it('should handle missing optional fields (no routes, no settlement, no authToken)', async () => {
      const connector = mockConnectorAdmin();
      const client = createDirectConnectorAdmin(connector);

      await client.addPeer({
        id: 'minimal-peer',
        url: 'btp+ws://minimal.example.com',
        authToken: 'required-token',
      });

      const callArgs = (connector.registerPeer as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as RegisterPeerParams;
      expect(callArgs.id).toBe('minimal-peer');
      expect(callArgs.url).toBe('btp+ws://minimal.example.com');
      expect(callArgs.authToken).toBe('required-token');
      expect(callArgs.routes).toBeUndefined();
      expect(callArgs.settlement).toBeUndefined();
    });

    it('should wrap registerPeer errors in BootstrapError', async () => {
      const connector = mockConnectorAdmin(new Error('Network timeout'));
      const client = createDirectConnectorAdmin(connector);

      await expect(
        client.addPeer({
          id: 'peer1',
          url: 'btp+ws://peer1.example.com',
          authToken: 'token',
        })
      ).rejects.toThrow(BootstrapError);

      await expect(
        client.addPeer({
          id: 'peer1',
          url: 'btp+ws://peer1.example.com',
          authToken: 'token',
        })
      ).rejects.toThrow(/Failed to register peer peer1/);
    });

    it('should not double-wrap BootstrapError instances on registerPeer', async () => {
      const originalError = new BootstrapError('Already a BootstrapError');
      const connector = mockConnectorAdmin(originalError);
      const client = createDirectConnectorAdmin(connector);

      let caughtError: unknown;
      try {
        await client.addPeer({
          id: 'peer1',
          url: 'btp+ws://peer1.example.com',
          authToken: 'token',
        });
      } catch (error) {
        caughtError = error;
      }

      // Should be the exact same error instance, not wrapped
      expect(caughtError).toBe(originalError);
      expect(caughtError).toBeInstanceOf(BootstrapError);
      expect((caughtError as BootstrapError).message).toBe(
        'Already a BootstrapError'
      );
    });
  });

  describe('removePeer', () => {
    it('should call connector.removePeer() with the peerId', async () => {
      const connector = mockConnectorAdmin();
      const client = createDirectConnectorAdmin(connector);

      await client.removePeer!('peer-to-remove');

      expect(connector.removePeer).toHaveBeenCalledWith('peer-to-remove');
    });

    it('should wrap removePeer errors in BootstrapError', async () => {
      const connector = mockConnectorAdmin(undefined, new Error('Peer not found'));
      const client = createDirectConnectorAdmin(connector);

      await expect(client.removePeer!('unknown-peer')).rejects.toThrow(
        BootstrapError
      );

      await expect(client.removePeer!('unknown-peer')).rejects.toThrow(
        /Failed to remove peer unknown-peer/
      );
    });

    it('should not double-wrap BootstrapError instances on removePeer', async () => {
      const originalError = new BootstrapError('Already a BootstrapError');
      const connector = mockConnectorAdmin(undefined, originalError);
      const client = createDirectConnectorAdmin(connector);

      let caughtError: unknown;
      try {
        await client.removePeer!('peer1');
      } catch (error) {
        caughtError = error;
      }

      // Should be the exact same error instance, not wrapped
      expect(caughtError).toBe(originalError);
      expect(caughtError).toBeInstanceOf(BootstrapError);
      expect((caughtError as BootstrapError).message).toBe(
        'Already a BootstrapError'
      );
    });
  });
});
