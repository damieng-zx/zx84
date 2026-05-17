import { describe, it, expect } from 'vitest';
import { saveZ80, loadZ80 } from '@/snapshot/z80format.ts';
import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/memory.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function w16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xFF;
  buf[offset + 1] = (value >> 8) & 0xFF;
}

function r16(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function makeCpu(): Z80 {
  const cpu = new Z80();
  cpu.a = 0x3E; cpu.f = 0x44;
  cpu.b = 0x10; cpu.c = 0x20;
  cpu.d = 0x30; cpu.e = 0x40;
  cpu.h = 0x50; cpu.l = 0x60;
  cpu.a_ = 0xAA; cpu.f_ = 0x55;
  cpu.b_ = 0x11; cpu.c_ = 0x22;
  cpu.d_ = 0x33; cpu.e_ = 0x44;
  cpu.h_ = 0x55; cpu.l_ = 0x66;
  cpu.iy = 0x1234;
  cpu.ix = 0x5678;
  cpu.sp = 0xFFFE;
  cpu.pc = 0x8000;
  cpu.i = 0x1F;
  cpu.r = 0x81;
  cpu.iff1 = true;
  cpu.iff2 = false;
  cpu.im = 2;
  return cpu;
}

function makeMemory48k(): SpectrumMemory {
  const mem = new SpectrumMemory('48k');
  mem.loadROM(new Uint8Array(16384));
  return mem;
}

function makeMemory128k(): SpectrumMemory {
  const mem = new SpectrumMemory('128k');
  mem.loadROM(new Uint8Array(16384));
  return mem;
}

function roundTripBank(
  originalBank: Uint8Array,
  bankIndex: number,
  is128K: boolean
): { bank: Uint8Array; cpu: Z80; memory: SpectrumMemory } {
  const cpu = makeCpu();
  const memory = is128K ? makeMemory128k() : makeMemory48k();
  memory.getRamBank(bankIndex).set(originalBank);

  const saved = saveZ80(cpu, memory, 3, is128K);

  const cpu2 = new Z80();
  const memory2 = is128K ? makeMemory128k() : makeMemory48k();
  loadZ80(saved, cpu2, memory2);

  return { bank: memory2.getRamBank(bankIndex), cpu: cpu2, memory: memory2 };
}

/** Build a v1 (48K) .z80 file with the given CPU state and 49152 bytes of RAM. */
function buildV1(
  cpu: Z80,
  ram: Uint8Array,
  compressed: boolean,
  borderColor: number
): Uint8Array {
  const header = new Uint8Array(30);
  header[0] = cpu.a; header[1] = cpu.f;
  header[2] = cpu.c; header[3] = cpu.b;
  header[4] = cpu.l; header[5] = cpu.h;
  w16(header, 6, cpu.pc);
  w16(header, 8, cpu.sp);
  header[10] = cpu.i;
  header[11] = cpu.r & 0x7F;
  const rBit7 = (cpu.r & 0x80) >> 7;
  header[12] = rBit7 | ((borderColor & 0x07) << 1) | (compressed ? 0x20 : 0);
  header[13] = cpu.e; header[14] = cpu.d;
  header[15] = cpu.c_; header[16] = cpu.b_;
  header[17] = cpu.e_; header[18] = cpu.d_;
  header[19] = cpu.l_; header[20] = cpu.h_;
  header[21] = cpu.a_; header[22] = cpu.f_;
  w16(header, 23, cpu.iy);
  w16(header, 25, cpu.ix);
  header[27] = cpu.iff1 ? 1 : 0;
  header[28] = cpu.iff2 ? 1 : 0;
  header[29] = cpu.im & 0x03;

  const result = new Uint8Array(30 + ram.length);
  result.set(header);
  result.set(ram, 30);
  return result;
}

/** Build a v3 .z80 file with paged blocks for 48K (pages 4, 5, 8). */
function buildV3_48K(
  cpu: Z80,
  banks: { pageId: number; data: Uint8Array }[],
  borderColor: number
): Uint8Array {
  const header = new Uint8Array(30);
  header[0] = cpu.a; header[1] = cpu.f;
  header[2] = cpu.c; header[3] = cpu.b;
  header[4] = cpu.l; header[5] = cpu.h;
  w16(header, 6, 0);
  w16(header, 8, cpu.sp);
  header[10] = cpu.i;
  header[11] = cpu.r & 0x7F;
  const rBit7 = (cpu.r & 0x80) >> 7;
  header[12] = rBit7 | ((borderColor & 0x07) << 1);
  header[13] = cpu.e; header[14] = cpu.d;
  header[15] = cpu.c_; header[16] = cpu.b_;
  header[17] = cpu.e_; header[18] = cpu.d_;
  header[19] = cpu.l_; header[20] = cpu.h_;
  header[21] = cpu.a_; header[22] = cpu.f_;
  w16(header, 23, cpu.iy);
  w16(header, 25, cpu.ix);
  header[27] = cpu.iff1 ? 1 : 0;
  header[28] = cpu.iff2 ? 1 : 0;
  header[29] = cpu.im & 0x03;

  const extHeaderLen = 54;
  const extHeader = new Uint8Array(2 + extHeaderLen);
  w16(extHeader, 0, extHeaderLen);
  w16(extHeader, 2, cpu.pc);
  extHeader[4] = 0;
  extHeader[5] = 0;

  const blockArrays: Uint8Array[] = [];
  for (const { pageId, data } of banks) {
    const bh = new Uint8Array(3);
    w16(bh, 0, 0xFFFF);
    bh[2] = pageId;
    blockArrays.push(bh);
    blockArrays.push(data);
  }

  const totalLen = 30 + 2 + extHeaderLen + blockArrays.reduce((s, b) => s + b.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  result.set(header, off); off += 30;
  result.set(extHeader, off); off += 2 + extHeaderLen;
  for (const block of blockArrays) {
    result.set(block, off); off += block.length;
  }
  return result;
}

/** Build a v3 .z80 file with paged blocks for 128K (pages 3-10). */
function buildV3_128K(
  cpu: Z80,
  banks: { pageId: number; data: Uint8Array }[],
  port7FFD: number,
  borderColor: number
): Uint8Array {
  const header = new Uint8Array(30);
  header[0] = cpu.a; header[1] = cpu.f;
  header[2] = cpu.c; header[3] = cpu.b;
  header[4] = cpu.l; header[5] = cpu.h;
  w16(header, 6, 0);
  w16(header, 8, cpu.sp);
  header[10] = cpu.i;
  header[11] = cpu.r & 0x7F;
  const rBit7 = (cpu.r & 0x80) >> 7;
  header[12] = rBit7 | ((borderColor & 0x07) << 1);
  header[13] = cpu.e; header[14] = cpu.d;
  header[15] = cpu.c_; header[16] = cpu.b_;
  header[17] = cpu.e_; header[18] = cpu.d_;
  header[19] = cpu.l_; header[20] = cpu.h_;
  header[21] = cpu.a_; header[22] = cpu.f_;
  w16(header, 23, cpu.iy);
  w16(header, 25, cpu.ix);
  header[27] = cpu.iff1 ? 1 : 0;
  header[28] = cpu.iff2 ? 1 : 0;
  header[29] = cpu.im & 0x03;

  const extHeaderLen = 54;
  const extHeader = new Uint8Array(2 + extHeaderLen);
  w16(extHeader, 0, extHeaderLen);
  w16(extHeader, 2, cpu.pc);
  extHeader[4] = 4;
  extHeader[5] = port7FFD;

  const blockArrays: Uint8Array[] = [];
  for (const { pageId, data } of banks) {
    const bh = new Uint8Array(3);
    w16(bh, 0, 0xFFFF);
    bh[2] = pageId;
    blockArrays.push(bh);
    blockArrays.push(data);
  }

  const totalLen = 30 + 2 + extHeaderLen + blockArrays.reduce((s, b) => s + b.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  result.set(header, off); off += 30;
  result.set(extHeader, off); off += 2 + extHeaderLen;
  for (const block of blockArrays) {
    result.set(block, off); off += block.length;
  }
  return result;
}

/**
 * Build a v2 .z80 file (extended header length = 23). Layout matches v3
 * but with the shorter extended header; paged-block format is identical.
 */
function buildV2(
  cpu: Z80,
  banks: { pageId: number; data: Uint8Array }[],
  hwMode: number,
  port7FFD: number,
  borderColor: number
): Uint8Array {
  const header = new Uint8Array(30);
  header[0] = cpu.a; header[1] = cpu.f;
  header[2] = cpu.c; header[3] = cpu.b;
  header[4] = cpu.l; header[5] = cpu.h;
  w16(header, 6, 0);
  w16(header, 8, cpu.sp);
  header[10] = cpu.i;
  header[11] = cpu.r & 0x7F;
  const rBit7 = (cpu.r & 0x80) >> 7;
  header[12] = rBit7 | ((borderColor & 0x07) << 1);
  header[13] = cpu.e; header[14] = cpu.d;
  header[15] = cpu.c_; header[16] = cpu.b_;
  header[17] = cpu.e_; header[18] = cpu.d_;
  header[19] = cpu.l_; header[20] = cpu.h_;
  header[21] = cpu.a_; header[22] = cpu.f_;
  w16(header, 23, cpu.iy);
  w16(header, 25, cpu.ix);
  header[27] = cpu.iff1 ? 1 : 0;
  header[28] = cpu.iff2 ? 1 : 0;
  header[29] = cpu.im & 0x03;

  const extHeaderLen = 23;
  const extHeader = new Uint8Array(2 + extHeaderLen);
  w16(extHeader, 0, extHeaderLen);
  w16(extHeader, 2, cpu.pc);
  extHeader[4] = hwMode;
  extHeader[5] = port7FFD;

  const blockArrays: Uint8Array[] = [];
  for (const { pageId, data } of banks) {
    const bh = new Uint8Array(3);
    w16(bh, 0, 0xFFFF);
    bh[2] = pageId;
    blockArrays.push(bh);
    blockArrays.push(data);
  }

  const totalLen = 30 + 2 + extHeaderLen + blockArrays.reduce((s, b) => s + b.length, 0);
  const result = new Uint8Array(totalLen);
  let off = 0;
  result.set(header, off); off += 30;
  result.set(extHeader, off); off += 2 + extHeaderLen;
  for (const block of blockArrays) {
    result.set(block, off); off += block.length;
  }
  return result;
}

/** Build a compressed v2/v3 data block: ED ED <count> <byte> entries. */
function buildCompressedBlock(entries: { count: number; value: number }[]): Uint8Array {
  const out: number[] = [];
  for (const { count, value } of entries) {
    out.push(0xED, 0xED, count, value);
  }
  return new Uint8Array(out);
}

// ── Version detection ──────────────────────────────────────────────────────

describe('Z80 format — version detection', () => {
  it('detects v1 when PC is non-zero', () => {
    const cpu = makeCpu();
    const data = buildV1(cpu, new Uint8Array(49152), false, 0);
    const cpu2 = new Z80();
    const mem = makeMemory48k();
    loadZ80(data, cpu2, mem);
    expect(cpu2.pc).toBe(0x8000);
  });

  it('detects v3 when PC=0 and extended header length is 54', () => {
    const cpu = makeCpu();
    cpu.pc = 0x1234;
    const data = buildV3_48K(cpu, [
      { pageId: 8, data: new Uint8Array(16384) },
      { pageId: 4, data: new Uint8Array(16384) },
      { pageId: 5, data: new Uint8Array(16384) },
    ], 0);
    // Verify constructed file has the v3 markers
    expect(r16(data, 6)).toBe(0);
    expect(r16(data, 30)).toBe(54);

    const cpu2 = new Z80();
    loadZ80(data, cpu2, makeMemory48k());
    // PC must come from the extended header (offset 32-33), not bytes 6-7
    expect(cpu2.pc).toBe(0x1234);
  });

  it('detects v2 when extended header length is 23', () => {
    const cpu = makeCpu();
    cpu.pc = 0x5678;
    // Build a v3 file then truncate the extended header to 23 bytes.
    const v3 = buildV3_48K(cpu, [
      { pageId: 8, data: new Uint8Array(16384) },
    ], 0);
    const extLen = 23;
    const dataBlocksStart = 32 + 54;
    const blocksLen = v3.length - dataBlocksStart;
    const data = new Uint8Array(30 + 2 + extLen + blocksLen);
    data.set(v3.subarray(0, 30), 0);
    w16(data, 30, extLen);
    // copy PC (extBase..extBase+1) and the rest of the first 23 ext bytes
    data.set(v3.subarray(32, 32 + extLen), 32);
    data.set(v3.subarray(dataBlocksStart), 32 + extLen);

    const cpu2 = new Z80();
    loadZ80(data, cpu2, makeMemory48k());
    expect(cpu2.pc).toBe(0x5678);
  });

  it('rejects files smaller than 30 bytes', () => {
    expect(() => loadZ80(new Uint8Array(29), new Z80(), makeMemory48k()))
      .toThrow('.z80 file too small');
  });
});

// ── CPU register save/restore ──────────────────────────────────────────────

describe('Z80 format — register round-trip', () => {
  it('preserves all main registers in 48K save/load', () => {
    const cpu = makeCpu();
    const mem = makeMemory48k();
    const saved = saveZ80(cpu, mem, 5, false);

    const cpu2 = new Z80();
    const mem2 = makeMemory48k();
    loadZ80(saved, cpu2, mem2);

    expect(cpu2.a).toBe(0x3E);
    expect(cpu2.f).toBe(0x44);
    expect(cpu2.b).toBe(0x10);
    expect(cpu2.c).toBe(0x20);
    expect(cpu2.d).toBe(0x30);
    expect(cpu2.e).toBe(0x40);
    expect(cpu2.h).toBe(0x50);
    expect(cpu2.l).toBe(0x60);
    expect(cpu2.a_).toBe(0xAA);
    expect(cpu2.f_).toBe(0x55);
    expect(cpu2.b_).toBe(0x11);
    expect(cpu2.c_).toBe(0x22);
    expect(cpu2.d_).toBe(0x33);
    expect(cpu2.e_).toBe(0x44);
    expect(cpu2.h_).toBe(0x55);
    expect(cpu2.l_).toBe(0x66);
    expect(cpu2.iy).toBe(0x1234);
    expect(cpu2.ix).toBe(0x5678);
    expect(cpu2.sp).toBe(0xFFFE);
    expect(cpu2.pc).toBe(0x8000);
    expect(cpu2.i).toBe(0x1F);
    expect(cpu2.r).toBe(0x81);
    expect(cpu2.iff1).toBe(true);
    expect(cpu2.iff2).toBe(false);
    expect(cpu2.im).toBe(2);
  });

  it('preserves all main registers in 128K save/load', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    const saved = saveZ80(cpu, mem, 2, true);

    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    const result = loadZ80(saved, cpu2, mem2);

    expect(result.is128K).toBe(true);
    expect(cpu2.a).toBe(0x3E);
    expect(cpu2.pc).toBe(0x8000);
    expect(cpu2.sp).toBe(0xFFFE);
    expect(cpu2.i).toBe(0x1F);
    expect(cpu2.r).toBe(0x81);
    expect(cpu2.im).toBe(2);
  });

  it('preserves R register high bit across byte 12 encoding', () => {
    for (const rVal of [0x00, 0x7F, 0x80, 0xFF]) {
      const cpu = new Z80();
      cpu.r = rVal;
      const mem = makeMemory48k();
      const saved = saveZ80(cpu, mem, 0, false);

      const cpu2 = new Z80();
      loadZ80(saved, cpu2, makeMemory48k());
      expect(cpu2.r).toBe(rVal);
    }
  });

  it('handles byte 12 = 255 compatibility (mapped to 1)', () => {
    const cpu = makeCpu();
    const data = buildV1(cpu, new Uint8Array(49152), false, 0);
    data[12] = 255;

    const cpu2 = new Z80();
    const result = loadZ80(data, cpu2, makeMemory48k());

    expect(cpu2.r & 0x80).toBe(0x80);
    expect(result.borderColor).toBe(0);
  });

  it('preserves IFF1=false and IFF2=true', () => {
    const cpu = new Z80();
    cpu.iff1 = false;
    cpu.iff2 = true;
    const mem = makeMemory48k();
    const saved = saveZ80(cpu, mem, 0, false);

    const cpu2 = new Z80();
    loadZ80(saved, cpu2, makeMemory48k());
    expect(cpu2.iff1).toBe(false);
    expect(cpu2.iff2).toBe(true);
  });

  it('clamps IM to 0-2', () => {
    for (const im of [0, 1, 2]) {
      const cpu = new Z80();
      cpu.im = im;
      const saved = saveZ80(cpu, makeMemory48k(), 0, false);
      const cpu2 = new Z80();
      loadZ80(saved, cpu2, makeMemory48k());
      expect(cpu2.im).toBe(im);
    }
  });
});

// ── Border color ───────────────────────────────────────────────────────────

describe('Z80 format — border color', () => {
  it('preserves all 8 border colors through save/load', () => {
    for (let bc = 0; bc < 8; bc++) {
      const cpu = new Z80();
      const mem = makeMemory48k();
      const saved = saveZ80(cpu, mem, bc, false);

      const cpu2 = new Z80();
      const result = loadZ80(saved, cpu2, makeMemory48k());
      expect(result.borderColor).toBe(bc);
    }
  });

  it('reads border color from a v1 file', () => {
    const cpu = makeCpu();
    const data = buildV1(cpu, new Uint8Array(49152), false, 4);
    const cpu2 = new Z80();
    const result = loadZ80(data, cpu2, makeMemory48k());
    expect(result.borderColor).toBe(4);
  });

  it('masks border color to 3 bits', () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const saved = saveZ80(cpu, mem, 7, false);

    saved[12] = (saved[12] & ~0x0E) | (0x05 << 1);
    const cpu2 = new Z80();
    const result = loadZ80(saved, cpu2, makeMemory48k());
    expect(result.borderColor).toBe(5);
  });
});

// ── V1 format loading ──────────────────────────────────────────────────────

describe('Z80 format — v1 loading', () => {
  it('loads uncompressed v1 48K RAM correctly', () => {
    const cpu = makeCpu();
    const ram = new Uint8Array(49152);
    ram[0] = 0x42;
    ram[16384] = 0x55;
    ram[32768] = 0xAA;
    ram[49151] = 0xFF;

    const data = buildV1(cpu, ram, false, 0);
    const cpu2 = new Z80();
    const mem = makeMemory48k();
    loadZ80(data, cpu2, mem);

    expect(mem.readByte(0x4000)).toBe(0x42);
    expect(mem.readByte(0x8000)).toBe(0x55);
    expect(mem.readByte(0xC000)).toBe(0xAA);
    expect(mem.readByte(0xFFFF)).toBe(0xFF);
  });

  it('loads compressed v1 48K RAM using RLE runs', () => {
    const cpu = makeCpu();

    // Compressed stream:
    //   literal 0x11, literal 0x22, RLE(100 x 0xAA), then v1 sentinel
    //   00 ED ED 00 followed by garbage that must NOT be decoded.
    const compressed: number[] = [
      0x11, 0x22,
      0xED, 0xED, 100, 0xAA,
      // sentinel (count==0 in v1 terminates the stream)
      0x00, 0xED, 0xED, 0x00, 0x00,
      // garbage that must be ignored
      0xFF, 0xFF, 0xFF, 0xFF,
    ];

    const data = new Uint8Array(30 + compressed.length);
    data.set(buildV1(cpu, new Uint8Array(0), true, 0).subarray(0, 30));
    for (let i = 0; i < compressed.length; i++) data[30 + i] = compressed[i];

    const cpu2 = new Z80();
    const mem = makeMemory48k();
    const result = loadZ80(data, cpu2, mem);

    expect(result.is128K).toBe(false);
    expect(result.port7FFD).toBe(0);
    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x4001)).toBe(0x22);
    for (let i = 0; i < 100; i++) {
      expect(mem.readByte(0x4002 + i)).toBe(0xAA);
    }
    // Sentinel's leading literal 0x00 is decoded; rest of RAM stays zero
    // because the sentinel terminates the stream before the trailing 0xFFs.
    expect(mem.readByte(0x4000 + 102)).toBe(0x00);
    expect(mem.readByte(0xFFFF)).toBe(0x00);
  });

  it('reports is128K=false for v1', () => {
    const cpu = makeCpu();
    const data = buildV1(cpu, new Uint8Array(49152), false, 0);
    const result = loadZ80(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
    expect(result.port7FFD).toBe(0);
  });
});

