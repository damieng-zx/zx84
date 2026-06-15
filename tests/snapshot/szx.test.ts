import { describe, it, expect } from 'vitest';
import { saveSZX, saveSZXSync, loadSZX, applySZXPaging } from '@/snapshot/szx.ts';
import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/memory.ts';
import type { SpectrumModel } from '@/spectrum.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function w16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xFF;
  data[offset + 1] = (value >> 8) & 0xFF;
}

function w32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xFF;
  data[offset + 1] = (value >> 8) & 0xFF;
  data[offset + 2] = (value >> 16) & 0xFF;
  data[offset + 3] = (value >> 24) & 0xFF;
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
  cpu.tStates = 1000;
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

function makeMemoryPlus3(): SpectrumMemory {
  const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
  mem.loadROM(new Uint8Array(65536)); // +3 has 4 × 16KB ROM pages
  return mem;
}

function writeStr(data: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < 4; i++) {
    data[offset + i] = i < s.length ? s.charCodeAt(i) : 0;
  }
}

function writeBlockHeader(data: Uint8Array, offset: number, id: string, size: number): number {
  writeStr(data, offset, id);
  w32(data, offset + 4, size);
  return offset + 8;
}

function buildSZX(
  machineId: number,
  blocks: { id: string; payload: Uint8Array }[]
): Uint8Array {
  let totalSize = 8;
  for (const b of blocks) totalSize += 8 + b.payload.length;

  const data = new Uint8Array(totalSize);
  let offset = 0;
  data[offset++] = 0x5A;
  data[offset++] = 0x58;
  data[offset++] = 0x53;
  data[offset++] = 0x54;
  data[offset++] = 1;
  data[offset++] = 4;
  data[offset++] = machineId;
  data[offset++] = 0;

  for (const { id, payload } of blocks) {
    offset = writeBlockHeader(data, offset, id, payload.length);
    data.set(payload, offset);
    offset += payload.length;
  }

  return data;
}

function buildZ80R(cpu: Z80): Uint8Array {
  const p = new Uint8Array(37);
  w16(p, 0, (cpu.a << 8) | cpu.f);
  w16(p, 2, (cpu.b << 8) | cpu.c);
  w16(p, 4, (cpu.d << 8) | cpu.e);
  w16(p, 6, (cpu.h << 8) | cpu.l);
  w16(p, 8, (cpu.a_ << 8) | cpu.f_);
  w16(p, 10, (cpu.b_ << 8) | cpu.c_);
  w16(p, 12, (cpu.d_ << 8) | cpu.e_);
  w16(p, 14, (cpu.h_ << 8) | cpu.l_);
  w16(p, 16, cpu.ix);
  w16(p, 18, cpu.iy);
  w16(p, 20, cpu.sp);
  w16(p, 22, cpu.pc);
  p[24] = cpu.i;
  p[25] = cpu.r;
  p[26] = cpu.iff1 ? 1 : 0;
  p[27] = cpu.iff2 ? 1 : 0;
  p[28] = cpu.im;
  w32(p, 29, cpu.tStates);
  p[33] = 0;
  p[34] = cpu.halted ? 0x02 : 0;
  w16(p, 35, 0);
  return p;
}

function buildSPCR(borderColor: number, port7FFD: number, port1FFD: number): Uint8Array {
  const p = new Uint8Array(8);
  p[0] = borderColor & 0x07;
  p[1] = port7FFD;
  p[2] = port1FFD;
  p[3] = borderColor & 0x07;
  w32(p, 4, 0);
  return p;
}

function buildRAMP(pageNo: number, pageData: Uint8Array, compressed: boolean): Uint8Array {
  const p = new Uint8Array(3 + pageData.length);
  w16(p, 0, compressed ? 1 : 0);
  p[2] = pageNo;
  p.set(pageData, 3);
  return p;
}

function buildAY(currentReg: number, regs: Uint8Array): Uint8Array {
  const p = new Uint8Array(18);
  p[0] = 0;
  p[1] = currentReg;
  p.set(regs.subarray(0, 16), 2);
  return p;
}

async function compress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  writer.write(data as unknown as BufferSource);
  writer.close();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const chunk of chunks) {
    result.set(chunk, off);
    off += chunk.byteLength;
  }
  return result;
}

// ── Loading errors ─────────────────────────────────────────────────────────

describe('SZX — loading errors', () => {
  it('rejects files smaller than 8 bytes', async () => {
    await expect(loadSZX(new Uint8Array(7), new Z80(), makeMemory48k()))
      .rejects.toThrow('SZX file too small');
  });

  it('rejects bad magic', async () => {
    const data = new Uint8Array(8);
    data.set([0x5A, 0x58, 0x53, 0x54, 0, 0, 0, 0]);
    data[0] = 0x00;
    await expect(loadSZX(data, new Z80(), makeMemory48k()))
      .rejects.toThrow('Not a valid SZX file');
  });

  it('rejects completely wrong magic', async () => {
    const data = new Uint8Array(8);
    data.set([0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 0, 0]);
    await expect(loadSZX(data, new Z80(), makeMemory48k()))
      .rejects.toThrow('Not a valid SZX file');
  });

  it('accepts valid ZXST magic', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });
});

// ── Machine ID detection ───────────────────────────────────────────────────

