import { describe, it, expect } from 'vitest';
import { base58Encode, base58Decode } from './base58.js';

const text = (s: string) => new TextEncoder().encode(s);

describe('base58', () => {
  const vectors: [Uint8Array, string][] = [
    [text('hello world'), 'StV1DL6CwTryKyV'],
    [text('Hello World!'), '2NEpo7TZRRrLZSi2U'],
    [new Uint8Array([0x61]), '2g'],
    [new Uint8Array([0x00, 0x00, 0x01]), '112'],
    [new Uint8Array(32), '1'.repeat(32)],
  ];

  it.each(vectors)('encodes known vector %#', (bytes, encoded) => {
    expect(base58Encode(bytes)).toBe(encoded);
  });

  it.each(vectors)('decodes known vector %#', (bytes, encoded) => {
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it('round-trips random bytes, including leading zeros', () => {
    for (let len = 1; len <= 64; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + len * 11) % 256;
      if (len % 3 === 0) bytes[0] = 0;
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
  });

  it('rejects characters outside the alphabet', () => {
    for (const bad of ['0', 'O', 'I', 'l']) {
      expect(() => base58Decode(`abc${bad}`)).toThrow(
        `Invalid base58 character: ${bad}`
      );
    }
  });
});
