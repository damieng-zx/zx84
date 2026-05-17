/**
 * Targeted tests covering remaining branches in src/snapshot/.
 *
 * Each test here exists to exercise a specific decision branch the broader
 * suites leave uncovered. Comments tie each test to the source line it pins.
 */

import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { loadSNA } from '@/snapshot/sna.ts';
import { loadZ80 } from '@/snapshot/z80format.ts';
import { saveSZX, loadSZX } from '@/snapshot/szx.ts';
import { unzip } from '@/snapshot/zip.ts';
import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/memory.ts';

// ── helpers ────────────────────────────────────────────────────────────────

function blankCpu(): Z80 {
  return new Z80();
}

function mem48(): SpectrumMemory {
  const m = new SpectrumMemory('48k');
  m.loadROM(new Uint8Array(16384));
  return m;
}

function mem128(): SpectrumMemory {
  const m = new SpectrumMemory('128k');
  m.loadROM(new Uint8Array(16384));
  return m;
}

function w16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xFF; buf[off + 1] = (v >> 8) & 0xFF;
}

// ── sna.ts:83 — truncated 128K SNA skips missing extra banks ───────────────

describe('SNA — truncated 128K snapshot', () => {
  it('stops loading extra banks when the file ends before all 5 are present', () => {
    // Build a minimal 128K SNA header by hand: 27-byte header + 49152 RAM +
    // 4 trailing bytes (PC lo, PC hi, port7FFD, TR-DOS) + ONLY 2 extra banks
    // (instead of the spec-mandated 5). The loader's `offset + 16384 <=
    // data.length` guard must short-circuit on the missing third bank.
    const cpu = blankCpu();
    cpu.pc = 0x4242;
    const port7FFD = 0x07; // current bank = 7 → extras are banks 0,1,3,4,6
    const present = 2;     // we'll only include banks 0 and 1

    const size = 49183 + present * 16384;
    const data = new Uint8Array(size);
    data[19] = 0;          // IFF2 = 0
    data[25] = 1;          // IM 1
    data[26] = 0;          // border
    // Tag bank-5 / bank-2 / current-bank regions with sentinel bytes so we
    // can confirm they were loaded.
    data[27] = 0x50;                  // bank 5, first byte
    data[27 + 16384] = 0x20;          // bank 2, first byte
    data[27 + 32768] = 0x70;          // current (bank 7), first byte
    w16(data, 49179, cpu.pc);
    data[49181] = port7FFD;
    data[49182] = 0;
    data[49183] = 0xA0;               // first extra (bank 0), first byte
    data[49183 + 16384] = 0xA1;       // second extra (bank 1), first byte

    const mem = mem128();
    const result = loadSNA(data, cpu, mem);

    expect(result.is128K).toBe(true);
    expect(mem.getRamBank(5)[0]).toBe(0x50);
    expect(mem.getRamBank(2)[0]).toBe(0x20);
    expect(mem.getRamBank(7)[0]).toBe(0x70);
    // Banks 0 and 1 were present in the trailing region.
    expect(mem.getRamBank(0)[0]).toBe(0xA0);
    expect(mem.getRamBank(1)[0]).toBe(0xA1);
    // Banks 3, 4, 6 were missing — guard must have skipped them without
    // throwing or reading off the end of the buffer.
    expect(mem.getRamBank(3)[0]).toBe(0);
    expect(mem.getRamBank(4)[0]).toBe(0);
    expect(mem.getRamBank(6)[0]).toBe(0);
  });
});

// ── z80format.ts:57-59 — v1 compressed literal pair (ED followed by non-ED) ─

describe('Z80 v1 compression — literal-pair branch in decompressV1', () => {
  it('treats ED followed by a non-ED byte as two literals', () => {
    // Build a v1 header (PC ≠ 0, compressed flag set in byte 12 bit 5).
    const header = new Uint8Array(30);
    header[6] = 0x00; header[7] = 0x80;      // PC = 0x8000 → v1
    header[12] = 0x20;                       // bit 5 = compressed
    header[29] = 1;                          // IM 1

    // Compressed stream: ED 42 (literal pair) then the v1 sentinel
    // 00 ED ED 00 to terminate.
    const stream = new Uint8Array([
      0xED, 0x42,
      0x00, 0xED, 0xED, 0x00,
    ]);
    const data = new Uint8Array(30 + stream.length);
    data.set(header, 0);
    data.set(stream, 30);

    const cpu = blankCpu();
    const mem = mem48();
    loadZ80(data, cpu, mem);

    // The decoder must have emitted 0xED then 0x42 as the first two bytes
    // of RAM (decompressed RAM is mapped to 0x4000+).
    expect(mem.readByte(0x4000)).toBe(0xED);
    expect(mem.readByte(0x4001)).toBe(0x42);
  });
});

