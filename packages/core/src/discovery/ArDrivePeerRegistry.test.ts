import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TurboAuthenticatedClient } from '@ardrive/turbo-sdk';
import { ArDrivePeerRegistry } from './ArDrivePeerRegistry.js';
import { PeerDiscoveryError } from '../errors.js';
import type { IlpPeerInfo } from '../types.js';

function validPeerInfo(overrides: Partial<IlpPeerInfo> = {}): IlpPeerInfo {
  return {
    ilpAddress: 'g.example.connector',
    btpEndpoint: 'wss://btp.example.com:3000',
    assetCode: 'USD',
    assetScale: 6,
    ...overrides,
  };
}

function makeGraphQlResponse(
  edges: {
    txId: string;
    pubkey: string;
    extraTags?: { name: string; value: string }[];
  }[],
) {
  return {
    data: {
      transactions: {
        edges: edges.map(({ txId, pubkey, extraTags = [] }) => ({
          node: {
            id: txId,
            tags: [
              { name: 'App-Name', value: 'agent-society' },
              { name: 'type', value: 'ilp-peer-info' },
              { name: 'pubkey', value: pubkey },
              { name: 'version', value: '1' },
              { name: 'Content-Type', value: 'application/json' },
              ...extraTags,
            ],
          },
        })),
      },
    },
  };
}

const VALID_PUBKEY = 'a'.repeat(64);
const VALID_PUBKEY_2 = 'b'.repeat(64);

function suppressWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(vi.fn());
}