describe('SZX — machine ID detection', () => {
  it('machineId 0 (16K) → is128K=false', async () => {
    const data = buildSZX(0, []);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });

  it('machineId 1 (48K) → is128K=false', async () => {
    const data = buildSZX(1, []);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });

  it('machineId 2 (128K) → is128K=true', async () => {
    const data = buildSZX(2, []);
    const result = await loadSZX(data, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });

  it('machineId 3 (+2) → is128K=true', async () => {
    const data = buildSZX(3, []);
    const result = await loadSZX(data, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });

  it('machineId 4 (+2A) → is128K=true', async () => {
    const data = buildSZX(4, []);
    const result = await loadSZX(data, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });

  it('machineId 5 (+3) → is128K=true', async () => {
    const data = buildSZX(5, []);
    const result = await loadSZX(data, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });

  it('machineId 6 (+3e) → is128K=true', async () => {
    const data = buildSZX(6, []);
    const result = await loadSZX(data, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });
});

// ── Z80R block parsing ─────────────────────────────────────────────────────

describe('SZX — Z80R register block', () => {
  it('restores all main registers', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());

    expect(cpu2.a).toBe(0x3E);
    expect(cpu2.f).toBe(0x44);
    expect(cpu2.b).toBe(0x10);
    expect(cpu2.c).toBe(0x20);
    expect(cpu2.d).toBe(0x30);
    expect(cpu2.e).toBe(0x40);
    expect(cpu2.h).toBe(0x50);
    expect(cpu2.l).toBe(0x60);
  });

  it('restores all shadow registers', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());

    expect(cpu2.a_).toBe(0xAA);
    expect(cpu2.f_).toBe(0x55);
    expect(cpu2.b_).toBe(0x11);
    expect(cpu2.c_).toBe(0x22);
    expect(cpu2.d_).toBe(0x33);
    expect(cpu2.e_).toBe(0x44);
    expect(cpu2.h_).toBe(0x55);
    expect(cpu2.l_).toBe(0x66);
  });

  it('restores IX, IY, SP, PC', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());

    expect(cpu2.ix).toBe(0x5678);
    expect(cpu2.iy).toBe(0x1234);
    expect(cpu2.sp).toBe(0xFFFE);
    expect(cpu2.pc).toBe(0x8000);
  });

  it('restores I, R registers', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());

    expect(cpu2.i).toBe(0x1F);
    expect(cpu2.r).toBe(0x81);
  });

  it('restores IFF1 and IFF2 independently', async () => {
    const cpu = makeCpu();
    cpu.iff1 = true;
    cpu.iff2 = false;
    const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());

    expect(cpu2.iff1).toBe(true);
    expect(cpu2.iff2).toBe(false);
  });

  it('restores IFF1=false, IFF2=true', async () => {
    const cpu = makeCpu();
    cpu.iff1 = false;
    cpu.iff2 = true;
    const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());

    expect(cpu2.iff1).toBe(false);
    expect(cpu2.iff2).toBe(true);
  });

  it('restores IM mode', async () => {
    for (const im of [0, 1, 2]) {
      const cpu = makeCpu();
      cpu.im = im;
      const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
      const cpu2 = new Z80();
      await loadSZX(data, cpu2, makeMemory48k());
      expect(cpu2.im).toBe(im);
    }
  });

  it('restores tStates from dwCyclesStart', async () => {
    const cpu = makeCpu();
    cpu.tStates = 12345;
    const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());
    expect(cpu2.tStates).toBe(12345);
  });

  it('sets halted=true when chFlags bit 1 is set', async () => {
    const cpu = makeCpu();
    const z80r = buildZ80R(cpu);
    z80r[34] = 0x02;
    const data = buildSZX(1, [{ id: 'Z80R', payload: z80r }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());
    expect(cpu2.halted).toBe(true);
  });

  it('sets halted=false when chFlags bit 1 is clear', async () => {
    const cpu = makeCpu();
    cpu.halted = true;
    const z80r = buildZ80R(cpu);
    z80r[34] = 0x00;
    const data = buildSZX(1, [{ id: 'Z80R', payload: z80r }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());
    expect(cpu2.halted).toBe(false);
  });
});

// ── SPCR block parsing ─────────────────────────────────────────────────────

describe('SZX — SPCR block', () => {
  it('reads border color from byte 0', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'SPCR', payload: buildSPCR(5, 0, 0) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.borderColor).toBe(5);
  });

  it('masks border color to 3 bits', async () => {
    const cpu = makeCpu();
    const spcr = buildSPCR(0, 0, 0);
    spcr[0] = 0xFF;
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'SPCR', payload: spcr },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.borderColor).toBe(0x07);
  });

  it('reads port7FFD from byte 1', async () => {
    const cpu = makeCpu();
    const data = buildSZX(2, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'SPCR', payload: buildSPCR(0, 0x0B, 0) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory128k());
    expect(result.port7FFD).toBe(0x0B);
  });

  it('reads port1FFD from byte 2', async () => {
    const cpu = makeCpu();
    const data = buildSZX(4, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'SPCR', payload: buildSPCR(0, 0, 0x04) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory128k());
    expect(result.port1FFD).toBe(0x04);
  });

  it('defaults borderColor to 7 when no SPCR block', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.borderColor).toBe(7);
  });

  it('defaults port7FFD and port1FFD to 0 when no SPCR block', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.port7FFD).toBe(0);
    expect(result.port1FFD).toBe(0);
  });
});

// ── RAMP block parsing — uncompressed ──────────────────────────────────────

describe('SZX — RAMP block (uncompressed)', () => {
  it('loads an uncompressed 16KB bank', async () => {
    const cpu = makeCpu();
    const bankData = new Uint8Array(16384);
    for (let i = 0; i < 16384; i++) bankData[i] = (i * 3 + 7) & 0xFF;

    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: buildRAMP(5, bankData, false) },
    ]);
    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);

    const loaded = mem.getRamBank(5);
    for (let i = 0; i < 16384; i++) {
      expect(loaded[i]).toBe((i * 3 + 7) & 0xFF);
    }
  });

  it('loads multiple RAMP blocks for different banks', async () => {
    const cpu = makeCpu();
    const bank0 = new Uint8Array(16384).fill(0xAA);
    const bank2 = new Uint8Array(16384).fill(0xBB);
    const bank5 = new Uint8Array(16384).fill(0xCC);

    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: buildRAMP(5, bank5, false) },
      { id: 'RAMP', payload: buildRAMP(2, bank2, false) },
      { id: 'RAMP', payload: buildRAMP(0, bank0, false) },
    ]);
    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);

    expect(mem.getRamBank(5)[0]).toBe(0xCC);
    expect(mem.getRamBank(2)[0]).toBe(0xBB);
    expect(mem.getRamBank(0)[0]).toBe(0xAA);
  });

  it('skips invalid bank numbers (>= 8)', async () => {
    const cpu = makeCpu();
    const bankData = new Uint8Array(16384).fill(0xFF);

    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: buildRAMP(8, bankData, false) },
    ]);
    const mem = makeMemory48k();
    await expect(loadSZX(data, new Z80(), mem)).resolves.toBeDefined();
  });

  it('loads all 8 banks for 128K', async () => {
    const cpu = makeCpu();
    const blocks: { id: string; payload: Uint8Array }[] = [
      { id: 'Z80R', payload: buildZ80R(cpu) },
    ];
    for (let b = 0; b < 8; b++) {
      const bankData = new Uint8Array(16384).fill(b * 0x11);
      blocks.push({ id: 'RAMP', payload: buildRAMP(b, bankData, false) });
    }
    const data = buildSZX(2, blocks);
    const mem = makeMemory128k();
    await loadSZX(data, new Z80(), mem);

    for (let b = 0; b < 8; b++) {
      expect(mem.getRamBank(b)[0]).toBe(b * 0x11);
    }
  });
});

