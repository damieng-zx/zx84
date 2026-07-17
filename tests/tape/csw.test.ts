/**
 * CSW (Compressed Square Wave) parser + playback tests.
 *
 * Expected T-state values are derived independently from the format spec:
 * a pulse of N samples at sample rate R lasts N * 3_500_000 / R T-states
 * (rounded, clamped to ≥1). Test rates are chosen to make that exact:
 *   - v1 uses R = 3500  → 1 sample = 1000 T-states.
 *   - v2 uses R = 3.5M  → 1 sample = 1 T-state.
 */
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { parseCSW } from '@/media/tape/csw.ts';
import { TapeDeck } from '@/media/tape/tap.ts';
import type { CswBlock, SetLevelBlock } from '@/media/tape/tap.ts';

// ── Builders ────────────────────────────────────────────────────────────────

const MAGIC = 'Compressed Square Wave\x1A';

function w16(v: number): number[] { return [v & 0xFF, (v >> 8) & 0xFF]; }
function w32(v: number): number[] {
  return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF];
}
function magicBytes(): number[] {
  return [...MAGIC].map((c) => c.charCodeAt(0));
}

/** Encode a pulse-sample list as an RLE stream: values < 256 as a single byte,
 *  larger ones (or when `forceEscape`) as a 0-escape + 32-bit length. */
function rle(samples: number[], forceEscape = false): number[] {
  const out: number[] = [];
  for (const n of samples) {
    if (n > 0 && n < 256 && !forceEscape) out.push(n);
    else out.push(0, ...w32(n));
  }
  return out;
}

function cswV1(sampleRate: number, flags: number, rleBytes: number[], compression = 1): Uint8Array {
  return new Uint8Array([
    ...magicBytes(),
    1, 1,                   // major, minor
    ...w16(sampleRate),     // 0x19
    compression,            // 0x1B
    flags,                  // 0x1C
    0, 0, 0,                // 0x1D reserved
    ...rleBytes,            // 0x20
  ]);
}

function cswV2(
  sampleRate: number, flags: number, compression: number, rleBytes: number[],
  opts: { totalPulses?: number; hdrExt?: number[]; app?: string } = {},
): Uint8Array {
  const hdrExt = opts.hdrExt ?? [];
  const app = new Array(16).fill(0);
  if (opts.app) [...opts.app].forEach((c, i) => { if (i < 16) app[i] = c.charCodeAt(0); });
  return new Uint8Array([
    ...magicBytes(),
    2, 0,                          // major, minor
    ...w32(sampleRate),            // 0x19
    ...w32(opts.totalPulses ?? 0), // 0x1D
    compression,                   // 0x21
    flags,                         // 0x22
    hdrExt.length,                 // 0x23
    ...app,                        // 0x24 (16 bytes)
    ...hdrExt,                     // 0x34
    ...rleBytes,
  ]);
}

// ── Signature / header validation ──────────────────────────────────────────

describe('CSW — header validation', () => {
  it('rejects a file with the wrong signature', async () => {
    const bad = new Uint8Array(40);
    await expect(parseCSW(bad)).rejects.toThrow('Not a valid CSW file');
  });

  it('rejects an unknown major version', async () => {
    const data = cswV1(3500, 0, rle([10]));
    data[0x17] = 9;
    await expect(parseCSW(data)).rejects.toThrow('Unsupported CSW version 9');
  });

  it('rejects a zero sample rate', async () => {
    const data = cswV1(0, 0, rle([10]));
    await expect(parseCSW(data)).rejects.toThrow('zero sample rate');
  });

  it('rejects an unknown compression type', async () => {
    const data = cswV1(3500, 0, rle([10]), 7);
    await expect(parseCSW(data)).rejects.toThrow('Unsupported CSW compression type 7');
  });

  it('rejects Z-RLE (type 2) in a v1 file — v1 is always uncompressed', async () => {
    const data = cswV1(3500, 0, rle([10]), 2);
    await expect(parseCSW(data)).rejects.toThrow('Unsupported CSW compression type 2');
  });
});

// ── v1 RLE decoding ─────────────────────────────────────────────────────────