// ── szx.ts:349 — uncompressed-fallback branch in saveSZX ───────────────────

describe('SZX save — uncompressed fallback when deflate does not shrink', () => {
  it('stores a high-entropy bank uncompressed when deflate produces a larger payload', async () => {
    const mem = mem48();
    // Fill page 5 with pseudo-random bytes that deflate cannot meaningfully
    // shrink. We use a deterministic LCG so the test is reproducible.
    const bank5 = mem.getRamBank(5);
    let s = 0xC0FFEEn;
    for (let i = 0; i < 16384; i++) {
      s = (s * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
      bank5[i] = Number((s >> 33n) & 0xFFn);
    }

    const saved = await saveSZX(blankCpu(), mem, 0, '48k', 0);

    // Walk SZX blocks to find page 5's RAMP block and inspect its wFlags.
    let off = 8; // skip ZXST header
    let found = false;
    while (off + 8 <= saved.length) {
      const id = String.fromCharCode(saved[off], saved[off + 1], saved[off + 2], saved[off + 3]);
      const size = saved[off + 4] | (saved[off + 5] << 8) | (saved[off + 6] << 16) | (saved[off + 7] << 24);
      const payload = saved.subarray(off + 8, off + 8 + size);
      if (id === 'RAMP') {
        const wFlags = payload[0] | (payload[1] << 8);
        const pageNo = payload[2];
        if (pageNo === 5) {
          // ZXSTRF_COMPRESSED is bit 0. Random data is incompressible so the
          // saver must have chosen the uncompressed branch.
          expect(wFlags & 1).toBe(0);
          // Payload after the 3-byte preamble must equal the raw bank bytes.
          const stored = payload.subarray(3);
          expect(stored.length).toBe(16384);
          expect(stored).toEqual(bank5);
          found = true;
          break;
        }
      }
      off += 8 + size;
    }
    expect(found).toBe(true);
  });
});

// ── zip.ts:50 — central-directory walk breaks on bad signature ─────────────

describe('unzip — central-directory walk halts on a corrupt entry', () => {
  it('stops iterating CD entries when a later entry has an invalid signature', async () => {
    // Construct a ZIP whose EOCD claims 2 entries but whose second CD entry
    // is corrupted. The first entry must still be returned; the loop must
    // break on entry 2 without throwing.
    //
    // We construct everything inline to keep the bytes auditable.
    const lfhSig = 0x04034b50;
    const cdSig  = 0x02014b50;
    const eocdSig = 0x06054b50;
    const name = new TextEncoder().encode('a.sna');
    const payload = new Uint8Array([0xAA, 0xBB, 0xCC]);

    // Local file header for entry 1 (stored, no CRC needed — loader ignores it).
    const lh = new Uint8Array(30 + name.length);
    const lhView = new DataView(lh.buffer);
    lhView.setUint32(0, lfhSig, true);
    lhView.setUint16(4, 20, true);
    lhView.setUint16(8, 0, true);                       // method = store
    lhView.setUint32(18, payload.length, true);         // compressedSize
    lhView.setUint32(22, payload.length, true);         // uncompressedSize
    lhView.setUint16(26, name.length, true);
    lh.set(name, 30);

    // Central directory entry 1 (valid).
    const cd1 = new Uint8Array(46 + name.length);
    const cd1View = new DataView(cd1.buffer);
    cd1View.setUint32(0, cdSig, true);
    cd1View.setUint16(10, 0, true);                     // method = store
    cd1View.setUint32(20, payload.length, true);
    cd1View.setUint32(24, payload.length, true);
    cd1View.setUint16(28, name.length, true);
    cd1View.setUint32(42, 0, true);                     // local header at 0
    cd1.set(name, 46);

    // Central directory entry 2 (corrupt signature). Min CD entry length = 46.
    const cd2 = new Uint8Array(46);
    // Leave signature as 0x00000000 — definitely not the CD magic.

    const cdOffset = lh.length + payload.length;
    const cdSize = cd1.length + cd2.length;

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, eocdSig, true);
    eocdView.setUint16(8, 2, true);                     // 2 entries this disk
    eocdView.setUint16(10, 2, true);                    // 2 total entries
    eocdView.setUint32(12, cdSize, true);
    eocdView.setUint32(16, cdOffset, true);

    const total = lh.length + payload.length + cdSize + eocd.length;
    const zip = new Uint8Array(total);
    let p = 0;
    zip.set(lh, p);            p += lh.length;
    zip.set(payload, p);       p += payload.length;
    zip.set(cd1, p);           p += cd1.length;
    zip.set(cd2, p);           p += cd2.length;
    zip.set(eocd, p);

    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('a.sna');
    expect(Array.from(out[0].data)).toEqual([0xAA, 0xBB, 0xCC]);
  });
});

