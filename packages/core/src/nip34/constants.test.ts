import { describe, it, expect } from 'vitest';
import * as nip34 from './index.js';

describe('NIP-34 kind constants', () => {
  it('pins the kind numbers other repos import', () => {
    expect(nip34.REPOSITORY_ANNOUNCEMENT_KIND).toBe(30617);
    expect(nip34.PATCH_KIND).toBe(1617);
    expect(nip34.PULL_REQUEST_KIND).toBe(1618);
    expect(nip34.PR_STATUS_UPDATE_KIND).toBe(1619);
    expect(nip34.ISSUE_KIND).toBe(1621);
    expect(nip34.STATUS_OPEN_KIND).toBe(1630);
    expect(nip34.STATUS_APPLIED_KIND).toBe(1631);
    expect(nip34.STATUS_CLOSED_KIND).toBe(1632);
    expect(nip34.STATUS_DRAFT_KIND).toBe(1633);
  });

  it('lists every NIP-34 kind in NIP34_EVENT_KINDS', () => {
    expect([...nip34.NIP34_EVENT_KINDS].sort((a, b) => a - b)).toEqual([
      1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 30617,
    ]);
    expect(nip34.isNIP34Event(1621)).toBe(true);
    expect(nip34.isNIP34Event(1)).toBe(false);
  });
});