// ── V3 paged block loading — 48K ───────────────────────────────────────────

describe('Z80 format — v3 48K paged blocks', () => {
  it('maps page 8 → bank 5 (0x4000-0x7FFF)', () => {
    const cpu = makeCpu();
    const page8 = new Uint8Array(16384);
    page8[0] = 0x88;
    const data = buildV3_48K(cpu, [{ pageId: 8, data: page8 }], 0);
    const mem = makeMemory48k();
    loadZ80(data, new Z80(), mem);
    expect(mem.readByte(0x4000)).toBe(0x88);
  });

  it('maps page 4 → bank 2 (0x8000-0xBFFF)', () => {
    const cpu = makeCpu();
    const page4 = new Uint8Array(16384);
    page4[0] = 0x44;
    const data = buildV3_48K(cpu, [{ pageId: 4, data: page4 }], 0);
    const mem = makeMemory48k();
    loadZ80(data, new Z80(), mem);
    expect(mem.readByte(0x8000)).toBe(0x44);
  });

  it('maps page 5 → bank 0 (0xC000-0xFFFF)', () => {
    const cpu = makeCpu();
    const page5 = new Uint8Array(16384);
    page5[0] = 0x55;
    const data = buildV3_48K(cpu, [{ pageId: 5, data: page5 }], 0);
    const mem = makeMemory48k();
    loadZ80(data, new Z80(), mem);
    expect(mem.readByte(0xC000)).toBe(0x55);
  });

  it('loads all three 48K pages together', () => {
    const cpu = makeCpu();
    const page8 = new Uint8Array(16384).fill(0x11);
    const page4 = new Uint8Array(16384).fill(0x22);
    const page5 = new Uint8Array(16384).fill(0x33);
    const data = buildV3_48K(cpu, [
      { pageId: 8, data: page8 },
      { pageId: 4, data: page4 },
      { pageId: 5, data: page5 },
    ], 0);
    const mem = makeMemory48k();
    loadZ80(data, new Z80(), mem);
    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x8000)).toBe(0x22);
    expect(mem.readByte(0xC000)).toBe(0x33);
  });

  it('ignores unknown page IDs', () => {
    const cpu = makeCpu();
    const page99 = new Uint8Array(16384).fill(0xFF);
    const page8 = new Uint8Array(16384).fill(0x42);
    const data = buildV3_48K(cpu, [
      { pageId: 99, data: page99 },
      { pageId: 8, data: page8 },
    ], 0);
    const mem = makeMemory48k();
    loadZ80(data, new Z80(), mem);
    expect(mem.readByte(0x4000)).toBe(0x42);
  });
});