// ── z80format.ts:52 — v1 stream ends immediately after a lone 0xED ─────────

describe('Z80 v1 compression — trailing 0xED at end of stream', () => {
  it('emits the 0xED as a literal when no following byte exists', () => {
    const header = new Uint8Array(30);
    header[6] = 0x00; header[7] = 0x80;      // PC = 0x8000 → v1
    header[12] = 0x20;                       // compressed flag
    header[29] = 1;

    // Compressed stream: one literal 0x11, then a lone 0xED with NO byte
    // after it. The decoder's `if (ip >= end)` branch must fire and emit
    // the ED literal before breaking.
    const stream = new Uint8Array([0x11, 0xED]);
    const data = new Uint8Array(30 + stream.length);
    data.set(header, 0);
    data.set(stream, 30);

    const cpu = blankCpu();
    const mem = mem48();
    loadZ80(data, cpu, mem);

    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x4001)).toBe(0xED);
  });
});

// ── z80format.ts:58 — v1 decompress refuses to overflow at byte 49151 ─────

describe('Z80 v1 compression — ED literal-pair at the very last RAM byte', () => {
  it('writes the ED literal but suppresses the trailing byte when op hits 49152', () => {
    const header = new Uint8Array(30);
    header[6] = 0x00; header[7] = 0x80;      // PC = 0x8000 → v1
    header[12] = 0x20;                       // compressed
    header[29] = 1;

    // Stream: an RLE run of 49151 0x77 bytes, then ED, 0x42 (literal pair).
    // The first ED literal lands at op=49151 (filling RAM); op++ → 49152
    // and the guard `op < 49152` then skips the 0x42 byte without overrun.
    // Trail with the v1 sentinel to keep the decoder happy.
    const stream = new Uint8Array([
      0xED, 0xED, 0xFF, 0x77,   // RLE 255 × 0x77
      0xED, 0xED, 0xFF, 0x77,   // RLE 255 × 0x77 (total 510)
      // Need 49151 total. We'll programmatically build runs below.
    ]);
    // Easier to build the stream programmatically.
    const parts: number[] = [];
    let remaining = 49151;
    while (remaining >= 255) {
      parts.push(0xED, 0xED, 0xFF, 0x77);
      remaining -= 255;
    }
    if (remaining >= 3) {
      // last small RLE run
      parts.push(0xED, 0xED, remaining, 0x77);
      remaining = 0;
    } else {
      // tail off with literals if fewer than 3 remain
      while (remaining-- > 0) parts.push(0x77);
    }
    // The pair that hits the boundary: ED then non-ED.
    parts.push(0xED, 0x42);
    // v1 sentinel.
    parts.push(0x00, 0xED, 0xED, 0x00);

    const compressed = new Uint8Array(parts);
    void stream; // silence unused-binding linter — we built `compressed` instead

    const data = new Uint8Array(30 + compressed.length);
    data.set(header, 0);
    data.set(compressed, 30);

    const mem = mem48();
    loadZ80(data, blankCpu(), mem);

    // The 49151 0x77s span 0x4000..0xFFFE. The trailing 0xED lands at
    // 0xFFFF and the 0x42 must NOT be written (no byte 0x10000).
    expect(mem.readByte(0xFFFE)).toBe(0x77);
    expect(mem.readByte(0xFFFF)).toBe(0xED);
  });
});

