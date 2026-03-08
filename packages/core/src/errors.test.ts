import { describe, it, expect } from 'vitest';
import {
  CrosstownError,
  InvalidEventError,
  PeerDiscoveryError,
} from './errors.js';

describe('CrosstownError', () => {
  it('should have correct name and code', () => {
    const error = new CrosstownError('test', 'TEST_CODE');
    expect(error.name).toBe('CrosstownError');
    expect(error.code).toBe('TEST_CODE');
  });

  it('should accept optional cause', () => {
    const cause = new Error('cause');
    const error = new CrosstownError('test', 'TEST_CODE', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('InvalidEventError', () => {
  it('should have correct code', () => {
    const error = new InvalidEventError('invalid event');
    expect(error.code).toBe('INVALID_EVENT');
    expect(error.name).toBe('InvalidEventError');
  });

  it('should extend CrosstownError', () => {
    const error = new InvalidEventError('invalid event');
    expect(error).toBeInstanceOf(CrosstownError);
  });
});

describe('PeerDiscoveryError', () => {
  it('should have correct code', () => {
    const error = new PeerDiscoveryError('discovery failed');
    expect(error.code).toBe('PEER_DISCOVERY_FAILED');
    expect(error.name).toBe('PeerDiscoveryError');
  });

  it('should extend CrosstownError', () => {
    const error = new PeerDiscoveryError('discovery failed');
    expect(error).toBeInstanceOf(CrosstownError);
  });
});
