/**
 * Social trust calculation using Nostr social graph.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import { TrustCalculationError } from '../errors.js';
import type { TrustConfig, TrustScore } from '../types.js';

/** Regular expression for validating 64-character lowercase hex pubkeys */
const PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/**
 * Default configuration for trust score calculation.
 * Weights sum to 1.0 for normalized scoring.
 */
export const DEFAULT_TRUST_CONFIG: TrustConfig = {
  socialDistanceWeight: 0.5,
  mutualFollowersWeight: 0.3,
  reputationWeight: 0.2,
  maxSocialDistance: 3,
  maxMutualFollowers: 10,
};

/**
 * Calculates trust metrics based on the Nostr social graph.
 * Uses NIP-02 follow lists to determine social distance between pubkeys.
 */
export class SocialTrustManager {
  private readonly relayUrls: string[];
  private readonly pool: SimplePool;

  /**
   * Creates a new SocialTrustManager instance.
   *
   * @param relayUrls - Array of relay WebSocket URLs to query
   * @param pool - Optional SimplePool instance (creates new one if not provided)
   */
  constructor(relayUrls: string[], pool?: SimplePool) {
    this.relayUrls = relayUrls;
    this.pool = pool ?? new SimplePool();
  }

  /**
   * Validates a pubkey format.
   *
   * @param pubkey - The pubkey to validate
   * @throws TrustCalculationError if pubkey format is invalid
   */
  private validatePubkey(pubkey: string): void {
    if (!PUBKEY_REGEX.test(pubkey)) {
      throw new TrustCalculationError(
        `Invalid pubkey format: must be 64-character lowercase hex string`
      );
    }
  }

  /**
   * Retrieves the list of pubkeys that follow a given pubkey.
   *
   * Queries kind:3 events where the target pubkey appears in a 'p' tag.
   * Each matching event's author is a follower.
   *
   * @param pubkey - The pubkey to get followers for (must be validated before calling)
   * @returns Array of follower pubkeys (deduplicated)
   */
  private async getFollowersForPubkey(pubkey: string): Promise<string[]> {
    const filter: Filter = {
      kinds: [3],
      '#p': [pubkey],
    };

    try {
      const events = await this.pool.querySync(this.relayUrls, filter);

      // Each event's pubkey (author) is a follower
      const followers = events.map((event) => event.pubkey);

      // Deduplicate
      return [...new Set(followers)];
    } catch {
      // Handle relay failures gracefully - return empty array
      return [];
    }
  }

  /**
   * Retrieves the list of pubkeys that a given pubkey follows.
   *
   * @param pubkey - The pubkey to get follows for (must be validated before calling)
   * @returns Array of followed pubkeys
   */
  private async getFollowsForPubkey(pubkey: string): Promise<string[]> {
    const filter: Filter = {
      kinds: [3],
      authors: [pubkey],
      limit: 1,
    };

    try {
      const events = await this.pool.querySync(this.relayUrls, filter);

      if (events.length === 0) {
        return [];
      }

      // Sort by created_at descending and use the most recent
      const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
      const mostRecent = sortedEvents[0];

      if (!mostRecent) {
        return [];
      }

      // Extract pubkeys from 'p' tags and deduplicate
      const pubkeys = mostRecent.tags
        .filter((tag): tag is [string, string, ...string[]] => tag[0] === 'p' && typeof tag[1] === 'string')
        .map((tag) => tag[1]);

      return [...new Set(pubkeys)];
    } catch {
      // Handle relay failures gracefully - return empty array
      return [];
    }
  }

  /**
   * Calculates the social distance between two pubkeys in the follow graph.
   *
   * Uses BFS (Breadth-First Search) to find the shortest path from fromPubkey
   * to toPubkey through the follow graph.
   *
   * @param fromPubkey - The starting pubkey (64-character hex)
   * @param toPubkey - The target pubkey (64-character hex)
   * @param maxDepth - Maximum depth to search (default: 3)
   * @returns Distance (1 = direct follow, 2 = follow-of-follow, etc.) or Infinity if no path
   * @throws TrustCalculationError if pubkey format is invalid
   */
  async getSocialDistance(fromPubkey: string, toPubkey: string, maxDepth = 3): Promise<number> {
    // Validate both pubkeys
    this.validatePubkey(fromPubkey);
    this.validatePubkey(toPubkey);

    // Same identity = distance 0
    if (fromPubkey === toPubkey) {
      return 0;
    }

    // BFS setup
    const visited = new Set<string>([fromPubkey]);
    let currentLevel: string[] = [fromPubkey];
    let depth = 0;

    while (currentLevel.length > 0 && depth < maxDepth) {
      depth++;
      const nextLevel: string[] = [];

      // Batch queries for all pubkeys at current level
      const followPromises = currentLevel.map((pk) => this.getFollowsForPubkey(pk));
      const followResults = await Promise.allSettled(followPromises);

      for (const result of followResults) {
        if (result.status !== 'fulfilled') {
          continue;
        }

        const follows = result.value;

        for (const followed of follows) {
          // Found target!
          if (followed === toPubkey) {
            return depth;
          }

          // Queue unvisited nodes for next level
          if (!visited.has(followed)) {
            visited.add(followed);
            nextLevel.push(followed);
          }
        }
      }

      currentLevel = nextLevel;
    }

    // No path found within maxDepth
    return Infinity;
  }