// ── z80format.ts:107 — v2/v3 block decompress refuses to overflow at 16383 ─

describe('Z80 v3 compression — ED literal-pair at the very last bank byte', () => {
  it('writes the ED literal but suppresses the trailing byte when op hits 16384', () => {
    // Build the compressed payload for a single 16K RAMP block (page 8).
    const parts: number[] = [];
    let remaining = 16383;
    while (remaining >= 255) {
      parts.push(0xED, 0xED, 0xFF, 0x33);
      remaining -= 255;
    }
    if (remaining >= 3) {
      parts.push(0xED, 0xED, remaining, 0x33);
      remaining = 0;
    } else {
      while (remaining-- > 0) parts.push(0x33);
    }
    parts.push(0xED, 0x42);
    const compressed = new Uint8Array(parts);

    // Build a v3 48K file with the crafted block.
    const header = new Uint8Array(30);
    header[6] = 0; header[7] = 0;            // PC=0 → v2/v3
    header[29] = 1;
    const extHeader = new Uint8Array(2 + 54);
    w16(extHeader, 0, 54);
    w16(extHeader, 2, 0x8000);
    extHeader[4] = 0;                        // 48K

    const bh = new Uint8Array(3);
    w16(bh, 0, compressed.length);
    bh[2] = 8;                               // page 8 → bank 5 / $4000

    const data = new Uint8Array(30 + extHeader.length + bh.length + compressed.length);
    let p = 0;
    data.set(header, p); p += 30;
    data.set(extHeader, p); p += extHeader.length;
    data.set(bh, p); p += bh.length;
    data.set(compressed, p);

    const mem = mem48();
    loadZ80(data, blankCpu(), mem);

    // Bank 5 is mapped at 0x4000. The 16383 0x33s fill 0x4000..0x7FFE; the
    // trailing 0xED lands at 0x7FFF; 0x42 must be discarded.
    expect(mem.readByte(0x7FFE)).toBe(0x33);
    expect(mem.readByte(0x7FFF)).toBe(0xED);
  });
});

// ── z80format.ts:269 — v3 block with truncated payload halts the loop ──────

describe('Z80 v3 paged blocks — truncated final block halts loop', () => {
  it('breaks out of the paged-block loop when the declared length runs off the end', () => {
    // Build a minimal 128K v3 file with one valid block (page 3 → bank 0)
    // and one trailing 3-byte block header that advertises an uncompressed
    // 16K payload but provides no payload bytes.
    const cpu = blankCpu();
    cpu.pc = 0x9000;

    const header = new Uint8Array(30);
    header[6] = 0; header[7] = 0;           // PC=0 → v2/v3
    header[29] = 1;                          // IM 1
    const extHeader = new Uint8Array(2 + 54);
    w16(extHeader, 0, 54);
    w16(extHeader, 2, cpu.pc);
    extHeader[4] = 4;                        // hwMode 4 = 128K

    // Block 1: page 3, uncompressed 16K, valid
    const block1Header = new Uint8Array(3);
    w16(block1Header, 0, 0xFFFF);
    block1Header[2] = 3;
    const block1Data = new Uint8Array(16384);
    block1Data[0] = 0x77;

    // Block 2: page 4, claims 16K uncompressed, no payload (truncated)
    const block2Header = new Uint8Array(3);
    w16(block2Header, 0, 0xFFFF);
    block2Header[2] = 4;

    const data = new Uint8Array(
      30 + extHeader.length + block1Header.length + block1Data.length + block2Header.length,
    );
    let p = 0;
    data.set(header, p); p += 30;
    data.set(extHeader, p); p += extHeader.length;
    data.set(block1Header, p); p += block1Header.length;
    data.set(block1Data, p); p += block1Data.length;
    data.set(block2Header, p);

    const mem = mem128();
    const result = loadZ80(data, blankCpu(), mem);

    expect(result.is128K).toBe(true);
    // Block 1 loaded successfully into bank 0 (page 3 maps to bank 0).
    expect(mem.getRamBank(0)[0]).toBe(0x77);
    // Block 2 was skipped due to the truncation guard — bank 1 is untouched.
    expect(mem.getRamBank(1)[0]).toBe(0);
  });
});

// ── zip.ts:124 — multi-chunk inflate with uncompressedSize=0 in CD ─────────

