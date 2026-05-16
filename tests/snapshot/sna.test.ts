import { describe, it, expect } from 'vitest';
import { saveSNA, loadSNA } from '@/snapshot/sna.ts';
import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/memory.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCpu(): Z80 {
  const cpu = new Z80();
  cpu.i = 0x1F;
  cpu.l_ = 0x61; cpu.h_ = 0x51;
  cpu.e_ = 0x41; cpu.d_ = 0x31;
  cpu.c_ = 0x21; cpu.b_ = 0x11;
  cpu.f_ = 0x55; cpu.a_ = 0xAA;
  cpu.l = 0x60; cpu.h = 0x50;
  cpu.e = 0x40; cpu.d = 0x30;
  cpu.c = 0x20; cpu.b = 0x10;
  cpu.iy = 0x1234;
  cpu.ix = 0x5678;
  cpu.sp = 0xFF00;
  cpu.pc = 0x8000;
  cpu.r = 0x81;
  cpu.iff1 = true;
  cpu.iff2 = true;
  cpu.im = 1;
  cpu.f = 0x44;
  cpu.a = 0x3E;
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

function buildSNA48K(
  cpu: Z80,
  ram: Uint8Array,
  borderColor: number
): Uint8Array {
  const data = new Uint8Array(49179);
  writeHeader(data, cpu, borderColor);
  data.set(ram, 27);
  return data;
}

function buildSNA128K(
  cpu: Z80,
  banks: Uint8Array[],
  port7FFD: number,
  borderColor: number
): Uint8Array {
  const currentBank = port7FFD & 0x07;
  let extraCount = 0;
  for (let b = 0; b < 8; b++) {
    if (b === 5 || b === 2 || b === currentBank) continue;
    extraCount++;
  }
  const data = new Uint8Array(49183 + extraCount * 16384);
  writeHeader(data, cpu, borderColor);

  data.set(banks[5], 27);
  data.set(banks[2], 27 + 16384);
  data.set(banks[currentBank], 27 + 32768);

  data[49179] = cpu.pc & 0xFF;
  data[49180] = (cpu.pc >> 8) & 0xFF;
  data[49181] = port7FFD;
  data[49182] = 0;

  let offset = 49183;
  for (let b = 0; b < 8; b++) {
    if (b === 5 || b === 2 || b === currentBank) continue;
    data.set(banks[b], offset);
    offset += 16384;
  }

  return data;
}

function writeHeader(data: Uint8Array, cpu: Z80, borderColor: number): void {
  data[0] = cpu.i;
  data[1] = cpu.l_; data[2] = cpu.h_;
  data[3] = cpu.e_; data[4] = cpu.d_;
  data[5] = cpu.c_; data[6] = cpu.b_;
  data[7] = cpu.f_; data[8] = cpu.a_;
  data[9] = cpu.l; data[10] = cpu.h;
  data[11] = cpu.e; data[12] = cpu.d;
  data[13] = cpu.c; data[14] = cpu.b;
  data[15] = cpu.iy & 0xFF; data[16] = (cpu.iy >> 8) & 0xFF;
  data[17] = cpu.ix & 0xFF; data[18] = (cpu.ix >> 8) & 0xFF;
  data[19] = cpu.iff2 ? 0x04 : 0x00;
  data[20] = cpu.r;
  data[21] = cpu.f; data[22] = cpu.a;
  data[23] = cpu.sp & 0xFF; data[24] = (cpu.sp >> 8) & 0xFF;
  data[25] = cpu.im;
  data[26] = borderColor & 0x07;
}

function make8Banks(fill: (bank: number, i: number) => number): Uint8Array[] {
  const banks: Uint8Array[] = [];
  for (let b = 0; b < 8; b++) {
    const data = new Uint8Array(16384);
    for (let i = 0; i < 16384; i++) data[i] = fill(b, i);
    banks.push(data);
  }
  return banks;
}

// ── Loading errors ─────────────────────────────────────────────────────────

describe('SNA — loading errors', () => {
  it('rejects files smaller than 49179 bytes', () => {
    expect(() => loadSNA(new Uint8Array(49178), new Z80(), makeMemory48k()))
      .toThrow('SNA file too small');
  });

  it('accepts exactly 49179 bytes (48K)', () => {
    const cpu = makeCpu();
    const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
    expect(() => loadSNA(data, new Z80(), makeMemory48k())).not.toThrow();
  });
});

// ── 48K header loading ─────────────────────────────────────────────────────

describe('SNA — 48K header loading', () => {
  it('restores all shadow registers', () => {
    const cpu = makeCpu();
    const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory48k());

    expect(cpu2.i).toBe(0x1F);
    expect(cpu2.l_).toBe(0x61);
    expect(cpu2.h_).toBe(0x51);
    expect(cpu2.e_).toBe(0x41);
    expect(cpu2.d_).toBe(0x31);
    expect(cpu2.c_).toBe(0x21);
    expect(cpu2.b_).toBe(0x11);
    expect(cpu2.f_).toBe(0x55);
    expect(cpu2.a_).toBe(0xAA);
  });

  it('restores all main registers', () => {
    const cpu = makeCpu();
    const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory48k());

    expect(cpu2.l).toBe(0x60);
    expect(cpu2.h).toBe(0x50);
    expect(cpu2.e).toBe(0x40);
    expect(cpu2.d).toBe(0x30);
    expect(cpu2.c).toBe(0x20);
    expect(cpu2.b).toBe(0x10);
    expect(cpu2.f).toBe(0x44);
    expect(cpu2.a).toBe(0x3E);
  });

  it('restores IY, IX, SP', () => {
    const cpu = makeCpu();
    const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory48k());

    expect(cpu2.iy).toBe(0x1234);
    expect(cpu2.ix).toBe(0x5678);
  });

  it('restores R register', () => {
    const cpu = makeCpu();
    cpu.r = 0xAB;
    const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory48k());
    expect(cpu2.r).toBe(0xAB);
  });

  it('restores IM mode', () => {
    for (const im of [0, 1, 2]) {
      const cpu = makeCpu();
      cpu.im = im;
      const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
      const cpu2 = new Z80();
      loadSNA(data, cpu2, makeMemory48k());
      expect(cpu2.im).toBe(im);
    }
  });

  it('extracts IFF2 from bit 2 of byte 19 and mirrors to IFF1', () => {
    const cpu = makeCpu();
    cpu.iff2 = true;
    const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
    expect(data[19] & 0x04).toBe(0x04);

    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory48k());
    expect(cpu2.iff2).toBe(true);
    expect(cpu2.iff1).toBe(true);
  });

  it('handles IFF2=false (bit 2 clear)', () => {
    const cpu = makeCpu();
    cpu.iff2 = false;
    cpu.iff1 = false;
    const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
    expect(data[19] & 0x04).toBe(0x00);

    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory48k());
    expect(cpu2.iff2).toBe(false);
    expect(cpu2.iff1).toBe(false);
  });

  it('extracts border color from byte 26', () => {
    const cpu = makeCpu();
    const data = buildSNA48K(cpu, new Uint8Array(49152), 5);
    const cpu2 = new Z80();
    const result = loadSNA(data, cpu2, makeMemory48k());
    expect(result.borderColor).toBe(5);
  });

  it('masks border color to 3 bits', () => {
    const cpu = makeCpu();
    const data = buildSNA48K(cpu, new Uint8Array(49152), 3);
    data[26] = 0xFF;
    const cpu2 = new Z80();
    const result = loadSNA(data, cpu2, makeMemory48k());
    expect(result.borderColor).toBe(0x07);
  });

  it('reports is128K=false for 48K', () => {
    const cpu = makeCpu();
    const data = buildSNA48K(cpu, new Uint8Array(49152), 0);
    const result = loadSNA(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
    expect(result.port7FFD).toBe(0);
  });
});

