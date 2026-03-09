import { describe, it, expect } from 'vitest';
import { ILP_PEER_INFO_KIND } from './constants.js';

describe('Event Kind Constants', () => {
  it('should define ILP_PEER_INFO_KIND as 10032', () => {
    expect(ILP_PEER_INFO_KIND).toBe(10032);
  });

  it('should have replaceable event kinds in 10000-19999 range', () => {
    expect(ILP_PEER_INFO_KIND).toBeGreaterThanOrEqual(10000);
    expect(ILP_PEER_INFO_KIND).toBeLessThan(20000);
  });
});
