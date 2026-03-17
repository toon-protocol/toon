/**
 * Unit Tests: DVM Handler Dispatch and Context Validation (Story 5.2, Task 3)
 *
 * Validates that the existing HandlerRegistry and HandlerContext correctly
 * handle DVM event kinds (5000-5999 range) without any production code changes.
 *
 * Test IDs from Story 5.2:
 *   T-5.2-04 - node.on(5100, handler) routes Kind 5100 to handler
 *   T-5.2-05 - ctx.decode() returns structured job request with all DVM tags
 *   T-5.2-06 - ctx.toon provides raw TOON for LLM consumption
 *   T-5.2-08 - DVM job request pays basePricePerByte * toonData.length
 *   T-5.2-09 - Multiple DVM handlers route to correct handler; 5300 no handler -> F00
 *   T-5.2-10 - Targeted request (p tag) vs untargeted request (no p tag)
 *
 * Implementation Phase: GREEN -- all tests enabled. Validates that the existing
 * SDK infrastructure (HandlerRegistry, HandlerContext, PricingValidator) handles
 * DVM event kinds (5000-5999) correctly without any production code changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HandlerRegistry } from './handler-registry.js';
import { createHandlerContext } from './handler-context.js';
import type { HandlerContext } from './handler-context.js';
import type { ToonRoutingMeta } from '@crosstown/core/toon';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  TEXT_GENERATION_KIND,
  IMAGE_GENERATION_KIND,
  TEXT_TO_SPEECH_KIND,
} from '@crosstown/core';

// Prevent live relay connections (project rule: always mock nostr-tools in tests)
vi.mock('nostr-tools');

// ---------------------------------------------------------------------------
// Test Fixtures: Deterministic mock data for DVM events
// ---------------------------------------------------------------------------

/**
 * Factory for creating a mock ToonRoutingMeta for DVM events.
 */
function createDvmMeta(
  overrides: Partial<ToonRoutingMeta> = {}
): ToonRoutingMeta {
  return {
    kind: TEXT_GENERATION_KIND, // 5100
    pubkey: 'ab'.repeat(32),
    id: 'a'.repeat(64),
    sig: 'c'.repeat(128),
    rawBytes: new Uint8Array([1, 2, 3, 4, 5]),
    ...overrides,
  };
}

/**
 * Factory for creating a decoded NostrEvent with DVM tags (Kind 5100 job request).
 */
