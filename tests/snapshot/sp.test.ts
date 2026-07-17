import { describe, it, expect } from 'vitest';
import { loadSP } from '@/machines/spectrum/snapshots/sp.ts';
import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/machines/spectrum/memory.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function w16(buf: Uint8Array, o: number, v: number): void {
  buf[o] = v & 0xFF;
  buf[o + 1] = (v >> 8) & 0xFF;
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
  cpu.r = 0x81;
  cpu.i = 0x1F;
  cpu.iff1 = true;
  cpu.iff2 = true;
  cpu.im = 1;
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

/** Build the 38-byte SP header (no RAM). */
function buildHeader(
  cpu: Z80,
  options: {
    progLen?: number;
    progLoc?: number;
    borderColor?: number;
    statusWord?: number;
  } = {}
): Uint8Array {
  const h = new Uint8Array(38);
  h[0] = 0x53; h[1] = 0x50; // 'SP'
  w16(h, 2, options.progLen ?? 49152);
  w16(h, 4, options.progLoc ?? 0x4000);

  w16(h, 6, (cpu.b << 8) | cpu.c);   // BC
  w16(h, 8, (cpu.d << 8) | cpu.e);   // DE
  w16(h, 10, (cpu.h << 8) | cpu.l);  // HL
  w16(h, 12, (cpu.a << 8) | cpu.f);  // AF
  w16(h, 14, cpu.ix);
  w16(h, 16, cpu.iy);

  w16(h, 18, (cpu.b_ << 8) | cpu.c_); // BC'
  w16(h, 20, (cpu.d_ << 8) | cpu.e_); // DE'
  w16(h, 22, (cpu.h_ << 8) | cpu.l_); // HL'
  w16(h, 24, (cpu.a_ << 8) | cpu.f_); // AF'

  h[26] = cpu.r;
  h[27] = cpu.i;
  w16(h, 28, cpu.sp);
  w16(h, 30, cpu.pc);
  // 32-33 reserved
  h[34] = options.borderColor ?? 0;
  // 35 reserved
  w16(h, 36, options.statusWord ?? 0x0005); // IFF1 + IFF2 + IM1 (status=5)
  return h;
}

/** Build a full 48K SP snapshot (header + 49152-byte RAM). */
function buildSP48K(cpu: Z80, ram: Uint8Array, opts: { borderColor?: number; statusWord?: number } = {}): Uint8Array {
  const header = buildHeader(cpu, opts);
  const out = new Uint8Array(38 + 49152);
  out.set(header, 0);
  out.set(ram, 38);
  return out;
}

/** Build a 128K SP: header + 49152 main RAM + port7FFD + extras. */
function buildSP128K(
  cpu: Z80,
  banks: Uint8Array[],
  port7FFD: number,
  opts: { borderColor?: number; statusWord?: number } = {}
): Uint8Array {
  const cb = port7FFD & 0x07;
  // Count extras: skip 5, 2, cb (deduplicated)
  const extras: number[] = [];
  for (let b = 0; b < 8; b++) {
    if (b === 5 || b === 2 || b === cb) continue;
    extras.push(b);
  }
  const totalLen = 38 + 49152 + 1 + extras.length * 16384;
  const out = new Uint8Array(totalLen);
  out.set(buildHeader(cpu, opts), 0);

  // Main 48K region: bank 5 at $4000, bank 2 at $8000, currentBank at $C000.
  out.set(banks[5], 38);
  out.set(banks[2], 38 + 16384);
  out.set(banks[cb], 38 + 32768);

  out[38 + 49152] = port7FFD;

  let off = 38 + 49152 + 1;
  for (const b of extras) {
    out.set(banks[b], off);
    off += 16384;
  }
  return out;
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

// ── Loading errors / signature ─────────────────────────────────────────────

describe('SP — loading errors', () => {
  it('rejects a file smaller than 38 bytes', () => {
    expect(() => loadSP(new Uint8Array(37), new Z80(), makeMemory48k()))
      .toThrow('File too small');
  });

  it('rejects a file without the "SP" magic', () => {
    const bad = new Uint8Array(49190);
    bad[0] = 0x53; bad[1] = 0x51; // 'SQ' instead of 'SP'
    expect(() => loadSP(bad, new Z80(), makeMemory48k())).toThrow('Invalid .sp signature');
  });

  it('accepts a minimal valid header + zero RAM', () => {
    // progLen=0 with no RAM payload — file is just the 38-byte header.
    const cpu = makeCpu();
    const data = buildHeader(cpu, { progLen: 0 });
    expect(() => loadSP(data, new Z80(), makeMemory48k())).not.toThrow();
  });
});

// ── Header parsing (registers, border, status word) ───────────────────────

describe('SP — register restoration', () => {
  it('restores main and alternate registers', () => {
    const cpu = makeCpu();
    const data = buildSP48K(cpu, new Uint8Array(49152));
    const cpu2 = new Z80();
    loadSP(data, cpu2, makeMemory48k());

    expect(cpu2.a).toBe(0x3E); expect(cpu2.f).toBe(0x44);
    expect(cpu2.b).toBe(0x10); expect(cpu2.c).toBe(0x20);
    expect(cpu2.d).toBe(0x30); expect(cpu2.e).toBe(0x40);
    expect(cpu2.h).toBe(0x50); expect(cpu2.l).toBe(0x60);
    expect(cpu2.a_).toBe(0xAA); expect(cpu2.f_).toBe(0x55);
    expect(cpu2.b_).toBe(0x11); expect(cpu2.c_).toBe(0x22);
    expect(cpu2.d_).toBe(0x33); expect(cpu2.e_).toBe(0x44);
    expect(cpu2.h_).toBe(0x55); expect(cpu2.l_).toBe(0x66);
    expect(cpu2.ix).toBe(0x5678); expect(cpu2.iy).toBe(0x1234);
    expect(cpu2.sp).toBe(0xFFFE); expect(cpu2.pc).toBe(0x8000);
    expect(cpu2.r).toBe(0x81); expect(cpu2.i).toBe(0x1F);
  });
});

describe('SP — border colour', () => {
  it('extracts border colour from byte 34', () => {
    for (let bc = 0; bc < 8; bc++) {
      const cpu = makeCpu();
      const data = buildSP48K(cpu, new Uint8Array(49152), { borderColor: bc });
      const result = loadSP(data, new Z80(), makeMemory48k());
      expect(result.borderColor).toBe(bc);
    }
  });

  it('masks the border byte to its low 3 bits', () => {
    const cpu = makeCpu();
    const data = buildSP48K(cpu, new Uint8Array(49152), { borderColor: 0xFF });
    const result = loadSP(data, new Z80(), makeMemory48k());
    expect(result.borderColor).toBe(0x07);
  });
});

describe('SP — status word interrupt flags', () => {
  // Status word bit layout (per WoS / komkon FAQ):
  //   bit 0 = IFF1
  //   bit 1 = IM2 selector (when bit 3 reset: 0=IM1, 1=IM2)
  //   bit 2 = IFF2
  //   bit 3 = IM0 selector (overrides bit 1 when set)
  //   bit 4 = interrupt pending at snapshot time
  //   bit 5 = ULA flash phase at snapshot time

  it.each([
    [0b0000_0001, true,  false, 1],  // IFF1 only, IM1
    [0b0000_0100, false, true,  1],  // IFF2 only, IM1
    [0b0000_0101, true,  true,  1],  // both, IM1
    [0b0000_0000, false, false, 1],  // neither, IM1
  ])('statusWord %s → iff1=%s iff2=%s im=%i', (status, iff1, iff2, im) => {
    const cpu = makeCpu();
    const data = buildSP48K(cpu, new Uint8Array(49152), { statusWord: status });
    const cpu2 = new Z80();
    loadSP(data, cpu2, makeMemory48k());
    expect(cpu2.iff1).toBe(iff1);
    expect(cpu2.iff2).toBe(iff2);
    expect(cpu2.im).toBe(im);
  });

  it('bit 1 (IM2 selector) sets IM2 when bit 3 is clear', () => {
    const cpu = makeCpu();
    const data = buildSP48K(cpu, new Uint8Array(49152), { statusWord: 0b0000_0010 });
    const cpu2 = new Z80();
    loadSP(data, cpu2, makeMemory48k());
    expect(cpu2.im).toBe(2);
  });

  it('bit 3 (IM0) overrides bit 1', () => {
    const cpu = makeCpu();
    // bit 1 set (would be IM2) AND bit 3 set (forces IM0) → IM0 wins.
    const data = buildSP48K(cpu, new Uint8Array(49152), { statusWord: 0b0000_1010 });
    const cpu2 = new Z80();
    loadSP(data, cpu2, makeMemory48k());
    expect(cpu2.im).toBe(0);
  });

  it('bit 5 (flash phase) round-trips into the loader result', () => {
    // Flash is the ULA's 16-frame phase counter; the SP format captures the
    // current phase so visuals resume in sync with the saved frame.
    const cpu = makeCpu();
    const onData  = buildSP48K(cpu, new Uint8Array(49152), { statusWord: 0b0010_0001 });
    const offData = buildSP48K(cpu, new Uint8Array(49152), { statusWord: 0b0000_0001 });
    expect(loadSP(onData,  new Z80(), makeMemory48k()).flashState).toBe(true);
    expect(loadSP(offData, new Z80(), makeMemory48k()).flashState).toBe(false);
  });

  it('bit 4 (interrupt pending) does not corrupt parsing of other status bits', () => {
    // The Spectrum frame loop reasserts INT every frame and tracks its pending
    // state across the int window, so the loader does not need to re-latch a
    // pending interrupt. The test verifies bit 4 is genuinely a no-op rather
    // than something that leaks into IFF/IM parsing.
    const cpu = makeCpu();
    // 0b0001_1100: bit 0 clear, bit 2 set (IFF2), bit 3 set (IM0), bit 4 set.
    const data = buildSP48K(cpu, new Uint8Array(49152), { statusWord: 0b0001_1100 });
    const cpu2 = new Z80();
    loadSP(data, cpu2, makeMemory48k());
    expect(cpu2.iff1).toBe(false);
    expect(cpu2.iff2).toBe(true);
    expect(cpu2.im).toBe(0);
  });
});

// ── 48K RAM loading ───────────────────────────────────────────────────────

describe('SP — 48K standard layout (progLoc=0x4000, progLen=49152)', () => {
  it('loads bytes into banks 5, 2, 0 at $4000/$8000/$C000', () => {
    const cpu = makeCpu();
    const ram = new Uint8Array(49152);
    for (let i = 0; i < 16384; i++) ram[i] = 0x11;
    for (let i = 16384; i < 32768; i++) ram[i] = 0x22;
    for (let i = 32768; i < 49152; i++) ram[i] = 0x33;
    const data = buildSP48K(cpu, ram);
    const mem = makeMemory48k();
    loadSP(data, new Z80(), mem);

    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x7FFF)).toBe(0x11);
    expect(mem.readByte(0x8000)).toBe(0x22);
    expect(mem.readByte(0xBFFF)).toBe(0x22);
    expect(mem.readByte(0xC000)).toBe(0x33);
    expect(mem.readByte(0xFFFF)).toBe(0x33);
  });

  it('reports is128K=false and port7FFD=0', () => {
    const cpu = makeCpu();
    const data = buildSP48K(cpu, new Uint8Array(49152));
    const result = loadSP(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
    expect(result.port7FFD).toBe(0);
  });
});

describe('SP — 48K non-standard layout', () => {
  it('loads a partial dump at a non-default address via writeByte (paging-aware)', () => {
    const cpu = makeCpu();
    // 1KB starting at $8000.
    const payload = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) payload[i] = (i * 5 + 1) & 0xFF;
    const header = buildHeader(cpu, { progLen: 1024, progLoc: 0x8000 });
    const data = new Uint8Array(38 + 1024);
    data.set(header, 0);
    data.set(payload, 38);

    const mem = makeMemory48k();
    const result = loadSP(data, new Z80(), mem);
    expect(result.is128K).toBe(false);
    for (let i = 0; i < 1024; i++) {
      expect(mem.readByte(0x8000 + i)).toBe((i * 5 + 1) & 0xFF);
    }
    // Other addresses untouched.
    expect(mem.readByte(0x4000)).toBe(0);
    expect(mem.readByte(0xC000)).toBe(0);
  });

  it('wraps progLoc + index modulo 0x10000 for addresses that overflow', () => {
    const cpu = makeCpu();
    // progLoc=0xFFFE, progLen=4 — final two bytes wrap to 0x0000 and 0x0001
    // (ROM region). The loader uses & 0xFFFF, so this must not crash.
    const header = buildHeader(cpu, { progLen: 4, progLoc: 0xFFFE });
    const data = new Uint8Array(38 + 4);
    data.set(header, 0);
    data[38] = 0xAA; data[39] = 0xBB; data[40] = 0xCC; data[41] = 0xDD;

    const mem = makeMemory48k();
    expect(() => loadSP(data, new Z80(), mem)).not.toThrow();
    // 0xFFFE and 0xFFFF map to bank 0 (RAM) and are writable.
    expect(mem.readByte(0xFFFE)).toBe(0xAA);
    expect(mem.readByte(0xFFFF)).toBe(0xBB);
  });
});

