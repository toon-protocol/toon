/**
 * Tests for BootstrapService
 *
 * Migrated from packages/core/src/bootstrap.test.ts with new tests
 * for ILP-first flow (Phase 2/3) and event emitter.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { BootstrapService, BootstrapError } from './BootstrapService.js';
import type { ConnectorAdminClient, KnownPeer, BootstrapEvent, AgentRuntimeClient } from './types.js';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import type { IlpPeerInfo } from '../types.js';

// Mock discovery module
vi.mock('../discovery/index.js', () => ({
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
import { GenesisPeerLoader, ArDrivePeerRegistry } from '../discovery/index.js';
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
   */
  function setupWebSocketMock(peerInfo: IlpPeerInfo, authorPubkey: string) {
    (WebSocket as unknown as Mock).mockImplementation(function (this: Record<string, (...args: unknown[]) => void>) {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      this.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      });
      this.send = vi.fn(() => {
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

        setTimeout(() => {
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

  // ===== Phase 1 Tests (migrated from bootstrap.test.ts) =====

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
      expect(results[0].peerInfo).toEqual({
        ...validPeerInfo,
        supportedChains: [],
        settlementAddresses: {},
      });
      expect(mockAdmin.addPeer).toHaveBeenCalled();
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

      expect(results.length).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to register peer'),
        expect.any(String)
      );

      warnSpy.mockRestore();
    });

    it('should log and skip failed kind:10032 publish', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      // Make publishOurInfo fail by making pool.publish throw
      const poolPublishSpy = vi.fn(async () => { throw new Error('Publish failed'); });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).pool.publish = poolPublishSpy;

      const results = await service.bootstrap();

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

  // ===== Phase 2 Tests (ILP handshake) =====

  describe('Phase 2: SPSP handshake via ILP', () => {
    let mockAgentRuntimeClient: AgentRuntimeClient;
    let mockToonEncoder: Mock;
    let mockToonDecoder: Mock;

    beforeEach(() => {
      mockAgentRuntimeClient = {
        sendIlpPacket: vi.fn(),
      };
      mockToonEncoder = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3]));
      mockToonDecoder = vi.fn();
    });

    it('should send 0-amount SPSP via agentRuntimeClient for each registered peer', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      (mockAgentRuntimeClient.sendIlpPacket as Mock).mockResolvedValue({
        accepted: true,
        fulfillment: 'abc',
        data: undefined,
      });

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      await service.bootstrap();

      // Phase 2: should have called sendIlpPacket for SPSP handshake
      expect(mockAgentRuntimeClient.sendIlpPacket).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: validPeerInfo.ilpAddress,
          amount: '0',
          data: expect.any(String),
        })
      );
    });

    it('should on REJECT, log error and continue to next peer', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
      setupWebSocketMock(validPeerInfo, peerPubkey);

      (mockAgentRuntimeClient.sendIlpPacket as Mock).mockResolvedValue({
        accepted: false,
        code: 'F06',
        message: 'Insufficient amount',
      });

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      const results = await service.bootstrap();

      // Should still return result from Phase 1
      expect(results.length).toBe(1);

      // Should emit handshake-failed event
      const failedEvents = events.filter((e) => e.type === 'bootstrap:handshake-failed');
      expect(failedEvents.length).toBe(1);

      warnSpy.mockRestore();
    });

    it('should skip Phase 2 when agentRuntimeClient not configured (backward compat)', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      const results = await service.bootstrap();

      expect(results.length).toBe(1);

      // Should not have a 'handshaking' phase event
      const handshakingPhases = events.filter(
        (e) => e.type === 'bootstrap:phase' && e.phase === 'handshaking'
      );
      expect(handshakingPhases.length).toBe(0);
    });

    it('should on FULFILL, parse response TOON for SpspResponse with settlement fields', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      // Create a peer secret key to build the encrypted SPSP response
      const peerSecretKey = generateSecretKey();
      const myPubkey = getPublicKey(secretKey);

      // For the TOON decoder mock, we return a fake Nostr event that parseSpspResponse can handle
      // We need to import the actual builders to create a valid encrypted event
      const { buildSpspResponseEvent } = await import('../events/builders.js');

      const spspResponseEvent = buildSpspResponseEvent(
        {
          requestId: 'test-req-id',
          destinationAccount: 'g.test.peer.spsp.abc123',
          sharedSecret: 'c2VjcmV0',
          negotiatedChain: 'evm:base:8453',
          channelId: '0xCHANNEL123',
          settlementAddress: '0xPEER_ADDR',
        },
        myPubkey,
        peerSecretKey
      );

      // The TOON decoder returns this event
      mockToonDecoder.mockReturnValue(spspResponseEvent);

      // Agent-runtime returns FULFILL with data
      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({
          accepted: true,
          fulfillment: 'abc',
          data: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'),
        })
        // Phase 3 announce
        .mockResolvedValueOnce({
          accepted: true,
          fulfillment: 'def',
        });

      // We need to use the peer's pubkey in the test, but we also need parseSpspResponse
      // to work with the actual peerSecretKey. Since our service uses `secretKey` and the
      // response was encrypted by `peerSecretKey` for `myPubkey`, it will work.
      // However, the response was encrypted by peerSecretKey, so we need to use the
      // peerPubkey matching peerSecretKey for parsing.
      // The BootstrapService calls parseSpspResponse(responseEvent, this.secretKey, result.knownPeer.pubkey)
      // So knownPeer.pubkey must match getPublicKey(peerSecretKey) for decryption to work.

      const actualPeerPubkey = getPublicKey(peerSecretKey);
      const peer = makeKnownPeer(actualPeerPubkey);

      setupWebSocketMock(validPeerInfo, actualPeerPubkey);

      const service = new BootstrapService(
        {
          knownPeers: [peer],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      const results = await service.bootstrap();

      expect(results.length).toBe(1);
      expect(results[0].channelId).toBe('0xCHANNEL123');
      expect(results[0].negotiatedChain).toBe('evm:base:8453');
      expect(results[0].settlementAddress).toBe('0xPEER_ADDR');
    });

    it('should on FULFILL with channelId, update peer registration with settlement config', async () => {
      const peerSecretKey = generateSecretKey();
      const myPubkey = getPublicKey(secretKey);
      const actualPeerPubkey = getPublicKey(peerSecretKey);

      const { buildSpspResponseEvent } = await import('../events/builders.js');

      const spspResponseEvent = buildSpspResponseEvent(
        {
          requestId: 'test-req-id',
          destinationAccount: 'g.test.peer.spsp.abc123',
          sharedSecret: 'c2VjcmV0',
          negotiatedChain: 'evm:base:8453',
          channelId: '0xCHANNEL456',
          settlementAddress: '0xPEER_ADDR',
          tokenAddress: '0xTOKEN',
          tokenNetworkAddress: '0xNETWORK',
        },
        myPubkey,
        peerSecretKey
      );

      mockToonDecoder.mockReturnValue(spspResponseEvent);

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({
          accepted: true,
          fulfillment: 'abc',
          data: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'),
        })
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'def' });

      const peer = makeKnownPeer(actualPeerPubkey);
      setupWebSocketMock(validPeerInfo, actualPeerPubkey);

      const service = new BootstrapService(
        {
          knownPeers: [peer],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      await service.bootstrap();

      // addPeer should have been called twice:
      // 1st: Phase 1 registration (no settlement)
      // 2nd: Phase 2 update with settlement config
      expect(mockAdmin.addPeer).toHaveBeenCalledTimes(2);
      expect(mockAdmin.addPeer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          settlement: expect.objectContaining({
            preference: 'evm:base:8453',
            channelId: '0xCHANNEL456',
            evmAddress: '0xPEER_ADDR',
            tokenAddress: '0xTOKEN',
            tokenNetworkAddress: '0xNETWORK',
          }),
        })
      );
    });
  });

  // ===== Phase 3 Tests (announce) =====

  describe('Phase 3: Announce via ILP', () => {
    let mockAgentRuntimeClient: AgentRuntimeClient;
    let mockToonEncoder: Mock;
    let mockToonDecoder: Mock;

    beforeEach(() => {
      mockAgentRuntimeClient = {
        sendIlpPacket: vi.fn(),
      };
      mockToonEncoder = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3]));
      mockToonDecoder = vi.fn();
    });

    it('should publish kind:10032 as paid ILP PREPARE after handshakes', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      // Phase 2 SPSP handshake succeeds without data
      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'def' }); // Phase 3

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      await service.bootstrap();

      // sendIlpPacket called twice: Phase 2 (SPSP) + Phase 3 (announce)
      expect(mockAgentRuntimeClient.sendIlpPacket).toHaveBeenCalledTimes(2);

      // Phase 3 call should have non-zero amount
      const announceCall = (mockAgentRuntimeClient.sendIlpPacket as Mock).mock.calls[1];
      expect(BigInt(announceCall[0].amount)).toBeGreaterThan(0n);
    });

    it('should not throw on publish failure (non-fatal)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
      setupWebSocketMock(validPeerInfo, peerPubkey);

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockResolvedValueOnce({ accepted: false, code: 'F06', message: 'Rejected' }); // Phase 3

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      // Should not throw
      const results = await service.bootstrap();
      expect(results.length).toBe(1);

      warnSpy.mockRestore();
    });

    it('should skip Phase 3 when agentRuntimeClient not configured', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      await service.bootstrap();

      // Should not have an 'announcing' phase event
      const announcingPhases = events.filter(
        (e) => e.type === 'bootstrap:phase' && e.phase === 'announcing'
      );
      expect(announcingPhases.length).toBe(0);
    });
  });

  // ===== Phase 3: Peer Announcement Tests =====

  describe('Phase 3: Peer Announcement', () => {
    let mockAgentRuntimeClient: AgentRuntimeClient;
    let mockToonEncoder: Mock;
    let mockToonDecoder: Mock;

    beforeEach(() => {
      mockAgentRuntimeClient = {
        sendIlpPacket: vi.fn(),
      };
      mockToonEncoder = vi.fn().mockReturnValue(new Uint8Array([10, 20, 30, 40, 50]));
      mockToonDecoder = vi.fn();
    });

    it('should call toonEncoder with kind:10032 event containing own ILP info', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'def' }); // Phase 3

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      await service.bootstrap();

      // toonEncoder called twice: Phase 2 (SPSP request) + Phase 3 (announce)
      expect(mockToonEncoder).toHaveBeenCalledTimes(2);

      // Phase 3 call should be a kind:10032 event with our ILP info
      const announceCall = mockToonEncoder.mock.calls[1][0];
      expect(announceCall.kind).toBe(ILP_PEER_INFO_KIND);
      const content = JSON.parse(announceCall.content);
      expect(content.ilpAddress).toBe(ownIlpInfo.ilpAddress);
      expect(content.btpEndpoint).toBe(ownIlpInfo.btpEndpoint);
    });

    it('should set destination to bootstrap peer ILP address', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'def' }); // Phase 3

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      await service.bootstrap();

      // Phase 3 call
      const announceCall = (mockAgentRuntimeClient.sendIlpPacket as Mock).mock.calls[1];
      expect(announceCall[0].destination).toBe(validPeerInfo.ilpAddress);
    });

    it('should calculate amount as toonBytes.length * default basePricePerByte (10n)', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      // toonEncoder returns 5 bytes
      mockToonEncoder.mockReturnValue(new Uint8Array([10, 20, 30, 40, 50]));

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'def' }); // Phase 3

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      await service.bootstrap();

      // Phase 3 call: 5 bytes * 10 = 50
      const announceCall = (mockAgentRuntimeClient.sendIlpPacket as Mock).mock.calls[1];
      expect(announceCall[0].amount).toBe('50');
    });

    it('should use custom basePricePerByte when configured', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      // toonEncoder returns 5 bytes
      mockToonEncoder.mockReturnValue(new Uint8Array([10, 20, 30, 40, 50]));

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'def' }); // Phase 3

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
          basePricePerByte: 25n,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      await service.bootstrap();

      // Phase 3 call: 5 bytes * 25 = 125
      const announceCall = (mockAgentRuntimeClient.sendIlpPacket as Mock).mock.calls[1];
      expect(announceCall[0].amount).toBe('125');
    });

    it('should emit bootstrap:announced event on FULFILL', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'def' }); // Phase 3

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      await service.bootstrap();

      const announcedEvents = events.filter((e) => e.type === 'bootstrap:announced');
      expect(announcedEvents.length).toBe(1);
      expect(announcedEvents[0]).toEqual({
        type: 'bootstrap:announced',
        peerId: `nostr-${peerPubkey.slice(0, 16)}`,
        eventId: expect.stringMatching(/^[0-9a-f]{64}$/),
        amount: expect.any(String),
      });
    });

    it('should emit bootstrap:announce-failed event on REJECT', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockResolvedValueOnce({ accepted: false, code: 'F06', message: 'Insufficient amount' }); // Phase 3

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      await service.bootstrap();

      const failedEvents = events.filter((e) => e.type === 'bootstrap:announce-failed');
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0]).toEqual({
        type: 'bootstrap:announce-failed',
        peerId: `nostr-${peerPubkey.slice(0, 16)}`,
        reason: 'F06 Insufficient amount',
      });
    });

    it('should emit bootstrap:announce-failed event on network error', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      (mockAgentRuntimeClient.sendIlpPacket as Mock)
        .mockResolvedValueOnce({ accepted: true, fulfillment: 'abc' }) // Phase 2
        .mockRejectedValueOnce(new Error('Network timeout')); // Phase 3 throws

      const service = new BootstrapService(
        {
          knownPeers: [makeKnownPeer()],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockAgentRuntimeClient);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

      const results = await service.bootstrap();

      // Should still return result (non-fatal)
      expect(results.length).toBe(1);

      const failedEvents = events.filter((e) => e.type === 'bootstrap:announce-failed');
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0]).toEqual({
        type: 'bootstrap:announce-failed',
        peerId: `nostr-${peerPubkey.slice(0, 16)}`,
        reason: 'Network timeout',
      });

      warnSpy.mockRestore();
    });
  });

  // ===== Event Emitter Tests =====

  describe('Event emitter', () => {
    it('should emit bootstrap:phase events on phase transitions', async () => {
      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      await service.bootstrap();

      const phaseEvents = events.filter((e) => e.type === 'bootstrap:phase');
      expect(phaseEvents.length).toBeGreaterThanOrEqual(2);

      // Should have discovering and registering phases at minimum
      const phases = phaseEvents.map((e) => (e as { phase: string }).phase);
      expect(phases).toContain('discovering');
      expect(phases).toContain('registering');
      expect(phases).toContain('ready');
    });

    it('should emit bootstrap:peer-registered on successful registration', async () => {
      setupWebSocketMock(validPeerInfo, peerPubkey);

      const service = new BootstrapService(
        { knownPeers: [makeKnownPeer()], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      await service.bootstrap();

      const peerRegisteredEvents = events.filter((e) => e.type === 'bootstrap:peer-registered');
      expect(peerRegisteredEvents.length).toBe(1);
      expect(peerRegisteredEvents[0]).toEqual({
        type: 'bootstrap:peer-registered',
        peerId: `nostr-${peerPubkey.slice(0, 16)}`,
        peerPubkey,
        ilpAddress: expect.any(String),
      });
    });

    it('should emit bootstrap:channel-opened on FULFILL with channel', async () => {
      const peerSecretKey = generateSecretKey();
      const myPubkey = getPublicKey(secretKey);
      const actualPeerPubkey = getPublicKey(peerSecretKey);

      const { buildSpspResponseEvent } = await import('../events/builders.js');

      const spspResponseEvent = buildSpspResponseEvent(
        {
          requestId: 'test-req-id',
          destinationAccount: 'g.test.peer.spsp.abc123',
          sharedSecret: 'c2VjcmV0',
          negotiatedChain: 'evm:base:8453',
          channelId: '0xCHANNEL789',
        },
        myPubkey,
        peerSecretKey
      );

      const mockToonEncoder = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3]));
      const mockToonDecoder = vi.fn().mockReturnValue(spspResponseEvent);
      const mockArc: AgentRuntimeClient = {
        sendIlpPacket: vi.fn()
          .mockResolvedValueOnce({
            accepted: true,
            fulfillment: 'abc',
            data: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'),
          })
          .mockResolvedValueOnce({ accepted: true, fulfillment: 'def' }),
      };

      const peer = makeKnownPeer(actualPeerPubkey);
      setupWebSocketMock(validPeerInfo, actualPeerPubkey);

      const service = new BootstrapService(
        {
          knownPeers: [peer],
          ardriveEnabled: false,
          toonEncoder: mockToonEncoder,
          toonDecoder: mockToonDecoder,
        },
        secretKey,
        ownIlpInfo
      );
      service.setConnectorAdmin(mockAdmin);
      service.setAgentRuntimeClient(mockArc);

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      await service.bootstrap();

      const channelOpenedEvents = events.filter((e) => e.type === 'bootstrap:channel-opened');
      expect(channelOpenedEvents.length).toBe(1);
      expect(channelOpenedEvents[0]).toEqual({
        type: 'bootstrap:channel-opened',
        peerId: expect.stringContaining('nostr-'),
        channelId: '0xCHANNEL789',
        negotiatedChain: 'evm:base:8453',
      });
    });

    it('should emit bootstrap:ready at completion', async () => {
      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      const events: BootstrapEvent[] = [];
      service.on((event) => events.push(event));

      await service.bootstrap();

      const readyEvents = events.filter((e) => e.type === 'bootstrap:ready');
      expect(readyEvents.length).toBe(1);
      expect(readyEvents[0]).toEqual({
        type: 'bootstrap:ready',
        peerCount: 0,
        channelCount: 0,
      });
    });

    it('should return current phase via getPhase()', async () => {
      const service = new BootstrapService(
        { knownPeers: [], ardriveEnabled: false },
        secretKey,
        ownIlpInfo
      );

      expect(service.getPhase()).toBe('discovering');

      await service.bootstrap();

      expect(service.getPhase()).toBe('ready');
    });

    it('should support on/off for listener management', () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      const listener = vi.fn();
      service.on(listener);
      service.off(listener);

      // After off, listener should not be called
      // We can't easily trigger an event without bootstrap, so just verify no errors
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