// ── 48K PC recovery from stack ─────────────────────────────────────────────

describe('SNA — 48K PC from stack', () => {
  it('recovers PC by popping from the stack', () => {
    const cpu = makeCpu();
    cpu.sp = 0xFF00;
    cpu.pc = 0x1234;
    const ram = new Uint8Array(49152);
    const stackOffset = 0xFF00 - 0x4000;
    ram[stackOffset] = 0x34;
    ram[stackOffset + 1] = 0x12;

    const data = buildSNA48K(cpu, ram, 0);
    const cpu2 = new Z80();
    const mem = makeMemory48k();
    loadSNA(data, cpu2, mem);

    expect(cpu2.pc).toBe(0x1234);
    expect(cpu2.sp).toBe(0xFF02);
  });

  it('increments SP by 2 after popping PC', () => {
    const cpu = makeCpu();
    cpu.sp = 0xD000;
    const ram = new Uint8Array(49152);
    const stackOffset = 0xD000 - 0x4000;
    ram[stackOffset] = 0x00;
    ram[stackOffset + 1] = 0x80;

    const data = buildSNA48K(cpu, ram, 0);
    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory48k());

    expect(cpu2.sp).toBe(0xD002);
  });

  it('handles SP at 0xFFFE wrapping to 0x0000', () => {
    const cpu = makeCpu();
    cpu.sp = 0xFFFE;
    const ram = new Uint8Array(49152);
    const stackOffset = 0xFFFE - 0x4000;
    ram[stackOffset] = 0xCD;
    ram[stackOffset + 1] = 0xAB;

    const data = buildSNA48K(cpu, ram, 0);
    const cpu2 = new Z80();
    const mem = makeMemory48k();
    loadSNA(data, cpu2, mem);

    expect(cpu2.pc).toBe(0xABCD);
    expect(cpu2.sp).toBe(0x0000);
  });
});

