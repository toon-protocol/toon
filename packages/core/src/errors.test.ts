import { describe, it, expect } from 'vitest';
import { ToonError } from './errors.js';

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
