import { describe, it, expect } from 'vitest';
import {
  ToonError,
  InvalidEventError,
  PeerDiscoveryError,
} from './errors.js';

describe('ToonError', () => {
  it('should have correct name and code', () => {
    const error = new ToonError('test', 'TEST_CODE');
    expect(error.name).toBe('ToonError');
    expect(error.code).toBe('TEST_CODE');
  });

  it('should accept optional cause', () => {
    const cause = new Error('cause');
    const error = new ToonError('test', 'TEST_CODE', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('InvalidEventError', () => {
  it('should have correct code', () => {
    const error = new InvalidEventError('invalid event');
    expect(error.code).toBe('INVALID_EVENT');
    expect(error.name).toBe('InvalidEventError');
  });

  it('should extend ToonError', () => {
    const error = new InvalidEventError('invalid event');
    expect(error).toBeInstanceOf(ToonError);
  });
});

describe('PeerDiscoveryError', () => {
  it('should have correct code', () => {
    const error = new PeerDiscoveryError('discovery failed');
    expect(error.code).toBe('PEER_DISCOVERY_FAILED');
    expect(error.name).toBe('PeerDiscoveryError');
  });

  it('should extend ToonError', () => {
    const error = new PeerDiscoveryError('discovery failed');
    expect(error).toBeInstanceOf(ToonError);
  });
});
