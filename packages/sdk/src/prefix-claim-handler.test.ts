/**
 * ATDD tests for Story 7.6: Prefix Claim Handler (AC #8, #9, #10, #12)
 *
 * Tests for the prefix claim handler factory that processes kind 10034
 * events and validates payment, prefix availability, and format.
 *
 * Validates:
 * - Handler accepts claim with sufficient payment and available prefix
 * - Handler rejects claim with insufficient payment (ILP F06)
 * - Handler rejects already-claimed prefix (PREFIX_TAKEN)
 * - Handler rejects invalid prefix (validation rules)
 * - Race condition defense: concurrent claims -> exactly one succeeds
 *
 * Test IDs from test-design-epic-7.md:
 * - T-7.7-02 [P0]: Handler accepts valid claim
 * - T-7.7-03 [P0]: Handler rejects PREFIX_TAKEN
 * - T-7.7-04 [P0]: Handler rejects insufficient payment (F06)
 * - T-7.7-05 [I, P0]: Race condition defense
 * - T-7.7-12 [I, P0]: Atomicity via claimPrefix callback
 */

import { describe, it, expect } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { createPrefixClaimHandler } from './prefix-claim-handler.js';
import type { HandlerContext } from './handler-context.js';
import type {
  HandlePacketAcceptResponse,
  HandlePacketRejectResponse,
} from './handler-context.js';

// ============================================================================
// Deterministic test fixtures
// ============================================================================

/** Fixed secret key for the upstream node (handler owner) */
const UPSTREAM_SECRET_KEY = Uint8Array.from(Buffer.from('a'.repeat(64), 'hex'));

/** Fixed claimer secret key */
const CLAIMER_SECRET_KEY = Uint8Array.from(Buffer.from('b'.repeat(64), 'hex'));
const CLAIMER_PUBKEY = getPublicKey(CLAIMER_SECRET_KEY);

/**
 * Creates a mock HandlerContext for prefix claim testing.
 * The context simulates an incoming prefix claim event with the given parameters.
 */
