/**
 * Event builders, parsers, and reputation scoring for DVM reputation system.
 *
 * Defines two new event kinds:
 * - Kind 31117 (Job Review): NIP-33 parameterized replaceable event for
 *   post-job reviews with integer 1-5 ratings.
 * - Kind 30382 (Web of Trust): NIP-33 parameterized replaceable event for
 *   endorsing provider pubkeys.
 *
 * Also provides:
 * - `ReputationScoreCalculator`: Pure logic class computing composite
 *   reputation scores from pre-gathered signals.
 * - `hasMinReputation()`: Utility for extracting `min_reputation` parameter
 *   from parsed job request params.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { JOB_REVIEW_KIND, WEB_OF_TRUST_KIND } from '../constants.js';
import { ToonError } from '../errors.js';

// Re-export constants for convenient co-located imports
export { JOB_REVIEW_KIND, WEB_OF_TRUST_KIND };

// ---------- Validation Helpers ----------

/** Regex for 64-char lowercase hex string. */
const HEX_64_REGEX = /^[0-9a-f]{64}$/;

// ---------- Types ----------

/** Parameters for building a Kind 31117 Job Review event. */
export interface JobReviewParams {
  /** 64-char hex event ID of the original Kind 5xxx job request. */
  jobRequestEventId: string;
  /** 64-char hex pubkey of the target provider being reviewed. */
  targetPubkey: string;
  /** Integer rating 1-5. */
  rating: number;
  /** Role of the reviewer: 'customer' or 'provider'. */
  role: 'customer' | 'provider';
  /** Optional text review content. */
  content?: string;
}

/** Parsed result from a Kind 31117 Job Review event. */
export interface ParsedJobReview {
  /** Job request event ID from the `d` tag. */
  jobRequestEventId: string;
  /** Target provider pubkey from the `p` tag. */
  targetPubkey: string;
  /** Integer rating 1-5. */
  rating: number;
  /** Role of the reviewer. */
  role: 'customer' | 'provider';
  /** Review text content. */
  content: string;
}

/** Parameters for building a Kind 30382 Web of Trust declaration event. */
export interface WotDeclarationParams {
  /** 64-char hex pubkey of the target provider being endorsed. */
  targetPubkey: string;
  /** Optional endorsement reason. */
  content?: string;
}

/** Parsed result from a Kind 30382 Web of Trust declaration event. */
export interface ParsedWotDeclaration {
  /** Target provider pubkey from the `p` tag. */
  targetPubkey: string;
  /** Declarer pubkey from the event's pubkey field. */
  declarerPubkey: string;
  /** Endorsement content. */
  content: string;
}

/** Individual reputation signal values. */
export interface ReputationSignals {
  /** Count of WoT declarations from non-zero-volume declarers. */
  trustedBy: number;
  /** Total USDC settled through the provider's payment channels. */
  channelVolumeUsdc: number;
  /** Count of Kind 6xxx result events published by the provider. */
  jobsCompleted: number;
  /** Mean rating from verified customer reviews (0 when no reviews). */
  avgRating: number;
}

/** Composite reputation score with individual signal values. */
export interface ReputationScore {
  /** The composite reputation score. */
  score: number;
  /** Individual signal values used to compute the score. */
  signals: ReputationSignals;
}

// ---------- Builders ----------

/**
 * Builds a Kind 31117 Job Review event (NIP-33 parameterized replaceable).
 *
 * The `d` tag = job request event ID enforces one review per job per reviewer.
 * Tags: `d` (job request ID), `p` (target pubkey), `rating`, `role`.
 *
 * @param params - The job review parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError for invalid inputs.
 */
