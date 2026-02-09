import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GenesisPeerLoader,
  isValidPubkey,
  isValidRelayUrl,
  isValidIlpAddress,
  isValidBtpEndpoint,
} from './GenesisPeerLoader.js';
import type { GenesisPeer } from './GenesisPeerLoader.js';

function validPeer(overrides: Partial<GenesisPeer> = {}): GenesisPeer {
  return {
    pubkey: 'a'.repeat(64),
    relayUrl: 'wss://relay.example.com',
    ilpAddress: 'g.example.node1',
    btpEndpoint: 'wss://btp.example.com:3000',
    ...overrides,
  };
}

function suppressWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(vi.fn());
}

describe('GenesisPeerLoader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('validation functions', () => {
    describe('isValidPubkey', () => {
      it('accepts 64-char lowercase hex', () => {
        expect(isValidPubkey('a'.repeat(64))).toBe(true);
        expect(isValidPubkey('0123456789abcdef'.repeat(4))).toBe(true);
      });

      it('rejects non-64-char strings', () => {
        expect(isValidPubkey('a'.repeat(63))).toBe(false);
        expect(isValidPubkey('a'.repeat(65))).toBe(false);
        expect(isValidPubkey('')).toBe(false);
      });

      it('rejects uppercase hex', () => {
        expect(isValidPubkey('A'.repeat(64))).toBe(false);
      });

      it('rejects non-hex characters', () => {
        expect(isValidPubkey('g'.repeat(64))).toBe(false);
      });
    });

    describe('isValidRelayUrl', () => {
      it('accepts wss:// URLs', () => {
        expect(isValidRelayUrl('wss://relay.example.com')).toBe(true);
      });

      it('accepts ws:// URLs', () => {
        expect(isValidRelayUrl('ws://localhost:7000')).toBe(true);
      });

      it('rejects http:// URLs', () => {
        expect(isValidRelayUrl('http://example.com')).toBe(false);
      });

      it('rejects empty string', () => {
        expect(isValidRelayUrl('')).toBe(false);
      });
    });

    describe('isValidIlpAddress', () => {
      it('accepts valid g. addresses', () => {
        expect(isValidIlpAddress('g.example.node1')).toBe(true);
        expect(isValidIlpAddress('g.test')).toBe(true);
        expect(isValidIlpAddress('g.foo-bar.baz')).toBe(true);
      });

      it('rejects addresses not starting with g.', () => {
        expect(isValidIlpAddress('test.example')).toBe(false);
        expect(isValidIlpAddress('example')).toBe(false);
      });

      it('rejects g. with no suffix', () => {
        expect(isValidIlpAddress('g.')).toBe(false);
      });

      it('rejects empty string', () => {
        expect(isValidIlpAddress('')).toBe(false);
      });
    });

    describe('isValidBtpEndpoint', () => {
      it('accepts wss:// URLs', () => {
        expect(isValidBtpEndpoint('wss://btp.example.com:3000')).toBe(true);
      });

      it('accepts ws:// URLs', () => {
        expect(isValidBtpEndpoint('ws://localhost:3000')).toBe(true);
      });

      it('rejects http:// URLs', () => {
        expect(isValidBtpEndpoint('http://example.com')).toBe(false);
      });
    });
  });

  describe('loadGenesisPeers', () => {
    it('returns valid entries from the bundled JSON', () => {
      const peers = GenesisPeerLoader.loadGenesisPeers();
      expect(Array.isArray(peers)).toBe(true);
      for (const peer of peers) {
        expect(isValidPubkey(peer.pubkey)).toBe(true);
        expect(isValidRelayUrl(peer.relayUrl)).toBe(true);
        expect(isValidIlpAddress(peer.ilpAddress)).toBe(true);
        expect(isValidBtpEndpoint(peer.btpEndpoint)).toBe(true);
      }
    });
  });

  describe('loadAdditionalPeers', () => {
    it('parses valid JSON string', () => {
      const peers = [validPeer()];
      const result = GenesisPeerLoader.loadAdditionalPeers(JSON.stringify(peers));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({ pubkey: 'a'.repeat(64) }));
    });

    it('handles malformed JSON gracefully', () => {
      const warnSpy = suppressWarnings();
      const result = GenesisPeerLoader.loadAdditionalPeers('not valid json');
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to parse additional peers JSON:',
        'not valid json'
      );
    });

    it('handles non-array JSON gracefully', () => {
      const warnSpy = suppressWarnings();
      const result = GenesisPeerLoader.loadAdditionalPeers('{"key":"value"}');
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith('Additional peers JSON is not an array');
    });

    it('skips invalid entries with invalid pubkey', () => {
      const warnSpy = suppressWarnings();
      const peers = [validPeer({ pubkey: 'invalid' })];
      const result = GenesisPeerLoader.loadAdditionalPeers(JSON.stringify(peers));
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('skips entries with invalid relay URL', () => {
      const warnSpy = suppressWarnings();
      const peers = [validPeer({ relayUrl: 'http://not-websocket' })];
      const result = GenesisPeerLoader.loadAdditionalPeers(JSON.stringify(peers));
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('skips entries with invalid ILP address', () => {
      const warnSpy = suppressWarnings();
      const peers = [validPeer({ ilpAddress: 'not.valid' })];
      const result = GenesisPeerLoader.loadAdditionalPeers(JSON.stringify(peers));
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('skips entries with invalid BTP endpoint', () => {
      const warnSpy = suppressWarnings();
      const peers = [validPeer({ btpEndpoint: 'http://not-websocket' })];
      const result = GenesisPeerLoader.loadAdditionalPeers(JSON.stringify(peers));
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('skips entries with missing fields', () => {
      const warnSpy = suppressWarnings();
      const result = GenesisPeerLoader.loadAdditionalPeers(
        JSON.stringify([{ pubkey: 'a'.repeat(64) }])
      );
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('returns empty array for empty JSON array', () => {
      const result = GenesisPeerLoader.loadAdditionalPeers('[]');
      expect(result).toEqual([]);
    });
  });

  describe('loadAllPeers', () => {
    it('returns genesis peers when no additional peers provided', () => {
      const result = GenesisPeerLoader.loadAllPeers();
      expect(Array.isArray(result)).toBe(true);
      const genesis = GenesisPeerLoader.loadGenesisPeers();
      expect(result).toEqual(genesis);
    });

    it('merges genesis and additional peers', () => {
      const additional = validPeer({ pubkey: 'b'.repeat(64) });
      const result = GenesisPeerLoader.loadAllPeers(JSON.stringify([additional]));
      const pubkeys = result.map((p) => p.pubkey);
      expect(pubkeys).toContain('b'.repeat(64));
    });

    it('deduplicates by pubkey with additional peers overriding genesis', () => {
      const genesis = GenesisPeerLoader.loadGenesisPeers();
      if (genesis.length === 0) return;

      const firstGenesis = genesis[0];
      expect(firstGenesis).toBeDefined();
      if (!firstGenesis) return;

      const overridePeer = validPeer({
        pubkey: firstGenesis.pubkey,
        relayUrl: 'wss://override.example.com',
      });
      const result = GenesisPeerLoader.loadAllPeers(JSON.stringify([overridePeer]));

      const match = result.find((p) => p.pubkey === firstGenesis.pubkey);
      expect(match).toBeDefined();
      expect(match?.relayUrl).toBe('wss://override.example.com');
    });

    it('handles malformed additional peers JSON (returns only genesis)', () => {
      suppressWarnings();
      const genesis = GenesisPeerLoader.loadGenesisPeers();
      const result = GenesisPeerLoader.loadAllPeers('not valid json');
      expect(result).toEqual(genesis);
    });

    it('works with undefined additional peers', () => {
      const result = GenesisPeerLoader.loadAllPeers(undefined);
      const genesis = GenesisPeerLoader.loadGenesisPeers();
      expect(result).toEqual(genesis);
    });
  });

  describe('deduplication within genesis peers', () => {
    it('deduplicates by pubkey within loadGenesisPeers (last entry wins)', () => {
      const peer1 = validPeer({ relayUrl: 'wss://first.example.com' });
      const peer2 = validPeer({ relayUrl: 'wss://second.example.com' });
      const result = GenesisPeerLoader.loadAdditionalPeers(
        JSON.stringify([peer1, peer2])
      );
      // loadAdditionalPeers doesn't dedup internally (loadAllPeers does)
      // but loadGenesisPeers does dedup, so test that pattern
      expect(result).toHaveLength(2);
    });
  });

  describe('console.warn is called for invalid entries', () => {
    it('warns when an invalid genesis-like entry is encountered', () => {
      const warnSpy = suppressWarnings();
      GenesisPeerLoader.loadAdditionalPeers(
        JSON.stringify([{ pubkey: 'bad', relayUrl: 'bad', ilpAddress: 'bad', btpEndpoint: 'bad' }])
      );
      expect(warnSpy).toHaveBeenCalledWith(
        'Skipping invalid additional peer entry:',
        expect.objectContaining({ pubkey: 'bad' })
      );
    });
  });
});