// ── RAMP block parsing — compressed ────────────────────────────────────────

describe('SZX — RAMP block (compressed)', () => {
  it('loads a zlib-compressed bank', async () => {
    const cpu = makeCpu();
    const bankData = new Uint8Array(16384).fill(0x42);
    const compressed = await compress(bankData);

    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: buildRAMP(5, compressed, true) },
    ]);
    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);

    expect(mem.getRamBank(5)[0]).toBe(0x42);
    expect(mem.getRamBank(5)[16383]).toBe(0x42);
  });

  it('correctly decompresses non-trivial data', async () => {
    const cpu = makeCpu();
    const bankData = new Uint8Array(16384);
    for (let i = 0; i < 16384; i++) bankData[i] = (i * 7 + 13) & 0xFF;
    const compressed = await compress(bankData);

    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: buildRAMP(5, compressed, true) },
    ]);
    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);

    const loaded = mem.getRamBank(5);
    for (let i = 0; i < 16384; i++) {
      expect(loaded[i]).toBe((i * 7 + 13) & 0xFF);
    }
  });
});

// ── AY block parsing ───────────────────────────────────────────────────────

describe('SZX — AY block', () => {
  it('reads AY register state', async () => {
    const cpu = makeCpu();
    const ayRegs = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ayRegs[i] = i * 0x10;

    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'AY\0\0', payload: buildAY(7, ayRegs) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());

    expect(result.ayCurrentReg).toBe(7);
    expect(result.ayRegs).toBeDefined();
    expect(result.ayRegs!.length).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(result.ayRegs![i]).toBe(i * 0x10);
    }
  });

  it('leaves AY state undefined when no AY block', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.ayRegs).toBeUndefined();
    expect(result.ayCurrentReg).toBeUndefined();
  });
});

// ── Unknown blocks ─────────────────────────────────────────────────────────

describe('SZX — unknown blocks', () => {
  it('skips unknown block IDs without error', async () => {
    const cpu = makeCpu();
    const unknown = new Uint8Array(100).fill(0xFF);

    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'XXXX', payload: unknown },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result).toBeDefined();
  });

  it('skips multiple unknown blocks', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'AAAA', payload: new Uint8Array(50) },
      { id: 'BBBB', payload: new Uint8Array(50) },
      { id: 'SPCR', payload: buildSPCR(3, 0, 0) },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.borderColor).toBe(3);
  });
});

// ── Truncated blocks ───────────────────────────────────────────────────────

describe('SZX — truncated data', () => {
  it('handles truncated block gracefully (blockEnd > data.length)', async () => {
    const partialData = new Uint8Array(20);

    partialData[0] = 0x5A; partialData[1] = 0x58;
    partialData[2] = 0x53; partialData[3] = 0x54;
    partialData[4] = 1; partialData[5] = 4;
    partialData[6] = 1; partialData[7] = 0;

    writeStr(partialData, 8, 'Z80R');
    w32(partialData, 12, 37);

    const result = await loadSZX(partialData, new Z80(), makeMemory48k());
    expect(result).toBeDefined();
  });

  it('handles data with only header (no blocks)', async () => {
    const data = new Uint8Array(8);
    data[0] = 0x5A; data[1] = 0x58;
    data[2] = 0x53; data[3] = 0x54;
    data[4] = 1; data[5] = 4;
    data[6] = 1; data[7] = 0;

    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });
});

// ── 48K bank-to-address mapping ────────────────────────────────────────────

describe('SZX — 48K bank-to-address mapping', () => {
  it('maps bank 5 → 0x4000, bank 2 → 0x8000, bank 0 → 0xC000', async () => {
    const cpu = makeCpu();
    const bank5 = new Uint8Array(16384).fill(0x11);
    const bank2 = new Uint8Array(16384).fill(0x22);
    const bank0 = new Uint8Array(16384).fill(0x33);

    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: buildRAMP(5, bank5, false) },
      { id: 'RAMP', payload: buildRAMP(2, bank2, false) },
      { id: 'RAMP', payload: buildRAMP(0, bank0, false) },
    ]);
    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);

    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x7FFF)).toBe(0x11);
    expect(mem.readByte(0x8000)).toBe(0x22);
    expect(mem.readByte(0xBFFF)).toBe(0x22);
    expect(mem.readByte(0xC000)).toBe(0x33);
    expect(mem.readByte(0xFFFF)).toBe(0x33);
  });
});

// ── Save — header structure ────────────────────────────────────────────────

describe('SZX — save header', () => {
  it('writes ZXST magic', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 0, '48k', 0);

    expect(saved[0]).toBe(0x5A);
    expect(saved[1]).toBe(0x58);
    expect(saved[2]).toBe(0x53);
    expect(saved[3]).toBe(0x54);
  });

  it('writes version 1.4', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 0, '48k', 0);

    expect(saved[4]).toBe(1);
    expect(saved[5]).toBe(4);
  });

  it('writes correct machine ID for each model', async () => {
    const models: SpectrumModel[] = ['16k', '48k', '128k', '+2', '+2A', '+3'];
    const expected = [0, 1, 2, 3, 4, 5];

    for (let i = 0; i < models.length; i++) {
      const cpu = new Z80();
      const mem = new SpectrumMemory(models[i]);
      mem.loadROM(new Uint8Array(16384));
      const saved = await saveSZX(cpu, mem, 0, models[i], 0);
      expect(saved[6]).toBe(expected[i]);
    }
  });

  it('sets flags byte to 0', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 0, '48k', 0);
    expect(saved[7]).toBe(0);
  });
});

// ── Save — Z80R block ──────────────────────────────────────────────────────