describe('ArDrivePeerRegistry', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('fetchPeers', () => {
    it('returns Map of valid IlpPeerInfo keyed by pubkey from mocked GraphQL response', async () => {
      const peerInfo = validPeerInfo();
      const graphQlResponse = makeGraphQlResponse([
        { txId: 'tx1', pubkey: VALID_PUBKEY },
      ]);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve(graphQlResponse),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve(peerInfo),
        });

      const result = await ArDrivePeerRegistry.fetchPeers();

      expect(result.size).toBe(1);
      expect(result.get(VALID_PUBKEY)).toEqual(peerInfo);
    });

    it('correctly constructs GraphQL query with required tags', async () => {
      const graphQlResponse = makeGraphQlResponse([]);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve(graphQlResponse),
      });

      await ArDrivePeerRegistry.fetchPeers();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://arweave.net/graphql',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('agent-society'),
        }),
      );

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.query).toContain('App-Name');
      expect(body.query).toContain('ilp-peer-info');
    });

    it('handles multiple transactions, deduplicating by pubkey (first seen wins)', async () => {
      const peerInfo1 = validPeerInfo({ assetCode: 'USD' });
      const graphQlResponse = makeGraphQlResponse([
        { txId: 'tx-newer', pubkey: VALID_PUBKEY },
        { txId: 'tx-older', pubkey: VALID_PUBKEY },
      ]);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve(graphQlResponse),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve(peerInfo1),
        });
      // tx-older should not be fetched at all (deduplication)

      const result = await ArDrivePeerRegistry.fetchPeers();

      expect(result.size).toBe(1);
      expect(result.get(VALID_PUBKEY)).toEqual(peerInfo1);
      // fetch called twice: once for GraphQL, once for tx-newer data
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('skips transactions with invalid/unparseable data (logs warning)', async () => {
      const warnSpy = suppressWarnings();
      const graphQlResponse = makeGraphQlResponse([
        { txId: 'tx-bad', pubkey: VALID_PUBKEY },
      ]);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve(graphQlResponse),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ invalid: 'data' }),
        });

      const result = await ArDrivePeerRegistry.fetchPeers();

      expect(result.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping transaction tx-bad'),
      );
    });

    it('returns empty Map when GraphQL gateway is unreachable (logs warning, does not throw)', async () => {
      const warnSpy = suppressWarnings();

      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      const result = await ArDrivePeerRegistry.fetchPeers();

      expect(result.size).toBe(0);
      expect(result).toBeInstanceOf(Map);
      expect(warnSpy).toHaveBeenCalledWith(
        'ArDrive peer registry unavailable:',
        expect.any(Error),
      );
    });

    it('returns empty Map when no matching transactions found', async () => {
      const graphQlResponse = makeGraphQlResponse([]);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve(graphQlResponse),
      });

      const result = await ArDrivePeerRegistry.fetchPeers();

      expect(result.size).toBe(0);
    });

    it('handles malformed GraphQL response gracefully', async () => {
      suppressWarnings();

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve({ data: null }),
      });

      const result = await ArDrivePeerRegistry.fetchPeers();

      expect(result.size).toBe(0);
    });

    it('validates IlpPeerInfo fields (rejects entries with missing/invalid fields)', async () => {
      const warnSpy = suppressWarnings();
      const graphQlResponse = makeGraphQlResponse([
        { txId: 'tx-missing-asset', pubkey: VALID_PUBKEY },
        { txId: 'tx-bad-scale', pubkey: VALID_PUBKEY_2 },
      ]);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve(graphQlResponse),
        })
        // Missing assetCode
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              ilpAddress: 'g.test',
              btpEndpoint: 'wss://btp.example.com',
              assetScale: 6,
            }),
        })
        // Float assetScale
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              ilpAddress: 'g.test',
              btpEndpoint: 'wss://btp.example.com',
              assetCode: 'USD',
              assetScale: 6.5,
            }),
        });

      const result = await ArDrivePeerRegistry.fetchPeers();

      expect(result.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('accepts custom gateway URL parameter', async () => {
      const customUrl = 'https://custom-gateway.example.com/graphql';
      const graphQlResponse = makeGraphQlResponse([]);

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve(graphQlResponse),
      });

      await ArDrivePeerRegistry.fetchPeers(customUrl);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        customUrl,
        expect.any(Object),
      );
    });

    it('handles individual transaction fetch failures gracefully (skips and continues)', async () => {
      const warnSpy = suppressWarnings();
      const peerInfo2 = validPeerInfo({ assetCode: 'EUR' });
      const graphQlResponse = makeGraphQlResponse([
        { txId: 'tx-fail', pubkey: VALID_PUBKEY },
        { txId: 'tx-ok', pubkey: VALID_PUBKEY_2 },
      ]);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve(graphQlResponse),
        })
        // First tx fetch fails
        .mockRejectedValueOnce(new Error('timeout'))
        // Second tx fetch succeeds
        .mockResolvedValueOnce({
          json: () => Promise.resolve(peerInfo2),
        });

      const result = await ArDrivePeerRegistry.fetchPeers();

      expect(result.size).toBe(1);
      expect(result.get(VALID_PUBKEY_2)).toEqual(peerInfo2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch transaction data for tx-fail'),
        expect.any(Error),
      );
    });
  });

  describe('publishPeerInfo', () => {
    it('uploads JSON with correct tags', async () => {
      const peerInfo = validPeerInfo();
      const mockUploadFile = vi.fn().mockResolvedValue({
        id: 'tx-result-123',
        dataCaches: [],
        fastFinalityIndexes: [],
      });
      const mockClient = { uploadFile: mockUploadFile } as unknown as TurboAuthenticatedClient;

      await ArDrivePeerRegistry.publishPeerInfo(peerInfo, VALID_PUBKEY, mockClient);

      expect(mockUploadFile).toHaveBeenCalledWith({
        fileStreamFactory: expect.any(Function),
        fileSizeFactory: expect.any(Function),
        dataItemOpts: {
          tags: [
            { name: 'App-Name', value: 'agent-society' },
            { name: 'type', value: 'ilp-peer-info' },
            { name: 'pubkey', value: VALID_PUBKEY },
            { name: 'version', value: '1' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      });

      // Verify the stream factory produces correct JSON
      const callArgs = mockUploadFile.mock.calls[0][0];
      const buffer = callArgs.fileStreamFactory();
      expect(buffer.toString('utf-8')).toBe(JSON.stringify(peerInfo));
      expect(callArgs.fileSizeFactory()).toBe(Buffer.byteLength(JSON.stringify(peerInfo), 'utf-8'));
    });

    it('returns transaction ID on success', async () => {
      const peerInfo = validPeerInfo();
      const mockClient = {
        uploadFile: vi.fn().mockResolvedValue({
          id: 'tx-abc-def',
          dataCaches: [],
          fastFinalityIndexes: [],
        }),
      } as unknown as TurboAuthenticatedClient;

      const txId = await ArDrivePeerRegistry.publishPeerInfo(peerInfo, VALID_PUBKEY, mockClient);

      expect(txId).toBe('tx-abc-def');
    });

    it('throws PeerDiscoveryError on upload failure', async () => {
      const peerInfo = validPeerInfo();
      const mockClient = {
        uploadFile: vi.fn().mockRejectedValue(new Error('Upload failed')),
      } as unknown as TurboAuthenticatedClient;

      await expect(
        ArDrivePeerRegistry.publishPeerInfo(peerInfo, VALID_PUBKEY, mockClient),
      ).rejects.toThrow(PeerDiscoveryError);

      await expect(
        ArDrivePeerRegistry.publishPeerInfo(peerInfo, VALID_PUBKEY, mockClient),
      ).rejects.toThrow('Failed to publish peer info to ArDrive');
    });

    it('rejects invalid pubkey before attempting upload', async () => {
      const peerInfo = validPeerInfo();
      const mockClient = {
        uploadFile: vi.fn(),
      } as unknown as TurboAuthenticatedClient;

      await expect(
        ArDrivePeerRegistry.publishPeerInfo(peerInfo, 'invalid-pubkey', mockClient),
      ).rejects.toThrow(PeerDiscoveryError);

      await expect(
        ArDrivePeerRegistry.publishPeerInfo(peerInfo, 'invalid-pubkey', mockClient),
      ).rejects.toThrow('Invalid pubkey');

      // uploadFile should NOT have been called
      expect(mockClient.uploadFile).not.toHaveBeenCalled();
    });
  });
});
