/**
 * CPR (RIFF/AMS!) cartridge codec.
 *
 * The .CPR container is a RIFF form with `AMS!` form-type and up to 32 `cbNN`
 * chunks (one per 16 KB cartridge page). Tests build known-good and known-bad
 * fixtures by hand (not via the codec) so the parser is checked against an
 * independent spec, not against its own output.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCpr, writeCpr, isCpr,
  CPR_PAGE_SIZE, CPR_MAX_PAGES,
} from '@/media/cartridge/cpr.ts';

/** Build a RIFF/AMS! image with the given pages. Each page is a fill byte so
 *  tests can identify which page landed where. */
function buildCpr(pages: { index: number; fill: number; size?: number }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const p of pages) {
    const id = new Uint8Array([
      0x63, 0x62,                                    // 'cb'
      0x30 + Math.floor(p.index / 10),               // '0'..'3'
      0x30 + (p.index % 10),                         // '0'..'9'
    ]);
    const payload = new Uint8Array(p.size ?? CPR_PAGE_SIZE).fill(p.fill);
    const size = new Uint8Array([
      payload.length & 0xFF,
      (payload.length >> 8) & 0xFF,
      (payload.length >> 16) & 0xFF,
      (payload.length >> 24) & 0xFF,
    ]);
    chunks.push(id, size, payload);
    if (payload.length & 1) chunks.push(new Uint8Array(1));   // RIFF word-align
  }
  const totalChunkBytes = chunks.reduce((n, c) => n + c.length, 0);
  const header = new Uint8Array(12);
  header[0] = 0x52; header[1] = 0x49; header[2] = 0x46; header[3] = 0x46;   // 'RIFF'
  const riffSize = 4 + totalChunkBytes;
  header[4] = riffSize & 0xFF;
  header[5] = (riffSize >> 8) & 0xFF;
  header[6] = (riffSize >> 16) & 0xFF;
  header[7] = (riffSize >> 24) & 0xFF;
  header[8] = 0x41; header[9] = 0x4D; header[10] = 0x53; header[11] = 0x21; // 'AMS!'
  const out = new Uint8Array(12 + totalChunkBytes);
  let off = 0;
  out.set(header, off); off += header.length;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

describe('isCpr', () => {
  it('accepts a well-formed RIFF/AMS! header', () => {
    const cpr = buildCpr([{ index: 0, fill: 0xAA }]);
    expect(isCpr(cpr)).toBe(true);
  });

  it('rejects a non-RIFF file', () => {
    expect(isCpr(new Uint8Array(64).fill(0xFF))).toBe(false);
  });

  it('rejects a RIFF file of a different form (e.g. WAVE)', () => {
    const wav = new Uint8Array(12);
    wav[0] = 0x52; wav[1] = 0x49; wav[2] = 0x46; wav[3] = 0x46;   // 'RIFF'
    wav[8] = 0x57; wav[9] = 0x41; wav[10] = 0x56; wav[11] = 0x45; // 'WAVE'
    expect(isCpr(wav)).toBe(false);
  });

  it('rejects data shorter than the 12-byte header', () => {
    expect(isCpr(new Uint8Array(8))).toBe(false);
  });
});