describe('SZX — save Z80R block', () => {
  it('writes all registers correctly', async () => {
    const cpu = makeCpu();
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 0, '48k', 0);

    const cpu2 = new Z80();
    await loadSZX(saved, cpu2, makeMemory48k());

    expect(cpu2.a).toBe(cpu.a);
    expect(cpu2.f).toBe(cpu.f);
    expect(cpu2.b).toBe(cpu.b);
    expect(cpu2.c).toBe(cpu.c);
    expect(cpu2.d).toBe(cpu.d);
    expect(cpu2.e).toBe(cpu.e);
    expect(cpu2.h).toBe(cpu.h);
    expect(cpu2.l).toBe(cpu.l);
    expect(cpu2.a_).toBe(cpu.a_);
    expect(cpu2.f_).toBe(cpu.f_);
    expect(cpu2.b_).toBe(cpu.b_);
    expect(cpu2.c_).toBe(cpu.c_);
    expect(cpu2.d_).toBe(cpu.d_);
    expect(cpu2.e_).toBe(cpu.e_);
    expect(cpu2.h_).toBe(cpu.h_);
    expect(cpu2.l_).toBe(cpu.l_);
    expect(cpu2.ix).toBe(cpu.ix);
    expect(cpu2.iy).toBe(cpu.iy);
    expect(cpu2.sp).toBe(cpu.sp);
    expect(cpu2.pc).toBe(cpu.pc);
    expect(cpu2.i).toBe(cpu.i);
    expect(cpu2.r).toBe(cpu.r);
    expect(cpu2.iff1).toBe(cpu.iff1);
    expect(cpu2.iff2).toBe(cpu.iff2);
    expect(cpu2.im).toBe(cpu.im);
  });

  it('writes halted flag in chFlags', async () => {
    const cpu = makeCpu();
    cpu.halted = true;
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 0, '48k', 0);

    const cpu2 = new Z80();
    await loadSZX(saved, cpu2, makeMemory48k());
    expect(cpu2.halted).toBe(true);
  });

  it('writes tStates relative to frameStartTStates', async () => {
    const cpu = makeCpu();
    cpu.tStates = 50000;
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 0, '48k', 40000);

    const cpu2 = new Z80();
    await loadSZX(saved, cpu2, makeMemory48k());
    expect(cpu2.tStates).toBe(10000);
  });
});

// ── Save — SPCR block ──────────────────────────────────────────────────────

describe('SZX — save SPCR block', () => {
  it('writes border color', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 6, '48k', 0);

    const result = await loadSZX(saved, new Z80(), makeMemory48k());
    expect(result.borderColor).toBe(6);
  });

  it('preserves all 8 border colors', async () => {
    for (let bc = 0; bc < 8; bc++) {
      const cpu = new Z80();
      const mem = makeMemory48k();
      const saved = await saveSZX(cpu, mem, bc, '48k', 0);
      const result = await loadSZX(saved, new Z80(), makeMemory48k());
      expect(result.borderColor).toBe(bc);
    }
  });

  it('writes port7FFD', async () => {
    const cpu = new Z80();
    const mem = makeMemory128k();
    mem.port7FFD = 0x17;
    mem.currentBank = 7;
    mem.applyBanking();
    const saved = await saveSZX(cpu, mem, 0, '128k', 0);

    const result = await loadSZX(saved, new Z80(), makeMemory128k());
    expect(result.port7FFD).toBe(0x17);
  });

  it('writes port1FFD', async () => {
    const cpu = new Z80();
    const mem = makeMemory128k();
    mem.port1FFD = 0x04;
    const saved = await saveSZX(cpu, mem, 0, '128k', 0);

    const result = await loadSZX(saved, new Z80(), makeMemory128k());
    expect(result.port1FFD).toBe(0x04);
  });
});

// ── Save — RAMP blocks ─────────────────────────────────────────────────────

describe('SZX — save RAMP blocks', () => {
  it('writes 3 pages for 48K (banks 0, 2, 5)', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 0, '48k', 0);

    const cpu2 = new Z80();
    const mem2 = makeMemory48k();
    await loadSZX(saved, cpu2, mem2);

    const pageNumbers: number[] = [];
    let offset = 8;
    while (offset + 8 <= saved.length) {
      const id = String.fromCharCode(saved[offset], saved[offset + 1], saved[offset + 2], saved[offset + 3]);
      const size = saved[offset + 4] | (saved[offset + 5] << 8) | (saved[offset + 6] << 16) | (saved[offset + 7] << 24);
      if (id === 'RAMP') {
        pageNumbers.push(saved[offset + 8 + 2]);
      }
      offset += 8 + size;
    }

    expect(pageNumbers.sort()).toEqual([0, 2, 5]);
  });

  it('writes 8 pages for 128K', async () => {
    const cpu = new Z80();
    const mem = makeMemory128k();
    const saved = await saveSZX(cpu, mem, 0, '128k', 0);

    const pageNumbers: number[] = [];
    let offset = 8;
    while (offset + 8 <= saved.length) {
      const id = String.fromCharCode(saved[offset], saved[offset + 1], saved[offset + 2], saved[offset + 3]);
      const size = saved[offset + 4] | (saved[offset + 5] << 8) | (saved[offset + 6] << 16) | (saved[offset + 7] << 24);
      if (id === 'RAMP') {
        pageNumbers.push(saved[offset + 8 + 2]);
      }
      offset += 8 + size;
    }

    expect(pageNumbers.sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('writes 1 page for 16K (bank 5)', async () => {
    const cpu = new Z80();
    const mem = new SpectrumMemory('16k');
    mem.loadROM(new Uint8Array(16384));
    const saved = await saveSZX(cpu, mem, 0, '16k', 0);

    const pageNumbers: number[] = [];
    let offset = 8;
    while (offset + 8 <= saved.length) {
      const id = String.fromCharCode(saved[offset], saved[offset + 1], saved[offset + 2], saved[offset + 3]);
      const size = saved[offset + 4] | (saved[offset + 5] << 8) | (saved[offset + 6] << 16) | (saved[offset + 7] << 24);
      if (id === 'RAMP') {
        pageNumbers.push(saved[offset + 8 + 2]);
      }
      offset += 8 + size;
    }

    expect(pageNumbers).toEqual([5]);
  });

  it('sets compression flag when compressed data is smaller', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    mem.getRamBank(5).fill(0x00);
    const saved = await saveSZX(cpu, mem, 0, '48k', 0);

    let offset = 8;
    while (offset + 8 <= saved.length) {
      const id = String.fromCharCode(saved[offset], saved[offset + 1], saved[offset + 2], saved[offset + 3]);
      const size = saved[offset + 4] | (saved[offset + 5] << 8) | (saved[offset + 6] << 16) | (saved[offset + 7] << 24);
      if (id === 'RAMP') {
        const flags = saved[offset + 8] | (saved[offset + 9] << 8);
        const pageNo = saved[offset + 10];
        if (pageNo === 5) {
          expect(flags & 1).toBe(1);
        }
      }
      offset += 8 + size;
    }
  });
});

// ── Save — AY block ────────────────────────────────────────────────────────

