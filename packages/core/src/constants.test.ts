import { describe, it, expect } from 'vitest';
import {
  ILP_PEER_INFO_KIND,
  SPSP_REQUEST_KIND,
  SPSP_RESPONSE_KIND,
} from './constants.js';

describe('Event Kind Constants', () => {
  it('should define ILP_PEER_INFO_KIND as 10032', () => {
    expect(ILP_PEER_INFO_KIND).toBe(10032);
  });

  it('should define SPSP_REQUEST_KIND as 23194', () => {
    expect(SPSP_REQUEST_KIND).toBe(23194);
  });

  it('should define SPSP_RESPONSE_KIND as 23195', () => {
    expect(SPSP_RESPONSE_KIND).toBe(23195);
  });

  it('should have replaceable event kinds in 10000-19999 range', () => {
    expect(ILP_PEER_INFO_KIND).toBeGreaterThanOrEqual(10000);
    expect(ILP_PEER_INFO_KIND).toBeLessThan(20000);
  });

  it('should have ephemeral event kinds in 20000-29999 range', () => {
    expect(SPSP_REQUEST_KIND).toBeGreaterThanOrEqual(20000);
    expect(SPSP_REQUEST_KIND).toBeLessThan(30000);
    expect(SPSP_RESPONSE_KIND).toBeGreaterThanOrEqual(20000);
    expect(SPSP_RESPONSE_KIND).toBeLessThan(30000);
  });
});