function createDvmJobRequestEvent(
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'ab'.repeat(32),
    kind: TEXT_GENERATION_KIND,
    content: '',
    tags: [
      ['i', 'Summarize this article about AI safety', 'text'],
      ['bid', '5000000', 'usdc'],
      ['output', 'text/plain'],
      ['p', 'de'.repeat(32)],
      ['param', 'model', 'gpt-4'],
      ['param', 'max_tokens', '1000'],
      ['relays', 'wss://relay1.example.com', 'wss://relay2.example.com'],
    ],
    created_at: 1700000000,
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

/**
 * Factory for creating a minimal mock HandlerContext for DVM dispatch tests.
 */
function createMockDvmContext(
  overrides: Partial<HandlerContext> = {}
): HandlerContext {
  return {
    toon: 'base64-encoded-dvm-toon-data',
    kind: TEXT_GENERATION_KIND,
    pubkey: 'ab'.repeat(32),
    amount: 5000n,
    destination: 'g.crosstown.relay',
    decode: vi.fn().mockReturnValue(createDvmJobRequestEvent()),
    accept: vi.fn().mockReturnValue({ accept: true, fulfillment: 'mock' }),
    reject: vi
      .fn()
      .mockReturnValue({ accept: false, code: 'F00', message: 'rejected' }),
    ...overrides,
  } as HandlerContext;
}

// ---------------------------------------------------------------------------
// Test Suite: DVM Handler Registry Dispatch (Task 3)
// ---------------------------------------------------------------------------

describe('DVM Handler Dispatch (Story 5.2, Task 3)', () => {
  let registry: HandlerRegistry;

  beforeEach(() => {
    registry = new HandlerRegistry();
  });

  // T-5.2-04: node.on(5100, handler) routes Kind 5100 to handler
  it('[P1] T-5.2-04: node.on(5100, handler) routes Kind 5100 to the registered handler', async () => {
    // Arrange
    const textHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'text-result' });
    registry.on(TEXT_GENERATION_KIND, textHandler);
    const ctx = createMockDvmContext({ kind: TEXT_GENERATION_KIND });

    // Act
    const result = await registry.dispatch(ctx);

    // Assert
    expect(textHandler).toHaveBeenCalledTimes(1);
    expect(textHandler).toHaveBeenCalledWith(ctx);
    expect(result).toEqual({ accept: true, fulfillment: 'text-result' });
  });

  // T-5.2-09: Multiple DVM handlers route to correct handler; 5300 no handler -> F00
  it('[P2] T-5.2-09: Multiple DVM handlers (5100, 5200) route to correct handler; 5300 with no handler returns F00', async () => {
    // Arrange
    const textHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'text' });
    const imageHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'image' });
    registry.on(TEXT_GENERATION_KIND, textHandler); // 5100
    registry.on(IMAGE_GENERATION_KIND, imageHandler); // 5200

    // Act -- dispatch Kind 5100
    const textCtx = createMockDvmContext({ kind: TEXT_GENERATION_KIND });
    const textResult = await registry.dispatch(textCtx);

    // Assert -- correct handler for Kind 5100
    expect(textHandler).toHaveBeenCalledTimes(1);
    expect(imageHandler).not.toHaveBeenCalled();
    expect(textResult).toEqual({ accept: true, fulfillment: 'text' });

    // Act -- dispatch Kind 5200
    textHandler.mockClear();
    imageHandler.mockClear();
    const imageCtx = createMockDvmContext({ kind: IMAGE_GENERATION_KIND });
    const imageResult = await registry.dispatch(imageCtx);

    // Assert -- correct handler for Kind 5200
    expect(imageHandler).toHaveBeenCalledTimes(1);
    expect(textHandler).not.toHaveBeenCalled();
    expect(imageResult).toEqual({ accept: true, fulfillment: 'image' });

    // Act -- dispatch Kind 5300 (no handler registered, no default handler)
    textHandler.mockClear();
    imageHandler.mockClear();
    const ttsCtx = createMockDvmContext({ kind: TEXT_TO_SPEECH_KIND });
    const ttsResult = await registry.dispatch(ttsCtx);

    // Assert -- F00 rejection for unhandled DVM kind
    expect(ttsResult).toEqual(
      expect.objectContaining({
        accept: false,
        code: 'F00',
      })
    );
    expect(textHandler).not.toHaveBeenCalled();
    expect(imageHandler).not.toHaveBeenCalled();
  });

  // T-5.2-09 amplification: default handler catches unregistered DVM kinds
  it('[P2] T-5.2-09 amplification: default handler catches unregistered DVM kinds', async () => {
    // Arrange
    const textHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'text' });
    const defaultHandler = vi
      .fn()
      .mockResolvedValue({ accept: true, fulfillment: 'default-handled' });
    registry.on(TEXT_GENERATION_KIND, textHandler);
    registry.onDefault(defaultHandler);

    // Act -- dispatch Kind 5300 (no specific handler, but default exists)
    const ttsCtx = createMockDvmContext({ kind: TEXT_TO_SPEECH_KIND });
    const result = await registry.dispatch(ttsCtx);

    // Assert -- default handler invoked, not text handler
    expect(defaultHandler).toHaveBeenCalledTimes(1);
    expect(textHandler).not.toHaveBeenCalled();
    expect(result).toEqual({ accept: true, fulfillment: 'default-handled' });
  });
});

// ---------------------------------------------------------------------------
// Test Suite: DVM HandlerContext Validation (Task 3)
// ---------------------------------------------------------------------------