// ── 48K RAM loading ────────────────────────────────────────────────────────

describe('SNA — 48K RAM loading', () => {
  it('loads bytes 27-49178 into banks 5, 2, 0', () => {
    const cpu = makeCpu();
    const ram = new Uint8Array(49152);
    for (let i = 0; i < 16384; i++) ram[i] = 0x11;
    for (let i = 16384; i < 32768; i++) ram[i] = 0x22;
    for (let i = 32768; i < 49152; i++) ram[i] = 0x33;

    const data = buildSNA48K(cpu, ram, 0);
    const mem = makeMemory48k();
    loadSNA(data, new Z80(), mem);

    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x7FFF)).toBe(0x11);
    expect(mem.readByte(0x8000)).toBe(0x22);
    expect(mem.readByte(0xBFFF)).toBe(0x22);
    expect(mem.readByte(0xC000)).toBe(0x33);
    expect(mem.readByte(0xFFFF)).toBe(0x33);
  });

  it('preserves exact byte values across the full 48K range', () => {
    const cpu = makeCpu();
    const ram = new Uint8Array(49152);
    for (let i = 0; i < 49152; i++) ram[i] = (i * 7 + 13) & 0xFF;

    const data = buildSNA48K(cpu, ram, 0);
    const mem = makeMemory48k();
    loadSNA(data, new Z80(), mem);

    for (let i = 0; i < 49152; i++) {
      expect(mem.readByte(0x4000 + i)).toBe(ram[i]);
    }
  });
});

// ── 128K header loading ────────────────────────────────────────────────────

