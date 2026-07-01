import { describe, it, expect } from 'vitest';
import type {
  StoreHealthResponse,
  StoreJobsRecent,
  StoreJobsByStatus,
  StoreJobsByKindEntry,
} from './store-health.js';

describe('StoreHealthResponse shape', () => {
  const mockStatus: StoreJobsByStatus = {
    processing: 2,
    success: 10,
    error: 1,
    partial: 0,
  };

  const mockByKind: StoreJobsByKindEntry[] = [
    { kind: 5094, count: 7 },
    { kind: 5250, count: 6 },
  ];

  const mockJobsRecent: StoreJobsRecent = {
    total: 13,
    byKind: mockByKind,
    byStatus: mockStatus,
  };

  const mockResponse: StoreHealthResponse = {
    status: 'ok',
    version: '1.0.0',
    nodePubkey: 'a'.repeat(64),
    uptimeSec: 42,
    handlerKinds: [5094, 5250],
    kindPricing: { '5094': '10', '5250': '10000' },
    basePricePerByte: '10',
    jobsRecent: mockJobsRecent,
  };

  it('handlerKinds is number[]', () => {
    expect(mockResponse.handlerKinds).toEqual([5094, 5250]);
    expect(typeof mockResponse.handlerKinds[0]).toBe('number');
  });

  it('kindPricing keys are stringified kinds and values are strings', () => {
    const keys = Object.keys(mockResponse.kindPricing);
    expect(keys).toContain('5094');
    expect(keys).toContain('5250');
    expect(typeof mockResponse.kindPricing['5094']).toBe('string');
    expect(typeof mockResponse.kindPricing['5250']).toBe('string');
  });

  it('kindPricing round-trips through JSON.stringify', () => {
    const serialized = JSON.stringify(mockResponse.kindPricing);
    const parsed = JSON.parse(serialized) as Record<string, string>;
    expect(parsed['5094']).toBe('10');
    expect(parsed['5250']).toBe('10000');
  });

  it('jobsRecent.byStatus has the four named status fields', () => {
    const { byStatus } = mockResponse.jobsRecent;
    expect(typeof byStatus.processing).toBe('number');
    expect(typeof byStatus.success).toBe('number');
    expect(typeof byStatus.error).toBe('number');
    expect(typeof byStatus.partial).toBe('number');
  });

  it('jobsRecent.byKind entries have kind and count as numbers', () => {
    for (const entry of mockResponse.jobsRecent.byKind) {
      expect(typeof entry.kind).toBe('number');
      expect(typeof entry.count).toBe('number');
    }
  });

  it('all status enum values are accepted', () => {
    const statuses: StoreHealthResponse['status'][] = [
      'starting',
      'ok',
      'stopping',
      'stopped',
      'error',
    ];
    for (const s of statuses) {
      const r: StoreHealthResponse = { ...mockResponse, status: s };
      expect(r.status).toBe(s);
    }
  });
});
