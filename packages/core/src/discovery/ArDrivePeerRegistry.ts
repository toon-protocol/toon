/**
 * ArDrive-based peer registry for permanent, decentralized storage
 * of ILP peer info on Arweave.
 *
 * Read path: queries Arweave GraphQL gateway (free, no wallet needed).
 * Write path: uploads via @ardrive/turbo-sdk (caller provides authenticated client).
 */

import type { TurboAuthenticatedClient } from '@ardrive/turbo-sdk';
import type { IlpPeerInfo } from '../types.js';
import { PeerDiscoveryError } from '../errors.js';
import { isValidPubkey, isValidIlpAddress, isValidBtpEndpoint } from './GenesisPeerLoader.js';

const DEFAULT_GATEWAY_URL = 'https://arweave.net/graphql';

const GRAPHQL_QUERY = `
query {
  transactions(
    tags: [
      { name: "App-Name", values: ["crosstown"] },
      { name: "type", values: ["ilp-peer-info"] }
    ],
    first: 100
  ) {
    edges {
      node {
        id
        tags {
          name
          value
        }
      }
    }
  }
}
`;

interface GraphQlTag {
  name: string;
  value: string;
}

interface GraphQlNode {
  id: string;
  tags: GraphQlTag[];
}

interface GraphQlEdge {
  node: GraphQlNode;
}

interface GraphQlResponse {
  data?: {
    transactions?: {
      edges?: GraphQlEdge[];
    };
  };
}

function isValidIlpPeerInfo(entry: unknown): entry is IlpPeerInfo {
  if (typeof entry !== 'object' || entry === null) return false;
  const obj = entry as Record<string, unknown>;
  return (
    typeof obj['ilpAddress'] === 'string' &&
    isValidIlpAddress(obj['ilpAddress']) &&
    typeof obj['btpEndpoint'] === 'string' &&
    isValidBtpEndpoint(obj['btpEndpoint']) &&
    typeof obj['assetCode'] === 'string' &&
    (obj['assetCode'] as string).length > 0 &&
    typeof obj['assetScale'] === 'number' &&
    Number.isInteger(obj['assetScale']) &&
    (obj['assetScale'] as number) >= 0 &&
    (obj['settlementEngine'] === undefined || typeof obj['settlementEngine'] === 'string')
  );
}

function getPubkeyFromTags(tags: GraphQlTag[]): string | undefined {
  const tag = tags.find((t) => t.name === 'pubkey');
  return tag?.value;
}

async function fetchPeers(
  gatewayUrl: string = DEFAULT_GATEWAY_URL,
): Promise<Map<string, IlpPeerInfo>> {
  const result = new Map<string, IlpPeerInfo>();

  try {
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: GRAPHQL_QUERY }),
    });

    const json = (await response.json()) as GraphQlResponse;
    const edges = json?.data?.transactions?.edges;

    if (!Array.isArray(edges)) {
      return result;
    }

    const baseUrl = gatewayUrl.replace(/\/graphql$/, '');

    for (const edge of edges) {
      const txId = edge?.node?.id;
      const tags = edge?.node?.tags;

      if (!txId || !Array.isArray(tags)) continue;

      const pubkey = getPubkeyFromTags(tags);
      if (!pubkey || !isValidPubkey(pubkey)) continue;

      // Deduplication: first occurrence wins (newest-first from Arweave)
      if (result.has(pubkey)) continue;

      try {
        const dataResponse = await fetch(`${baseUrl}/${txId}`);
        const data = (await dataResponse.json()) as unknown;

        if (isValidIlpPeerInfo(data)) {
          result.set(pubkey, data);
        } else {
          console.warn(`Skipping transaction ${txId}: invalid IlpPeerInfo data`);
        }
      } catch (err) {
        console.warn(`Failed to fetch transaction data for ${txId}:`, err);
      }
    }
  } catch (err) {
    console.warn('ArDrive peer registry unavailable:', err);
  }

  return result;
}

async function publishPeerInfo(
  peerInfo: IlpPeerInfo,
  pubkey: string,
  turboClient: TurboAuthenticatedClient,
): Promise<string> {
  if (!isValidPubkey(pubkey)) {
    throw new PeerDiscoveryError(`Invalid pubkey: ${pubkey}`);
  }

  try {
    const json = JSON.stringify(peerInfo);
    const result = await turboClient.uploadFile({
      fileStreamFactory: () => Buffer.from(json, 'utf-8'),
      fileSizeFactory: () => Buffer.byteLength(json, 'utf-8'),
      dataItemOpts: {
        tags: [
          { name: 'App-Name', value: 'crosstown' },
          { name: 'type', value: 'ilp-peer-info' },
          { name: 'pubkey', value: pubkey },
          { name: 'version', value: '1' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
    });

    return result.id;
  } catch (err) {
    throw new PeerDiscoveryError(
      'Failed to publish peer info to ArDrive',
      err instanceof Error ? err : undefined,
    );
  }
}

export const ArDrivePeerRegistry = {
  fetchPeers,
  publishPeerInfo,
} as const;