describe('parseCpr', () => {
  it('parses a single-page cartridge into page 0', () => {
    const cpr = buildCpr([{ index: 0, fill: 0x11 }]);
    const pages = parseCpr(cpr);
    expect(pages.length).toBe(CPR_MAX_PAGES);
    expect(pages[0]?.length).toBe(CPR_PAGE_SIZE);
    expect(pages[0]?.[0]).toBe(0x11);
    expect(pages[1]).toBeUndefined();
  });

  it('parses the Burnin\' Rubber page layout (OS in 0, BASIC in 1, AMSDOS in 3)', () => {
    const cpr = buildCpr([
      { index: 0, fill: 0xAA },   // OS
      { index: 1, fill: 0xBB },   // BASIC
      { index: 3, fill: 0xDD },   // AMSDOS
    ]);
    const pages = parseCpr(cpr);
    expect(pages[0]?.[0]).toBe(0xAA);
    expect(pages[1]?.[0]).toBe(0xBB);
    expect(pages[2]).toBeUndefined();
    expect(pages[3]?.[0]).toBe(0xDD);
  });

  it('zero-pads an under-sized page to 16 KB', () => {
    const cpr = buildCpr([{ index: 0, fill: 0x42, size: 0x100 }]);
    const pages = parseCpr(cpr);
    expect(pages[0]?.length).toBe(CPR_PAGE_SIZE);
    expect(pages[0]?.[0]).toBe(0x42);
    expect(pages[0]?.[0x100]).toBe(0x00);    // padded tail
    expect(pages[0]?.[CPR_PAGE_SIZE - 1]).toBe(0x00);
  });

  it('truncates an over-sized page to 16 KB', () => {
    const cpr = buildCpr([{ index: 0, fill: 0x77, size: CPR_PAGE_SIZE + 0x100 }]);
    const pages = parseCpr(cpr);
    expect(pages[0]?.length).toBe(CPR_PAGE_SIZE);
  });

  it('throws on a non-RIFF/AMS! image', () => {
    expect(() => parseCpr(new Uint8Array(64).fill(0xFF))).toThrow(/AMS!/);
  });

  it('skips unrecognised chunk IDs without crashing', () => {
    // RIFF allows arbitrary chunks; a non-`cbNN` chunk should be silently
    // skipped (matching how Caprice32 and the real ASIC tolerate extra
    // metadata chunks some .CPR writers include).
    const cpr = new Uint8Array(12 + 8 + 4 + 8 + 0x4000);
    cpr[0] = 0x52; cpr[1] = 0x49; cpr[2] = 0x46; cpr[3] = 0x46;
    cpr[8] = 0x41; cpr[9] = 0x4D; cpr[10] = 0x53; cpr[11] = 0x21;
    // Junk chunk: 'LIST' size=4 data='xxxx'
    let off = 12;
    cpr[off] = 0x4C; cpr[off+1] = 0x49; cpr[off+2] = 0x53; cpr[off+3] = 0x54;  // 'LIST'
    cpr[off+4] = 4; cpr[off+5] = 0; cpr[off+6] = 0; cpr[off+7] = 0;
    cpr[off+8] = 0x78; cpr[off+9] = 0x78; cpr[off+10] = 0x78; cpr[off+11] = 0x78;
    off += 12;
    // Real page 0 chunk: 'cb00' size=0x4000
    cpr[off] = 0x63; cpr[off+1] = 0x62; cpr[off+2] = 0x30; cpr[off+3] = 0x30;
    cpr[off+4] = 0x00; cpr[off+5] = 0x40; cpr[off+6] = 0; cpr[off+7] = 0;
    cpr[off + 8] = 0x99;
    const pages = parseCpr(cpr);
    expect(pages[0]?.[0]).toBe(0x99);
  });
});

describe('writeCpr', () => {
  it('round-trips a sparse page array through writeCpr → parseCpr', () => {
    const pages: (Uint8Array | undefined)[] = new Array(CPR_MAX_PAGES).fill(undefined);
    pages[0] = new Uint8Array(CPR_PAGE_SIZE).fill(0xAA);
    pages[1] = new Uint8Array(CPR_PAGE_SIZE).fill(0xBB);
    pages[7] = new Uint8Array(CPR_PAGE_SIZE).fill(0xCC);
    const written = writeCpr(pages);
    expect(isCpr(written)).toBe(true);
    const reparsed = parseCpr(written);
    expect(reparsed[0]?.[0]).toBe(0xAA);
    expect(reparsed[1]?.[0]).toBe(0xBB);
    expect(reparsed[2]).toBeUndefined();
    expect(reparsed[7]?.[0]).toBe(0xCC);
  });

  it('omits absent pages from the serialized image', () => {
    const pages: (Uint8Array | undefined)[] = new Array(CPR_MAX_PAGES).fill(undefined);
    pages[0] = new Uint8Array(CPR_PAGE_SIZE).fill(0x11);
    const written = writeCpr(pages);
    // Header (12) + one chunk header (8) + one 16 KB payload.
    expect(written.length).toBe(12 + 8 + CPR_PAGE_SIZE);
  });
});
