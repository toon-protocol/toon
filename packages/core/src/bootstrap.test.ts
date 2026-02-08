/**
 * Tests for BootstrapService
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { BootstrapService, BootstrapError } from './bootstrap.js';
import type { ConnectorAdminClient, KnownPeer } from './bootstrap.js';
import { ILP_PEER_INFO_KIND } from './constants.js';
import type { IlpPeerInfo } from './types.js';

// Mock discovery module
vi.mock('./discovery/index.js', () => ({
  GenesisPeerLoader: {
    loadAllPeers: vi.fn(() => []),
  },
  ArDrivePeerRegistry: {
    fetchPeers: vi.fn(async () => new Map()),
  },
}));

// Mock WebSocket
vi.mock('ws', () => {
  const MockWebSocket = vi.fn();
  MockWebSocket.prototype.on = vi.fn();
  MockWebSocket.prototype.send = vi.fn();
  MockWebSocket.prototype.close = vi.fn();
  return { default: MockWebSocket };
});

// Mock SimplePool
vi.mock('nostr-tools/pool', () => ({
  SimplePool: vi.fn(() => ({
    publish: vi.fn(async () => []),
    querySync: vi.fn(async () => []),
  })),
}));

// Import mocked modules after mock setup
import { GenesisPeerLoader, ArDrivePeerRegistry } from './discovery/index.js';
import WebSocket from 'ws';

describe('BootstrapService', () => {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  const ownIlpInfo: IlpPeerInfo = {
    ilpAddress: 'g.test.me',
    btpEndpoint: 'ws://localhost:3000',
    assetCode: 'USD',
    assetScale: 6,
  };

  // Valid 64-char hex pubkey for test peers
  const peerPubkey = 'a'.repeat(64);

  const validPeerInfo: IlpPeerInfo = {
    ilpAddress: 'g.test.peer',
    btpEndpoint: 'ws://peer:3000',
    assetCode: 'USD',
    assetScale: 6,
  };

  let mockAdmin: ConnectorAdminClient;

  function makeKnownPeer(pk: string = peerPubkey): KnownPeer {
    return {
      pubkey: pk,
      relayUrl: 'ws://localhost:7000',
      btpEndpoint: 'ws://peer:3000',
    };
  }

  /**
   * Helper to set up WebSocket mock to simulate relay responses.
   * Returns the EVENT and EOSE messages for a peer info query.
   */
  function setupWebSocketMock(peerInfo: IlpPeerInfo, authorPubkey: string) {
    (WebSocket as unknown as Mock).mockImplementation(function (this: Record<string, (...args: unknown[]) => void>) {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      this.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      });
      this.send = vi.fn(() => {
        // After REQ is sent, simulate EVENT then EOSE
        const subId = 'bootstrap-' + Date.now();
        const nostrEvent = {
          id: 'e'.repeat(64),
          pubkey: authorPubkey,
          created_at: Math.floor(Date.now() / 1000),
          kind: ILP_PEER_INFO_KIND,
          tags: [],
          content: JSON.stringify(peerInfo),
          sig: 'f'.repeat(128),
        };

        // Simulate async relay messages
        setTimeout(() => {
          // We need to extract the actual subId from the REQ message
          const sendCalls = (this.send as Mock).mock.calls;
          const reqMsg = sendCalls.length > 0 ? JSON.parse(sendCalls[0][0] as string) : null;
          const actualSubId = reqMsg ? reqMsg[1] : subId;

          if (handlers['message']) {
            handlers['message'](Buffer.from(JSON.stringify(['EVENT', actualSubId, nostrEvent])));
            handlers['message'](Buffer.from(JSON.stringify(['EOSE', actualSubId])));
          }
        }, 10);
      });
      this.close = vi.fn();

      // Simulate connection opening
      setTimeout(() => {
        if (handlers['open']) handlers['open']();
      }, 5);

      return this;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdmin = {
      addPeer: vi.fn().mockResolvedValue(undefined),
    };
    (GenesisPeerLoader.loadAllPeers as Mock).mockReturnValue([]);
    (ArDrivePeerRegistry.fetchPeers as Mock).mockResolvedValue(new Map());
  });

  describe('constructor', () => {
    it('should create instance with valid config', () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      expect(service.getPubkey()).toBe(pubkey);
    });

    it('should set default config values', () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      expect(service).toBeDefined();
    });
  });

  describe('bootstrap', () => {
    it('should call queryPeerInfo and addPeerToConnector for each genesis peer (no SPSP handshake)', async () => {
      const genesisPeer = {
        pubkey: peerPubkey,
        relayUrl: 'ws://localhost:7000',
        ilpAddress: 'g.test.peer',
        btpEndpoint: 'ws://peer:3000',
      };
      (GenesisPeerLoader.loadAllPeers as Mock).mockReturnValue([genesisPeer]);

      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);

      const results = await service.bootstrap();

      expect(results.length).toBe(1);
      expect(results[0].peerInfo).toEqual(validPeerInfo);
      expect(mockAdmin.addPeer).toHaveBeenCalled();
      // Verify no SPSP-related properties
      expect((results[0] as Record<string, unknown>)['spspInfo']).toBeUndefined();
    });

    it('should return empty array when no known peers', async () => {
      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      const results = await service.bootstrap();

      expect(results).toEqual([]);
    });
  });

  describe('ConnectorAdminClient.addPeer', () => {
    it('should be called with correct config shape { id, url, authToken, routes }', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);

      await service.bootstrap();

      expect(mockAdmin.addPeer).toHaveBeenCalledWith({
        id: `nostr-${peerPubkey.slice(0, 16)}`,
        url: validPeerInfo.btpEndpoint,
        authToken: '',
        routes: [{ prefix: validPeerInfo.ilpAddress }],
      });
    });
  });

  describe('BootstrapResult', () => {
    it('should not include spspInfo field', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);

      const results = await service.bootstrap();

      expect(results.length).toBe(1);
      expect(Object.keys(results[0])).not.toContain('spspInfo');
    });

    it('should include registeredPeerId field', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);

      const results = await service.bootstrap();

      expect(results.length).toBe(1);
      expect(results[0].registeredPeerId).toBe(`nostr-${peerPubkey.slice(0, 16)}`);
    });
  });

  describe('non-fatal failures', () => {
    it('should log and skip failed peer registration', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
      setupWebSocketMock(validPeerInfo, peerPubkey);

      const failingAdmin: ConnectorAdminClient = {
        addPeer: vi.fn(async () => { throw new Error('Admin API down'); }),
      };

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(failingAdmin);

      const results = await service.bootstrap();

      // Should still return a result (non-fatal)
      expect(results.length).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to register peer'),
        expect.any(String)
      );

      warnSpy.mockRestore();
    });

    it('should log and skip failed kind:10032 publish', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      // Set up WS mock for queryPeerInfo
      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      // Make publishOurInfo fail by making pool.publish throw
      // Access the pool via a workaround: the pool's publish method
      const poolPublishSpy = vi.fn(async () => { throw new Error('Publish failed'); });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).pool.publish = poolPublishSpy;

      const results = await service.bootstrap();

      // Should still return a result (non-fatal)
      expect(results.length).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to publish ILP info'),
        expect.any(String)
      );

      warnSpy.mockRestore();
    });
  });

  describe('loadPeers', () => {
    it('should merge genesis + ArDrive peers, deduplicating by pubkey', async () => {
      const genesisPeer = {
        pubkey: peerPubkey,
        relayUrl: 'ws://genesis-relay:7000',
        ilpAddress: 'g.genesis.peer',
        btpEndpoint: 'ws://genesis:3000',
      };
      const ardrivePeerInfo: IlpPeerInfo = {
        ilpAddress: 'g.ardrive.peer',
        btpEndpoint: 'ws://ardrive:3000',
        assetCode: 'USD',
        assetScale: 6,
      };

      (GenesisPeerLoader.loadAllPeers as Mock).mockReturnValue([genesisPeer]);
      (ArDrivePeerRegistry.fetchPeers as Mock).mockResolvedValue(
        new Map([[peerPubkey, ardrivePeerInfo]])
      );

      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: true, defaultRelayUrl: 'ws://default-relay:7000' },
        secretKey,
        ownIlpInfo
      );

      const peers = await service.loadPeers();

      // ArDrive should override genesis for matching pubkey
      expect(peers.length).toBe(1);
      expect(peers[0].pubkey).toBe(peerPubkey);
      expect(peers[0].ilpAddress).toBe('g.ardrive.peer');
      expect(peers[0].relayUrl).toBe('ws://default-relay:7000');
    });

    it('should skip ArDrive fetch when ardriveEnabled is false', async () => {
      const genesisPeer = {
        pubkey: peerPubkey,
        relayUrl: 'ws://genesis-relay:7000',
        ilpAddress: 'g.genesis.peer',
        btpEndpoint: 'ws://genesis:3000',
      };
      (GenesisPeerLoader.loadAllPeers as Mock).mockReturnValue([genesisPeer]);

      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      const peers = await service.loadPeers();

      expect(ArDrivePeerRegistry.fetchPeers).not.toHaveBeenCalled();
      expect(peers.length).toBe(1);
      expect(peers[0].pubkey).toBe(peerPubkey);
    });

    it('should handle ArDrive fetch failure gracefully (returns only genesis peers)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
      const genesisPeer = {
        pubkey: peerPubkey,
        relayUrl: 'ws://genesis-relay:7000',
        ilpAddress: 'g.genesis.peer',
        btpEndpoint: 'ws://genesis:3000',
      };
      (GenesisPeerLoader.loadAllPeers as Mock).mockReturnValue([genesisPeer]);
      (ArDrivePeerRegistry.fetchPeers as Mock).mockRejectedValue(new Error('Network error'));

      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: true, defaultRelayUrl: 'ws://default-relay:7000' },
        secretKey,
        ownIlpInfo
      );

      const peers = await service.loadPeers();

      expect(peers.length).toBe(1);
      expect(peers[0].pubkey).toBe(peerPubkey);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ArDrive peer fetch failed'),
        expect.any(String)
      );

      warnSpy.mockRestore();
    });
  });

  describe('bootstrapWithPeer', () => {
    it('should throw BootstrapError for invalid pubkey format', async () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      const invalidPeer: KnownPeer = {
        pubkey: 'not-a-valid-pubkey',
        relayUrl: 'ws://localhost:7000',
        btpEndpoint: 'ws://localhost:3000',
      };

      await expect(service.bootstrapWithPeer(invalidPeer)).rejects.toThrow(
        BootstrapError
      );
    });
  });

  describe('BootstrapError', () => {
    it('should have correct name and code', () => {
      const error = new BootstrapError('Test error');

      expect(error.name).toBe('BootstrapError');
      expect(error.code).toBe('BOOTSTRAP_FAILED');
      expect(error.message).toBe('Test error');
    });

    it('should chain cause error', () => {
      const cause = new Error('Cause');
      const error = new BootstrapError('Test error', cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe('getPubkey', () => {
    it('should return the derived pubkey', () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      expect(service.getPubkey()).toBe(pubkey);
      expect(service.getPubkey()).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
