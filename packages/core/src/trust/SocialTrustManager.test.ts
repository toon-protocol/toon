import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SocialTrustManager, DEFAULT_TRUST_CONFIG } from './SocialTrustManager.js';
import { TrustCalculationError } from '../errors.js';
import type { SimplePool } from 'nostr-tools/pool';
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { TrustConfig } from '../types.js';

// Helper to create a minimal valid kind:3 event for a given author
function createKind3Event(
  pubkey: string,
  followedPubkeys: string[],
  created_at = Math.floor(Date.now() / 1000)
): VerifiedEvent {
  return {
    id: `event-${pubkey.slice(0, 8)}`,
    pubkey,
    kind: 3,
    content: '',
    tags: followedPubkeys.map((pk) => ['p', pk]),
    created_at,
    sig: 'mock-sig',
  } as unknown as VerifiedEvent;
}

describe('SocialTrustManager', () => {
  let mockPool: SimplePool;

  beforeEach(() => {
    mockPool = {
      querySync: vi.fn(),
    } as unknown as SimplePool;
    vi.clearAllMocks();
  });

  // Task 8: Constructor tests
  describe('constructor', () => {
    it('accepts relay URLs and stores them', () => {
      const manager = new SocialTrustManager(['wss://relay.example']);
      expect(manager).toBeInstanceOf(SocialTrustManager);
    });

    it('creates SimplePool if not provided', () => {
      const manager = new SocialTrustManager(['wss://relay.example']);
      expect(manager).toBeInstanceOf(SocialTrustManager);
    });

    it('uses provided SimplePool if passed', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkey = 'a'.repeat(64);

      vi.mocked(mockPool.querySync).mockResolvedValue([]);

      await manager.getSocialDistance(pubkey, 'b'.repeat(64));

      expect(mockPool.querySync).toHaveBeenCalled();
    });
  });

  // Task 9: Distance=0 (same pubkey)
  describe('getSocialDistance - same pubkey (distance=0)', () => {
    it('returns 0 when fromPubkey equals toPubkey', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkey = 'a'.repeat(64);

      const distance = await manager.getSocialDistance(pubkey, pubkey);

      expect(distance).toBe(0);
    });

    it('does not make relay queries when pubkeys are the same', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkey = 'a'.repeat(64);

      await manager.getSocialDistance(pubkey, pubkey);

      expect(mockPool.querySync).not.toHaveBeenCalled();
    });
  });

  // Task 10: Distance=1 (direct follow)
  describe('getSocialDistance - direct follow (distance=1)', () => {
    it('returns 1 when fromPubkey directly follows toPubkey', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const fromPubkey = 'a'.repeat(64);
      const toPubkey = 'b'.repeat(64);

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(fromPubkey, [toPubkey]),
      ]);

      const distance = await manager.getSocialDistance(fromPubkey, toPubkey);

      expect(distance).toBe(1);
    });

    it('returns 1 when target is among multiple follows', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const fromPubkey = 'a'.repeat(64);
      const toPubkey = 'b'.repeat(64);
      const otherPubkey = 'c'.repeat(64);

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(fromPubkey, [otherPubkey, toPubkey]),
      ]);

      const distance = await manager.getSocialDistance(fromPubkey, toPubkey);

      expect(distance).toBe(1);
    });
  });

  // Task 11: Distance=2 (follow-of-follow)
  describe('getSocialDistance - follow-of-follow (distance=2)', () => {
    it('returns 2 when path is A follows B, B follows C', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);

      // A follows B
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB]),
      ]);
      // B follows C
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyB, [pubkeyC]),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyC);

      expect(distance).toBe(2);
    });
  });

  // Task 12: Distance=3
  describe('getSocialDistance - three hops (distance=3)', () => {
    it('returns 3 when path is A->B->C->D', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);
      const pubkeyD = 'd'.repeat(64);

      // A follows B
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB]),
      ]);
      // B follows C
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyB, [pubkeyC]),
      ]);
      // C follows D
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyC, [pubkeyD]),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyD);

      expect(distance).toBe(3);
    });
  });

  // Task 13: Infinity (no path)
  describe('getSocialDistance - no path (Infinity)', () => {
    it('returns Infinity when no path exists within maxDepth', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);
      const pubkeyD = 'd'.repeat(64);
      const unconnected = 'e'.repeat(64);

      // A follows B
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB]),
      ]);
      // B follows C
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyB, [pubkeyC]),
      ]);
      // C follows D (but not unconnected)
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyC, [pubkeyD]),
      ]);
      // D follows no one relevant
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyD, []),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, unconnected);

      expect(distance).toBe(Infinity);
    });

    it('returns Infinity when fromPubkey has no follows', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, []),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyB);

      expect(distance).toBe(Infinity);
    });

    it('returns Infinity when relay returns no events', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyB);

      expect(distance).toBe(Infinity);
    });
  });

  // Task 14: Custom maxDepth
  describe('getSocialDistance - custom maxDepth', () => {
    it('maxDepth=1 only checks direct follows', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);

      // A follows B, B follows C
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB]),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyC, 1);

      expect(distance).toBe(Infinity);
      // Only one query made (for A's follows)
      expect(mockPool.querySync).toHaveBeenCalledTimes(1);
    });

    it('maxDepth=2 checks up to 2 hops', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);

      // A follows B
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB]),
      ]);
      // B follows C
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyB, [pubkeyC]),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyC, 2);

      expect(distance).toBe(2);
    });

    it('returns Infinity when path exists but beyond maxDepth', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);
      const pubkeyD = 'd'.repeat(64);

      // A -> B -> C -> D (3 hops)
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB]),
      ]);
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyB, [pubkeyC]),
      ]);

      // maxDepth=2 cannot reach D
      const distance = await manager.getSocialDistance(pubkeyA, pubkeyD, 2);

      expect(distance).toBe(Infinity);
    });
  });

  // Task 15: Cycle handling
  describe('getSocialDistance - cycle handling', () => {
    it('handles circular follow graph (A follows B, B follows A)', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);

      // A follows B
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB]),
      ]);
      // B follows A (cycle) and C
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyB, [pubkeyA, pubkeyC]),
      ]);

      // Should not infinite loop, should find C at distance 2
      const distance = await manager.getSocialDistance(pubkeyA, pubkeyC);

      expect(distance).toBe(2);
    });

    it('does not revisit already-visited nodes', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      // A follows B
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB]),
      ]);
      // B follows A (cycle back)
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyB, [pubkeyA]),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, 'c'.repeat(64));

      expect(distance).toBe(Infinity);
      // A should not be queried again even though B follows A
      expect(mockPool.querySync).toHaveBeenCalledTimes(2);
    });

    it('handles self-follow gracefully', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      // A follows A (self) and B
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyA, pubkeyB]),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyB);

      expect(distance).toBe(1);
    });
  });

  // Task 16: Invalid pubkey handling
  describe('getSocialDistance - invalid pubkey handling', () => {
    it('throws TrustCalculationError for invalid fromPubkey', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      await expect(
        manager.getSocialDistance('invalid', 'a'.repeat(64))
      ).rejects.toThrow(TrustCalculationError);

      await expect(
        manager.getSocialDistance('invalid', 'a'.repeat(64))
      ).rejects.toThrow('Invalid pubkey format');
    });

    it('throws TrustCalculationError for invalid toPubkey', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      await expect(
        manager.getSocialDistance('a'.repeat(64), 'invalid')
      ).rejects.toThrow(TrustCalculationError);
    });

    it('throws TrustCalculationError for uppercase hex pubkey', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      await expect(
        manager.getSocialDistance('A'.repeat(64), 'b'.repeat(64))
      ).rejects.toThrow(TrustCalculationError);
    });

    it('throws TrustCalculationError for wrong length pubkey', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      await expect(
        manager.getSocialDistance('a'.repeat(63), 'b'.repeat(64))
      ).rejects.toThrow(TrustCalculationError);

      await expect(
        manager.getSocialDistance('a'.repeat(64), 'b'.repeat(65))
      ).rejects.toThrow(TrustCalculationError);
    });

    it('has correct error code for TrustCalculationError', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      try {
        await manager.getSocialDistance('invalid', 'a'.repeat(64));
        expect.fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TrustCalculationError);
        expect((error as TrustCalculationError).code).toBe('TRUST_CALCULATION_FAILED');
      }
    });
  });

  // Task 17: Empty follow lists
  describe('getSocialDistance - empty follow lists', () => {
    it('handles pubkey with no follows (returns Infinity)', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, []),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyB);

      expect(distance).toBe(Infinity);
    });

    it('handles relay returning no events', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      vi.mocked(mockPool.querySync).mockResolvedValueOnce([]);

      const distance = await manager.getSocialDistance('a'.repeat(64), 'b'.repeat(64));

      expect(distance).toBe(Infinity);
    });

    it('handles relay query failure gracefully', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      vi.mocked(mockPool.querySync).mockRejectedValueOnce(new Error('Network error'));

      const distance = await manager.getSocialDistance('a'.repeat(64), 'b'.repeat(64));

      // Should not throw, just return Infinity
      expect(distance).toBe(Infinity);
    });
  });

  // ============================================
  // getMutualFollowers tests (Story 3.2)
  // ============================================

  // Task 5: Basic functionality tests
  describe('getMutualFollowers - basic functionality', () => {
    it('returns empty array when no mutual followers exist', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const followerX = 'x'.repeat(64);
      const followerY = 'y'.repeat(64);

      // X follows A, Y follows B (no overlap)
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(followerX, [pubkeyA])])
        .mockResolvedValueOnce([createKind3Event(followerY, [pubkeyB])]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      expect(result).toEqual([]);
    });

    it('returns correct pubkeys when mutual followers exist', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollower = 'm'.repeat(64);

      // mutualFollower follows both A and B
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(mutualFollower, [pubkeyA])])
        .mockResolvedValueOnce([createKind3Event(mutualFollower, [pubkeyB])]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      expect(result).toEqual([mutualFollower]);
    });

    it('returns all mutual followers when multiple exist', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const follower1 = '1'.repeat(64);
      const follower2 = '2'.repeat(64);
      const follower3 = '3'.repeat(64);

      // follower1 and follower2 follow both A and B, follower3 only follows A
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([
          createKind3Event(follower1, [pubkeyA]),
          createKind3Event(follower2, [pubkeyA]),
          createKind3Event(follower3, [pubkeyA]),
        ])
        .mockResolvedValueOnce([
          createKind3Event(follower1, [pubkeyB]),
          createKind3Event(follower2, [pubkeyB]),
        ]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      expect(result).toHaveLength(2);
      expect(result).toContain(follower1);
      expect(result).toContain(follower2);
      expect(result).not.toContain(follower3);
    });

    it('returns sorted array for deterministic output', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const followerZ = 'z'.repeat(64);
      const followerM = 'm'.repeat(64);
      const followerA = 'a'.repeat(63) + 'b'; // slightly different from pubkeyA

      // Return in unsorted order
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([
          createKind3Event(followerZ, [pubkeyA]),
          createKind3Event(followerM, [pubkeyA]),
          createKind3Event(followerA, [pubkeyA]),
        ])
        .mockResolvedValueOnce([
          createKind3Event(followerZ, [pubkeyB]),
          createKind3Event(followerM, [pubkeyB]),
          createKind3Event(followerA, [pubkeyB]),
        ]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      // Should be sorted
      expect(result).toEqual([...result].sort());
    });
  });

  // Task 6: Edge cases tests
  describe('getMutualFollowers - edge cases', () => {
    it('returns empty array when same pubkey for A and B', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkey = 'a'.repeat(64);

      const result = await manager.getMutualFollowers(pubkey, pubkey);

      expect(result).toEqual([]);
      // Should not make any relay queries
      expect(mockPool.querySync).not.toHaveBeenCalled();
    });

    it('throws TrustCalculationError for invalid pubkeyA', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      await expect(
        manager.getMutualFollowers('invalid', 'a'.repeat(64))
      ).rejects.toThrow(TrustCalculationError);
    });

    it('throws TrustCalculationError for invalid pubkeyB', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      await expect(
        manager.getMutualFollowers('a'.repeat(64), 'invalid')
      ).rejects.toThrow(TrustCalculationError);
    });

    it('returns empty array when relay returns no events', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      expect(result).toEqual([]);
    });

    it('returns empty array when one pubkey has no followers', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const follower = 'f'.repeat(64);

      // A has a follower, B has none
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(follower, [pubkeyA])])
        .mockResolvedValueOnce([]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      expect(result).toEqual([]);
    });
  });

  // Task 7: Intersection calculation tests
  describe('getMutualFollowers - intersection calculation', () => {
    it('A has followers [X, Y, Z], B has followers [Y, Z, W] → returns [Y, Z]', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const followerX = 'x'.repeat(64);
      const followerY = 'y'.repeat(64);
      const followerZ = 'z'.repeat(64);
      const followerW = 'w'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([
          createKind3Event(followerX, [pubkeyA]),
          createKind3Event(followerY, [pubkeyA]),
          createKind3Event(followerZ, [pubkeyA]),
        ])
        .mockResolvedValueOnce([
          createKind3Event(followerY, [pubkeyB]),
          createKind3Event(followerZ, [pubkeyB]),
          createKind3Event(followerW, [pubkeyB]),
        ]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      expect(result).toHaveLength(2);
      expect(result).toContain(followerY);
      expect(result).toContain(followerZ);
    });

    it('A has followers [X], B has followers [Y] → returns []', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const followerX = 'x'.repeat(64);
      const followerY = 'y'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(followerX, [pubkeyA])])
        .mockResolvedValueOnce([createKind3Event(followerY, [pubkeyB])]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      expect(result).toEqual([]);
    });

    it('A has followers [X, Y], B has followers [X, Y] → returns [X, Y]', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const followerX = 'x'.repeat(64);
      const followerY = 'y'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([
          createKind3Event(followerX, [pubkeyA]),
          createKind3Event(followerY, [pubkeyA]),
        ])
        .mockResolvedValueOnce([
          createKind3Event(followerX, [pubkeyB]),
          createKind3Event(followerY, [pubkeyB]),
        ]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      expect(result).toHaveLength(2);
      expect(result).toContain(followerX);
      expect(result).toContain(followerY);
    });
  });

  // Task 8: Parallel queries tests
  describe('getMutualFollowers - parallel queries', () => {
    it('makes both follower queries in parallel', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      const callOrder: string[] = [];
      vi.mocked(mockPool.querySync).mockImplementation(async (_relays, filter) => {
        const filterWithP = filter as { '#p'?: string[] };
        if (filterWithP['#p']?.[0] === pubkeyA) {
          callOrder.push('A');
        } else if (filterWithP['#p']?.[0] === pubkeyB) {
          callOrder.push('B');
        }
        return [];
      });

      await manager.getMutualFollowers(pubkeyA, pubkeyB);

      // Both queries should be made
      expect(mockPool.querySync).toHaveBeenCalledTimes(2);
      // Verify the filter patterns
      expect(mockPool.querySync).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kinds: [3], '#p': [pubkeyA] })
      );
      expect(mockPool.querySync).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kinds: [3], '#p': [pubkeyB] })
      );
    });

    it('handles one query failing while other succeeds', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const follower = 'f'.repeat(64);

      // First query fails, second succeeds
      vi.mocked(mockPool.querySync)
        .mockRejectedValueOnce(new Error('Query A failed'))
        .mockResolvedValueOnce([createKind3Event(follower, [pubkeyB])]);

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      // Should return empty (can't have mutual if one failed)
      expect(result).toEqual([]);
    });

    it('handles both queries failing gracefully', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockRejectedValueOnce(new Error('Query A failed'))
        .mockRejectedValueOnce(new Error('Query B failed'));

      const result = await manager.getMutualFollowers(pubkeyA, pubkeyB);

      // Should not throw, just return empty array
      expect(result).toEqual([]);
    });
  });

  // Additional BFS tests
  describe('getSocialDistance - BFS behavior', () => {
    it('finds shortest path when multiple paths exist', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);
      const pubkeyD = 'd'.repeat(64);

      // A follows B and C
      // B follows D (distance 2)
      // C follows nothing
      // So A->B->D is distance 2
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB, pubkeyC]),
      ]);
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyB, [pubkeyD]),
      ]);
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyC, []),
      ]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyD);

      expect(distance).toBe(2);
    });

    it('uses Promise.allSettled for parallel queries within a level', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);
      const pubkeyTarget = 'd'.repeat(64);

      // A follows B and C
      vi.mocked(mockPool.querySync).mockResolvedValueOnce([
        createKind3Event(pubkeyA, [pubkeyB, pubkeyC]),
      ]);

      // B's query fails, C follows target
      vi.mocked(mockPool.querySync)
        .mockRejectedValueOnce(new Error('B query failed'))
        .mockResolvedValueOnce([createKind3Event(pubkeyC, [pubkeyTarget])]);

      const distance = await manager.getSocialDistance(pubkeyA, pubkeyTarget);

      // Should still find target through C despite B's failure
      expect(distance).toBe(2);
    });
  });

  // ============================================
  // computeTrustScore tests (Story 3.3)
  // ============================================

  // Task 10: TrustConfig and TrustScore types tests
  describe('DEFAULT_TRUST_CONFIG', () => {
    it('has all required TrustConfig fields', () => {
      expect(DEFAULT_TRUST_CONFIG).toHaveProperty('socialDistanceWeight');
      expect(DEFAULT_TRUST_CONFIG).toHaveProperty('mutualFollowersWeight');
      expect(DEFAULT_TRUST_CONFIG).toHaveProperty('reputationWeight');
      expect(DEFAULT_TRUST_CONFIG).toHaveProperty('maxSocialDistance');
      expect(DEFAULT_TRUST_CONFIG).toHaveProperty('maxMutualFollowers');
    });

    it('has sensible default values', () => {
      expect(DEFAULT_TRUST_CONFIG.socialDistanceWeight).toBe(0.5);
      expect(DEFAULT_TRUST_CONFIG.mutualFollowersWeight).toBe(0.3);
      expect(DEFAULT_TRUST_CONFIG.reputationWeight).toBe(0.2);
      expect(DEFAULT_TRUST_CONFIG.maxSocialDistance).toBe(3);
      expect(DEFAULT_TRUST_CONFIG.maxMutualFollowers).toBe(10);
    });

    it('has weights that sum to 1.0', () => {
      const sum =
        DEFAULT_TRUST_CONFIG.socialDistanceWeight +
        DEFAULT_TRUST_CONFIG.mutualFollowersWeight +
        DEFAULT_TRUST_CONFIG.reputationWeight;
      expect(sum).toBe(1.0);
    });
  });

  // Task 11: Social distance scoring tests
  describe('computeTrustScore - social distance scoring', () => {
    it('distance 0 (self) returns distanceScore 1.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkey = 'a'.repeat(64);

      const result = await manager.computeTrustScore(pubkey, pubkey);

      expect(result.breakdown.socialDistanceScore).toBe(1.0);
    });

    it('distance 1 (direct follow) returns distanceScore 1.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const fromPubkey = 'a'.repeat(64);
      const toPubkey = 'b'.repeat(64);

      // A directly follows B
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(fromPubkey, [toPubkey])]) // getSocialDistance
        .mockResolvedValueOnce([]) // getMutualFollowers query 1
        .mockResolvedValueOnce([]); // getMutualFollowers query 2

      const result = await manager.computeTrustScore(fromPubkey, toPubkey);

      expect(result.socialDistance).toBe(1);
      expect(result.breakdown.socialDistanceScore).toBe(1.0);
    });

    it('distance 2 returns distanceScore ~0.5', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);

      // A follows B, B follows C
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])]) // getSocialDistance level 1
        .mockResolvedValueOnce([createKind3Event(pubkeyB, [pubkeyC])]) // getSocialDistance level 2
        .mockResolvedValueOnce([]) // getMutualFollowers query 1
        .mockResolvedValueOnce([]); // getMutualFollowers query 2

      const result = await manager.computeTrustScore(pubkeyA, pubkeyC);

      expect(result.socialDistance).toBe(2);
      // Formula: 1 - (2 - 1) / (3 - 1) = 1 - 0.5 = 0.5
      expect(result.breakdown.socialDistanceScore).toBe(0.5);
    });

    it('distance 3 returns distanceScore ~0.0 (at maxDistance)', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);
      const pubkeyD = 'd'.repeat(64);

      // A -> B -> C -> D (3 hops)
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([createKind3Event(pubkeyB, [pubkeyC])])
        .mockResolvedValueOnce([createKind3Event(pubkeyC, [pubkeyD])])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyD);

      expect(result.socialDistance).toBe(3);
      // Formula: 1 - (3 - 1) / (3 - 1) = 0
      expect(result.breakdown.socialDistanceScore).toBe(0);
    });

    it('distance >= maxDistance returns distanceScore 0.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const unconnected = 'e'.repeat(64);

      // No path exists
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [])]) // getSocialDistance
        .mockResolvedValueOnce([]) // getMutualFollowers query 1
        .mockResolvedValueOnce([]); // getMutualFollowers query 2

      const result = await manager.computeTrustScore(pubkeyA, unconnected);

      expect(result.socialDistance).toBe(Infinity);
      expect(result.breakdown.socialDistanceScore).toBe(0);
    });

    it('Infinity distance returns distanceScore 0.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([]) // No follows
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.socialDistance).toBe(Infinity);
      expect(result.breakdown.socialDistanceScore).toBe(0);
    });
  });

  // Task 12: Mutual followers scoring tests
  describe('computeTrustScore - mutual followers scoring', () => {
    it('0 mutual followers returns mutualFollowersScore 0.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])]) // getSocialDistance
        .mockResolvedValueOnce([]) // getMutualFollowers - no followers for A
        .mockResolvedValueOnce([]); // getMutualFollowers - no followers for B

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.mutualFollowerCount).toBe(0);
      expect(result.breakdown.mutualFollowersScore).toBe(0);
    });

    it('5 mutual followers with maxCount=10 returns score 0.5', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollowers = Array.from({ length: 5 }, (_, i) => (i + 1).toString().repeat(64));

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])]) // getSocialDistance
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyA])))
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyB])));

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.mutualFollowerCount).toBe(5);
      expect(result.breakdown.mutualFollowersScore).toBe(0.5);
    });

    it('10 mutual followers with maxCount=10 returns score 1.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollowers = Array.from({ length: 10 }, (_, i) => (i + 1).toString().padStart(64, '0'));

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyA])))
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyB])));

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.mutualFollowerCount).toBe(10);
      expect(result.breakdown.mutualFollowersScore).toBe(1.0);
    });

    it('20 mutual followers with maxCount=10 returns score 1.0 (capped)', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollowers = Array.from({ length: 20 }, (_, i) => (i + 1).toString().padStart(64, '0'));

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyA])))
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyB])));

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.mutualFollowerCount).toBe(20);
      expect(result.breakdown.mutualFollowersScore).toBe(1.0);
    });
  });

  // Task 13: computeTrustScore basic functionality tests
  describe('computeTrustScore - basic functionality', () => {
    it('returns TrustScore object with all required fields', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('socialDistance');
      expect(result).toHaveProperty('mutualFollowerCount');
      expect(result).toHaveProperty('breakdown');
      expect(result.breakdown).toHaveProperty('socialDistanceScore');
      expect(result.breakdown).toHaveProperty('mutualFollowersScore');
      expect(result.breakdown).toHaveProperty('reputationScore');
    });

    it('calls getSocialDistance internally', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.socialDistance).toBe(1);
    });

    it('calls getMutualFollowers internally', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollower = 'm'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([createKind3Event(mutualFollower, [pubkeyA])])
        .mockResolvedValueOnce([createKind3Event(mutualFollower, [pubkeyB])]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.mutualFollowerCount).toBe(1);
    });
  });

  // Task 14: computeTrustScore with default config tests
  describe('computeTrustScore - default config', () => {
    it('direct follow (distance=1) with 0 mutuals calculates correctly', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      // distanceScore=1.0, mutualScore=0.0, repScore=0.5
      // score = (1.0*0.5 + 0.0*0.3 + 0.5*0.2) / 1.0 = 0.5 + 0 + 0.1 = 0.6
      expect(result.score).toBeCloseTo(0.6, 5);
    });

    it('direct follow (distance=1) with 5 mutuals calculates correctly', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollowers = Array.from({ length: 5 }, (_, i) => (i + 1).toString().repeat(64));

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyA])))
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyB])));

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      // distanceScore=1.0, mutualScore=0.5, repScore=0.5
      // score = (1.0*0.5 + 0.5*0.3 + 0.5*0.2) = 0.5 + 0.15 + 0.1 = 0.75
      expect(result.score).toBeCloseTo(0.75, 5);
    });

    it('follow-of-follow (distance=2) with 10 mutuals calculates correctly', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);
      const mutualFollowers = Array.from({ length: 10 }, (_, i) => (i + 1).toString().padStart(64, '0'));

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([createKind3Event(pubkeyB, [pubkeyC])])
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyA])))
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyC])));

      const result = await manager.computeTrustScore(pubkeyA, pubkeyC);

      // distanceScore=0.5 (distance 2), mutualScore=1.0, repScore=0.5
      // score = (0.5*0.5 + 1.0*0.3 + 0.5*0.2) = 0.25 + 0.3 + 0.1 = 0.65
      expect(result.score).toBeCloseTo(0.65, 5);
    });

    it('no connection (Infinity) with 0 mutuals returns score near 0.1', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([]) // No follows
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      // distanceScore=0.0, mutualScore=0.0, repScore=0.5
      // score = (0.0*0.5 + 0.0*0.3 + 0.5*0.2) = 0 + 0 + 0.1 = 0.1
      expect(result.score).toBeCloseTo(0.1, 5);
    });
  });

  // Task 15: computeTrustScore with custom config tests
  describe('computeTrustScore - custom config', () => {
    it('custom weights are applied correctly', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const customConfig: Partial<TrustConfig> = {
        socialDistanceWeight: 1.0,
        mutualFollowersWeight: 0.0,
        reputationWeight: 0.0,
      };

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB, customConfig);

      // Only distance matters, direct follow = 1.0
      expect(result.score).toBeCloseTo(1.0, 5);
    });

    it('socialDistanceWeight=1.0 (only distance matters)', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const pubkeyC = 'c'.repeat(64);

      // Distance 2
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([createKind3Event(pubkeyB, [pubkeyC])])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyC, {
        socialDistanceWeight: 1.0,
        mutualFollowersWeight: 0.0,
        reputationWeight: 0.0,
      });

      // Distance 2 score = 0.5
      expect(result.score).toBeCloseTo(0.5, 5);
    });

    it('mutualFollowersWeight=1.0 (only mutuals matter)', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollowers = Array.from({ length: 5 }, (_, i) => (i + 1).toString().repeat(64));

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyA])))
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyB])));

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB, {
        socialDistanceWeight: 0.0,
        mutualFollowersWeight: 1.0,
        reputationWeight: 0.0,
      });

      // 5/10 = 0.5
      expect(result.score).toBeCloseTo(0.5, 5);
    });

    it('partial config merges with defaults', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      // Only override maxMutualFollowers
      const result = await manager.computeTrustScore(pubkeyA, pubkeyB, {
        maxMutualFollowers: 20,
      });

      // Should still use default weights
      // distanceScore=1.0, mutualScore=0.0, repScore=0.5
      // score = (1.0*0.5 + 0.0*0.3 + 0.5*0.2) = 0.6
      expect(result.score).toBeCloseTo(0.6, 5);
    });
  });

  // Task 16: Edge cases tests
  describe('computeTrustScore - edge cases', () => {
    it('same pubkey returns score 1.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkey = 'a'.repeat(64);

      const result = await manager.computeTrustScore(pubkey, pubkey);

      expect(result.score).toBe(1.0);
      expect(result.socialDistance).toBe(0);
      expect(result.mutualFollowerCount).toBe(0);
      expect(result.breakdown.socialDistanceScore).toBe(1.0);
      expect(result.breakdown.mutualFollowersScore).toBe(1.0);
      expect(result.breakdown.reputationScore).toBe(1.0);
      expect(mockPool.querySync).not.toHaveBeenCalled();
    });

    it('invalid pubkey throws TrustCalculationError', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);

      await expect(
        manager.computeTrustScore('invalid', 'a'.repeat(64))
      ).rejects.toThrow(TrustCalculationError);

      await expect(
        manager.computeTrustScore('a'.repeat(64), 'invalid')
      ).rejects.toThrow(TrustCalculationError);
    });

    it('handles relay failures gracefully (returns low score, not error)', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      // All queries fail
      vi.mocked(mockPool.querySync)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      // Graceful degradation: Infinity distance, 0 mutuals
      expect(result.socialDistance).toBe(Infinity);
      expect(result.mutualFollowerCount).toBe(0);
      expect(result.score).toBeCloseTo(0.1, 5); // Only reputation contributes
    });

    it('config with all weights set to 0 returns score 0.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB, {
        socialDistanceWeight: 0,
        mutualFollowersWeight: 0,
        reputationWeight: 0,
      });

      expect(result.score).toBe(0);
    });
  });

  // Task 17: Score bounds tests
  describe('computeTrustScore - score bounds', () => {
    it('score is always >= 0.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      // Worst case: no connection, no mutuals
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('score is always <= 1.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollowers = Array.from({ length: 100 }, (_, i) => (i + 1).toString().padStart(64, '0'));

      // Best case: direct follow with many mutuals
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyA])))
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyB])));

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      expect(result.score).toBeLessThanOrEqual(1.0);
    });

    it('maximum trust scenario returns score close to 1.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);
      const mutualFollowers = Array.from({ length: 10 }, (_, i) => (i + 1).toString().padStart(64, '0'));

      // Direct follow + max mutuals
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([createKind3Event(pubkeyA, [pubkeyB])])
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyA])))
        .mockResolvedValueOnce(mutualFollowers.map((pk) => createKind3Event(pk, [pubkeyB])));

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB);

      // distanceScore=1.0, mutualScore=1.0, repScore=0.5
      // score = (1.0*0.5 + 1.0*0.3 + 0.5*0.2) = 0.5 + 0.3 + 0.1 = 0.9
      expect(result.score).toBeCloseTo(0.9, 5);
    });

    it('minimum trust scenario (non-self) returns score close to 0.0', async () => {
      const manager = new SocialTrustManager(['wss://relay.example'], mockPool);
      const pubkeyA = 'a'.repeat(64);
      const pubkeyB = 'b'.repeat(64);

      // No connection, no mutuals, but with reputation=0 weights
      vi.mocked(mockPool.querySync)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.computeTrustScore(pubkeyA, pubkeyB, {
        socialDistanceWeight: 0.5,
        mutualFollowersWeight: 0.5,
        reputationWeight: 0.0,
      });

      // distanceScore=0, mutualScore=0, no reputation weight
      expect(result.score).toBe(0);
    });
  });
});