  /**
   * Returns pubkeys that follow both pubkeyA and pubkeyB (mutual followers).
   *
   * @param pubkeyA - First pubkey (64-character hex)
   * @param pubkeyB - Second pubkey (64-character hex)
   * @returns Sorted array of pubkeys that follow both A and B
   * @throws TrustCalculationError if pubkey format is invalid
   */
  async getMutualFollowers(pubkeyA: string, pubkeyB: string): Promise<string[]> {
    // Validate both pubkeys
    this.validatePubkey(pubkeyA);
    this.validatePubkey(pubkeyB);

    // Edge case: same pubkey has no mutual followers with self
    if (pubkeyA === pubkeyB) {
      return [];
    }

    // Query followers for both pubkeys in parallel
    const [followersA, followersB] = await Promise.all([
      this.getFollowersForPubkey(pubkeyA),
      this.getFollowersForPubkey(pubkeyB),
    ]);

    // Compute intersection using Set for O(n+m) efficiency
    const setB = new Set(followersB);
    const mutual = followersA.filter((pk) => setB.has(pk));

    // Sort for deterministic output
    return mutual.sort();
  }

  /**
   * Calculates the trust score component from social distance.
   *
   * @param distance - Social distance (0 = self, 1 = direct follow, etc.)
   * @param maxDistance - Distance at which score becomes 0
   * @returns Score from 0-1
   */
  private calculateSocialDistanceScore(distance: number, maxDistance: number): number {
    if (distance === Infinity) return 0;
    if (distance <= 1) return 1.0; // Same identity or direct follow
    if (distance >= maxDistance) return 0;
    // Linear decay from 1.0 at distance 1 to 0.0 at maxDistance
    return 1 - (distance - 1) / (maxDistance - 1);
  }

  /**
   * Calculates the trust score component from mutual followers count.
   *
   * @param count - Number of mutual followers
   * @param maxCount - Count at which score reaches maximum
   * @returns Score from 0-1
   */
  private calculateMutualFollowersScore(count: number, maxCount: number): number {
    return Math.min(count / maxCount, 1.0);
  }

  /**
   * Calculates the trust score component from reputation.
   *
   * @returns Score from 0-1 (currently placeholder)
   */
  private calculateReputationScore(): number {
    // TODO: Implement NIP-57 zap-based reputation in future story
    return 0.5; // Neutral reputation for MVP
  }

  /**
   * Computes an overall trust score between two pubkeys using configured weights.
   *
   * @param fromPubkey - The trusting pubkey (64-character hex)
   * @param toPubkey - The pubkey being evaluated (64-character hex)
   * @param config - Optional partial config to override defaults
   * @returns TrustScore with overall score and component breakdown
   * @throws TrustCalculationError if pubkey format is invalid
   */
  async computeTrustScore(
    fromPubkey: string,
    toPubkey: string,
    config?: Partial<TrustConfig>
  ): Promise<TrustScore> {
    // Merge provided config with defaults
    const mergedConfig: TrustConfig = { ...DEFAULT_TRUST_CONFIG, ...config };

    // Validate both pubkeys
    this.validatePubkey(fromPubkey);
    this.validatePubkey(toPubkey);

    // Edge case: same pubkey = maximum self-trust
    if (fromPubkey === toPubkey) {
      return {
        score: 1.0,
        socialDistance: 0,
        mutualFollowerCount: 0,
        breakdown: {
          socialDistanceScore: 1.0,
          mutualFollowersScore: 1.0,
          reputationScore: 1.0,
        },
      };
    }

    // Get raw metrics
    const socialDistance = await this.getSocialDistance(fromPubkey, toPubkey);
    const mutualFollowers = await this.getMutualFollowers(fromPubkey, toPubkey);

    // Calculate component scores
    const socialDistanceScore = this.calculateSocialDistanceScore(
      socialDistance,
      mergedConfig.maxSocialDistance
    );
    const mutualFollowersScore = this.calculateMutualFollowersScore(
      mutualFollowers.length,
      mergedConfig.maxMutualFollowers
    );
    const reputationScore = this.calculateReputationScore();

    // Calculate total weight
    const totalWeight =
      mergedConfig.socialDistanceWeight +
      mergedConfig.mutualFollowersWeight +
      mergedConfig.reputationWeight;

    // Handle edge case: all weights are 0
    if (totalWeight === 0) {
      return {
        score: 0,
        socialDistance,
        mutualFollowerCount: mutualFollowers.length,
        breakdown: {
          socialDistanceScore,
          mutualFollowersScore,
          reputationScore,
        },
      };
    }

    // Compute weighted average (normalized)
    const weightedScore =
      (socialDistanceScore * mergedConfig.socialDistanceWeight +
        mutualFollowersScore * mergedConfig.mutualFollowersWeight +
        reputationScore * mergedConfig.reputationWeight) /
      totalWeight;

    // Clamp to [0, 1] range
    const score = Math.max(0, Math.min(1, weightedScore));

    return {
      score,
      socialDistance,
      mutualFollowerCount: mutualFollowers.length,
      breakdown: {
        socialDistanceScore,
        mutualFollowersScore,
        reputationScore,
      },
    };
  }
}