// ── V3 paged block loading — 128K ──────────────────────────────────────────

describe('Z80 format — v3 128K paged blocks', () => {
  it('maps page 3 → bank 0 through page 10 → bank 7', () => {
    const cpu = makeCpu();
    const banks: { pageId: number; data: Uint8Array }[] = [];
    for (let bank = 0; bank < 8; bank++) {
      const data = new Uint8Array(16384);
      data[0] = bank * 0x11;
      banks.push({ pageId: bank + 3, data });
    }
    const file = buildV3_128K(cpu, banks, 0x07, 0);
    const mem = makeMemory128k();
    const result = loadZ80(file, new Z80(), mem);

    expect(result.is128K).toBe(true);
    expect(result.port7FFD).toBe(0x07);
    for (let bank = 0; bank < 8; bank++) {
      expect(mem.getRamBank(bank)[0]).toBe(bank * 0x11);
    }
  });

  it('ignores ROM pages (0-2)', () => {
    const cpu = makeCpu();
    const romPage = new Uint8Array(16384).fill(0xFF);
    const bank0 = new Uint8Array(16384).fill(0x42);
    const file = buildV3_128K(cpu, [
      { pageId: 1, data: romPage },
      { pageId: 3, data: bank0 },
    ], 0, 0);
    const mem = makeMemory128k();
    loadZ80(file, new Z80(), mem);
    expect(mem.getRamBank(0)[0]).toBe(0x42);
  });

  it('restores port7FFD paging state', () => {
    const cpu = makeCpu();
    const banks: { pageId: number; data: Uint8Array }[] = [];
    for (let bank = 0; bank < 8; bank++) {
      banks.push({ pageId: bank + 3, data: new Uint8Array(16384) });
    }
    const file = buildV3_128K(cpu, banks, 0x17, 0);
    const mem = makeMemory128k();
    loadZ80(file, new Z80(), mem);

    expect(mem.port7FFD).toBe(0x17);
    expect(mem.currentBank).toBe(0x07);
    expect(mem.currentROM).toBe(1);
    expect(mem.pagingLocked).toBe(false);
  });

  it('restores paging locked flag', () => {
    const cpu = makeCpu();
    const banks: { pageId: number; data: Uint8Array }[] = [];
    for (let bank = 0; bank < 8; bank++) {
      banks.push({ pageId: bank + 3, data: new Uint8Array(16384) });
    }
    const file = buildV3_128K(cpu, banks, 0x25, 0);
    const mem = makeMemory128k();
    loadZ80(file, new Z80(), mem);
    expect(mem.pagingLocked).toBe(true);
  });
});