describe('SNA — 128K loading', () => {
  it('restores registers from header', () => {
    const cpu = makeCpu();
    const banks = make8Banks(() => 0);
    const data = buildSNA128K(cpu, banks, 0x07, 2);
    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory128k());

    expect(cpu2.i).toBe(0x1F);
    expect(cpu2.a).toBe(0x3E);
    expect(cpu2.f).toBe(0x44);
    expect(cpu2.a_).toBe(0xAA);
    expect(cpu2.iy).toBe(0x1234);
    expect(cpu2.ix).toBe(0x5678);
    expect(cpu2.r).toBe(0x81);
    expect(cpu2.im).toBe(1);
  });

  it('reads PC from extended header bytes 49179-49180', () => {
    const cpu = makeCpu();
    cpu.pc = 0xBEEF;
    const banks = make8Banks(() => 0);
    const data = buildSNA128K(cpu, banks, 0x07, 0);
    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory128k());
    expect(cpu2.pc).toBe(0xBEEF);
  });

  it('does not modify SP from stack pop (128K)', () => {
    const cpu = makeCpu();
    cpu.sp = 0xD000;
    const banks = make8Banks(() => 0);
    const data = buildSNA128K(cpu, banks, 0x07, 0);
    const cpu2 = new Z80();
    loadSNA(data, cpu2, makeMemory128k());
    expect(cpu2.sp).toBe(0xD000);
  });

  it('reads port7FFD from byte 49181', () => {
    const cpu = makeCpu();
    const banks = make8Banks(() => 0);
    const data = buildSNA128K(cpu, banks, 0x0B, 0);
    const cpu2 = new Z80();
    const result = loadSNA(data, cpu2, makeMemory128k());
    expect(result.port7FFD).toBe(0x0B);
  });

  it('reports is128K=true', () => {
    const cpu = makeCpu();
    const banks = make8Banks(() => 0);
    const data = buildSNA128K(cpu, banks, 0x07, 0);
    const result = loadSNA(data, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });
});

// ── 128K bank loading ──────────────────────────────────────────────────────

describe('SNA — 128K bank loading', () => {
  it('loads main 48K region into banks 5, 2, currentBank', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => b * 0x11);
    const data = buildSNA128K(cpu, banks, 0x07, 0);
    const mem = makeMemory128k();
    loadSNA(data, new Z80(), mem);

    expect(mem.getRamBank(5)[0]).toBe(0x55);
    expect(mem.getRamBank(2)[0]).toBe(0x22);
    expect(mem.getRamBank(7)[0]).toBe(0x77);
  });

  it('loads all extra banks skipping 5, 2, currentBank', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => b + 1);
    const data = buildSNA128K(cpu, banks, 0x07, 0);
    const mem = makeMemory128k();
    loadSNA(data, new Z80(), mem);

    for (let b = 0; b < 8; b++) {
      expect(mem.getRamBank(b)[0]).toBe(b + 1);
    }
  });

  it('handles currentBank = 0 (bank 0 is in main 48K, not extras)', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => b * 0x20);
    const data = buildSNA128K(cpu, banks, 0x00, 0);
    const mem = makeMemory128k();
    loadSNA(data, new Z80(), mem);

    expect(mem.getRamBank(0)[0]).toBe(0x00);
    expect(mem.getRamBank(2)[0]).toBe(0x40);
    expect(mem.getRamBank(5)[0]).toBe(0xA0);
  });

  it('handles currentBank = 2 (bank 2 occupies $8000 AND $C000, skipped from extras)', () => {
    // Per WoS spec: the third RAM bank saved is always the currently paged
    // one, even if it is 5 or 2. So when currentBank=2, bank 2 is written
    // both at $8000 and $C000 in the main 48K region; it is NOT repeated
    // in the trailing extras (which then number 6 instead of 5 — banks
    // 0, 1, 3, 4, 6, 7 — pushing the file size to 147487).
    const cpu = makeCpu();
    const banks = make8Banks((b) => b * 0x10);
    const data = buildSNA128K(cpu, banks, 0x02, 0);
    expect(data.length).toBe(49183 + 6 * 16384); // 147487
    const mem = makeMemory128k();
    loadSNA(data, new Z80(), mem);

    // All 8 banks must be correctly populated.
    for (let b = 0; b < 8; b++) {
      expect(mem.getRamBank(b)[0]).toBe(b * 0x10);
    }
  });

  it('handles currentBank = 5 (bank 5 occupies $4000 AND $C000, skipped from extras)', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => b * 0x10);
    const data = buildSNA128K(cpu, banks, 0x05, 0);
    expect(data.length).toBe(49183 + 6 * 16384); // 147487
    const mem = makeMemory128k();
    loadSNA(data, new Z80(), mem);

    for (let b = 0; b < 8; b++) {
      expect(mem.getRamBank(b)[0]).toBe(b * 0x10);
    }
  });

  it('applies paging state correctly', () => {
    const cpu = makeCpu();
    const banks = make8Banks(() => 0);
    const port7FFD = 0x17;
    const data = buildSNA128K(cpu, banks, port7FFD, 0);
    const mem = makeMemory128k();
    loadSNA(data, new Z80(), mem);

    expect(mem.port7FFD).toBe(0x17);
    expect(mem.currentBank).toBe(0x07);
    expect(mem.currentROM).toBe(1);
    expect(mem.pagingLocked).toBe(false);
  });

  it('sets pagingLocked when bit 5 of port7FFD is set', () => {
    const cpu = makeCpu();
    const banks = make8Banks(() => 0);
    const data = buildSNA128K(cpu, banks, 0x25, 0);
    const mem = makeMemory128k();
    loadSNA(data, new Z80(), mem);
    expect(mem.pagingLocked).toBe(true);
  });
});