describe('SZX — save AY block', () => {
  it('omits AY block when no AY regs provided', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const saved = await saveSZX(cpu, mem, 0, '48k', 0);

    let hasAY = false;
    let offset = 8;
    while (offset + 8 <= saved.length) {
      const id = String.fromCharCode(saved[offset], saved[offset + 1], saved[offset + 2], saved[offset + 3]);
      if (id === 'AY\0') hasAY = true;
      const size = saved[offset + 4] | (saved[offset + 5] << 8) | (saved[offset + 6] << 16) | (saved[offset + 7] << 24);
      offset += 8 + size;
    }
    expect(hasAY).toBe(false);
  });

  it('writes AY block when AY regs provided', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    const ayRegs = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ayRegs[i] = i * 2;

    const saved = await saveSZX(cpu, mem, 0, '48k', 0, ayRegs, 5);
    const result = await loadSZX(saved, new Z80(), makeMemory48k());

    expect(result.ayCurrentReg).toBe(5);
    for (let i = 0; i < 16; i++) {
      expect(result.ayRegs![i]).toBe(i * 2);
    }
  });
});

// ── 48K full round-trip ────────────────────────────────────────────────────

describe('SZX — 48K full round-trip', () => {
  it('preserves all memory across save/load', async () => {
    const cpu = makeCpu();
    const mem = makeMemory48k();
    const bank5 = mem.getRamBank(5);
    const bank2 = mem.getRamBank(2);
    const bank0 = mem.getRamBank(0);
    for (let i = 0; i < 16384; i++) {
      bank5[i] = (i * 3 + 1) & 0xFF;
      bank2[i] = (i * 5 + 2) & 0xFF;
      bank0[i] = (i * 7 + 3) & 0xFF;
    }

    const saved = await saveSZX(cpu, mem, 4, '48k', 0);
    const cpu2 = new Z80();
    const mem2 = makeMemory48k();
    const result = await loadSZX(saved, cpu2, mem2);

    expect(result.is128K).toBe(false);
    expect(result.borderColor).toBe(4);

    for (let i = 0; i < 16384; i++) {
      expect(mem2.getRamBank(5)[i]).toBe((i * 3 + 1) & 0xFF);
      expect(mem2.getRamBank(2)[i]).toBe((i * 5 + 2) & 0xFF);
      expect(mem2.getRamBank(0)[i]).toBe((i * 7 + 3) & 0xFF);
    }
  });
});

// ── 128K full round-trip ───────────────────────────────────────────────────

describe('SZX — 128K full round-trip', () => {
  it('preserves all 8 RAM banks', async () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    for (let b = 0; b < 8; b++) {
      const data = mem.getRamBank(b);
      for (let i = 0; i < 16384; i++) {
        data[i] = ((b * 16384 + i) * 3 + 7) & 0xFF;
      }
    }

    const saved = await saveSZX(cpu, mem, 2, '128k', 0);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    const result = await loadSZX(saved, cpu2, mem2);

    expect(result.is128K).toBe(true);

    for (let b = 0; b < 8; b++) {
      const data = mem2.getRamBank(b);
      for (let i = 0; i < 16384; i++) {
        expect(data[i]).toBe(((b * 16384 + i) * 3 + 7) & 0xFF);
      }
    }
  });

  it('preserves port7FFD across round-trip', async () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.port7FFD = 0x0B; // bank 3, ROM 0, paging unlocked
    mem.currentBank = 0x0B & 0x07; // bank index is bits 0-2 of port7FFD
    mem.applyBanking();

    const saved = await saveSZX(cpu, mem, 0, '128k', 0);
    const result = await loadSZX(saved, new Z80(), makeMemory128k());
    expect(result.port7FFD).toBe(0x0B);
  });
});

// ── applySZXPaging — shared paging restore (resume + file-load) ─────────────

describe('SZX — applySZXPaging', () => {
  const result128 = (port7FFD: number, port1FFD = 0) => ({
    is128K: true, borderColor: 0, port7FFD, port1FFD,
  });

  it('+2A/+3: ROM page combines 1FFD bit 2 (high) and 7FFD bit 4 (low)', () => {
    // 7FFD bit4=1 (low ROM bit), 1FFD bit2=1 (high ROM bit) → ROM 3 (48K BASIC).
    // Regression: the resume path used to ignore 1FFD bit 2 and select ROM 1,
    // paging in the wrong ROM and freezing ROM-dependent interrupt effects.
    const mem = makeMemoryPlus3();
    applySZXPaging(mem, true, result128(0x10, 0x04));
    expect(mem.currentROM).toBe(3);
    expect(mem.specialPaging).toBe(false);
    expect(mem.port1FFD).toBe(0x04);
  });

  it('+2A/+3: each ROM-bit combination maps to the right page', () => {
    const cases: [number, number, number][] = [
      // [7FFD, 1FFD, expectedROM]
      [0x00, 0x00, 0],
      [0x10, 0x00, 1],
      [0x00, 0x04, 2],
      [0x10, 0x04, 3],
    ];
    for (const [p7, p1, rom] of cases) {
      const mem = makeMemoryPlus3();
      applySZXPaging(mem, true, result128(p7, p1));
      expect(mem.currentROM).toBe(rom);
    }
  });

  it('+2A/+3: 1FFD bit 0 enables all-RAM special paging', () => {
    const mem = makeMemoryPlus3();
    applySZXPaging(mem, true, result128(0x00, 0x01));
    expect(mem.specialPaging).toBe(true);
  });

  it('plain 128K/+2: ROM is only 7FFD bit 4 (no special-paging high bit)', () => {
    const mem = makeMemory128k();
    applySZXPaging(mem, false, result128(0x10, 0x04));
    expect(mem.currentROM).toBe(1); // 1FFD bit 2 must NOT contribute here
  });

  it('restores the RAM bank and paging-lock bit from 7FFD', () => {
    const mem = makeMemory128k();
    applySZXPaging(mem, false, result128(0x23)); // bank 3, lock bit (0x20) set
    expect(mem.currentBank).toBe(3);
    expect(mem.pagingLocked).toBe(true);
  });

  it('is a no-op for a 48K (non-128K) result', () => {
    const mem = makeMemory48k();
    const before = mem.currentROM;
    applySZXPaging(mem, false, { is128K: false, borderColor: 0, port7FFD: 0xFF, port1FFD: 0xFF });
    expect(mem.currentROM).toBe(before);
  });
});

// ── Synchronous (uncompressed) writer — the beforeunload resume path ────────