describe('DVM HandlerContext Validation (Story 5.2, Task 3)', () => {
  const rawToon = 'base64-encoded-dvm-toon-payload';
  const mockDvmEvent = createDvmJobRequestEvent();
  const mockDecoder = vi.fn().mockReturnValue(mockDvmEvent);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // T-5.2-06: ctx.toon provides raw TOON for LLM consumption
  it('[P1] T-5.2-06: ctx.toon provides raw TOON base64 string for direct LLM consumption (no decode needed)', () => {
    // Arrange
    const dvmMeta = createDvmMeta();
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: dvmMeta,
      amount: 5000n,
      destination: 'g.crosstown.relay',
      toonDecoder: mockDecoder,
    });

    // Act
    const toon = ctx.toon;

    // Assert -- raw TOON string returned without triggering decode
    expect(toon).toBe(rawToon);
    expect(mockDecoder).not.toHaveBeenCalled();
  });

  // T-5.2-05: ctx.decode() returns structured job request with all DVM tags intact
  it('[P1] T-5.2-05: ctx.decode() returns full Nostr event with all DVM tags (i, bid, output, p, param, relays) intact', () => {
    // Arrange
    const dvmMeta = createDvmMeta();
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: dvmMeta,
      amount: 5000n,
      destination: 'g.crosstown.relay',
      toonDecoder: mockDecoder,
    });

    // Act
    const decoded = ctx.decode();

    // Assert -- event kind is DVM kind
    expect(decoded.kind).toBe(TEXT_GENERATION_KIND);

    // Assert -- all DVM tags are present and intact
    const iTag = decoded.tags.find((t: string[]) => t[0] === 'i');
    expect(iTag).toBeDefined();
    expect(iTag?.[1]).toBe('Summarize this article about AI safety');
    expect(iTag?.[2]).toBe('text');

    const bidTag = decoded.tags.find((t: string[]) => t[0] === 'bid');
    expect(bidTag).toBeDefined();
    expect(bidTag?.[1]).toBe('5000000');
    expect(bidTag?.[2]).toBe('usdc');

    const outputTag = decoded.tags.find((t: string[]) => t[0] === 'output');
    expect(outputTag).toBeDefined();
    expect(outputTag?.[1]).toBe('text/plain');

    const pTag = decoded.tags.find((t: string[]) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag?.[1]).toBe('de'.repeat(32));

    const paramTags = decoded.tags.filter((t: string[]) => t[0] === 'param');
    expect(paramTags).toHaveLength(2);
    expect(paramTags[0]?.[1]).toBe('model');
    expect(paramTags[0]?.[2]).toBe('gpt-4');
    expect(paramTags[1]?.[1]).toBe('max_tokens');
    expect(paramTags[1]?.[2]).toBe('1000');

    const relaysTag = decoded.tags.find((t: string[]) => t[0] === 'relays');
    expect(relaysTag).toBeDefined();
    expect(relaysTag?.[1]).toBe('wss://relay1.example.com');
    expect(relaysTag?.[2]).toBe('wss://relay2.example.com');
  });

  // T-5.2-05 amplification: decode caches result (lazy decode invariant)
  it('[P1] T-5.2-05 amplification: ctx.decode() caches result and only calls decoder once', () => {
    // Arrange
    const dvmMeta = createDvmMeta();
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: dvmMeta,
      amount: 5000n,
      destination: 'g.crosstown.relay',
      toonDecoder: mockDecoder,
    });

    // Act
    const first = ctx.decode();
    const second = ctx.decode();

    // Assert -- decoder called once, same reference returned
    expect(mockDecoder).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  // T-5.2-10: Targeted request filtering via p tag
  it('[P2] T-5.2-10: handler can detect targeted request via ctx.decode() and check for p tag presence', () => {
    // Arrange -- targeted request (has p tag)
    const targetedEvent = createDvmJobRequestEvent({
      tags: [
        ['i', 'Generate text', 'text'],
        ['bid', '5000000', 'usdc'],
        ['output', 'text/plain'],
        ['p', 'ff'.repeat(32)], // targeted to specific provider
      ],
    });
    const targetedDecoder = vi.fn().mockReturnValue(targetedEvent);
    const dvmMeta = createDvmMeta();
    const targetedCtx = createHandlerContext({
      toon: rawToon,
      meta: dvmMeta,
      amount: 5000n,
      destination: 'g.crosstown.relay',
      toonDecoder: targetedDecoder,
    });

    // Act
    const decodedTargeted = targetedCtx.decode();
    const pTag = decodedTargeted.tags.find((t: string[]) => t[0] === 'p');

    // Assert -- targeted request has p tag
    expect(pTag).toBeDefined();
    expect(pTag?.[1]).toBe('ff'.repeat(32));

    // Arrange -- untargeted request (no p tag)
    const untargetedEvent = createDvmJobRequestEvent({
      tags: [
        ['i', 'Generate text', 'text'],
        ['bid', '5000000', 'usdc'],
        ['output', 'text/plain'],
        // No p tag -- open marketplace request
      ],
    });
    const untargetedDecoder = vi.fn().mockReturnValue(untargetedEvent);
    const untargetedCtx = createHandlerContext({
      toon: rawToon,
      meta: dvmMeta,
      amount: 5000n,
      destination: 'g.crosstown.relay',
      toonDecoder: untargetedDecoder,
    });

    // Act
    const decodedUntargeted = untargetedCtx.decode();
    const noPTag = decodedUntargeted.tags.find((t: string[]) => t[0] === 'p');

    // Assert -- untargeted request has no p tag
    expect(noPTag).toBeUndefined();
  });

  // T-5.2-06 amplification: ctx.kind from shallow parse matches DVM kind
  it('[P1] T-5.2-06 amplification: ctx.kind from shallow parse returns DVM kind without triggering decode', () => {
    // Arrange
    const dvmMeta = createDvmMeta({ kind: IMAGE_GENERATION_KIND }); // 5200
    const ctx = createHandlerContext({
      toon: rawToon,
      meta: dvmMeta,
      amount: 5000n,
      destination: 'g.crosstown.relay',
      toonDecoder: mockDecoder,
    });

    // Act & Assert
    expect(ctx.kind).toBe(IMAGE_GENERATION_KIND);
    expect(mockDecoder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: DVM Pricing Validation (Task 1.2)
// ---------------------------------------------------------------------------

describe('DVM Pricing Validation (Story 5.2, Task 1.2)', () => {
  // T-5.2-08: DVM job request pays basePricePerByte * toonData.length
  it('[P1] T-5.2-08: DVM event pricing uses basePricePerByte * toonData.length (same as any event)', async () => {
    // Arrange
    const { encodeEventToToon } = await import('@crosstown/core/toon');
    const { createPricingValidator } = await import('./pricing-validator.js');

    const dvmEvent = createDvmJobRequestEvent();
    const toonBytes = encodeEventToToon(dvmEvent);
    const basePricePerByte = 10n;

    const pricer = createPricingValidator({
      basePricePerByte,
      ownPubkey: 'ff'.repeat(32), // different from event pubkey
    });

    const meta = createDvmMeta({
      kind: TEXT_GENERATION_KIND,
      rawBytes: toonBytes,
    });

    const requiredAmount = BigInt(toonBytes.length) * basePricePerByte;

    // Act -- validate with exact required amount
    const exactResult = pricer.validate(meta, requiredAmount);

    // Assert -- exact amount accepted
    expect(exactResult.accepted).toBe(true);

    // Act -- validate with underpayment
    const underpaidResult = pricer.validate(meta, requiredAmount - 1n);

    // Assert -- underpayment rejected with F04
    expect(underpaidResult.accepted).toBe(false);
    expect(underpaidResult.rejection?.code).toBe('F04');
  });

  // T-5.2-08 amplification: DVM events have no kind-specific pricing override
  it('[P1] T-5.2-08 amplification: DVM kinds have no special pricing (same rate as Kind 1 events)', async () => {
    // Arrange
    const { encodeEventToToon } = await import('@crosstown/core/toon');
    const { createPricingValidator } = await import('./pricing-validator.js');

    const basePricePerByte = 15n;

    // Create a regular Kind 1 event and a DVM Kind 5100 event
    const regularEvent: NostrEvent = {
      id: 'a'.repeat(64),
      pubkey: 'ab'.repeat(32),
      kind: 1,
      content: 'Hello, world!',
      tags: [],
      created_at: 1700000000,
      sig: 'c'.repeat(128),
    };

    const dvmEvent = createDvmJobRequestEvent({ content: 'Hello, world!' });

    const regularToon = encodeEventToToon(regularEvent);
    const dvmToon = encodeEventToToon(dvmEvent);

    const pricer = createPricingValidator({
      basePricePerByte,
      ownPubkey: 'ff'.repeat(32),
    });

    // Act
    const regularMeta = createDvmMeta({
      kind: 1,
      rawBytes: regularToon,
    });
    const dvmMeta = createDvmMeta({
      kind: TEXT_GENERATION_KIND,
      rawBytes: dvmToon,
    });

    const regularRequired = BigInt(regularToon.length) * basePricePerByte;
    const dvmRequired = BigInt(dvmToon.length) * basePricePerByte;

    const regularResult = pricer.validate(regularMeta, regularRequired);
    const dvmResult = pricer.validate(dvmMeta, dvmRequired);

    // Assert -- both accepted at the same per-byte rate
    expect(regularResult.accepted).toBe(true);
    expect(dvmResult.accepted).toBe(true);

    // Assert -- pricing formula is identical for both kinds: basePricePerByte * byteLength.
    // Underpay by 1 unit for each to prove the pricer enforces the same rate for DVM kinds.
    const regularUnderpaid = pricer.validate(regularMeta, regularRequired - 1n);
    const dvmUnderpaid = pricer.validate(dvmMeta, dvmRequired - 1n);
    expect(regularUnderpaid.accepted).toBe(false);
    expect(dvmUnderpaid.accepted).toBe(false);
    expect(regularUnderpaid.rejection?.code).toBe('F04');
    expect(dvmUnderpaid.rejection?.code).toBe('F04');
  });
});
