/**
 * Unit tests for issue #84 — rfc-0039 stream receipts (rolling-swap spec §7.2).
 *
 * Covers the receipt primitive itself: canonical signing payload, BIP-340
 * sign/verify roundtrip, tamper detection per field, structural parse
 * validation, the sender-side ReceiptChainTracker (monotone-cumulative +
 * duplicate/hole detection, out-of-order adds), the serialized audit
 * artifact, and the maker-side session store + issuance helper.
 *
 * The end-to-end wiring (handler emits receipts on FULFILL metadata;
 * streamSwap verifies/accumulates them) is tested in `swap-handler.test.ts`
 * and `stream-swap.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import {
  signStreamReceipt,
  verifyStreamReceipt,
  parseStreamReceipt,
  encodeReceiptSigningPayload,
  serializeReceiptChain,
  isValidStreamNonce,
  issueSessionReceipt,
  ReceiptChainTracker,
  BoundedReceiptSessions,
  STREAM_RECEIPT_VERSION,
  type StreamReceipt,
  type StreamReceiptFields,
} from './stream-receipts.js';

const makerSecretKey = generateSecretKey();
const makerPubkey = getPublicKey(makerSecretKey);
const otherSecretKey = generateSecretKey();

const NONCE = 'ab'.repeat(16); // 32-char lowercase hex

function fields(
  overrides: Partial<StreamReceiptFields> = {}
): StreamReceiptFields {
  return {
    v: STREAM_RECEIPT_VERSION,
    streamNonce: NONCE,
    seq: 1,
    cumulativeDelivered: '1000',
    rate: '4.0007',
    rateTimestamp: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

describe('signStreamReceipt / verifyStreamReceipt', () => {
  it('sign→verify roundtrips against the maker pubkey', () => {
    const receipt = signStreamReceipt(fields(), makerSecretKey);
    expect(receipt.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyStreamReceipt(receipt, makerPubkey)).toBe(true);
  });

  it('rejects a receipt signed with a different key (wrong-key detection)', () => {
    const receipt = signStreamReceipt(fields(), otherSecretKey);
    expect(verifyStreamReceipt(receipt, makerPubkey)).toBe(false);
    // ... but verifies against ITS key, so a dedicated receiptSecretKey works.
    expect(verifyStreamReceipt(receipt, getPublicKey(otherSecretKey))).toBe(
      true
    );
  });

  it.each([
    ['seq', { seq: 2 }],
    ['cumulativeDelivered', { cumulativeDelivered: '1001' }],
    ['rate', { rate: '4.0008' }],
    ['rateTimestamp', { rateTimestamp: 1_700_000_000_001 }],
    ['streamNonce', { streamNonce: 'cd'.repeat(16) }],
  ] as const)(
    'detects tampering of %s (signature no longer verifies)',
    (_name, mutation) => {
      const receipt = signStreamReceipt(fields(), makerSecretKey);
      const tampered = { ...receipt, ...mutation } as StreamReceipt;
      expect(verifyStreamReceipt(tampered, makerPubkey)).toBe(false);
    }
  );

  it('detects a tampered signature', () => {
    const receipt = signStreamReceipt(fields(), makerSecretKey);
    const flipped = (receipt.sig[0] === '0' ? '1' : '0') + receipt.sig.slice(1);
    expect(verifyStreamReceipt({ ...receipt, sig: flipped }, makerPubkey)).toBe(
      false
    );
  });

  it('returns false (never throws) for a malformed pubkey or sig', () => {
    const receipt = signStreamReceipt(fields(), makerSecretKey);
    expect(verifyStreamReceipt(receipt, 'not-hex')).toBe(false);
    expect(
      verifyStreamReceipt({ ...receipt, sig: 'zz'.repeat(64) }, makerPubkey)
    ).toBe(false);
  });

  it('throws on a non-32-byte secret key', () => {
    expect(() => signStreamReceipt(fields(), new Uint8Array(31))).toThrow(
      /32-byte/
    );
  });

  it('signing payload is deterministic and unambiguous across field boundaries', () => {
    const a = encodeReceiptSigningPayload(fields());
    const b = encodeReceiptSigningPayload(fields());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // Length-prefixing: moving a digit between cumulativeDelivered and rate
    // must change the payload (no concatenation ambiguity).
    const x = encodeReceiptSigningPayload(
      fields({ cumulativeDelivered: '12', rate: '34' })
    );
    const y = encodeReceiptSigningPayload(
      fields({ cumulativeDelivered: '123', rate: '4' })
    );
    expect(Buffer.from(x).equals(Buffer.from(y))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseStreamReceipt — structural validation
// ---------------------------------------------------------------------------

describe('parseStreamReceipt', () => {
  it('accepts a well-formed receipt object', () => {
    const receipt = signStreamReceipt(fields(), makerSecretKey);
    expect(parseStreamReceipt({ ...receipt })).toEqual(receipt);
  });

  it.each([
    ['not an object', 'receipt-as-string'],
    ['array', []],
    ['null', null],
    ['wrong version', { ...fields(), v: 2, sig: 'a'.repeat(128) }],
    [
      'bad streamNonce (uppercase)',
      { ...fields(), streamNonce: 'AB'.repeat(16), sig: 'a'.repeat(128) },
    ],
    [
      'bad streamNonce (short)',
      { ...fields(), streamNonce: 'ab'.repeat(15), sig: 'a'.repeat(128) },
    ],
    ['seq zero', { ...fields(), seq: 0, sig: 'a'.repeat(128) }],
    ['seq fractional', { ...fields(), seq: 1.5, sig: 'a'.repeat(128) }],
    [
      'cumulativeDelivered negative',
      { ...fields(), cumulativeDelivered: '-1', sig: 'a'.repeat(128) },
    ],
    [
      'cumulativeDelivered non-numeric',
      { ...fields(), cumulativeDelivered: '10x', sig: 'a'.repeat(128) },
    ],
    ['rate zero', { ...fields(), rate: '0.0', sig: 'a'.repeat(128) }],
    ['rate garbage', { ...fields(), rate: 'fast', sig: 'a'.repeat(128) }],
    [
      'rateTimestamp non-integer',
      { ...fields(), rateTimestamp: 1.5, sig: 'a'.repeat(128) },
    ],
    ['sig missing', { ...fields() }],
    ['sig short', { ...fields(), sig: 'ab'.repeat(32) }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseStreamReceipt(value)).toThrow();
  });
});

describe('isValidStreamNonce', () => {
  it('accepts 32-char lowercase hex only', () => {
    expect(isValidStreamNonce(NONCE)).toBe(true);
    expect(isValidStreamNonce(NONCE.toUpperCase())).toBe(false);
    expect(isValidStreamNonce('ab'.repeat(15))).toBe(false);
    expect(isValidStreamNonce(42)).toBe(false);
    expect(isValidStreamNonce(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReceiptChainTracker — accumulation, monotonicity, holes
// ---------------------------------------------------------------------------

function issue(
  seq: number,
  cumulative: string,
  key = makerSecretKey
): StreamReceipt {
  return signStreamReceipt(
    fields({ seq, cumulativeDelivered: cumulative }),
    key
  );
}

describe('ReceiptChainTracker', () => {
  it('accumulates in-order receipts with monotonically increasing totals', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    expect(tracker.add(issue(1, '100'))).toEqual({ ok: true });
    expect(tracker.add(issue(2, '250'))).toEqual({ ok: true });
    expect(tracker.add(issue(3, '600'))).toEqual({ ok: true });
    const chain = tracker.chain();
    expect(chain.receipts.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(chain.latest?.seq).toBe(3);
    expect(chain.totalDelivered).toBe('600');
    expect(chain.holes).toEqual([]);
  });

  it('accepts out-of-order arrival (adaptive W>1 completion order)', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    expect(tracker.add(issue(2, '250')).ok).toBe(true);
    expect(tracker.add(issue(1, '100')).ok).toBe(true);
    expect(tracker.add(issue(3, '600')).ok).toBe(true);
    expect(tracker.chain().receipts.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(tracker.chain().holes).toEqual([]);
  });

  it('rejects a wrong-key receipt with BAD_SIGNATURE', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    const res = tracker.add(issue(1, '100', otherSecretKey));
    expect(res).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(tracker.size).toBe(0);
  });

  it('rejects a tampered receipt with BAD_SIGNATURE', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    const receipt = issue(1, '100');
    const res = tracker.add({ ...receipt, cumulativeDelivered: '999999' });
    expect(res).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('rejects a receipt from another session with WRONG_STREAM_NONCE', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: 'cd'.repeat(16),
      makerPubkey,
    });
    // Validly signed — but for NONCE, not this tracker's session.
    const res = tracker.add(issue(1, '100'));
    expect(res).toMatchObject({ ok: false, code: 'WRONG_STREAM_NONCE' });
  });

  it('rejects a duplicate seq with DUPLICATE_SEQ (maker session fork)', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    expect(tracker.add(issue(1, '100')).ok).toBe(true);
    const res = tracker.add(issue(1, '100'));
    expect(res).toMatchObject({ ok: false, code: 'DUPLICATE_SEQ' });
    expect(tracker.size).toBe(1);
  });

  it('rejects a cumulative total BELOW an earlier seq with NON_MONOTONIC', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    expect(tracker.add(issue(1, '100')).ok).toBe(true);
    expect(tracker.add(issue(2, '250')).ok).toBe(true);
    const res = tracker.add(issue(3, '200'));
    expect(res).toMatchObject({ ok: false, code: 'NON_MONOTONIC' });
  });

  it('rejects out-of-order NON_MONOTONIC against the higher neighbor too', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    expect(tracker.add(issue(3, '300')).ok).toBe(true);
    // seq 2 claiming MORE than seq 3's total is equivocation.
    const res = tracker.add(issue(2, '400'));
    expect(res).toMatchObject({ ok: false, code: 'NON_MONOTONIC' });
  });

  it('permits equal cumulative totals across seqs (zero-target packet)', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    expect(tracker.add(issue(1, '100')).ok).toBe(true);
    expect(tracker.add(issue(2, '100')).ok).toBe(true);
  });

  it('reports holes: missing seqs in [1, latest.seq]', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    expect(tracker.add(issue(1, '100')).ok).toBe(true);
    expect(tracker.add(issue(2, '250')).ok).toBe(true);
    expect(tracker.add(issue(5, '900')).ok).toBe(true);
    expect(tracker.chain().holes).toEqual([3, 4]);
    expect(tracker.chain().totalDelivered).toBe('900');
  });

  it('empty tracker yields an empty chain with totalDelivered 0', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    const chain = tracker.chain();
    expect(chain.receipts).toEqual([]);
    expect(chain.latest).toBeUndefined();
    expect(chain.totalDelivered).toBe('0');
    expect(chain.holes).toEqual([]);
  });

  it('chain() snapshots are independent of later adds', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    tracker.add(issue(1, '100'));
    const snapshot = tracker.chain();
    tracker.add(issue(2, '250'));
    expect(snapshot.receipts).toHaveLength(1);
    expect(tracker.chain().receipts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// serializeReceiptChain — the audit/dispute artifact
// ---------------------------------------------------------------------------

describe('serializeReceiptChain', () => {
  it('produces a versioned, re-verifiable JSON artifact', () => {
    const tracker = new ReceiptChainTracker({
      streamNonce: NONCE,
      makerPubkey,
    });
    tracker.add(issue(1, '100'));
    tracker.add(issue(2, '250'));
    const artifact = serializeReceiptChain(tracker.chain());
    const parsed = JSON.parse(artifact) as {
      kind: string;
      v: number;
      streamNonce: string;
      totalDelivered: string;
      holes: number[];
      receipts: unknown[];
    };
    expect(parsed.kind).toBe('toon.stream-receipt-chain');
    expect(parsed.v).toBe(STREAM_RECEIPT_VERSION);
    expect(parsed.streamNonce).toBe(NONCE);
    expect(parsed.totalDelivered).toBe('250');
    expect(parsed.holes).toEqual([]);
    expect(parsed.receipts).toHaveLength(2);
    // A third party can re-verify every enclosed receipt offline.
    for (const raw of parsed.receipts) {
      const receipt = parseStreamReceipt(raw);
      expect(verifyStreamReceipt(receipt, makerPubkey)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Maker side — BoundedReceiptSessions + issueSessionReceipt
// ---------------------------------------------------------------------------

describe('issueSessionReceipt', () => {
  it('increments seq and cumulativeDelivered per fulfilled packet', () => {
    const sessions = new BoundedReceiptSessions();
    const r1 = issueSessionReceipt({
      sessions,
      streamNonce: NONCE,
      deliveredAmount: 100n,
      rate: '2',
      rateTimestamp: 1,
      secretKey: makerSecretKey,
    });
    const r2 = issueSessionReceipt({
      sessions,
      streamNonce: NONCE,
      deliveredAmount: 150n,
      rate: '2',
      rateTimestamp: 2,
      secretKey: makerSecretKey,
    });
    expect(r1).toMatchObject({ seq: 1, cumulativeDelivered: '100' });
    expect(r2).toMatchObject({ seq: 2, cumulativeDelivered: '250' });
    expect(verifyStreamReceipt(r1, makerPubkey)).toBe(true);
    expect(verifyStreamReceipt(r2, makerPubkey)).toBe(true);
  });

  it('tracks sessions independently per streamNonce', () => {
    const sessions = new BoundedReceiptSessions();
    const otherNonce = 'cd'.repeat(16);
    issueSessionReceipt({
      sessions,
      streamNonce: NONCE,
      deliveredAmount: 100n,
      rate: '2',
      rateTimestamp: 1,
      secretKey: makerSecretKey,
    });
    const other = issueSessionReceipt({
      sessions,
      streamNonce: otherNonce,
      deliveredAmount: 7n,
      rate: '2',
      rateTimestamp: 1,
      secretKey: makerSecretKey,
    });
    expect(other).toMatchObject({
      seq: 1,
      cumulativeDelivered: '7',
      streamNonce: otherNonce,
    });
  });

  it('rejects a negative deliveredAmount', () => {
    const sessions = new BoundedReceiptSessions();
    expect(() =>
      issueSessionReceipt({
        sessions,
        streamNonce: NONCE,
        deliveredAmount: -1n,
        rate: '2',
        rateTimestamp: 1,
        secretKey: makerSecretKey,
      })
    ).toThrow(/non-negative/);
  });
});

describe('BoundedReceiptSessions', () => {
  it('evicts least-recently-accessed sessions past the cap', () => {
    const sessions = new BoundedReceiptSessions(2);
    sessions.set('a'.repeat(32), { seq: 1, cumulativeDelivered: 1n });
    sessions.set('b'.repeat(32), { seq: 1, cumulativeDelivered: 1n });
    // Touch 'a' so 'b' is the LRU entry.
    expect(sessions.get('a'.repeat(32))).toBeDefined();
    sessions.set('c'.repeat(32), { seq: 1, cumulativeDelivered: 1n });
    expect(sessions.size).toBe(2);
    expect(sessions.get('b'.repeat(32))).toBeUndefined();
    expect(sessions.get('a'.repeat(32))).toBeDefined();
    expect(sessions.get('c'.repeat(32))).toBeDefined();
  });

  it('rejects a non-positive cap', () => {
    expect(() => new BoundedReceiptSessions(0)).toThrow(/positive integer/);
  });
});