describe('unzip — multi-chunk inflate falls back to summed chunk length', () => {
  it('uses the actual chunk total when the CD uncompressedSize is zero', async () => {
    // Build a ZIP that deflates ~1 MiB of zeros into a small payload, then
    // patch the central-directory uncompressedSize field to 0 so the
    // multi-chunk allocation path takes the `totalLen` branch of its ternary.
    const SIZE = 1024 * 1024;
    const raw = new Uint8Array(SIZE);
    const deflated = new Uint8Array(deflateRawSync(raw));

    const name = new TextEncoder().encode('big.dsk');
    const lh = new Uint8Array(30 + name.length);
    const lhView = new DataView(lh.buffer);
    lhView.setUint32(0, 0x04034b50, true);
    lhView.setUint16(4, 20, true);
    lhView.setUint16(8, 8, true);
    lhView.setUint32(18, deflated.length, true);
    lhView.setUint32(22, raw.length, true);
    lhView.setUint16(26, name.length, true);
    lh.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cdView = new DataView(cd.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(10, 8, true);
    cdView.setUint32(20, deflated.length, true);
    cdView.setUint32(24, 0, true);                       // ← uncompressedSize = 0
    cdView.setUint16(28, name.length, true);
    cdView.setUint32(42, 0, true);
    cd.set(name, 46);

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, 1, true);
    eocdView.setUint16(10, 1, true);
    eocdView.setUint32(12, cd.length, true);
    eocdView.setUint32(16, lh.length + deflated.length, true);

    const zip = new Uint8Array(lh.length + deflated.length + cd.length + eocd.length);
    let p = 0;
    zip.set(lh, p); p += lh.length;
    zip.set(deflated, p); p += deflated.length;
    zip.set(cd, p); p += cd.length;
    zip.set(eocd, p);

    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    // The CD lied about uncompressedSize=0, but the multi-chunk fallback
    // uses the summed chunk length, so all 1 MiB came through.
    expect(out[0].data.length).toBe(SIZE);
    expect(out[0].data[SIZE - 1]).toBe(0);
  });
});

// ── szx.ts:91-97 / zip.ts:124 — multi-chunk inflate concatenation ──────────
//
// Decompression streams in Node deliver large inflated outputs in multiple
// reader chunks once the output exceeds the stream's internal high-water
// mark. By inflating ~1 MiB of zeroes we reliably trigger the multi-chunk
// branch in both `szx.ts` and `zip.ts` (their inflate helpers share the
// same shape: single-chunk fast path, otherwise concatenate).