// ── 48K save ───────────────────────────────────────────────────────────────

describe('SNA — 48K save', () => {
  it('writes correct header bytes', () => {
    const cpu = makeCpu();
    const mem = makeMemory48k();
    const saved = saveSNA(cpu, mem, 3);

    expect(saved[0]).toBe(cpu.i);
    expect(saved[1]).toBe(cpu.l_);
    expect(saved[2]).toBe(cpu.h_);
    expect(saved[7]).toBe(cpu.f_);
    expect(saved[8]).toBe(cpu.a_);
    expect(saved[9]).toBe(cpu.l);
    expect(saved[10]).toBe(cpu.h);
    expect(saved[21]).toBe(cpu.f);
    expect(saved[22]).toBe(cpu.a);
    expect(saved[25]).toBe(cpu.im);
    expect(saved[26]).toBe(3);
  });

  it('writes SP with PC pushed (SP - 2)', () => {
    const cpu = makeCpu();
    cpu.sp = 0xFF00;
    cpu.pc = 0x8000;
    const mem = makeMemory48k();
    const saved = saveSNA(cpu, mem, 0);

    const savedSP = saved[23] | (saved[24] << 8);
    expect(savedSP).toBe(0xFEFE);

    const pcLoOffset = 27 + (0xFEFE - 0x4000);
    const pcHiOffset = 27 + (0xFEFF - 0x4000);
    expect(saved[pcLoOffset]).toBe(0x00);
    expect(saved[pcHiOffset]).toBe(0x80);
  });

  it('writes IFF2 in bit 2 of byte 19', () => {
    const cpu = makeCpu();
    cpu.iff2 = true;
    const mem = makeMemory48k();
    const saved = saveSNA(cpu, mem, 0);
    expect(saved[19] & 0x04).toBe(0x04);

    cpu.iff2 = false;
    const saved2 = saveSNA(cpu, mem, 0);
    expect(saved2[19] & 0x04).toBe(0x00);
  });

  it('restores original stack bytes after save', () => {
    const cpu = makeCpu();
    cpu.sp = 0xFF00;
    cpu.pc = 0x8000;
    const mem = makeMemory48k();
    mem.writeByte(0xFEFF, 0x42);
    mem.writeByte(0xFF00, 0x43);

    saveSNA(cpu, mem, 0);

    expect(mem.readByte(0xFEFF)).toBe(0x42);
    expect(mem.readByte(0xFF00)).toBe(0x43);
  });

  it('dumps banks 5, 2, currentBank into bytes 27-49178', () => {
    const cpu = makeCpu();
    const mem = makeMemory48k();
    mem.getRamBank(5).fill(0x11);
    mem.getRamBank(2).fill(0x22);
    mem.getRamBank(0).fill(0x33);

    const saved = saveSNA(cpu, mem, 0);

    expect(saved[27]).toBe(0x11);
    expect(saved[27 + 16383]).toBe(0x11);
    expect(saved[27 + 16384]).toBe(0x22);
    expect(saved[27 + 32767]).toBe(0x22);
    expect(saved[27 + 32768]).toBe(0x33);
    expect(saved[27 + 49151]).toBe(0x33);
  });

  it('produces exactly 49179 bytes', () => {
    const cpu = makeCpu();
    const mem = makeMemory48k();
    const saved = saveSNA(cpu, mem, 0);
    expect(saved.length).toBe(49179);
  });
});

