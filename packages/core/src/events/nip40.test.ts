import { describe, it, expect } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { buildIlpPeerInfoEvent } from './builders.js';
import { getEventExpiration, isEventExpired, EXPIRATION_TAG } from './nip40.js';
import type { IlpPeerInfo } from '../types.js';

function info(): IlpPeerInfo {
  return {
    ilpAddress: 'g.example.connector',
    btpEndpoint: 'wss://btp.example.com',
    assetCode: 'USD',
    assetScale: 6,
  };
}

/** Build a kind:10032 with an explicit expiration tag value. */
function withExpiration(value: string | undefined): NostrEvent {
  const event = buildIlpPeerInfoEvent(info(), generateSecretKey());
  return {
    ...event,
    tags: value === undefined ? [] : [[EXPIRATION_TAG, value]],
  };
}

describe('getEventExpiration', () => {
  it('returns undefined when no expiration tag is present', () => {
    expect(getEventExpiration(withExpiration(undefined))).toBeUndefined();
  });

  it('returns the timestamp from the expiration tag', () => {
    expect(getEventExpiration(withExpiration('1700000000'))).toBe(1700000000);
  });

  it('returns undefined for a non-numeric or negative value', () => {
    expect(getEventExpiration(withExpiration('not-a-number'))).toBeUndefined();
    expect(getEventExpiration(withExpiration('-5'))).toBeUndefined();
  });
});

describe('isEventExpired', () => {
  it('is false for an event with no expiration tag (back-compat)', () => {
    expect(isEventExpired(withExpiration(undefined), 9_999_999_999)).toBe(
      false
    );
  });

  it('is true once now passes the expiration timestamp', () => {
    const event = withExpiration('1000');
    expect(isEventExpired(event, 999)).toBe(false);
    expect(isEventExpired(event, 1000)).toBe(true); // boundary: <= counts as expired
    expect(isEventExpired(event, 1001)).toBe(true);
  });
});

describe('buildIlpPeerInfoEvent NIP-40 ttl', () => {
  it('omits the expiration tag when no ttl is provided', () => {
    const event = buildIlpPeerInfoEvent(info(), generateSecretKey());
    expect(event.tags).toEqual([]);
    expect(getEventExpiration(event)).toBeUndefined();
  });

  it('stamps expiration = created_at + ttlSeconds when ttl is positive', () => {
    const event = buildIlpPeerInfoEvent(info(), generateSecretKey(), {
      ttlSeconds: 3600,
    });
    expect(getEventExpiration(event)).toBe(event.created_at + 3600);
    expect(isEventExpired(event, event.created_at)).toBe(false);
    expect(isEventExpired(event, event.created_at + 3601)).toBe(true);
  });

  it('omits the expiration tag when ttlSeconds is zero or negative', () => {
    expect(
      buildIlpPeerInfoEvent(info(), generateSecretKey(), { ttlSeconds: 0 }).tags
    ).toEqual([]);
    expect(
      buildIlpPeerInfoEvent(info(), generateSecretKey(), { ttlSeconds: -1 })
        .tags
    ).toEqual([]);
  });
});