describe('SZX — saveSZXSync (uncompressed, no CompressionStream)', () => {
  it('round-trips all 8 RAM banks of a 128K machine', async () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    for (let b = 0; b < 8; b++) {
      const data = mem.getRamBank(b);
      for (let i = 0; i < 16384; i++) {
        data[i] = ((b * 16384 + i) * 5 + 11) & 0xFF;
      }
    }

    const saved = saveSZXSync(cpu, mem, 2, '128k', 0); // synchronous — no await
    const mem2 = makeMemory128k();
    const result = await loadSZX(saved, new Z80(), mem2);
    expect(result.is128K).toBe(true);

    for (let b = 0; b < 8; b++) {
      const data = mem2.getRamBank(b);
      for (let i = 0; i < 16384; i++) {
        expect(data[i]).toBe(((b * 16384 + i) * 5 + 11) & 0xFF);
      }
    }
  });

  it('writes RAMP blocks uncompressed (wFlags bit 0 clear, full 16KB payload)', () => {
    const saved = saveSZXSync(makeCpu(), makeMemory128k(), 0, '128k', 0);
    // Walk the block list and confirm every RAMP is raw and full-sized.
    let offset = 8; // past header
    let ramps = 0;
    while (offset + 8 <= saved.length) {
      const id = String.fromCharCode(saved[offset], saved[offset + 1], saved[offset + 2], saved[offset + 3]);
      const size = saved[offset + 4] | (saved[offset + 5] << 8) | (saved[offset + 6] << 16) | (saved[offset + 7] << 24);
      if (id === 'RAMP') {
        const wFlags = saved[offset + 8] | (saved[offset + 9] << 8);
        expect(wFlags & 1).toBe(0);        // not compressed
        expect(size).toBe(3 + 16384);      // wFlags(2) + page(1) + raw 16KB
        ramps++;
      }
      offset += 8 + size;
    }
    expect(ramps).toBe(8); // all 8 banks for a 128K snapshot
  });

  it('preserves CPU interrupt state (IM2 / EI / I) — what a halted game needs to resume', async () => {
    const cpu = makeCpu();
    cpu.im = 2;
    cpu.iff1 = true;
    cpu.iff2 = true;
    cpu.i = 0xFE;
    cpu.halted = true;
    const saved = saveSZXSync(cpu, makeMemory128k(), 0, '128k', 0);

    const cpu2 = new Z80();
    await loadSZX(saved, cpu2, makeMemory128k());
    expect(cpu2.im).toBe(2);
    expect(cpu2.iff1).toBe(true);
    expect(cpu2.i).toBe(0xFE);
    expect(cpu2.halted).toBe(true);
  });
});

// ── Extended machine IDs (per ZXSTMID_* enum) ──────────────────────────────

describe('SZX — extended machine ID detection', () => {
  it.each([
    [7,  '128K-class', true],   // Pentagon 128
    [8,  '48K-class',  false],  // Timex TC2048
    [9,  '48K-class',  false],  // Timex TC2068
    [10, '128K-class', true],   // Scorpion ZS-256
    [11, '128K-class', true],   // Spectrum SE
    [12, '48K-class',  false],  // Timex TS2068
    [13, '128K-class', true],   // Pentagon 512
    [14, '128K-class', true],   // Pentagon 1024
    [15, '48K-class',  false],  // 48K NTSC
    [16, '128K-class', true],   // Spectrum 128Ke
  ])('machineId %i (%s) → is128K=%s', async (id, _label, expected) => {
    const cpu = makeCpu();
    const data = buildSZX(id, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    const memory = expected ? makeMemory128k() : makeMemory48k();
    const result = await loadSZX(data, new Z80(), memory);
    expect(result.is128K).toBe(expected);
  });
});

// ── Header flags byte tolerance ────────────────────────────────────────────

describe('SZX — header flags byte', () => {
  it('tolerates ZXSTMF_ALTERNATETIMINGS (flags bit 0) without affecting load', async () => {
    const cpu = makeCpu();
    const data = buildSZX(1, [{ id: 'Z80R', payload: buildZ80R(cpu) }]);
    data[7] = 0x01; // ZXSTMF_ALTERNATETIMINGS

    const cpu2 = new Z80();
    const result = await loadSZX(data, cpu2, makeMemory48k());
    expect(result.is128K).toBe(false);
    expect(cpu2.pc).toBe(cpu.pc);
  });
});

// ── SPCR chFe byte semantics ───────────────────────────────────────────────

describe('SZX — SPCR chFe (port FE) byte', () => {
  it('does not let chFe override border colour from chBorder', async () => {
    // Per spec: chBorder is authoritative for the border colour; chFe is
    // the last value written to port $FE, with only bits 3-4 (MIC/EAR)
    // guaranteed valid. The loader must read border from byte 0, not 3.
    const cpu = makeCpu();
    const spcr = buildSPCR(/* border */ 2, 0, 0);
    spcr[3] = 0xFF; // chFe: all bits set (border bits 0-2 = 7)
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'SPCR', payload: spcr },
    ]);
    const result = await loadSZX(data, new Z80(), makeMemory48k());
    expect(result.borderColor).toBe(2); // not 7
  });
});

// ── Extended Z80R blocks (forward compatibility) ───────────────────────────

describe('SZX — extended Z80R block tolerance', () => {
  it('accepts a Z80R block larger than 37 bytes (future extensions)', async () => {
    const cpu = makeCpu();
    cpu.pc = 0xC0DE;
    // Build a 64-byte Z80R block: 37 bytes of standard fields plus 27
    // trailing bytes that the loader must skip without misreading.
    const standard = buildZ80R(cpu);
    const extended = new Uint8Array(64);
    extended.set(standard, 0);
    extended.fill(0xAB, 37);

    const data = buildSZX(1, [{ id: 'Z80R', payload: extended }]);
    const cpu2 = new Z80();
    await loadSZX(data, cpu2, makeMemory48k());
    expect(cpu2.pc).toBe(0xC0DE);
    expect(cpu2.a).toBe(cpu.a);
  });
});

// ── RAMP wFlags bit semantics ──────────────────────────────────────────────

describe('SZX — RAMP wFlags bit 0 = ZXSTRF_COMPRESSED only', () => {
  it('treats wFlags=0x0000 as uncompressed', async () => {
    const cpu = makeCpu();
    const bankData = new Uint8Array(16384).fill(0x77);
    const ramp = new Uint8Array(3 + 16384);
    w16(ramp, 0, 0x0000); // wFlags
    ramp[2] = 5;
    ramp.set(bankData, 3);
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: ramp },
    ]);
    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);
    expect(mem.getRamBank(5)[0]).toBe(0x77);
  });

  it('treats wFlags=0xFFFE (bit 0 clear, other bits set) as uncompressed', async () => {
    const cpu = makeCpu();
    const bankData = new Uint8Array(16384).fill(0x55);
    const ramp = new Uint8Array(3 + 16384);
    w16(ramp, 0, 0xFFFE);
    ramp[2] = 5;
    ramp.set(bankData, 3);
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: ramp },
    ]);
    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);
    expect(mem.getRamBank(5)[0]).toBe(0x55);
  });
});