// ── 128K save ──────────────────────────────────────────────────────────────

describe('SNA — 128K save', () => {
  it('writes PC in extended header', () => {
    const cpu = makeCpu();
    cpu.pc = 0xBEEF;
    const mem = makeMemory128k();
    const saved = saveSNA(cpu, mem, 0);

    expect(saved[49179]).toBe(0xEF);
    expect(saved[49180]).toBe(0xBE);
  });

  it('writes port7FFD in extended header', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.port7FFD = 0x0B;
    mem.applyBanking();
    const saved = saveSNA(cpu, mem, 0);

    expect(saved[49181]).toBe(0x0B);
  });

  it('writes banks 5, 2, currentBank in main 48K region', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.getRamBank(5).fill(0x55);
    mem.getRamBank(2).fill(0x22);
    mem.getRamBank(7).fill(0x77);
    mem.port7FFD = 0x07;
    mem.currentBank = 7;
    mem.applyBanking();

    const saved = saveSNA(cpu, mem, 0);

    expect(saved[27]).toBe(0x55);
    expect(saved[27 + 16384]).toBe(0x22);
    expect(saved[27 + 32768]).toBe(0x77);
  });

  it('writes extra banks in order 0-7 skipping 5, 2, currentBank', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    for (let b = 0; b < 8; b++) mem.getRamBank(b).fill(b);
    mem.port7FFD = 0x07;
    mem.currentBank = 7;
    mem.applyBanking();

    const saved = saveSNA(cpu, mem, 0);
    let offset = 49183;
    const order: number[] = [];
    for (let b = 0; b < 8; b++) {
      if (b === 5 || b === 2 || b === 7) continue;
      order.push(b);
      expect(saved[offset]).toBe(b);
      offset += 16384;
    }
    expect(order).toEqual([0, 1, 3, 4, 6]);
  });

  it('produces 131103-byte file when currentBank is not 2 or 5', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.port7FFD = 0x07;
    mem.applyBanking();
    const saved = saveSNA(cpu, mem, 0);
    expect(saved.length).toBe(131103); // 49183 + 5 * 16384
  });

  it('produces 147487-byte file when currentBank is 2 (one fewer skipped bank in extras)', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.port7FFD = 0x02;
    mem.applyBanking();
    const saved = saveSNA(cpu, mem, 0);
    expect(saved.length).toBe(147487); // 49183 + 6 * 16384
  });

  it('produces 147487-byte file when currentBank is 5', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.port7FFD = 0x05;
    mem.applyBanking();
    const saved = saveSNA(cpu, mem, 0);
    expect(saved.length).toBe(147487);
  });

  it('writes TR-DOS flag as 0', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    const saved = saveSNA(cpu, mem, 0);
    expect(saved[49182]).toBe(0);
  });
});

// ── 48K full round-trip ────────────────────────────────────────────────────