function createMockClaimContext(options: {
  requestedPrefix: string;
  amount: bigint;
  pubkey?: string;
}): HandlerContext {
  const claimContent = { requestedPrefix: options.requestedPrefix };
  const pubkey = options.pubkey ?? CLAIMER_PUBKEY;

  return {
    toon: Buffer.from(JSON.stringify(claimContent)).toString('base64'),
    kind: 10034,
    pubkey,
    amount: options.amount,
    destination: 'g.toon.upstream',
    decode() {
      return {
        id: 'a'.repeat(64),
        pubkey,
        created_at: 1700000000,
        kind: 10034,
        tags: [],
        content: JSON.stringify(claimContent),
        sig: 'c'.repeat(128),
      };
    },
    accept(metadata?: Record<string, unknown>): HandlePacketAcceptResponse {
      return {
        accept: true,
        ...(metadata ? { metadata } : {}),
      };
    },
    reject(code: string, message: string): HandlePacketRejectResponse {
      return {
        accept: false,
        code,
        message,
      };
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createPrefixClaimHandler() (Story 7.6, AC #8, #9, #10, #12)', () => {
  // --------------------------------------------------------------------------
  // T-7.7-02: Handler accepts valid claim
  // --------------------------------------------------------------------------

  it('T-7.7-02 [P0]: accepts claim with sufficient payment and available prefix (AC #8)', async () => {
    // Arrange
    const claimedPrefixes = new Map<string, string>();
    const publishedGrants: unknown[] = [];

    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: (prefix: string, claimerPubkey: string) => {
        if (claimedPrefixes.has(prefix)) return false;
        claimedPrefixes.set(prefix, claimerPubkey);
        return true;
      },
      publishGrant: async (grantEvent) => {
        publishedGrants.push(grantEvent);
      },
    });

    const ctx = createMockClaimContext({
      requestedPrefix: 'useast',
      amount: 1000n,
    });

    // Act
    const result = await handler(ctx);

    // Assert -- accepted
    expect(result.accept).toBe(true);
    // Prefix was claimed
    expect(claimedPrefixes.has('useast')).toBe(true);
    expect(claimedPrefixes.get('useast')).toBe(CLAIMER_PUBKEY);
    // Grant event was published
    expect(publishedGrants.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // T-7.7-04: Handler rejects insufficient payment
  // --------------------------------------------------------------------------

  it('T-7.7-04 [P0]: rejects claim with insufficient payment with F06 (AC #9)', async () => {
    // Arrange
    const claimedPrefixes = new Map<string, string>();

    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: (prefix: string, claimerPubkey: string) => {
        claimedPrefixes.set(prefix, claimerPubkey);
        return true;
      },
      publishGrant: async () => {},
    });

    const ctx = createMockClaimContext({
      requestedPrefix: 'useast',
      amount: 999n, // Less than basePrice of 1000n
    });

    // Act
    const result = await handler(ctx);

    // Assert -- rejected with F06
    expect(result.accept).toBe(false);
    const reject = result as HandlePacketRejectResponse;
    expect(reject.code).toBe('F06');
    // Prefix was NOT claimed
    expect(claimedPrefixes.has('useast')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // T-7.7-03: Handler rejects already-claimed prefix
  // --------------------------------------------------------------------------

  it('T-7.7-03 [P0]: rejects claim for already-claimed prefix with PREFIX_TAKEN (AC #10)', async () => {
    // Arrange -- prefix already claimed by someone else
    const claimedPrefixes = new Map<string, string>();
    claimedPrefixes.set('useast', 'other-pubkey');

    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: (prefix: string) => {
        if (claimedPrefixes.has(prefix)) return false;
        return true;
      },
      publishGrant: async () => {},
    });

    const ctx = createMockClaimContext({
      requestedPrefix: 'useast',
      amount: 1000n,
    });

    // Act
    const result = await handler(ctx);

    // Assert -- rejected with PREFIX_TAKEN
    expect(result.accept).toBe(false);
    const reject = result as HandlePacketRejectResponse;
    expect(reject.message).toContain('PREFIX_TAKEN');
  });

  // --------------------------------------------------------------------------
  // Invalid prefix: too short
  // --------------------------------------------------------------------------

  it('[P0] rejects claim with invalid prefix (too short) with validation error (AC #12)', async () => {
    // Arrange
    const claimedPrefixes = new Map<string, string>();

    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: () => true,
      publishGrant: async () => {},
    });

    const ctx = createMockClaimContext({
      requestedPrefix: 'a', // Too short (min 2)
      amount: 1000n,
    });

    // Act
    const result = await handler(ctx);

    // Assert -- rejected
    expect(result.accept).toBe(false);
    // No prefix claimed
    expect(claimedPrefixes.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Invalid prefix: reserved word
  // --------------------------------------------------------------------------

  it('[P0] rejects claim with reserved word prefix (AC #12)', async () => {
    // Arrange
    const claimedPrefixes = new Map<string, string>();

    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: () => true,
      publishGrant: async () => {},
    });

    const ctx = createMockClaimContext({
      requestedPrefix: 'toon', // Reserved word
      amount: 1000n,
    });

    // Act
    const result = await handler(ctx);

    // Assert -- rejected
    expect(result.accept).toBe(false);
    expect(claimedPrefixes.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // T-7.7-05: Race condition defense
  // --------------------------------------------------------------------------

  it('T-7.7-05 [P0]: concurrent claims for same prefix -> exactly one succeeds (AC #8, #10)', async () => {
    // Arrange -- claimPrefix uses atomic check-and-set
    const claimedPrefixes = new Map<string, string>();
    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: (prefix: string, claimerPubkey: string) => {
        // Atomic check-and-set: only first caller wins
        if (claimedPrefixes.has(prefix)) return false;
        claimedPrefixes.set(prefix, claimerPubkey);
        return true;
      },
      publishGrant: async () => {},
    });

    // Two different claimers requesting the same prefix
    const claimer2SecretKey = Uint8Array.from(
      Buffer.from('c'.repeat(64), 'hex')
    );
    const claimer2Pubkey = getPublicKey(claimer2SecretKey);

    const ctx1 = createMockClaimContext({
      requestedPrefix: 'useast',
      amount: 1000n,
      pubkey: CLAIMER_PUBKEY,
    });
    const ctx2 = createMockClaimContext({
      requestedPrefix: 'useast',
      amount: 1000n,
      pubkey: claimer2Pubkey,
    });

    // Act -- both claims run concurrently
    const [result1, result2] = await Promise.all([
      handler(ctx1),
      handler(ctx2),
    ]);

    // Assert -- exactly one succeeded, one failed
    const acceptCount = [result1, result2].filter((r) => r.accept).length;
    const rejectCount = [result1, result2].filter((r) => !r.accept).length;
    expect(acceptCount).toBe(1);
    expect(rejectCount).toBe(1);

    // Prefix is claimed exactly once
    expect(claimedPrefixes.size).toBe(1);
    expect(claimedPrefixes.has('useast')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Malformed content: JSON but not a valid prefix claim
  // --------------------------------------------------------------------------

  it('[P1] rejects claim with malformed content (valid JSON, missing requestedPrefix) (AC #8)', async () => {
    // Arrange
    const claimedPrefixes = new Map<string, string>();

    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: () => true,
      publishGrant: async () => {},
    });

    // Create a context with valid JSON but no requestedPrefix field
    const ctx: HandlerContext = {
      toon: Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64'),
      kind: 10034,
      pubkey: CLAIMER_PUBKEY,
      amount: 1000n,
      destination: 'g.toon.upstream',
      decode() {
        return {
          id: 'a'.repeat(64),
          pubkey: CLAIMER_PUBKEY,
          created_at: 1700000000,
          kind: 10034,
          tags: [],
          content: JSON.stringify({ foo: 'bar' }),
          sig: 'c'.repeat(128),
        };
      },
      accept(metadata?: Record<string, unknown>): HandlePacketAcceptResponse {
        return {
          accept: true,
          fulfillment: 'test-fulfillment',
          ...(metadata ? { metadata } : {}),
        };
      },
      reject(code: string, message: string): HandlePacketRejectResponse {
        return {
          accept: false,
          code,
          message,
        };
      },
    };

    // Act
    const result = await handler(ctx);

    // Assert -- rejected (malformed content)
    expect(result.accept).toBe(false);
    // No prefix claimed
    expect(claimedPrefixes.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Payment exceeds base price -> accepted
  // --------------------------------------------------------------------------

  it('[P1] propagates error when publishGrant throws after successful claim', async () => {
    // Arrange -- publishGrant throws an error
    const claimedPrefixes = new Map<string, string>();

    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: (prefix: string, claimerPubkey: string) => {
        claimedPrefixes.set(prefix, claimerPubkey);
        return true;
      },
      publishGrant: async () => {
        throw new Error('Relay unavailable');
      },
    });

    const ctx = createMockClaimContext({
      requestedPrefix: 'useast',
      amount: 1000n,
    });

    // Act & Assert -- error propagates (prefix is claimed but grant publish failed)
    await expect(handler(ctx)).rejects.toThrow('Relay unavailable');
    // Prefix was still claimed (atomicity: claim persists even if grant publish fails)
    expect(claimedPrefixes.has('useast')).toBe(true);
  });

  it('[P1] accepts claim when payment exceeds base price', async () => {
    // Arrange
    const claimedPrefixes = new Map<string, string>();

    const handler = createPrefixClaimHandler({
      prefixPricing: { basePrice: 1000n },
      secretKey: UPSTREAM_SECRET_KEY,
      getClaimedPrefixes: () => claimedPrefixes,
      claimPrefix: (prefix: string, claimerPubkey: string) => {
        claimedPrefixes.set(prefix, claimerPubkey);
        return true;
      },
      publishGrant: async () => {},
    });

    const ctx = createMockClaimContext({
      requestedPrefix: 'euwest',
      amount: 5000n, // More than basePrice of 1000n
    });

    // Act
    const result = await handler(ctx);

    // Assert -- accepted (overpayment is fine)
    expect(result.accept).toBe(true);
    expect(claimedPrefixes.has('euwest')).toBe(true);
  });
});