export function buildJobReviewEvent(
  params: JobReviewParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate jobRequestEventId
  if (!HEX_64_REGEX.test(params.jobRequestEventId)) {
    throw new ToonError(
      'Job review jobRequestEventId must be a 64-character lowercase hex string',
      'REPUTATION_INVALID_JOB_REQUEST_EVENT_ID'
    );
  }

  // Validate targetPubkey
  if (!HEX_64_REGEX.test(params.targetPubkey)) {
    throw new ToonError(
      'Job review targetPubkey must be a 64-character lowercase hex string',
      'REPUTATION_INVALID_TARGET_PUBKEY'
    );
  }

  // Validate rating (integer 1-5)
  if (
    typeof params.rating !== 'number' ||
    !Number.isInteger(params.rating) ||
    params.rating < 1 ||
    params.rating > 5
  ) {
    throw new ToonError(
      `Job review rating must be an integer 1-5, got ${String(params.rating)}`,
      'REPUTATION_INVALID_RATING'
    );
  }

  // Validate role
  if (params.role !== 'customer' && params.role !== 'provider') {
    throw new ToonError(
      `Job review role must be 'customer' or 'provider', got '${String(params.role)}'`,
      'REPUTATION_INVALID_ROLE'
    );
  }

  const tags: string[][] = [
    ['d', params.jobRequestEventId],
    ['p', params.targetPubkey],
    ['rating', params.rating.toString()],
    ['role', params.role],
  ];

  return finalizeEvent(
    {
      kind: JOB_REVIEW_KIND,
      content: params.content ?? '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

/**
 * Parses a Kind 31117 event into a ParsedJobReview.
 *
 * Returns `null` for malformed events (wrong kind, missing tags, invalid rating).
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed job review, or null if invalid.
 */
export function parseJobReview(event: NostrEvent): ParsedJobReview | null {
  if (event.kind !== JOB_REVIEW_KIND) {
    return null;
  }

  // Extract d tag (job request event ID)
  const dTag = event.tags.find((t: string[]) => t[0] === 'd');
  if (!dTag) return null;
  const jobRequestEventId = dTag[1];
  if (jobRequestEventId === undefined || !HEX_64_REGEX.test(jobRequestEventId))
    return null;

  // Extract p tag (target pubkey)
  const pTag = event.tags.find((t: string[]) => t[0] === 'p');
  if (!pTag) return null;
  const targetPubkey = pTag[1];
  if (targetPubkey === undefined || !HEX_64_REGEX.test(targetPubkey))
    return null;

  // Extract rating tag
  const ratingTag = event.tags.find((t: string[]) => t[0] === 'rating');
  if (!ratingTag) return null;
  const ratingStr = ratingTag[1];
  if (ratingStr === undefined) return null;
  const rating = Number(ratingStr);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;

  // Extract role tag
  const roleTag = event.tags.find((t: string[]) => t[0] === 'role');
  if (!roleTag) return null;
  const role = roleTag[1];
  if (role !== 'customer' && role !== 'provider') return null;

  return {
    jobRequestEventId,
    targetPubkey,
    rating,
    role,
    content: event.content,
  };
}

// ---------- Web of Trust ----------

/**
 * Builds a Kind 30382 Web of Trust declaration event (NIP-33 parameterized replaceable).
 *
 * The `d` tag = target pubkey enforces one WoT declaration per declarer per target.
 *
 * @param params - The WoT declaration parameters.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 * @throws ToonError for invalid inputs.
 */
export function buildWotDeclarationEvent(
  params: WotDeclarationParams,
  secretKey: Uint8Array
): NostrEvent {
  // Validate targetPubkey
  if (!HEX_64_REGEX.test(params.targetPubkey)) {
    throw new ToonError(
      'WoT declaration targetPubkey must be a 64-character lowercase hex string',
      'REPUTATION_INVALID_TARGET_PUBKEY'
    );
  }

  const tags: string[][] = [
    ['d', params.targetPubkey],
    ['p', params.targetPubkey],
  ];

  return finalizeEvent(
    {
      kind: WEB_OF_TRUST_KIND,
      content: params.content ?? '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

/**
 * Parses a Kind 30382 event into a ParsedWotDeclaration.
 *
 * Returns `null` for malformed events (wrong kind, missing tags,
 * d tag not matching p tag).
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed WoT declaration, or null if invalid.
 */
export function parseWotDeclaration(
  event: NostrEvent
): ParsedWotDeclaration | null {
  if (event.kind !== WEB_OF_TRUST_KIND) {
    return null;
  }

  // Extract d tag
  const dTag = event.tags.find((t: string[]) => t[0] === 'd');
  if (!dTag) return null;
  const dValue = dTag[1];
  if (dValue === undefined) return null;

  // Extract p tag
  const pTag = event.tags.find((t: string[]) => t[0] === 'p');
  if (!pTag) return null;
  const targetPubkey = pTag[1];
  if (targetPubkey === undefined || !HEX_64_REGEX.test(targetPubkey))
    return null;

  // d tag must match p tag (NIP-33 consistency)
  if (dValue !== targetPubkey) return null;

  return {
    targetPubkey,
    declarerPubkey: event.pubkey,
    content: event.content,
  };
}

// ---------- Reputation Score Calculator ----------

/**
 * Pure logic class for computing composite reputation scores.
 *
 * Receives pre-computed signals (WoT declarations, reviews, channel volume,
 * job count) and calculates the composite score. Does NOT perform relay
 * queries or on-chain reads. The caller is responsible for gathering signals.
 *
 * Formula: score = (trusted_by x 100) + (log10(max(1, channel_volume_usdc)) x 10)
 *                + (jobs_completed x 5) + (avg_rating x 20)
 */
export class ReputationScoreCalculator {
  /**
   * Computes the composite reputation score from pre-computed signals.
   *
   * @param signals - The individual signal values.
   * @returns The composite score with individual signals.
   */
  calculateScore(signals: ReputationSignals): ReputationScore {
    const score =
      signals.trustedBy * 100 +
      Math.log10(Math.max(1, signals.channelVolumeUsdc)) * 10 +
      signals.jobsCompleted * 5 +
      signals.avgRating * 20;

    // Guard: ensure the composite score is always a finite number (AC #1).
    // NaN or Infinity signals would propagate silently without this check.
    if (!isFinite(score)) {
      return { score: 0, signals };
    }

    return { score, signals };
  }

  /**
   * Computes the threshold-filtered trusted_by count from WoT declarations.
   *
   * Declarers with non-zero channel volume contribute 1 to the count.
   * Declarers with zero channel volume contribute 0 (sybil defense).
   *
   * @param wotDeclarations - Parsed WoT declarations targeting the provider.
   * @param getChannelVolume - Callback to look up a declarer's channel volume.
   * @returns The count of WoT declarations from non-zero-volume declarers.
   */
  computeTrustedBy(
    wotDeclarations: ParsedWotDeclaration[],
    getChannelVolume: (pubkey: string) => number
  ): number {
    let count = 0;
    for (const declaration of wotDeclarations) {
      const volume = getChannelVolume(declaration.declarerPubkey);
      if (volume > 0) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Computes the average rating from verified customer reviews only.
   *
   * Reviews are provided as tuples of `{ review, reviewerPubkey }` so the
   * calculator can filter by the verified customer set. Reviews from pubkeys
   * NOT in `verifiedCustomerPubkeys` are excluded entirely (customer-gate
   * sybil defense per E6-R013).
   *
   * @param reviews - Parsed job reviews with reviewer pubkeys.
   * @param verifiedCustomerPubkeys - Set of pubkeys that authored Kind 5xxx requests.
   * @returns The mean rating from verified reviews, or 0 when no verified reviews exist.
   */
  computeAvgRating(
    reviews: { review: ParsedJobReview; reviewerPubkey: string }[],
    verifiedCustomerPubkeys: Set<string>
  ): number {
    let sum = 0;
    let count = 0;
    for (const { review, reviewerPubkey } of reviews) {
      // Customer-gate: only count reviews from verified customers
      if (!verifiedCustomerPubkeys.has(reviewerPubkey)) {
        continue;
      }
      if (
        Number.isInteger(review.rating) &&
        review.rating >= 1 &&
        review.rating <= 5
      ) {
        sum += review.rating;
        count += 1;
      }
    }

    return count === 0 ? 0 : sum / count;
  }
}

// ---------- Utility Functions ----------

/**
 * Extracts the `min_reputation` parameter value from parsed job request params.
 *
 * Follows the same pattern as `hasRequireAttestation()`.
 *
 * @param params - The params array from a parsed job request.
 * @returns The numeric threshold value, null if not present, or throws on invalid value.
 * @throws ToonError with code REPUTATION_INVALID_MIN_REPUTATION if value is non-numeric.
 */
export function hasMinReputation(
  params: { key: string; value: string }[]
): number | null {
  const param = params.find((p) => p.key === 'min_reputation');
  if (param === undefined) {
    return null;
  }

  const trimmed = param.value.trim();
  const numericValue = Number(trimmed);
  if (trimmed === '' || isNaN(numericValue) || !isFinite(numericValue)) {
    throw new ToonError(
      `min_reputation value must be numeric, got '${param.value}'`,
      'REPUTATION_INVALID_MIN_REPUTATION'
    );
  }

  return numericValue;
}