describe('SNA — 48K full round-trip', () => {
  it('preserves all registers across save/load', () => {
    const cpu = makeCpu();
    cpu.sp = 0xFF00;
    const mem = makeMemory48k();
    mem.writeByte(0xFEFF, 0x00);
    mem.writeByte(0xFF00, 0x80);

    const saved = saveSNA(cpu, mem, 4);
    const cpu2 = new Z80();
    const mem2 = makeMemory48k();
    const result = loadSNA(saved, cpu2, mem2);

    expect(cpu2.i).toBe(cpu.i);
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
    expect(cpu2.iy).toBe(cpu.iy);
    expect(cpu2.ix).toBe(cpu.ix);
    expect(cpu2.r).toBe(cpu.r);
    expect(cpu2.im).toBe(cpu.im);
    expect(cpu2.iff1).toBe(cpu.iff1);
    expect(cpu2.iff2).toBe(cpu.iff2);
    expect(cpu2.pc).toBe(cpu.pc);
    expect(result.borderColor).toBe(4);
  });

  it('preserves all 48K memory contents (except 2 stack bytes overwritten by PC push)', () => {
    const cpu = makeCpu();
    cpu.sp = 0xFF00;
    cpu.pc = 0x8000;
    const mem = makeMemory48k();
    const bank5 = mem.getRamBank(5);
    const bank2 = mem.getRamBank(2);
    const bank0 = mem.getRamBank(0);
    for (let i = 0; i < 16384; i++) {
      bank5[i] = (i * 3 + 1) & 0xFF;
      bank2[i] = (i * 5 + 2) & 0xFF;
      bank0[i] = (i * 7 + 3) & 0xFF;
    }

    const saved = saveSNA(cpu, mem, 2);
    const cpu2 = new Z80();
    const mem2 = makeMemory48k();
    loadSNA(saved, cpu2, mem2);

    for (let i = 0; i < 16384; i++) {
      expect(mem2.getRamBank(5)[i]).toBe((i * 3 + 1) & 0xFF);
      expect(mem2.getRamBank(2)[i]).toBe((i * 5 + 2) & 0xFF);
    }

    const pushOffsetLo = (cpu.sp - 2) & 0xFFFF;
    const pushOffsetHi = (cpu.sp - 1) & 0xFFFF;
    for (let i = 0; i < 16384; i++) {
      const addr = 0xC000 + i;
      if (addr === pushOffsetLo || addr === pushOffsetHi) continue;
      expect(mem2.getRamBank(0)[i]).toBe((i * 7 + 3) & 0xFF);
    }
  });

  it('preserves border color across round-trip', () => {
    for (let bc = 0; bc < 8; bc++) {
      const cpu = makeCpu();
      const mem = makeMemory48k();
      const saved = saveSNA(cpu, mem, bc);
      const result = loadSNA(saved, new Z80(), makeMemory48k());
      expect(result.borderColor).toBe(bc);
    }
  });
});

// ── 128K full round-trip ───────────────────────────────────────────────────

