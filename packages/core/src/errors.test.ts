import { describe, it, expect } from 'vitest';
import {
  AgentSocietyError,
  InvalidEventError,
  PeerDiscoveryError,
  SpspError,
  SpspTimeoutError,
} from './errors.js';

describe('SpspTimeoutError', () => {
  it('should have correct error code', () => {
    const error = new SpspTimeoutError('timeout', 'abc123');
    expect(error.code).toBe('SPSP_TIMEOUT');
  });

  it('should store recipientPubkey', () => {
    const pubkey = 'abc123def456';
    const error = new SpspTimeoutError('timeout', pubkey);
    expect(error.recipientPubkey).toBe(pubkey);
  });

  it('should extend AgentSocietyError', () => {
    const error = new SpspTimeoutError('timeout', 'abc123');
    expect(error).toBeInstanceOf(AgentSocietyError);
  });

  it('should have correct name', () => {
    const error = new SpspTimeoutError('timeout', 'abc123');
    expect(error.name).toBe('SpspTimeoutError');
  });

  it('should store message', () => {
    const message = 'SPSP request timed out after 10000ms';
    const error = new SpspTimeoutError(message, 'abc123');
    expect(error.message).toBe(message);
  });

  it('should accept optional cause', () => {
    const cause = new Error('underlying error');
    const error = new SpspTimeoutError('timeout', 'abc123', cause);
    expect(error.cause).toBe(cause);
  });

  it('should work without cause', () => {
    const error = new SpspTimeoutError('timeout', 'abc123');
    expect(error.cause).toBeUndefined();
  });
});

describe('AgentSocietyError', () => {
  it('should have correct name and code', () => {
    const error = new AgentSocietyError('test', 'TEST_CODE');
    expect(error.name).toBe('AgentSocietyError');
    expect(error.code).toBe('TEST_CODE');
  });

  it('should accept optional cause', () => {
    const cause = new Error('cause');
    const error = new AgentSocietyError('test', 'TEST_CODE', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('InvalidEventError', () => {
  it('should have correct code', () => {
    const error = new InvalidEventError('invalid event');
    expect(error.code).toBe('INVALID_EVENT');
    expect(error.name).toBe('InvalidEventError');
  });

  it('should extend AgentSocietyError', () => {
    const error = new InvalidEventError('invalid event');
    expect(error).toBeInstanceOf(AgentSocietyError);
  });
});

describe('PeerDiscoveryError', () => {
  it('should have correct code', () => {
    const error = new PeerDiscoveryError('discovery failed');
    expect(error.code).toBe('PEER_DISCOVERY_FAILED');
    expect(error.name).toBe('PeerDiscoveryError');
  });

  it('should extend AgentSocietyError', () => {
    const error = new PeerDiscoveryError('discovery failed');
    expect(error).toBeInstanceOf(AgentSocietyError);
  });
});

describe('SpspError', () => {
  it('should have correct code', () => {
    const error = new SpspError('spsp failed');
    expect(error.code).toBe('SPSP_FAILED');
    expect(error.name).toBe('SpspError');
  });

  it('should extend AgentSocietyError', () => {
    const error = new SpspError('spsp failed');
    expect(error).toBeInstanceOf(AgentSocietyError);
  });
});