// ── Hardware mode detection ────────────────────────────────────────────────

describe('Z80 format — hardware mode detection', () => {
  it('v3 mode 0 = 48K', () => {
    const cpu = makeCpu();
    const file = buildV3_48K(cpu, [
      { pageId: 8, data: new Uint8Array(16384) },
      { pageId: 4, data: new Uint8Array(16384) },
      { pageId: 5, data: new Uint8Array(16384) },
    ], 0);
    const result = loadZ80(file, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });

  it('v3 mode 3 = 48K (MGT)', () => {
    const cpu = makeCpu();
    const file = buildV3_48K(cpu, [
      { pageId: 8, data: new Uint8Array(16384) },
      { pageId: 4, data: new Uint8Array(16384) },
      { pageId: 5, data: new Uint8Array(16384) },
    ], 0);
    file[34] = 3;
    const result = loadZ80(file, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });

  it('v3 mode 4 = 128K', () => {
    const cpu = makeCpu();
    const banks: { pageId: number; data: Uint8Array }[] = [];
    for (let bank = 0; bank < 8; bank++) {
      banks.push({ pageId: bank + 3, data: new Uint8Array(16384) });
    }
    const file = buildV3_128K(cpu, banks, 0, 0);
    file[34] = 4;
    const mem = makeMemory128k();
    const result = loadZ80(file, new Z80(), mem);
    expect(result.is128K).toBe(true);
  });

  it('v3 mode 7 = +3 (128K-class)', () => {
    const cpu = makeCpu();
    const banks: { pageId: number; data: Uint8Array }[] = [];
    for (let bank = 0; bank < 8; bank++) {
      banks.push({ pageId: bank + 3, data: new Uint8Array(16384) });
    }
    const file = buildV3_128K(cpu, banks, 0, 0);
    file[34] = 7;
    const mem = makeMemory128k();
    const result = loadZ80(file, new Z80(), mem);
    expect(result.is128K).toBe(true);
  });

  it('v2 mode 3 = 128K', () => {
    const cpu = makeCpu();
    const file = buildV3_128K(cpu, [], 0, 0);
    w16(file, 30, 23);
    file[34] = 3;
    const result = loadZ80(file, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });

  it('v2 mode 1 = 48K', () => {
    const cpu = makeCpu();
    const file = buildV3_48K(cpu, [
      { pageId: 8, data: new Uint8Array(16384) },
    ], 0);
    w16(file, 30, 23);
    file[34] = 1;
    const result = loadZ80(file, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });
});

// ── Compression — ED byte handling ─────────────────────────────────────────

describe('Z80 compression — ED byte handling', () => {
  it('round-trips a solitary 0xED followed by an RLE-run of 5 bytes', () => {
    const bank = new Uint8Array(16384);
    bank[0] = 0xED;
    for (let i = 1; i <= 5; i++) bank[i] = 0x00;
    const { bank: result } = roundTripBank(bank, 5, false);
    expect(result[0]).toBe(0xED);
    for (let i = 1; i <= 5; i++) expect(result[i]).toBe(0x00);
  });

  it('round-trips a solitary 0xED not followed by an RLE-run', () => {
    const bank = new Uint8Array(16384);
    bank[0] = 0xED;
    bank[1] = 0x42;
    const { bank: result } = roundTripBank(bank, 5, false);
    expect(result[0]).toBe(0xED);
    expect(result[1]).toBe(0x42);
  });

  it('round-trips consecutive 0xED 0xED pairs', () => {
    const bank = new Uint8Array(16384);
    bank[0] = 0xED;
    bank[1] = 0xED;
    bank[2] = 0xED;
    bank[3] = 0x55;
    const { bank: result } = roundTripBank(bank, 5, false);
    expect(result[0]).toBe(0xED);
    expect(result[1]).toBe(0xED);
    expect(result[2]).toBe(0xED);
    expect(result[3]).toBe(0x55);
  });

  it('round-trips a single trailing 0xED at end of bank', () => {
    const bank = new Uint8Array(16384);
    bank[16383] = 0xED;
    const { bank: result } = roundTripBank(bank, 5, false);
    expect(result[16383]).toBe(0xED);
  });

  it('round-trips 0xED at the boundary before a long run of identical bytes', () => {
    const bank = new Uint8Array(16384);
    bank[100] = 0xED;
    for (let i = 101; i < 200; i++) bank[i] = 0xAA;
    const { bank: result } = roundTripBank(bank, 0, true);
    expect(result[100]).toBe(0xED);
    for (let i = 101; i < 200; i++) expect(result[i]).toBe(0xAA);
  });

  it('round-trips many alternating ED and non-ED bytes', () => {
    const bank = new Uint8Array(16384);
    for (let i = 0; i < 100; i++) bank[i] = i % 2 === 0 ? 0xED : 0x42;
    const { bank: result } = roundTripBank(bank, 5, false);
    for (let i = 0; i < 100; i++) {
      expect(result[i]).toBe(i % 2 === 0 ? 0xED : 0x42);
    }
  });

  it('round-trips a bank filled entirely with 0xED', () => {
    const bank = new Uint8Array(16384).fill(0xED);
    const { bank: result } = roundTripBank(bank, 0, true);
    for (let i = 0; i < 16384; i++) {
      expect(result[i]).toBe(0xED);
    }
  });
});

// ── Compression — RLE runs ─────────────────────────────────────────────────

describe('Z80 compression — RLE runs', () => {
  it('round-trips a run of exactly 5 identical bytes (RLE threshold)', () => {
    const bank = new Uint8Array(16384);
    for (let i = 0; i < 5; i++) bank[i] = 0x77;
    bank[5] = 0x88;
    const { bank: result } = roundTripBank(bank, 5, false);
    for (let i = 0; i < 5; i++) expect(result[i]).toBe(0x77);
    expect(result[5]).toBe(0x88);
  });

  it('round-trips a run of 4 identical bytes (below RLE threshold, literal)', () => {
    const bank = new Uint8Array(16384);
    for (let i = 0; i < 4; i++) bank[i] = 0x77;
    bank[4] = 0x88;
    const { bank: result } = roundTripBank(bank, 5, false);
    for (let i = 0; i < 4; i++) expect(result[i]).toBe(0x77);
    expect(result[4]).toBe(0x88);
  });

  it('round-trips a run of 255 identical bytes (max RLE count)', () => {
    const bank = new Uint8Array(16384);
    for (let i = 0; i < 255; i++) bank[i] = 0xCC;
    bank[255] = 0xDD;
    const { bank: result } = roundTripBank(bank, 5, false);
    for (let i = 0; i < 255; i++) expect(result[i]).toBe(0xCC);
    expect(result[255]).toBe(0xDD);
  });

  it('round-trips a run of 300 identical bytes (splits across two RLE blocks)', () => {
    const bank = new Uint8Array(16384);
    for (let i = 0; i < 300; i++) bank[i] = 0xBB;
    bank[300] = 0xAA;
    const { bank: result } = roundTripBank(bank, 5, false);
    for (let i = 0; i < 300; i++) expect(result[i]).toBe(0xBB);
    expect(result[300]).toBe(0xAA);
  });

  it('round-trips a bank filled entirely with 0x00 (highly compressible)', () => {
    const bank = new Uint8Array(16384);
    const { bank: result } = roundTripBank(bank, 5, false);
    for (let i = 0; i < 16384; i++) expect(result[i]).toBe(0x00);
  });

  it('round-trips a bank of all 0xFF', () => {
    const bank = new Uint8Array(16384).fill(0xFF);
    const { bank: result } = roundTripBank(bank, 5, false);
    for (let i = 0; i < 16384; i++) expect(result[i]).toBe(0xFF);
  });

  it('round-trips multiple RLE blocks with different values', () => {
    const bank = new Uint8Array(16384);
    for (let i = 0; i < 10; i++) bank[i] = 0x11;
    for (let i = 10; i < 20; i++) bank[i] = 0x22;
    for (let i = 20; i < 30; i++) bank[i] = 0x33;
    bank[30] = 0x44;
    const { bank: result } = roundTripBank(bank, 5, false);
    for (let i = 0; i < 10; i++) expect(result[i]).toBe(0x11);
    for (let i = 10; i < 20; i++) expect(result[i]).toBe(0x22);
    for (let i = 20; i < 30; i++) expect(result[i]).toBe(0x33);
    expect(result[30]).toBe(0x44);
  });
});

// ── Compression — uncompressed fallback ────────────────────────────────────

describe('Z80 compression — uncompressed fallback', () => {
  it('stores block as uncompressed when compression expands the data', () => {
    const bank = new Uint8Array(16384);
    for (let i = 0; i < 16384; i++) bank[i] = (i * 7 + 13) & 0xFF;

    const cpu = new Z80();
    const mem = makeMemory48k();
    mem.getRamBank(5).set(bank);
    const saved = saveZ80(cpu, mem, 0, false);

    const cpu2 = new Z80();
    const mem2 = makeMemory48k();
    loadZ80(saved, cpu2, mem2);

    const result = mem2.getRamBank(5);
    for (let i = 0; i < 16384; i++) {
      expect(result[i]).toBe(bank[i]);
    }
  });

  it('marks uncompressed blocks with 0xFFFF length', () => {
    const bank = new Uint8Array(16384);
    for (let i = 0; i < 16384; i++) bank[i] = i & 0xFF;

    const cpu = new Z80();
    const mem = makeMemory48k();
    mem.getRamBank(5).set(bank);
    const saved = saveZ80(cpu, mem, 0, false);

    const extHeaderLen = r16(saved, 30);
    const dataStart = 32 + extHeaderLen;
    const blockLen = r16(saved, dataStart);
    expect(blockLen).toBe(0xFFFF);
  });
});

// ── Save/load full round-trip — 48K ───────────────────────────────────────

describe('Z80 format — 48K full round-trip', () => {
  it('preserves memory contents across save/load', () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const bank5 = mem.getRamBank(5);
    const bank2 = mem.getRamBank(2);
    const bank0 = mem.getRamBank(0);
    for (let i = 0; i < 16384; i++) {
      bank5[i] = i & 0xFF;
      bank2[i] = (i >> 1) & 0xFF;
      bank0[i] = (i >> 2) & 0xFF;
    }

    const saved = saveZ80(cpu, mem, 1, false);
    const cpu2 = new Z80();
    const mem2 = makeMemory48k();
    loadZ80(saved, cpu2, mem2);

    const bank5b = mem2.getRamBank(5);
    const bank2b = mem2.getRamBank(2);
    const bank0b = mem2.getRamBank(0);
    for (let i = 0; i < 16384; i++) {
      expect(bank5b[i]).toBe(i & 0xFF);
      expect(bank2b[i]).toBe((i >> 1) & 0xFF);
      expect(bank0b[i]).toBe((i >> 2) & 0xFF);
    }
  });

  it('writes three pages (8, 4, 5) in correct order', () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    mem.getRamBank(5).fill(0x11);
    mem.getRamBank(2).fill(0x22);
    mem.getRamBank(0).fill(0x33);

    const saved = saveZ80(cpu, mem, 0, false);
    const extHeaderLen = r16(saved, 30);
    const dataStart = 32 + extHeaderLen;

    expect(saved[dataStart + 2]).toBe(8);
    const len1 = r16(saved, dataStart);
    const offset2 = dataStart + 3 + (len1 === 0xFFFF ? 16384 : len1);
    expect(saved[offset2 + 2]).toBe(4);
    const len2 = r16(saved, offset2);
    const offset3 = offset2 + 3 + (len2 === 0xFFFF ? 16384 : len2);
    expect(saved[offset3 + 2]).toBe(5);
  });
});

// ── Save/load full round-trip — 128K ──────────────────────────────────────

describe('Z80 format — 128K full round-trip', () => {
  it('preserves all 8 RAM banks across save/load', () => {
    const cpu = new Z80();
    const mem = makeMemory128k();
    for (let bank = 0; bank < 8; bank++) {
      const data = mem.getRamBank(bank);
      for (let i = 0; i < 16384; i++) {
        data[i] = ((bank * 16384 + i) * 3 + 7) & 0xFF;
      }
    }

    const saved = saveZ80(cpu, mem, 4, true);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    const result = loadZ80(saved, cpu2, mem2);

    expect(result.is128K).toBe(true);
    for (let bank = 0; bank < 8; bank++) {
      const data = mem2.getRamBank(bank);
      for (let i = 0; i < 16384; i++) {
        expect(data[i]).toBe(((bank * 16384 + i) * 3 + 7) & 0xFF);
      }
    }
  });

  it('writes 8 pages (3-10) for 128K', () => {
    const cpu = new Z80();
    const mem = makeMemory128k();
    const saved = saveZ80(cpu, mem, 0, true);

    const extHeaderLen = r16(saved, 30);
    let offset = 32 + extHeaderLen;
    const pageIds: number[] = [];
    for (let i = 0; i < 8; i++) {
      pageIds.push(saved[offset + 2]);
      const len = r16(saved, offset);
      offset += 3 + (len === 0xFFFF ? 16384 : len);
    }
    expect(pageIds).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('preserves port7FFD across round-trip', () => {
    const cpu = new Z80();
    const mem = makeMemory128k();
    mem.port7FFD = 0x0B;
    mem.applyBanking();

    const saved = saveZ80(cpu, mem, 0, true);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    const result = loadZ80(saved, cpu2, mem2);

    expect(result.port7FFD).toBe(0x0B);
    expect(mem2.port7FFD).toBe(0x0B);
  });
});

// ── Decompression of manually constructed blocks ───────────────────────────

describe('Z80 format — decompression edge cases via v3 load', () => {
  it('decompresses a single RLE block', () => {
    const cpu = makeCpu();
    const compressed = buildCompressedBlock([{ count: 10, value: 0xAB }]);
    const bh = new Uint8Array(3);
    w16(bh, 0, compressed.length);
    bh[2] = 8;
    const file = buildV3_48K(cpu, [{ pageId: 8, data: new Uint8Array(16384) }], 0);

    const extHeaderLen = r16(file, 30);
    const totalLen = 30 + 2 + extHeaderLen + 3 + compressed.length;
    const result = new Uint8Array(totalLen);
    result.set(file.subarray(0, 32 + extHeaderLen));
    result.set(bh, 32 + extHeaderLen);
    result.set(compressed, 32 + extHeaderLen + 3);

    const mem = makeMemory48k();
    loadZ80(result, new Z80(), mem);
    for (let i = 0; i < 10; i++) expect(mem.readByte(0x4000 + i)).toBe(0xAB);
  });

  it('handles ED followed by non-ED as two literals in compressed data', () => {
    const cpu = makeCpu();
    const compressed = new Uint8Array([0xED, 0x42]);
    const bh = new Uint8Array(3);
    w16(bh, 0, compressed.length);
    bh[2] = 8;
    const file = buildV3_48K(cpu, [{ pageId: 8, data: new Uint8Array(16384) }], 0);

    const extHeaderLen = r16(file, 30);
    const totalLen = 30 + 2 + extHeaderLen + 3 + compressed.length;
    const result = new Uint8Array(totalLen);
    result.set(file.subarray(0, 32 + extHeaderLen));
    result.set(bh, 32 + extHeaderLen);
    result.set(compressed, 32 + extHeaderLen + 3);

    const mem = makeMemory48k();
    loadZ80(result, new Z80(), mem);
    expect(mem.readByte(0x4000)).toBe(0xED);
    expect(mem.readByte(0x4001)).toBe(0x42);
  });

  it('handles a truncated ED-ED run by zero-filling the rest of the page', () => {
    // Decoder contract for malformed compression: emit what we can decode,
    // leave the rest of the destination bank zero. The loader must not throw,
    // and must not leak stale bytes from elsewhere in memory into the bank.
    const cpu = makeCpu();
    const compressed = new Uint8Array([0xED, 0xED]); // dangling RLE marker
    const bh = new Uint8Array(3);
    w16(bh, 0, compressed.length);
    bh[2] = 8; // pageId 8 = bank 5 at 0x4000
    const file = buildV3_48K(cpu, [{ pageId: 8, data: new Uint8Array(16384) }], 0);

    const extHeaderLen = r16(file, 30);
    const totalLen = 30 + 2 + extHeaderLen + 3 + compressed.length;
    const result = new Uint8Array(totalLen);
    result.set(file.subarray(0, 32 + extHeaderLen));
    result.set(bh, 32 + extHeaderLen);
    result.set(compressed, 32 + extHeaderLen + 3);

    const mem = makeMemory48k();
    // Pre-poison the destination bank so the test would fail if the loader
    // silently skipped the page rather than overwriting it with zeros.
    mem.getRamBank(5).fill(0xA5);

    loadZ80(result, new Z80(), mem);

    // Truncated ED ED with no count/value: decoder emits nothing for the run
    // and the destination is the fresh-allocated zero buffer that replaced
    // the poisoned bytes.
    expect(mem.readByte(0x4000)).toBe(0);
    expect(mem.readByte(0x4001)).toBe(0);
    expect(mem.readByte(0x7FFF)).toBe(0);
  });

  it('treats ED ED 00 as zero-length run (no sentinel in v2/v3 blocks)', () => {
    // Per WoS spec: paged blocks have no end-marker. A count==0 run is not
    // a terminator — the decoder must produce zero bytes and continue.
    const cpu = makeCpu();
    // ED ED 00 XX (zero-count, value irrelevant) followed by literal 0x42.
    // After the zero-count run the decoder must keep going and emit 0x42.
    const compressed = new Uint8Array([0xED, 0xED, 0x00, 0xAA, 0x42]);
    const bh = new Uint8Array(3);
    w16(bh, 0, compressed.length);
    bh[2] = 8;
    const file = buildV3_48K(cpu, [{ pageId: 8, data: new Uint8Array(16384) }], 0);

    const extHeaderLen = r16(file, 30);
    const totalLen = 30 + 2 + extHeaderLen + 3 + compressed.length;
    const result = new Uint8Array(totalLen);
    result.set(file.subarray(0, 32 + extHeaderLen));
    result.set(bh, 32 + extHeaderLen);
    result.set(compressed, 32 + extHeaderLen + 3);

    // Pre-fill bank 5 so we can detect whether the decoder wrote into it.
    const mem = makeMemory48k();
    mem.getRamBank(5).fill(0xCC);
    loadZ80(result, new Z80(), mem);
    // First byte is the trailing 0x42 (zero-count run emitted nothing).
    expect(mem.readByte(0x4000)).toBe(0x42);
    // The rest of the bank was overwritten by the decoder's zero-init.
    expect(mem.readByte(0x4001)).toBe(0x00);
  });

  it('handles a literal 0xED at the end of compressed stream', () => {
    const cpu = makeCpu();
    const compressed = new Uint8Array([0x42, 0xED]);
    const bh = new Uint8Array(3);
    w16(bh, 0, compressed.length);
    bh[2] = 8;
    const file = buildV3_48K(cpu, [{ pageId: 8, data: new Uint8Array(16384) }], 0);

    const extHeaderLen = r16(file, 30);
    const totalLen = 30 + 2 + extHeaderLen + 3 + compressed.length;
    const result = new Uint8Array(totalLen);
    result.set(file.subarray(0, 32 + extHeaderLen));
    result.set(bh, 32 + extHeaderLen);
    result.set(compressed, 32 + extHeaderLen + 3);

    const mem = makeMemory48k();
    loadZ80(result, new Z80(), mem);
    expect(mem.readByte(0x4000)).toBe(0x42);
    expect(mem.readByte(0x4001)).toBe(0xED);
  });
});

// ── V2 paged-block loading (real data) ─────────────────────────────────────

describe('Z80 format — v2 paged-block loading', () => {
  it('loads 48K paged blocks via v2 (extLen=23) into the right slots', () => {
    const cpu = makeCpu();
    cpu.pc = 0x9000;
    const page8 = new Uint8Array(16384).fill(0xA8); // → bank 5 / $4000
    const page4 = new Uint8Array(16384).fill(0xB4); // → bank 2 / $8000
    const page5 = new Uint8Array(16384).fill(0xC5); // → bank 0 / $C000

    const file = buildV2(cpu, [
      { pageId: 8, data: page8 },
      { pageId: 4, data: page4 },
      { pageId: 5, data: page5 },
    ], /* hwMode 0 = 48K */ 0, 0, 0);

    const cpu2 = new Z80();
    const mem = makeMemory48k();
    const result = loadZ80(file, cpu2, mem);

    expect(result.is128K).toBe(false);
    expect(cpu2.pc).toBe(0x9000);
    expect(mem.readByte(0x4000)).toBe(0xA8);
    expect(mem.readByte(0x8000)).toBe(0xB4);
    expect(mem.readByte(0xC000)).toBe(0xC5);
  });

  it('loads 128K paged blocks via v2 (extLen=23) for all 8 RAM banks', () => {
    const cpu = makeCpu();
    cpu.pc = 0xC123;
    const banks: { pageId: number; data: Uint8Array }[] = [];
    for (let bank = 0; bank < 8; bank++) {
      const data = new Uint8Array(16384);
      data[0] = 0x80 | bank;
      data[16383] = 0xF0 | bank;
      banks.push({ pageId: bank + 3, data });
    }
    const file = buildV2(cpu, banks, /* v2 hwMode 3 = 128K */ 3, 0x06, 0);

    const cpu2 = new Z80();
    const mem = makeMemory128k();
    const result = loadZ80(file, cpu2, mem);

    expect(result.is128K).toBe(true);
    expect(result.port7FFD).toBe(0x06);
    expect(cpu2.pc).toBe(0xC123);
    for (let bank = 0; bank < 8; bank++) {
      expect(mem.getRamBank(bank)[0]).toBe(0x80 | bank);
      expect(mem.getRamBank(bank)[16383]).toBe(0xF0 | bank);
    }
  });

  it('decompresses compressed blocks in v2 paged format', () => {
    const cpu = makeCpu();
    cpu.pc = 0x4000;
    // RLE block for page 8: a run of 50 0x77 bytes, rest zero (decompressed).
    const compressed = buildCompressedBlock([{ count: 50, value: 0x77 }]);
    const bh = new Uint8Array(3);
    w16(bh, 0, compressed.length);
    bh[2] = 8;

    // Build a v2 file with a single placeholder block, then splice in our
    // compressed block in its place.
    const placeholder = new Uint8Array(16384);
    const file = buildV2(cpu, [{ pageId: 8, data: placeholder }], 0, 0, 0);
    const extLen = r16(file, 30);
    const dataStart = 32 + extLen;
    const result = new Uint8Array(dataStart + 3 + compressed.length);
    result.set(file.subarray(0, dataStart));
    result.set(bh, dataStart);
    result.set(compressed, dataStart + 3);

    const mem = makeMemory48k();
    loadZ80(result, new Z80(), mem);
    for (let i = 0; i < 50; i++) expect(mem.readByte(0x4000 + i)).toBe(0x77);
    expect(mem.readByte(0x4032)).toBe(0x00);
  });
});

// ── V3 hardware modes — extended coverage ──────────────────────────────────

describe('Z80 format — extended v3 hardware modes', () => {
  it.each([
    [9,  '128K (Pentagon)'],
    [12, '+2'],
    [13, '+2A'],
  ])('v3 mode %i (%s) is treated as 128K-class', (mode) => {
    const cpu = makeCpu();
    const banks: { pageId: number; data: Uint8Array }[] = [];
    for (let bank = 0; bank < 8; bank++) {
      banks.push({ pageId: bank + 3, data: new Uint8Array(16384) });
    }
    const file = buildV3_128K(cpu, banks, 0, 0);
    file[34] = mode;
    const result = loadZ80(file, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });
});

// ── V3 extended header length 55 ───────────────────────────────────────────

describe('Z80 format — v3 extHeaderLen=55 variant', () => {
  it('loads correctly when the extended header is 55 bytes', () => {
    const cpu = makeCpu();
    cpu.pc = 0xABCD;
    const banks: { pageId: number; data: Uint8Array }[] = [];
    for (let bank = 0; bank < 8; bank++) {
      const data = new Uint8Array(16384);
      data[0] = bank + 0xA0;
      banks.push({ pageId: bank + 3, data });
    }
    const file = buildV3_128K(cpu, banks, 0x07, 0);

    // Convert from extHeaderLen=54 to 55 by inserting one extra byte for
    // the "last OUT to port 0x1FFD" field. We rebuild the file rather than
    // mutating offsets piecewise.
    const oldExt = 54;
    const newExt = 55;
    const blocksStart = 32 + oldExt;
    const expanded = new Uint8Array(file.length + 1);
    expanded.set(file.subarray(0, 30), 0);
    w16(expanded, 30, newExt);
    expanded.set(file.subarray(32, 32 + oldExt), 32);
    expanded[32 + oldExt] = 0x00; // port 0x1FFD value
    expanded.set(file.subarray(blocksStart), 32 + newExt);

    const cpu2 = new Z80();
    const mem = makeMemory128k();
    const result = loadZ80(expanded, cpu2, mem);

    expect(result.is128K).toBe(true);
    expect(cpu2.pc).toBe(0xABCD);
    for (let bank = 0; bank < 8; bank++) {
      expect(mem.getRamBank(bank)[0]).toBe(bank + 0xA0);
    }
  });
});

// ── Canonical single-ED encoding (byte-level inspection) ───────────────────

describe('Z80 compression — canonical encoding shape', () => {
  /** Locate the page-8 (48K) compressed block in a saved file and return its bytes. */
  function extractPage8Block(saved: Uint8Array): Uint8Array {
    const extLen = r16(saved, 30);
    let off = 32 + extLen;
    while (off + 3 <= saved.length) {
      const len = r16(saved, off);
      const pageId = saved[off + 2];
      const payloadLen = (len === 0xFFFF) ? 16384 : len;
      if (pageId === 8) return saved.subarray(off + 3, off + 3 + payloadLen);
      off += 3 + payloadLen;
    }
    throw new Error('page 8 block not found');
  }

  it('encodes a lone ED as a literal pair (ED, next-byte) — not as a run of count 1', () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const bank5 = mem.getRamBank(5);
    bank5.fill(0); // mostly zeros so the run-of-zeros section is compact
    bank5[0] = 0xED;
    bank5[1] = 0x42;

    const saved = saveZ80(cpu, mem, 0, false);
    const block = extractPage8Block(saved);

    // Canonical: ED 42 ... (literal ED, forced literal of next byte).
    // Forbidden by spec: ED ED 01 ED ... (a 1-count run of EDs).
    expect(block[0]).toBe(0xED);
    expect(block[1]).toBe(0x42);
    expect(block[2]).not.toBe(0x01);
  });

  it('encodes ED followed by a run of zeros per the spec example (ED 00 ED ED 05 00)', () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const bank5 = mem.getRamBank(5);
    // Bank starts with ED then 6 zeros then a sentinel byte; the rest is
    // a uniform run far away. Per spec: ED 6×00 → ED 00 (forced literal),
    // then 5 zeros form an RLE block: ED ED 05 00.
    bank5[0] = 0xED;
    // bank5[1..6] = 0 (already zero-initialised by SpectrumMemory)
    bank5[7] = 0x33;
    bank5.fill(0x99, 8, 16384);

    const saved = saveZ80(cpu, mem, 0, false);
    const block = extractPage8Block(saved);

    expect(block[0]).toBe(0xED);
    expect(block[1]).toBe(0x00);
    expect(block[2]).toBe(0xED);
    expect(block[3]).toBe(0xED);
    expect(block[4]).toBe(0x05);
    expect(block[5]).toBe(0x00);
    expect(block[6]).toBe(0x33);
  });

  it('encodes two consecutive EDs as ED ED 02 ED', () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const bank5 = mem.getRamBank(5);
    bank5.fill(0);
    bank5[0] = 0xED;
    bank5[1] = 0xED;
    bank5[2] = 0x33;

    const saved = saveZ80(cpu, mem, 0, false);
    const block = extractPage8Block(saved);

    expect(block[0]).toBe(0xED);
    expect(block[1]).toBe(0xED);
    expect(block[2]).toBe(0x02);
    expect(block[3]).toBe(0xED);
    expect(block[4]).toBe(0x33);
  });
});

// ── 128K save round-trip — extra coverage ──────────────────────────────────

describe('Z80 format — 128K round-trip extras', () => {
  it('preserves pagingLocked (port7FFD bit 5) and currentROM across save/load', () => {
    const cpu = new Z80();
    const mem = makeMemory128k();
    // 0x35 = 0011_0101: bank 5, ROM 1 (bit 4), paging locked (bit 5).
    mem.port7FFD = 0x35;
    mem.applyBanking();

    const saved = saveZ80(cpu, mem, 0, true);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    const result = loadZ80(saved, cpu2, mem2);

    expect(result.port7FFD).toBe(0x35);
    expect(mem2.pagingLocked).toBe(true);
    expect(mem2.currentROM).toBe(1);
    expect(mem2.currentBank).toBe(5);
  });

  it('preserves every CPU register including the full alternate set in 128K mode', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    const saved = saveZ80(cpu, mem, 3, true);

    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    loadZ80(saved, cpu2, mem2);

    // Main set
    expect(cpu2.a).toBe(cpu.a);   expect(cpu2.f).toBe(cpu.f);
    expect(cpu2.b).toBe(cpu.b);   expect(cpu2.c).toBe(cpu.c);
    expect(cpu2.d).toBe(cpu.d);   expect(cpu2.e).toBe(cpu.e);
    expect(cpu2.h).toBe(cpu.h);   expect(cpu2.l).toBe(cpu.l);
    // Alternate set
    expect(cpu2.a_).toBe(cpu.a_); expect(cpu2.f_).toBe(cpu.f_);
    expect(cpu2.b_).toBe(cpu.b_); expect(cpu2.c_).toBe(cpu.c_);
    expect(cpu2.d_).toBe(cpu.d_); expect(cpu2.e_).toBe(cpu.e_);
    expect(cpu2.h_).toBe(cpu.h_); expect(cpu2.l_).toBe(cpu.l_);
    // Index, stack, control
    expect(cpu2.ix).toBe(cpu.ix); expect(cpu2.iy).toBe(cpu.iy);
    expect(cpu2.sp).toBe(cpu.sp); expect(cpu2.pc).toBe(cpu.pc);
    expect(cpu2.i).toBe(cpu.i);   expect(cpu2.r).toBe(cpu.r);
    expect(cpu2.iff1).toBe(cpu.iff1);
    expect(cpu2.iff2).toBe(cpu.iff2);
    expect(cpu2.im).toBe(cpu.im);
  });
});

// ── V1 decompression edge cases (decompressV1 branches) ────────────────────

/**
 * Build a v1 .z80 header with the "compressed" flag set, then concatenate
 * an arbitrary compressed payload. Used to feed targeted byte sequences to
 * the decompressV1 routine.
 */
function buildV1Raw(cpu: Z80, stream: Uint8Array, borderColor = 0): Uint8Array {
  const header = buildV1(cpu, new Uint8Array(0), true, borderColor).subarray(0, 30);
  const data = new Uint8Array(30 + stream.length);
  data.set(header, 0);
  data.set(stream, 30);
  return data;
}

describe('Z80 v1 decompression — edge cases', () => {
  it('treats ED followed by a non-ED byte as two literals', () => {
    const cpu = makeCpu();
    const stream = new Uint8Array([
      0xED, 0x42,                // literal pair
      0x00, 0xED, 0xED, 0x00,    // v1 sentinel
    ]);
    const cpu2 = new Z80();
    const mem = makeMemory48k();
    loadZ80(buildV1Raw(cpu, stream), cpu2, mem);
    expect(mem.readByte(0x4000)).toBe(0xED);
    expect(mem.readByte(0x4001)).toBe(0x42);
  });

  it('emits a trailing lone 0xED as a literal when the stream ends after it', () => {
    const cpu = makeCpu();
    // No sentinel — the lone-ED-at-EOF branch must fire and emit ED.
    const stream = new Uint8Array([0x11, 0xED]);
    const cpu2 = new Z80();
    const mem = makeMemory48k();
    loadZ80(buildV1Raw(cpu, stream), cpu2, mem);
    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x4001)).toBe(0xED);
  });

  it('writes the ED literal but suppresses its partner when op hits 49152', () => {
    // Fill RAM with 49151 0x77s (so the next write lands at op=49151), then
    // an ED-non-ED literal pair: the ED fills the final RAM byte, the 0x42
    // must be discarded by the `if (op < 49152)` guard rather than overrun.
    const cpu = makeCpu();
    const parts: number[] = [];
    let remaining = 49151;
    while (remaining >= 255) {
      parts.push(0xED, 0xED, 0xFF, 0x77);
      remaining -= 255;
    }
    if (remaining > 0) {
      parts.push(0xED, 0xED, remaining, 0x77);
    }
    parts.push(0xED, 0x42);                        // boundary pair
    parts.push(0x00, 0xED, 0xED, 0x00);            // sentinel (ignored — RAM is full)

    const mem = makeMemory48k();
    loadZ80(buildV1Raw(cpu, new Uint8Array(parts)), new Z80(), mem);
    expect(mem.readByte(0xFFFE)).toBe(0x77);       // last filler byte
    expect(mem.readByte(0xFFFF)).toBe(0xED);       // ED took the final slot
  });
});