describe('SNA — 128K full round-trip', () => {
  it('preserves all registers across save/load', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.port7FFD = 0x0B;
    mem.applyBanking();

    const saved = saveSNA(cpu, mem, 6);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    const result = loadSNA(saved, cpu2, mem2);

    expect(cpu2.a).toBe(cpu.a);
    expect(cpu2.f).toBe(cpu.f);
    expect(cpu2.pc).toBe(cpu.pc);
    expect(cpu2.sp).toBe(cpu.sp);
    expect(cpu2.i).toBe(cpu.i);
    expect(cpu2.r).toBe(cpu.r);
    expect(cpu2.im).toBe(cpu.im);
    expect(cpu2.iy).toBe(cpu.iy);
    expect(cpu2.ix).toBe(cpu.ix);
    expect(result.is128K).toBe(true);
    expect(result.port7FFD).toBe(0x0B);
    expect(result.borderColor).toBe(6);
  });

  it('preserves all 8 RAM banks', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    for (let b = 0; b < 8; b++) {
      const bank = mem.getRamBank(b);
      for (let i = 0; i < 16384; i++) {
        bank[i] = ((b * 16384 + i) * 3 + 7) & 0xFF;
      }
    }
    mem.port7FFD = 0x0B;
    mem.applyBanking();

    const saved = saveSNA(cpu, mem, 0);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    loadSNA(saved, cpu2, mem2);

    for (let b = 0; b < 8; b++) {
      const bank = mem2.getRamBank(b);
      for (let i = 0; i < 16384; i++) {
        expect(bank[i]).toBe(((b * 16384 + i) * 3 + 7) & 0xFF);
      }
    }
  });

  it('preserves port7FFD and paging state', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.port7FFD = 0x17;
    mem.applyBanking();

    const saved = saveSNA(cpu, mem, 0);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    loadSNA(saved, cpu2, mem2);

    expect(mem2.port7FFD).toBe(0x17);
    expect(mem2.currentBank).toBe(0x07);
    expect(mem2.currentROM).toBe(1);
  });

  it('preserves pagingLocked across round-trip', () => {
    const cpu = makeCpu();
    const mem = makeMemory128k();
    mem.port7FFD = 0x25;
    mem.applyBanking();

    const saved = saveSNA(cpu, mem, 0);
    const cpu2 = new Z80();
    const mem2 = makeMemory128k();
    loadSNA(saved, cpu2, mem2);

    expect(mem2.pagingLocked).toBe(true);
  });

  it('round-trips with different currentBank values (including 2 and 5)', () => {
    // Banks 2 and 5 are special: they also occupy the fixed main-region
    // slots, so when currentBank ∈ {2,5} the file size grows to 147487 and
    // the bank is written twice in the main 48K region but never in the
    // extras. Verify round-trip correctness for every possible value.
    for (const cb of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const cpu = makeCpu();
      const mem = makeMemory128k();
      for (let b = 0; b < 8; b++) mem.getRamBank(b).fill(b * 0x10);
      mem.port7FFD = cb;
      mem.currentBank = cb;
      mem.applyBanking();

      const saved = saveSNA(cpu, mem, 0);
      const cpu2 = new Z80();
      const mem2 = makeMemory128k();
      loadSNA(saved, cpu2, mem2);

      for (let b = 0; b < 8; b++) {
        expect(mem2.getRamBank(b)[0]).toBe(b * 0x10);
      }
    }
  });
});

// ── SP edge case: 48K save with PC push near stack boundaries ──────────────

describe('SNA — 48K SP edge cases', () => {
  it('handles SP near the bottom of RAM', () => {
    const cpu = makeCpu();
    cpu.sp = 0x4002;
    cpu.pc = 0x1234;
    const mem = makeMemory48k();

    const saved = saveSNA(cpu, mem, 0);
    const savedSP = saved[23] | (saved[24] << 8);
    expect(savedSP).toBe(0x4000);

    const pcLoOffset = 27 + (0x4000 - 0x4000);
    const pcHiOffset = 27 + (0x4001 - 0x4000);
    expect(saved[pcLoOffset]).toBe(0x34);
    expect(saved[pcHiOffset]).toBe(0x12);
  });

  it('handles SP = 0x0000 wrapping to 0xFFFE', () => {
    const cpu = makeCpu();
    cpu.sp = 0x0000;
    cpu.pc = 0xABCD;
    const mem = makeMemory48k();

    const saved = saveSNA(cpu, mem, 0);
    const savedSP = saved[23] | (saved[24] << 8);
    expect(savedSP).toBe(0xFFFE);

    const pcLoOffset = 27 + (0xFFFE - 0x4000);
    const pcHiOffset = 27 + (0xFFFF - 0x4000);
    expect(saved[pcLoOffset]).toBe(0xCD);
    expect(saved[pcHiOffset]).toBe(0xAB);
  });
});