// ── 16K full round-trip ────────────────────────────────────────────────────

describe('SZX — 16K full round-trip', () => {
  it('saves and loads only bank 5 for 16K machines', async () => {
    const cpu = makeCpu();
    const mem = new SpectrumMemory('16k');
    mem.loadROM(new Uint8Array(16384));
    const bank5 = mem.getRamBank(5);
    for (let i = 0; i < 16384; i++) bank5[i] = (i * 13 + 7) & 0xFF;

    const saved = await saveSZX(cpu, mem, 1, '16k', 0);
    expect(saved[6]).toBe(0); // machine ID = 16K

    // Exactly one RAMP block, for page 5.
    let rampCount = 0;
    let rampPage = -1;
    let offset = 8;
    while (offset + 8 <= saved.length) {
      const id = String.fromCharCode(saved[offset], saved[offset + 1], saved[offset + 2], saved[offset + 3]);
      const size = saved[offset + 4] | (saved[offset + 5] << 8) | (saved[offset + 6] << 16) | (saved[offset + 7] << 24);
      if (id === 'RAMP') {
        rampCount++;
        rampPage = saved[offset + 8 + 2];
      }
      offset += 8 + size;
    }
    expect(rampCount).toBe(1);
    expect(rampPage).toBe(5);

    const cpu2 = new Z80();
    const mem2 = new SpectrumMemory('16k');
    mem2.loadROM(new Uint8Array(16384));
    const result = await loadSZX(saved, cpu2, mem2);
    expect(result.is128K).toBe(false);
    expect(result.borderColor).toBe(1);
    for (let i = 0; i < 16384; i++) {
      expect(mem2.getRamBank(5)[i]).toBe((i * 13 + 7) & 0xFF);
    }
  });
});

// ── Byte-identity round-trip ───────────────────────────────────────────────

describe('SZX — byte-identity round-trip', () => {
  it('48K save → load → save produces byte-identical output', async () => {
    // Use frameStart=0 so dwCyclesStart is the absolute tStates value;
    // the loader stores dwCyclesStart back into cpu.tStates verbatim, so
    // only a zero offset preserves byte-identity on the second save.
    const cpu = makeCpu();
    const mem = makeMemory48k();
    for (let i = 0; i < 16384; i++) {
      mem.getRamBank(5)[i] = (i * 3 + 1) & 0xFF;
      mem.getRamBank(2)[i] = (i * 5 + 2) & 0xFF;
      mem.getRamBank(0)[i] = (i * 7 + 3) & 0xFF;
    }

    const saved1 = await saveSZX(cpu, mem, 4, '48k', 0);
    const cpu2 = new Z80();
    const mem2 = makeMemory48k();
    await loadSZX(saved1, cpu2, mem2);
    const saved2 = await saveSZX(cpu2, mem2, 4, '48k', 0);

    expect(saved2.length).toBe(saved1.length);
    for (let i = 0; i < saved1.length; i++) {
      expect(saved2[i]).toBe(saved1[i]);
    }
  });

  it('128K save → load → save produces byte-identical output', async () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    for (let b = 0; b < 8; b++) {
      const bank = mem.getRamBank(b);
      for (let i = 0; i < 16384; i++) {
        bank[i] = ((b * 16384 + i) * 11 + 17) & 0xFF;
      }
    }
    mem.port7FFD = 0x13; // bank 3, ROM 1, unlocked
    mem.currentBank = 3;
    mem.applyBanking();

    const saved1 = await saveSZX(cpu, mem, 2, '128k', 0);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    // Unlike the .z80 and .sna loaders, loadSZX returns port7FFD/port1FFD
    // in the result object rather than applying them to memory. The caller
    // is responsible for syncing — replicate that here so the second save
    // emits the same SPCR bytes.
    const r = await loadSZX(saved1, cpu2, mem2);
    mem2.port7FFD = r.port7FFD;
    mem2.port1FFD = r.port1FFD;
    mem2.currentBank = r.port7FFD & 0x07;
    mem2.applyBanking();
    const saved2 = await saveSZX(cpu2, mem2, 2, '128k', 0);

    expect(saved2.length).toBe(saved1.length);
    for (let i = 0; i < saved1.length; i++) {
      expect(saved2[i]).toBe(saved1[i]);
    }
  });
});

// ── Save: uncompressed fallback for incompressible banks ───────────────────