// ── V3 decompression edge cases (decompressBlock + paged-block loop) ───────

describe('Z80 v3 decompression — edge cases', () => {
  it('writes the ED literal but suppresses its partner when op hits 16384', () => {
    // Same boundary-overflow shape as the v1 test, but for a single 16K
    // RAMP block decoded by decompressBlock.
    const cpu = makeCpu();
    const parts: number[] = [];
    let remaining = 16383;
    while (remaining >= 255) {
      parts.push(0xED, 0xED, 0xFF, 0x33);
      remaining -= 255;
    }
    if (remaining > 0) {
      parts.push(0xED, 0xED, remaining, 0x33);
    }
    parts.push(0xED, 0x42);                        // boundary pair
    const compressed = new Uint8Array(parts);

    const bh = new Uint8Array(3);
    w16(bh, 0, compressed.length);
    bh[2] = 8;                                     // page 8 → bank 5 / $4000

    // Splice the crafted block into a placeholder v3 file.
    const placeholder = buildV3_48K(cpu, [{ pageId: 8, data: new Uint8Array(16384) }], 0);
    const extLen = r16(placeholder, 30);
    const dataStart = 32 + extLen;
    const result = new Uint8Array(dataStart + 3 + compressed.length);
    result.set(placeholder.subarray(0, dataStart));
    result.set(bh, dataStart);
    result.set(compressed, dataStart + 3);

    const mem = makeMemory48k();
    loadZ80(result, new Z80(), mem);
    expect(mem.readByte(0x7FFE)).toBe(0x33);
    expect(mem.readByte(0x7FFF)).toBe(0xED);
  });

  it('breaks out of the 128K paged-block loop when a final block is truncated', () => {
    // Build a 128K v3 file by hand: one valid block (page 3 → bank 0) then
    // a trailing 3-byte header that claims an uncompressed 16 KiB payload
    // but provides zero payload bytes. The `offset + 16384 > data.length`
    // guard must abort the loop without throwing or over-reading.
    const cpu = makeCpu();
    cpu.pc = 0x9000;

    const header = new Uint8Array(30);
    header[6] = 0; header[7] = 0;                  // PC=0 → v2/v3
    header[29] = 1;
    const extHeader = new Uint8Array(2 + 54);
    w16(extHeader, 0, 54);
    w16(extHeader, 2, cpu.pc);
    extHeader[4] = 4;                              // hwMode 4 = 128K

    const block1Header = new Uint8Array(3);
    w16(block1Header, 0, 0xFFFF);
    block1Header[2] = 3;                           // page 3 → bank 0
    const block1Data = new Uint8Array(16384);
    block1Data[0] = 0x77;

    const block2Header = new Uint8Array(3);
    w16(block2Header, 0, 0xFFFF);                  // claims 16K, no payload
    block2Header[2] = 4;

    const total = 30 + extHeader.length + 3 + 16384 + 3;
    const data = new Uint8Array(total);
    let p = 0;
    data.set(header, p);       p += 30;
    data.set(extHeader, p);    p += extHeader.length;
    data.set(block1Header, p); p += 3;
    data.set(block1Data, p);   p += 16384;
    data.set(block2Header, p);

    const mem = makeMemory128k();
    loadZ80(data, new Z80(), mem);
    expect(mem.getRamBank(0)[0]).toBe(0x77);       // block 1 loaded
    expect(mem.getRamBank(1)[0]).toBe(0);          // truncated block 2 skipped
  });
});