describe('inflate helpers — multi-chunk concatenation branch', () => {
  it('zip.ts inflate concatenates chunks for large deflated payloads', async () => {
    // 1 MiB of zeros — deflates to a handful of bytes, inflates to a payload
    // large enough that DecompressionStream emits multiple chunks.
    const SIZE = 1024 * 1024;
    const raw = new Uint8Array(SIZE);
    const deflated = new Uint8Array(deflateRawSync(raw));

    const name = new TextEncoder().encode('big.dsk');
    const lh = new Uint8Array(30 + name.length);
    const lhView = new DataView(lh.buffer);
    lhView.setUint32(0, 0x04034b50, true);
    lhView.setUint16(4, 20, true);
    lhView.setUint16(8, 8, true);                       // method = deflate
    lhView.setUint32(18, deflated.length, true);
    lhView.setUint32(22, raw.length, true);
    lhView.setUint16(26, name.length, true);
    lh.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cdView = new DataView(cd.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(10, 8, true);                      // method = deflate
    cdView.setUint32(20, deflated.length, true);
    cdView.setUint32(24, raw.length, true);
    cdView.setUint16(28, name.length, true);
    cdView.setUint32(42, 0, true);
    cd.set(name, 46);

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, 1, true);
    eocdView.setUint16(10, 1, true);
    eocdView.setUint32(12, cd.length, true);
    eocdView.setUint32(16, lh.length + deflated.length, true);

    const zip = new Uint8Array(lh.length + deflated.length + cd.length + eocd.length);
    let p = 0;
    zip.set(lh, p); p += lh.length;
    zip.set(deflated, p); p += deflated.length;
    zip.set(cd, p); p += cd.length;
    zip.set(eocd, p);

    const out = await unzip(zip);
    expect(out).toHaveLength(1);
    expect(out[0].data.length).toBe(SIZE);
    // Spot-check first, middle and last bytes — equality on a 1 MiB array
    // is correct but slow under deep-equal in vitest, so sample instead.
    expect(out[0].data[0]).toBe(0);
    expect(out[0].data[SIZE / 2]).toBe(0);
    expect(out[0].data[SIZE - 1]).toBe(0);
  });

  it('szx.ts inflate concatenates chunks when a RAMP block inflates beyond 16 KiB', async () => {
    // Node's DecompressionStream emits inflated bytes in 16 KiB chunks. To
    // exercise szx.ts:inflate's multi-chunk concatenation we need an inflated
    // payload >16 KiB. RAMP normally caps at 16 KiB but the loader does not
    // validate the inflated size — it just hands the result to
    // setBankFromSnapshot which clamps. So we deflate 32 KiB (the first
    // 16 KiB carries the actual bank data, the remainder is filler that gets
    // dropped) and pack it into a hand-rolled SZX with a single 128K RAMP
    // (page 5).
    const bankBytes = new Uint8Array(16384);
    for (let i = 0; i < bankBytes.length; i++) bankBytes[i] = (i * 5) & 0xFF;
    const filler = new Uint8Array(16384 + 1); // tip the inflated size over 16 KiB
    const raw = new Uint8Array(bankBytes.length + filler.length);
    raw.set(bankBytes, 0);
    raw.set(filler, bankBytes.length);

    const { deflateSync } = await import('node:zlib');
    const deflated = new Uint8Array(deflateSync(raw)); // zlib (NOT raw) for SZX

    // Build the SZX header: 'ZXST' + ver + machine ID + flags (8 bytes).
    const szxHeader = new Uint8Array(8);
    szxHeader[0] = 0x5A; szxHeader[1] = 0x58;
    szxHeader[2] = 0x53; szxHeader[3] = 0x54;
    szxHeader[4] = 1; szxHeader[5] = 4;
    szxHeader[6] = 1; // 48K — fine for loading bank 5
    szxHeader[7] = 0;

    // Z80R block (37 payload bytes — values don't matter; just need a valid
    // header so the loader can iterate to our RAMP).
    const z80rPayload = new Uint8Array(37);
    const z80rBlock = new Uint8Array(8 + z80rPayload.length);
    z80rBlock[0] = 0x5A; z80rBlock[1] = 0x38; z80rBlock[2] = 0x30; z80rBlock[3] = 0x52;
    z80rBlock[4] = z80rPayload.length & 0xFF;
    z80rBlock[5] = (z80rPayload.length >> 8) & 0xFF;
    z80rBlock.set(z80rPayload, 8);

    // RAMP block: wFlags=1 (compressed), chPageNo=5, then deflated bytes.
    const rampPayload = new Uint8Array(3 + deflated.length);
    rampPayload[0] = 1; rampPayload[1] = 0;   // wFlags = compressed
    rampPayload[2] = 5;                       // page 5
    rampPayload.set(deflated, 3);
    const rampSize = rampPayload.length;
    const rampBlock = new Uint8Array(8 + rampSize);
    rampBlock[0] = 0x52; rampBlock[1] = 0x41; rampBlock[2] = 0x4D; rampBlock[3] = 0x50;
    rampBlock[4] = rampSize & 0xFF;
    rampBlock[5] = (rampSize >> 8) & 0xFF;
    rampBlock[6] = (rampSize >> 16) & 0xFF;
    rampBlock[7] = (rampSize >> 24) & 0xFF;
    rampBlock.set(rampPayload, 8);

    const file = new Uint8Array(szxHeader.length + z80rBlock.length + rampBlock.length);
    let p = 0;
    file.set(szxHeader, p); p += szxHeader.length;
    file.set(z80rBlock, p); p += z80rBlock.length;
    file.set(rampBlock, p);

    const mem = mem48();
    const cpu2 = blankCpu();
    await loadSZX(file, cpu2, mem);

    // Bank 5 must hold the first 16 KiB of our raw payload exactly. If the
    // multi-chunk concatenation were wrong, the early bytes would be corrupt.
    const bank5 = mem.getRamBank(5);
    for (let i = 0; i < bankBytes.length; i++) {
      expect(bank5[i]).toBe(bankBytes[i]);
    }
  });
});