// ── 128K detection and loading ────────────────────────────────────────────

describe('SP — 128K detection', () => {
  it('detects 128K when the file is larger than the declared 48K program', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => (b + 1) * 0x10);
    const data = buildSP128K(cpu, banks, 0x07, {});
    const result = loadSP(data, new Z80(), makeMemory128k());
    expect(result.is128K).toBe(true);
  });

  it('does NOT misdetect a basic 49190-byte 48K file as 128K', () => {
    const cpu = makeCpu();
    const data = buildSP48K(cpu, new Uint8Array(49152));
    expect(data.length).toBe(49190);
    const result = loadSP(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });

  it('treats a partial 48K (smaller progLen, exact file size match) as 48K', () => {
    const cpu = makeCpu();
    // progLen=1024, file length = 38 + 1024 = 1062, exactly matches.
    const header = buildHeader(cpu, { progLen: 1024, progLoc: 0x4000 });
    const data = new Uint8Array(38 + 1024);
    data.set(header, 0);
    const result = loadSP(data, new Z80(), makeMemory48k());
    expect(result.is128K).toBe(false);
  });
});

describe('SP — 128K bank loading', () => {
  it('loads all 8 banks for currentBank=7', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => (b + 1) * 0x11);
    const data = buildSP128K(cpu, banks, 0x07);
    const mem = makeMemory128k();
    const result = loadSP(data, new Z80(), mem);
    expect(result.is128K).toBe(true);
    expect(result.port7FFD).toBe(0x07);
    for (let b = 0; b < 8; b++) {
      expect(mem.getRamBank(b)[0]).toBe((b + 1) * 0x11);
    }
  });

  it('handles currentBank=2 (extras list omits bank 2; file is 147495 bytes)', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => b * 0x10 + 1);
    const data = buildSP128K(cpu, banks, 0x02);
    expect(data.length).toBe(38 + 49152 + 1 + 6 * 16384); // 147495
    const mem = makeMemory128k();
    loadSP(data, new Z80(), mem);
    for (let b = 0; b < 8; b++) {
      expect(mem.getRamBank(b)[0]).toBe(b * 0x10 + 1);
    }
  });

  it('handles currentBank=5 (extras list omits bank 5; file is 147495 bytes)', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => b * 0x20 + 7);
    const data = buildSP128K(cpu, banks, 0x05);
    expect(data.length).toBe(38 + 49152 + 1 + 6 * 16384);
    const mem = makeMemory128k();
    loadSP(data, new Z80(), mem);
    for (let b = 0; b < 8; b++) {
      expect(mem.getRamBank(b)[0]).toBe(b * 0x20 + 7);
    }
  });

  it('restores paging state from port7FFD', () => {
    const cpu = makeCpu();
    const banks = make8Banks(() => 0);
    // port7FFD = 0x17 = bank 7, ROM 1, unlocked.
    const data = buildSP128K(cpu, banks, 0x17);
    const mem = makeMemory128k();
    loadSP(data, new Z80(), mem);

    expect(mem.port7FFD).toBe(0x17);
    expect(mem.currentBank).toBe(7);
    expect(mem.currentROM).toBe(1);
    expect(mem.pagingLocked).toBe(false);
  });

  it('restores pagingLocked when port7FFD bit 5 is set', () => {
    const cpu = makeCpu();
    const banks = make8Banks(() => 0);
    const data = buildSP128K(cpu, banks, 0x25); // bit 5 set
    const mem = makeMemory128k();
    loadSP(data, new Z80(), mem);
    expect(mem.pagingLocked).toBe(true);
  });

  it('gracefully truncates when extras are missing from a malformed 128K file', () => {
    const cpu = makeCpu();
    const banks = make8Banks((b) => b + 1);
    const full = buildSP128K(cpu, banks, 0x07);
    // Lop off the last 2 extra banks (32KB).
    const truncated = full.slice(0, full.length - 2 * 16384);

    const mem = makeMemory128k();
    expect(() => loadSP(truncated, new Z80(), mem)).not.toThrow();
    // First 3 extras (after 5/2/7 main) loaded; the last 2 stay at default 0.
    // The exact identity of the loaded vs missing extras depends on the
    // ordering 0,1,3,4,6 — first three are 0,1,3 (loaded), last two are
    // 4 and 6 (missing).
    expect(mem.getRamBank(0)[0]).toBe(0 + 1);
    expect(mem.getRamBank(1)[0]).toBe(1 + 1);
    expect(mem.getRamBank(3)[0]).toBe(3 + 1);
    expect(mem.getRamBank(4)[0]).toBe(0); // truncated
    expect(mem.getRamBank(6)[0]).toBe(0); // truncated
  });
});