describe('SZX — save uncompressed fallback when deflate does not shrink', () => {
  it('stores a high-entropy bank uncompressed when deflate produces a larger payload', async () => {
    const cpu = new Z80();
    const mem = makeMemory48k();
    // Fill page 5 with deterministic pseudo-random bytes that deflate cannot
    // meaningfully shrink, forcing the `zipped.length < raw.length` branch
    // to take its else arm.
    const bank5 = mem.getRamBank(5);
    let s = 0xC0FFEEn;
    for (let i = 0; i < bank5.length; i++) {
      s = (s * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
      bank5[i] = Number((s >> 33n) & 0xFFn);
    }

    const saved = await saveSZX(cpu, mem, 0, '48k', 0);

    // Walk SZX blocks until we find the RAMP block for page 5.
    let off = 8;
    let inspected = false;
    while (off + 8 <= saved.length) {
      const id = String.fromCharCode(saved[off], saved[off + 1], saved[off + 2], saved[off + 3]);
      const size = saved[off + 4] | (saved[off + 5] << 8) | (saved[off + 6] << 16) | (saved[off + 7] << 24);
      const payload = saved.subarray(off + 8, off + 8 + size);
      if (id === 'RAMP' && payload[2] === 5) {
        // ZXSTRF_COMPRESSED = bit 0. Saver picked the uncompressed branch.
        const wFlags = payload[0] | (payload[1] << 8);
        expect(wFlags & 1).toBe(0);
        const stored = payload.subarray(3);
        expect(stored.length).toBe(16384);
        expect(stored).toEqual(bank5);
        inspected = true;
        break;
      }
      off += 8 + size;
    }
    expect(inspected).toBe(true);
  });
});

// ── Save: optional fields on the Z80R/AY blocks ────────────────────────────

describe('SZX — Z80R block iff1/iff2 byte encoding', () => {
  it.each([
    [false, false],
    [true,  false],
    [false, true],
    [true,  true],
  ])('writes iff1=%s iff2=%s as the matching 0/1 bytes', async (iff1, iff2) => {
    const cpu = new Z80();
    cpu.iff1 = iff1;
    cpu.iff2 = iff2;
    const saved = await saveSZX(cpu, makeMemory48k(), 0, '48k', 0);

    // Z80R block sits immediately after the 8-byte SZX header + 8-byte block
    // header. Fields 26 and 27 inside the payload are chIff1 and chIff2.
    const z80rPayload = 8 + 8;
    expect(saved[z80rPayload + 26]).toBe(iff1 ? 1 : 0);
    expect(saved[z80rPayload + 27]).toBe(iff2 ? 1 : 0);

    const cpu2 = new Z80();
    await loadSZX(saved, cpu2, makeMemory48k());
    expect(cpu2.iff1).toBe(iff1);
    expect(cpu2.iff2).toBe(iff2);
  });
});

describe('SZX — save AY block without an explicit current register', () => {
  it('defaults chCurrentRegister to 0 when ayCurrentReg is omitted', async () => {
    const cpu = new Z80();
    const ayRegs = new Uint8Array(16);
    for (let i = 0; i < 16; i++) ayRegs[i] = i + 0x10;

    // Pass ayRegs but no ayCurrentReg — exercises the `?? 0` branch.
    const saved = await saveSZX(cpu, makeMemory48k(), 0, '48k', 0, ayRegs);

    // Locate the AY block and inspect chCurrentRegister.
    let off = 8;
    let found = false;
    while (off + 8 <= saved.length) {
      const id0 = saved[off], id1 = saved[off + 1];
      const size = saved[off + 4] | (saved[off + 5] << 8) | (saved[off + 6] << 16) | (saved[off + 7] << 24);
      if (id0 === 0x41 /* 'A' */ && id1 === 0x59 /* 'Y' */) {
        const payload = saved.subarray(off + 8, off + 8 + size);
        expect(payload[0]).toBe(0);     // chFlags
        expect(payload[1]).toBe(0);     // chCurrentRegister — defaulted
        expect(Array.from(payload.subarray(2, 18))).toEqual(Array.from(ayRegs));
        found = true;
        break;
      }
      off += 8 + size;
    }
    expect(found).toBe(true);
  });
});

// ── Load: short Z80R block (no chFlags byte) ───────────────────────────────

describe('SZX — Z80R block without chFlags byte', () => {
  it('skips reading halted when the block ends before offset 34', async () => {
    // Standard Z80R payload is 37 bytes. Truncate it to 33 (just past
    // dwCyclesStart's last byte) so the parser's `o + 34 < data.length`
    // guard takes its else arm.
    const cpu = makeCpu();
    const fullPayload = buildZ80R(cpu);
    const shortPayload = fullPayload.subarray(0, 33);

    const data = buildSZX(1, [{ id: 'Z80R', payload: shortPayload }]);

    const cpu2 = new Z80();
    cpu2.halted = true; // pre-set to a known value so we can tell it stayed put
    await loadSZX(data, cpu2, makeMemory48k());
    // Registers up through dwCyclesStart must still have loaded correctly.
    expect(cpu2.a).toBe(cpu.a);
    expect(cpu2.pc).toBe(cpu.pc);
    // halted must not have been touched — the field was absent from the block.
    expect(cpu2.halted).toBe(true);
  });
});

// ── Load: multi-chunk inflate concatenation ────────────────────────────────

describe('SZX — multi-chunk inflate concatenation', () => {
  it('concatenates inflated chunks when a RAMP payload expands beyond 16 KiB', async () => {
    // Node's DecompressionStream emits inflated bytes in ~16 KiB chunks. A
    // legitimate RAMP block is 16 KiB so the multi-chunk branch never fires
    // on real files. We instead craft a RAMP whose deflate inflates to
    // 32 KiB — szx.ts hands the result straight to setBankFromSnapshot,
    // which clamps to 16 KiB, but the inflate helper still has to assemble
    // both chunks first.
    const bankBytes = new Uint8Array(16384);
    for (let i = 0; i < bankBytes.length; i++) bankBytes[i] = (i * 5) & 0xFF;
    const filler = new Uint8Array(16385);  // tips the inflated size over 16 KiB
    const raw = new Uint8Array(bankBytes.length + filler.length);
    raw.set(bankBytes, 0);
    raw.set(filler, bankBytes.length);

    const { deflateSync } = await import('node:zlib');
    const deflated = new Uint8Array(deflateSync(raw)); // zlib (SZX uses 'deflate', not raw)

    const cpu = new Z80();
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: buildRAMP(5, deflated, true) },
    ]);

    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);
    const bank5 = mem.getRamBank(5);
    for (let i = 0; i < bankBytes.length; i++) {
      expect(bank5[i]).toBe(bankBytes[i]);
    }
  });
});

// ── Block size endianness ──────────────────────────────────────────────────

describe('SZX — dwSize is little-endian and payload-only', () => {
  it('reads dwSize as LE (a payload larger than 256 bytes parses correctly)', async () => {
    const cpu = makeCpu();
    // Z80R is exactly 37 bytes; the high byte of size remains 0. To
    // exercise multi-byte sizes, put an uncompressed 16384-byte RAMP block
    // (size = 16387 = 0x4003, which has a non-zero high byte).
    const bank = new Uint8Array(16384).fill(0x66);
    const data = buildSZX(1, [
      { id: 'Z80R', payload: buildZ80R(cpu) },
      { id: 'RAMP', payload: buildRAMP(5, bank, false) },
    ]);
    // Sanity-check that the size bytes really encode 0x4003 little-endian.
    const rampSizeOffset = 8 + 8 + 37 + 4; // header + Z80R header+body + RAMP id
    const dwSize = data[rampSizeOffset]
      | (data[rampSizeOffset + 1] << 8)
      | (data[rampSizeOffset + 2] << 16)
      | (data[rampSizeOffset + 3] << 24);
    expect(dwSize).toBe(16387); // 3 + 16384
    expect(data[rampSizeOffset]).toBe(0x03);
    expect(data[rampSizeOffset + 1]).toBe(0x40);

    const mem = makeMemory48k();
    await loadSZX(data, new Z80(), mem);
    expect(mem.getRamBank(5)[0]).toBe(0x66);
  });
});
