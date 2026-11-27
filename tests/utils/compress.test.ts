/**
 * The shared deflate/inflate path (`utils/compress.ts`).
 *
 * The expectations come from the formats themselves — a zlib stream starts
 * with 0x78, gzip with 0x1f 0x8b — and from Node's independent zlib encoder,
 * never from the code under test.
 */

import { describe, it, expect } from 'vitest';
import { deflateSync, deflateRawSync, gzipSync, inflateSync } from 'node:zlib';
import { deflate, gunzip, inflate, inflateRaw } from '@/utils/compress.ts';

const text = 'zx84: the same bytes, through one codec, twice. '.repeat(200);
const raw = new TextEncoder().encode(text);

describe('compress — deflate', () => {
  it('wraps a zlib stream that Node can inflate', async () => {
    const packed = await deflate(raw);
    expect(packed[0] & 0x0F).toBe(8);           // DEFLATE method
    expect(((packed[0] << 8) | packed[1]) % 31).toBe(0); // zlib check bits
    expect([...inflateSync(packed)]).toEqual([...raw]);
  });

  it('inflates a zlib stream produced independently by Node', async () => {
    const packed = new Uint8Array(deflateSync(raw));
    expect(await inflate(packed)).toEqual(raw);
  });

  it('round-trips an empty payload', async () => {
    expect(await inflate(await deflate(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });
});

describe('compress — raw DEFLATE and gzip', () => {
  it('round-trips a bare DEFLATE stream (the ZIP entry form)', async () => {
    const packed = await deflate(raw, 'deflate-raw');
    expect(await inflateRaw(packed)).toEqual(raw);
    expect(await inflateRaw(new Uint8Array(deflateRawSync(raw)))).toEqual(raw);
  });

  it('round-trips a gzip stream and reads one made by Node', async () => {
    const packed = await deflate(raw, 'gzip');
    expect(packed[0]).toBe(0x1f);
    expect(packed[1]).toBe(0x8b);
    expect(await gunzip(packed)).toEqual(raw);
    expect(await gunzip(new Uint8Array(gzipSync(raw)))).toEqual(raw);
  });
});

describe('compress — inflate guards', () => {
  it('refuses output past the caller’s cap', async () => {
    const bomb = new Uint8Array(deflateRawSync(new Uint8Array(1 << 20)));
    await expect(inflateRaw(bomb, 1024)).rejects.toThrow(/exceeds 1024 bytes/);
  });

  it('rejects a stream that is not DEFLATE', async () => {
    await expect(inflate(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow();
  });

  it('concatenates output larger than one stream chunk', async () => {
    // Node emits inflated output in ~16 KiB chunks, so 1 MiB exercises the
    // assembly path rather than the single-chunk shortcut.
    const big = new Uint8Array(1 << 20);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xFF;
    const packed = await deflate(big, 'deflate-raw');
    const out = await inflateRaw(packed);
    expect(out.length).toBe(big.length);
    expect(out[0]).toBe(0);
    expect(out[big.length >> 1]).toBe(big[big.length >> 1]);
    expect(out[big.length - 1]).toBe(big[big.length - 1]);
  });
});