describe('CSW — v1 RLE', () => {
  it('emits a set-level (initial polarity) then a csw pulse block', async () => {
    const blocks = await parseCSW(cswV1(3500, 1, rle([50, 100, 200])));
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as SetLevelBlock).kind).toBe('set-level');
    expect((blocks[0] as SetLevelBlock).level).toBe(1);
    expect((blocks[1] as CswBlock).kind).toBe('csw');
  });

  it('initial polarity 0 when the flag bit is clear', async () => {
    const blocks = await parseCSW(cswV1(3500, 0, rle([50])));
    expect((blocks[0] as SetLevelBlock).level).toBe(0);
  });

  it('converts samples to T-states at 3500Hz (1 sample = 1000 T-states)', async () => {
    const blocks = await parseCSW(cswV1(3500, 0, rle([50, 100, 200])));
    const csw = blocks[1] as CswBlock;
    expect(Array.from(csw.pulses)).toEqual([50_000, 100_000, 200_000]);
  });

  it('decodes a 0-escape 32-bit long pulse', async () => {
    // 70000 samples cannot fit in a byte → escaped. At 3500Hz that is
    // 70000 * 3_500_000 / 3500 = 70_000_000 T-states.
    const blocks = await parseCSW(cswV1(3500, 0, rle([5, 70000])));
    const csw = blocks[1] as CswBlock;
    expect(Array.from(csw.pulses)).toEqual([5_000, 70_000_000]);
  });

  it('honours a 0-escape even for a small value', async () => {
    const blocks = await parseCSW(cswV1(3500, 0, rle([42], /* forceEscape */ true)));
    const csw = blocks[1] as CswBlock;
    expect(Array.from(csw.pulses)).toEqual([42_000]);
  });

  it('stops cleanly on a truncated 0-escape rather than reading past the end', async () => {
    // A trailing 0 with only 2 of the 4 dword bytes present.
    const blocks = await parseCSW(cswV1(3500, 0, [5, 0, 0x01, 0x02]));
    const csw = blocks[1] as CswBlock;
    expect(Array.from(csw.pulses)).toEqual([5_000]);
  });
});

// ── v2 RLE + Z-RLE decoding ─────────────────────────────────────────────────

describe('CSW — v2', () => {
  it('reads a 32-bit sample rate and RLE stream (1 sample = 1 T-state at 3.5MHz)', async () => {
    const blocks = await parseCSW(cswV2(3_500_000, 0, 1, rle([50, 100, 200, 50])));
    const csw = blocks[1] as CswBlock;
    expect(Array.from(csw.pulses)).toEqual([50, 100, 200, 50]);
  });

  it('skips the header extension bytes before the pulse stream', async () => {
    const blocks = await parseCSW(
      cswV2(3_500_000, 1, 1, rle([12, 34]), { hdrExt: [0xDE, 0xAD, 0xBE], app: 'zx84' }),
    );
    expect((blocks[0] as SetLevelBlock).level).toBe(1);
    expect(Array.from((blocks[1] as CswBlock).pulses)).toEqual([12, 34]);
  });

  it('decodes Z-RLE (zlib-compressed RLE)', async () => {
    const raw = rle([80, 160, 240, 3, 70000]);
    const compressed = Array.from(deflateSync(Buffer.from(raw)));
    const blocks = await parseCSW(cswV2(3_500_000, 0, 2, compressed));
    const csw = blocks[1] as CswBlock;
    expect(Array.from(csw.pulses)).toEqual([80, 160, 240, 3, 70000]);
  });

  it('clamps a sub-T-state pulse up to 1 so playback never stalls on a zero-length pulse', async () => {
    // 1 sample at 8MHz = 0.4375 T-states → rounds to 0 → clamped to 1.
    const blocks = await parseCSW(cswV2(8_000_000, 0, 1, rle([1])));
    expect(Array.from((blocks[1] as CswBlock).pulses)).toEqual([1]);
  });
});

// ── Playback through the TapeDeck ────────────────────────────────────────────

describe('CSW — playback', () => {
  it('seeds the initial polarity then toggles once per pulse, in order', async () => {
    // initial polarity 1, pulses 50/100/200/50 T-states (v2 @ 3.5MHz).
    const blocks = await parseCSW(cswV2(3_500_000, 1, 1, rle([50, 100, 200, 50])));
    const deck = new TapeDeck(3_500_000);
    deck.blocks = blocks;
    deck.position = 0;
    deck.startPlayback();

    // The set-level block seeded earBit to the initial polarity (1).
    expect(deck.earBit).toBe(1);

    deck.advance(50);
    expect(deck.earBit).toBe(0);
    deck.advance(100);
    expect(deck.earBit).toBe(1);
    deck.advance(200);
    expect(deck.earBit).toBe(0);
    deck.advance(50);
    expect(deck.earBit).toBe(1);
    // Pulse stream exhausted → playback stops.
    expect(deck.playing).toBe(false);
  });

  it('a custom-loader (csw) block blocks the ROM instant-load trap', async () => {
    const blocks = await parseCSW(cswV2(3_500_000, 0, 1, rle([50, 100])));
    const deck = new TapeDeck(3_500_000);
    deck.blocks = blocks;
    deck.position = 0;
    // No ROM-loadable data block precedes the csw stream.
    expect(deck.hasRomBlock()).toBe(false);
    expect(deck.peekDataBlock()).toBeNull();
  });
});
