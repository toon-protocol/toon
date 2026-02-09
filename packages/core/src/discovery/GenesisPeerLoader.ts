/**
 * Genesis peer loader for bootstrapping new nodes into the network.
 *
 * Loads well-known genesis peers from a bundled JSON file and supports
 * merging with runtime-provided additional peers.
 */

import genesisPeersJson from './genesis-peers.json';

/** A genesis peer entry used for network bootstrapping. */
export interface GenesisPeer {
  pubkey: string;
  relayUrl: string;
  ilpAddress: string;
  btpEndpoint: string;
}

const PUBKEY_REGEX = /^[0-9a-f]{64}$/;
const ILP_ADDRESS_REGEX = /^g\.[a-zA-Z0-9.-]+$/;

export function isValidPubkey(pubkey: string): boolean {
  return PUBKEY_REGEX.test(pubkey);
}

export function isValidRelayUrl(url: string): boolean {
  return url.startsWith('wss://') || url.startsWith('ws://');
}

export function isValidIlpAddress(address: string): boolean {
  return ILP_ADDRESS_REGEX.test(address);
}

export function isValidBtpEndpoint(url: string): boolean {
  return url.startsWith('wss://') || url.startsWith('ws://');
}

function isValidGenesisPeer(entry: unknown): entry is GenesisPeer {
  if (typeof entry !== 'object' || entry === null) return false;
  const obj = entry as Record<string, unknown>;
  return (
    typeof obj['pubkey'] === 'string' &&
    typeof obj['relayUrl'] === 'string' &&
    typeof obj['ilpAddress'] === 'string' &&
    typeof obj['btpEndpoint'] === 'string' &&
    isValidPubkey(obj['pubkey']) &&
    isValidRelayUrl(obj['relayUrl']) &&
    isValidIlpAddress(obj['ilpAddress']) &&
    isValidBtpEndpoint(obj['btpEndpoint'])
  );
}

function deduplicateByPubkey(peers: GenesisPeer[]): GenesisPeer[] {
  const map = new Map<string, GenesisPeer>();
  for (const peer of peers) {
    map.set(peer.pubkey, peer);
  }
  return [...map.values()];
}

/** Load and validate genesis peers from the bundled JSON file. */
function loadGenesisPeers(): GenesisPeer[] {
  const raw: unknown[] = genesisPeersJson;
  const valid: GenesisPeer[] = [];
  for (const entry of raw) {
    if (isValidGenesisPeer(entry)) {
      valid.push(entry);
    } else {
      console.warn('Skipping invalid genesis peer entry:', entry);
    }
  }
  return deduplicateByPubkey(valid);
}

/** Parse and validate additional peers from a JSON string. */
function loadAdditionalPeers(json: string): GenesisPeer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    console.warn('Failed to parse additional peers JSON:', json);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('Additional peers JSON is not an array');
    return [];
  }
  const valid: GenesisPeer[] = [];
  for (const entry of parsed as unknown[]) {
    if (isValidGenesisPeer(entry)) {
      valid.push(entry);
    } else {
      console.warn('Skipping invalid additional peer entry:', entry);
    }
  }
  return valid;
}

/** Load genesis peers and optionally merge with additional peers. */
function loadAllPeers(additionalPeersJson?: string): GenesisPeer[] {
  const genesis = loadGenesisPeers();
  if (!additionalPeersJson) {
    return genesis;
  }
  const additional = loadAdditionalPeers(additionalPeersJson);
  return deduplicateByPubkey([...genesis, ...additional]);
}

export const GenesisPeerLoader = {
  loadGenesisPeers,
  loadAdditionalPeers,
  loadAllPeers,
} as const;
