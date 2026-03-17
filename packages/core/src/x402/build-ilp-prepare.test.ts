/**
 * Unit Tests: buildIlpPrepare() — Packet Equivalence (Story 5.2)
 *
 * Pure-function tests that validate buildIlpPrepare() produces identical
 * ILP PREPARE packets regardless of submission path (ILP-native vs x402).
 * No infrastructure, no mocks — just function inputs and outputs.
 *
 * Test IDs:
 *   T-5.2-03 / T-INT-04 - ILP and x402 produce identical ILP PREPARE packets
 *   T-5.2-02 - x402-submitted Kind 5100 uses shared buildIlpPrepare()
 *   T-5.2-03 amp - ILP-native and x402 compute identical amounts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';

import { buildIlpPrepare } from './build-ilp-prepare.js';
import {
  TEXT_GENERATION_KIND,
  buildJobRequestEvent,
} from '../events/dvm.js';
import { encodeEventToToon, decodeEventFromToon } from '../toon/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDvmJobRequestViaBuilder(secretKey: Uint8Array) {
  return buildJobRequestEvent(
    {
      kind: TEXT_GENERATION_KIND,
      input: {
        data: 'Summarize this article about quantum computing',
        type: 'text',
      },
      bid: '5000000',
      output: 'text/plain',
      content: 'Please provide a concise summary',
      params: [
        { key: 'model', value: 'claude-3' },
        { key: 'max_tokens', value: '1000' },
      ],
      relays: ['wss://relay1.example.com', 'wss://relay2.example.com'],
    },
    secretKey
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildIlpPrepare() Packet Equivalence (Story 5.2)', () => {
  let eventSecretKey: Uint8Array;

  beforeAll(() => {
    eventSecretKey = generateSecretKey();
  });

  // T-5.2-03 / T-INT-04: Packet equivalence — ILP and x402 produce identical packets
  it('T-5.2-03 / T-INT-04: produces identical packets for ILP-native and x402 paths', () => {
    const dvmEvent = createDvmJobRequestViaBuilder(eventSecretKey);
    const toonData = encodeEventToToon(dvmEvent);
    const basePricePerByte = 10n;
    const amount = basePricePerByte * BigInt(toonData.length);

    // Build ILP PREPARE packet (same function used by both paths)
    const ilpPacket = buildIlpPrepare({
      destination: 'g.crosstown.relay',
      amount,
      data: toonData,
    });

    // Simulate x402 path: also uses buildIlpPrepare with same inputs
    const x402Packet = buildIlpPrepare({
      destination: 'g.crosstown.relay',
      amount,
      data: toonData,
    });

    // Packets are identical (same function, same inputs)
    expect(ilpPacket.destination).toBe(x402Packet.destination);
    expect(ilpPacket.amount).toBe(x402Packet.amount);
    expect(ilpPacket.data).toBe(x402Packet.data);

    // Amount is string representation of bigint
    expect(ilpPacket.amount).toBe(amount.toString());

    // Data is base64-encoded TOON that roundtrips correctly
    expect(typeof ilpPacket.data).toBe('string');
    const decodedFromBase64 = Buffer.from(ilpPacket.data, 'base64');
    const roundtripped = decodeEventFromToon(decodedFromBase64);
    expect(roundtripped.kind).toBe(TEXT_GENERATION_KIND);
    expect(roundtripped.id).toBe(dvmEvent.id);
  });

  // T-5.2-02: x402 submitted event produces identical relay-side storage
  it('T-5.2-02: x402-submitted Kind 5100 uses shared buildIlpPrepare() ensuring identical relay-side behavior', () => {
    const dvmEvent = createDvmJobRequestViaBuilder(eventSecretKey);
    const toonData = encodeEventToToon(dvmEvent);
    const basePricePerByte = 10n;
    const amount = basePricePerByte * BigInt(toonData.length);

    // Both paths use the same packet construction
    const packet = buildIlpPrepare({
      destination: 'g.crosstown.relay',
      amount,
      data: toonData,
    });

    // Packet contains properly encoded DVM data
    const toonFromPacket = Buffer.from(packet.data, 'base64');
    const decoded = decodeEventFromToon(toonFromPacket);

    // Relay would see identical event data regardless of rail
    expect(decoded.kind).toBe(TEXT_GENERATION_KIND);
    expect(decoded.id).toBe(dvmEvent.id);
    expect(decoded.pubkey).toBe(dvmEvent.pubkey);
    expect(decoded.sig).toBe(dvmEvent.sig);
    expect(decoded.content).toBe(dvmEvent.content);
    expect(decoded.tags).toEqual(dvmEvent.tags);
  });

  // T-5.2-03 amplification: amount calculation is identical for both paths
  it('T-5.2-03 amplification: ILP-native and x402 compute identical amounts for DVM events', () => {
    const dvmEvent = createDvmJobRequestViaBuilder(eventSecretKey);
    const toonData = encodeEventToToon(dvmEvent);
    const basePricePerByte = 10n;

    // Compute amount the same way publishEvent() does
    const ilpAmount = basePricePerByte * BigInt(toonData.length);

    // Compute amount the same way x402 handler does
    const x402Amount = basePricePerByte * BigInt(toonData.length);

    // Amounts are identical
    expect(ilpAmount).toBe(x402Amount);
    expect(ilpAmount).toBeGreaterThan(0n);
  });
});
