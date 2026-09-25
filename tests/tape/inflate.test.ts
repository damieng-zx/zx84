import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { inflateZlibSync } from '@/media/tape/inflate.ts';

/** Deterministic pseudo-random bytes with some repetition so the encoder
 *  uses back-references as well as literals. */
function sample(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = i % 7 === 0 ? (x >>> 24) : (i & 0x0F);
  }
  return out;
}

describe('inflateZlibSync', () => {
  it('round-trips a stored (level 0) stream', () => {
    const src = sample(70_000); // > 65535 → spans several stored blocks
    expect(inflateZlibSync(deflateSync(src, { level: 0 }), 1 << 20)).toEqual(src);
  });

  it('round-trips a fixed-Huffman stream', () => {
    const src = new Uint8Array([1, 2, 3, 1, 2, 3, 1, 2, 3, 4]);
    expect(inflateZlibSync(deflateSync(src, { strategy: 4 /* Z_FIXED */ }), 1024)).toEqual(src);
  });

  it('round-trips a dynamic-Huffman stream', () => {
    const src = sample(200_000);
    expect(inflateZlibSync(deflateSync(src, { level: 9 }), 1 << 20)).toEqual(src);
  });

  it('round-trips an empty stream', () => {
    expect(inflateZlibSync(deflateSync(new Uint8Array(0)), 16).length).toBe(0);
  });

  it('refuses output beyond the cap', () => {
    const src = new Uint8Array(10_000);
    expect(() => inflateZlibSync(deflateSync(src), 9_999)).toThrow(/exceeds/);
  });

  it('rejects a non-zlib header', () => {
    expect(() => inflateZlibSync(new Uint8Array([0x78, 0x00, 0, 0]), 16)).toThrow('Not a zlib stream');
  });

  it('rejects a truncated stream', () => {
    const z = deflateSync(sample(5000));
    expect(() => inflateZlibSync(z.subarray(0, z.length >> 1), 1 << 20)).toThrow(/Truncated/);
  });
});
