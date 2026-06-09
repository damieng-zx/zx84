/**
 * ULA contention / floating bus tests, built from documented external behaviour.
 *
 * References:
 *  - Sinclair Wiki, "Contended Memory": https://sinclair.wiki.zxnet.co.uk/wiki/Contended_memory
 *  - Sinclair Wiki, "Contended I/O": https://sinclair.wiki.zxnet.co.uk/wiki/Contended_I/O
 *  - FUSE tests/contention.c reference output (Phil Kendall)
 *  - Chris Smith, "The ZX Spectrum ULA" (2010)
 *  - Ramsoft "Spectrum 128K Technical Notes"
 *
 * The expectations here come from the docs first; if the implementation
 * disagrees, the failure is the news. Where our model returns the *extra*
 * T-states only (the base 4T of an IORQ is accounted for in the instruction
 * itself), the test computes the same quantity by hand from the documented
 * pattern.
 */

import { describe, it, expect } from 'vitest';
import { Contention, TIMING_48K, TIMING_128K, TIMING_PLUS2A } from '@/contention.ts';
import { SpectrumMemory } from '@/memory.ts';
import { spectrum48K } from '@/variants/spectrum-48k.ts';
import { spectrum16K } from '@/variants/spectrum-16k.ts';
import { createFerranti128K } from '@/variants/spectrum-ferranti.ts';
import { createAmstrad } from '@/variants/spectrum-amstrad.ts';
import { vramBitmapAddr, vramAttrAddr } from '@/cores/ula.ts';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function newContention(model: '48k' | '128k' | '+2A'): {
  c: Contention; mem: SpectrumMemory; bank: (n: number) => Uint8Array;
} {
  const variant = model === '48k'
    ? spectrum48K
    : model === '128k'
      ? createFerranti128K('128k')
      : createAmstrad('+2A');
  const mem = new SpectrumMemory(
    model as any,
    { hasBanking: variant.hasBanking, romPageCount: variant.romPageCount, is16K: false },
  );
  // Give it a tiny ROM stand-in so updateSlots populates slot 0 cleanly.
  const rom = new Uint8Array(64 * 1024);
  mem.loadROM(rom);
  const c = new Contention(variant, mem);
  c.frameStartTStates = 0;
  return {
    c,
    mem,
    bank: (n: number) => mem.getRamBank(n),
  };
}

/** Apply I/O contention to a "fake" CPU and return the extra T-states added. */
function ioDelta(c: Contention, port: number, beam: number): number {
  const fake = { tStates: beam };
  c.applyIOContention(port, fake);
  return fake.tStates - beam;
}

// ─────────────────────────────────────────────────────────────────────────
// Timing constants — sanity-check against documented values
// ─────────────────────────────────────────────────────────────────────────

describe('Documented timing constants', () => {
  it('48K: 224 T-states/line × 312 lines = 69888 T/frame, contention starts at 14335', () => {
    expect(TIMING_48K.tStatesPerLine).toBe(224);
    expect(TIMING_48K.tStatesPerFrame).toBe(69888);
    expect(TIMING_48K.tStatesPerLine * 312).toBe(TIMING_48K.tStatesPerFrame);
    expect(TIMING_48K.contentionStart).toBe(14335);
    expect(TIMING_48K.intLength).toBe(32);
  });

  it('128K Ferranti: 228 T-states/line × 311 lines = 70908, contention starts 14361', () => {
    expect(TIMING_128K.tStatesPerLine).toBe(228);
    expect(TIMING_128K.tStatesPerLine * 311).toBe(TIMING_128K.tStatesPerFrame);
    expect(TIMING_128K.contentionStart).toBe(14361);
    expect(TIMING_128K.intLength).toBe(36);
  });

  it('+2A/+3 Amstrad: same 228×311 frame as 128K, contention starts 14361', () => {
    expect(TIMING_PLUS2A.tStatesPerLine).toBe(228);
    expect(TIMING_PLUS2A.tStatesPerFrame).toBe(70908);
    expect(TIMING_PLUS2A.contentionStart).toBe(14361);
  });

  it('CPU clocks: 48K = 3.5 MHz, 128K/+2A/+3 = 3.546900 MHz', () => {
    expect(TIMING_48K.cpuClock).toBe(3_500_000);
    expect(TIMING_128K.cpuClock).toBe(3_546_900);
    expect(TIMING_PLUS2A.cpuClock).toBe(3_546_900);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Contention patterns — documented per-model values
// ─────────────────────────────────────────────────────────────────────────

describe('Contention pattern arrays — documented values', () => {
  it('48K / 128K Ferranti pattern is [6, 5, 4, 3, 2, 1, 0, 0]', () => {
    expect(Array.from(spectrum48K.contentionPattern))
      .toEqual([6, 5, 4, 3, 2, 1, 0, 0]);
    expect(Array.from(createFerranti128K('128k').contentionPattern))
      .toEqual([6, 5, 4, 3, 2, 1, 0, 0]);
  });

  it('+2A/+3 Amstrad pattern is [1, 0, 7, 6, 5, 4, 3, 2] (shifted by 1 from Ferranti)', () => {
    expect(Array.from(createAmstrad('+2A').contentionPattern))
      .toEqual([1, 0, 7, 6, 5, 4, 3, 2]);
  });

  it('16K uses the same Ferranti pattern as the 48K', () => {
    expect(Array.from(spectrum16K.contentionPattern))
      .toEqual([6, 5, 4, 3, 2, 1, 0, 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isContended — documented memory map per model
// ─────────────────────────────────────────────────────────────────────────

describe('isContended (memory map) — 48K', () => {
  it('only 0x4000-0x7FFF is contended; ROM and 0x8000-0xFFFF are not', () => {
    const { c } = newContention('48k');
    expect(c.isContended(0x0000)).toBe(false); // ROM
    expect(c.isContended(0x3FFF)).toBe(false);
    expect(c.isContended(0x4000)).toBe(true);
    expect(c.isContended(0x5800)).toBe(true);  // attr file
    expect(c.isContended(0x7FFF)).toBe(true);
    expect(c.isContended(0x8000)).toBe(false);
    expect(c.isContended(0xFFFF)).toBe(false);
  });
});

describe('isContended — 128K Ferranti (odd RAM banks 1,3,5,7)', () => {
  const { c, mem } = newContention('128k');

  it('slot 0 (ROM) is never contended', () => {
    expect(c.isContended(0x0000)).toBe(false);
  });

  it('slot 1 always shows bank 5 — contended', () => {
    expect(c.isContended(0x4000)).toBe(true);
  });

  it('slot 2 always shows bank 2 — NOT contended', () => {
    expect(c.isContended(0x8000)).toBe(false);
  });

  it('slot 3 is contended only when an odd bank is paged in', () => {
    mem.bankSwitch(0); // bank 0 → uncontended
    expect(c.isContended(0xC000)).toBe(false);
    mem.bankSwitch(1); // odd
    expect(c.isContended(0xC000)).toBe(true);
    mem.bankSwitch(4); // even
    expect(c.isContended(0xC000)).toBe(false);
    mem.bankSwitch(7); // odd
    expect(c.isContended(0xC000)).toBe(true);
  });
});

describe('isContended — +2A/+3 Amstrad (banks 4-7 are contended, by physical RAM chip)', () => {
  const { c, mem } = newContention('+2A');

  it('ROM is uncontended', () => {
    expect(c.isContended(0x0000)).toBe(false);
  });

  it('bank 5 in slot 1 is contended', () => {
    expect(c.isContended(0x4000)).toBe(true);
  });

  it('bank 2 in slot 2 is NOT contended (bank < 4)', () => {
    expect(c.isContended(0x8000)).toBe(false);
  });

  it('paging banks 0..7 in slot 3: banks 4-7 contended, 0-3 not', () => {
    for (let b = 0; b < 8; b++) {
      mem.bankSwitch(b);
      expect(c.isContended(0xC000)).toBe(b >= 4);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// contentionDelay — documented per-T pattern application
// ─────────────────────────────────────────────────────────────────────────

describe('contentionDelay — Ferranti 48K', () => {
  it('returns 0 before contentionStart (no display fetch yet)', () => {
    const { c } = newContention('48k');
    expect(c.contentionDelay(0)).toBe(0);
    expect(c.contentionDelay(14334)).toBe(0);
  });

  it('at T=14335 (first contended T), delay = pattern[0] = 6', () => {
    const { c } = newContention('48k');
    expect(c.contentionDelay(14335)).toBe(6);
  });

  it('walks the pattern across the first 8 T-states of line 0', () => {
    const { c } = newContention('48k');
    const expected = [6, 5, 4, 3, 2, 1, 0, 0];
    for (let i = 0; i < 8; i++) {
      expect(c.contentionDelay(14335 + i)).toBe(expected[i]);
    }
  });

  it('pattern repeats every 8 T-states for the 128 fetch T-states of the line', () => {
    const { c } = newContention('48k');
    for (let cell = 0; cell < 16; cell++) {
      expect(c.contentionDelay(14335 + cell * 8 + 0)).toBe(6);
      expect(c.contentionDelay(14335 + cell * 8 + 7)).toBe(0);
    }
  });

  it('returns 0 once the line passes col 128 (border/blanking)', () => {
    const { c } = newContention('48k');
    expect(c.contentionDelay(14335 + 128)).toBe(0);
    expect(c.contentionDelay(14335 + 223)).toBe(0);
  });

  it('line 1 starts at T = 14335 + 224', () => {
    const { c } = newContention('48k');
    expect(c.contentionDelay(14335 + 224)).toBe(6);
  });

  it('after line 191 (last display line) — no further contention', () => {
    const { c } = newContention('48k');
    const lastLineStart = 14335 + 191 * 224;
    expect(c.contentionDelay(lastLineStart)).toBe(6); // last contended line
    expect(c.contentionDelay(lastLineStart + 224)).toBe(0); // next line is border
  });
});

describe('contentionDelay — +2A/+3 Amstrad', () => {
  it('pattern starts with 1 not 6 at the first contended T', () => {
    const { c } = newContention('+2A');
    expect(c.contentionDelay(14361)).toBe(1);
  });

  it('full pattern at the first cell is [1, 0, 7, 6, 5, 4, 3, 2]', () => {
    const { c } = newContention('+2A');
    const expected = [1, 0, 7, 6, 5, 4, 3, 2];
    for (let i = 0; i < 8; i++) {
      expect(c.contentionDelay(14361 + i)).toBe(expected[i]);
    }
  });

  it('next line (228T later) restarts the pattern', () => {
    const { c } = newContention('+2A');
    expect(c.contentionDelay(14361 + 228)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// I/O contention 4-case rule — Ferranti
// ─────────────────────────────────────────────────────────────────────────

describe('I/O contention — Ferranti 4-case rule at beam where pattern[col0]=6', () => {
  // Test all four documented combinations at T = contentionStart, where the
  // pattern is at its strongest. The "extra" T-states added are computed
  // straight from the docs:
  //
  //   [C:1][C:3]      → δ(T) + δ(T + 1 + δ(T))             (no extra base T)
  //   [C:1][C:1][C:1][C:1] → 4 samples, each "C:1"
  //   [N:1][C:3]      → 1 normal, 1 sample
  //   [N:4]           → 0
  //
  // (Our applyIOContention does not advance by the base 4T of the IO cycle —
  // that's accounted for in the instruction. It only adds the contention extras.)

  it('Case 1 (contended addr + ULA port, A0=0): adds 6 T-states at beam 14335', () => {
    // δ(14335)=6, then advance 1; δ(14335+6+1=14342)=pattern[col 7]=0
    // total extra = 6 + 0 = 6
    const { c } = newContention('48k');
    expect(ioDelta(c, 0x4000, 14335)).toBe(6);
  });

  it('Case 2 (contended addr + non-ULA port, A0=1): adds 12 T-states at beam 14335', () => {
    // δ(14335)=6, advance 1 → 14342; δ=0, advance 1 → 14343
    // δ(14343)=pattern[col 8 → col 0]=6, advance 1 → 14350; δ=0; advance ‑3
    // Net extras: 6 + 0 + 6 + 0 = 12
    const { c } = newContention('48k');
    expect(ioDelta(c, 0x4001, 14335)).toBe(12);
  });

  it('Case 3 (non-contended addr + ULA port): adds 5 T-states at beam 14335', () => {
    // N:1 → advance 1, then C:3 samples at 14336 → δ=5; net extra = 5
    const { c } = newContention('48k');
    expect(ioDelta(c, 0x0000, 14335)).toBe(5);
  });

  it('Case 4 (non-contended addr + non-ULA port): adds 0 T-states', () => {
    const { c } = newContention('48k');
    expect(ioDelta(c, 0x0001, 14335)).toBe(0);
  });

  it('offsetIntoCycle anchors the probes at the IORQ cycle start', () => {
    // INs invoke the port handler 3T into the IORQ cycle (late sample point),
    // but the contention probes are defined from the cycle START. An IN whose
    // cycle began at 14335, calling at 14338 with offset 3, must add exactly
    // what an OUT calling at 14335 adds: δ(14335)=6. Without the anchor the
    // probe would land on pattern[3]=3 — so this fails if the offset is lost.
    const { c } = newContention('48k');
    expect(ioDelta(c, 0x4000, 14335)).toBe(6);
    const fake = { tStates: 14338 };
    c.applyIOContention(0x4000, fake, 3);
    expect(fake.tStates - 14338).toBe(6);
  });

  it('all four cases add 0 outside contention window (before frame T=14335)', () => {
    const { c } = newContention('48k');
    expect(ioDelta(c, 0x4000, 0)).toBe(0);
    expect(ioDelta(c, 0x4001, 0)).toBe(0);
    expect(ioDelta(c, 0x0000, 0)).toBe(0);
    expect(ioDelta(c, 0x0001, 0)).toBe(0);
  });
});

describe('I/O contention — +2A/+3 Amstrad has NO IO contention', () => {
  // Documented: the Amstrad gate array only applies contention while MREQ is
  // active. IO cycles (IORQ) do not assert MREQ, so contention does not apply.
  // Every port access takes a flat 4T regardless of the beam position.
  it('contended-class address + ULA port still adds 0 at the heaviest beam', () => {
    const { c } = newContention('+2A');
    expect(ioDelta(c, 0x4000, 14361)).toBe(0);
    expect(ioDelta(c, 0x4001, 14361)).toBe(0);
    expect(ioDelta(c, 0x0000, 14361)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Floating bus reads — documented per FUSE & Sinclair Wiki
// ─────────────────────────────────────────────────────────────────────────

describe('Floating bus — 48K (Ferranti)', () => {
  it('returns 0xFF before display fetch begins', () => {
    const { c, bank } = newContention('48k');
    // Screen bank for 48K is bank 5 (which lives at 0x4000-0x7FFF logically)
    // We'll fill bank 5 with a recognisable pattern.
    bank(5).fill(0xAA);
    expect(c.floatingBusRead(0, bank(5))).toBe(0xFF);
    expect(c.floatingBusRead(14000, bank(5))).toBe(0xFF);
  });

  it('returns 0xFF after the 192 display lines complete', () => {
    const { c, bank } = newContention('48k');
    bank(5).fill(0xAA);
    // With 48K floatingBusAdjust = -1, the first T at which (offset/224)|0 >= 192
    // is contentionStart + 1 + 192*224 = 57345.
    const t = 14335 + 1 + 192 * 224;
    expect(c.floatingBusRead(t, bank(5))).toBe(0xFF);
    // Also covers the post-display path at the start of line 192 col 0.
    expect(c.floatingBusRead(t + 4, bank(5))).toBe(0xFF);
  });

  it('returns the pixel byte during the first half of each 4-T cell', () => {
    // 48K floatingBusAdjust = -1, so the bus shows the LAST fetched byte:
    // at beam T = contentionStart, offset = -1, would underflow → returns 0xFF.
    // The first valid floating-bus T-state is therefore contentionStart + 1.
    const { c, bank } = newContention('48k');
    const screen = bank(5);
    // Mark the first pixel byte uniquely
    const pixelAddr = vramBitmapAddr(0) - 0x4000;
    screen[pixelAddr] = 0x42;
    // At T = 14336, offset = 0, col=0, phase=0 → pixel byte of line 0 col 0
    expect(c.floatingBusRead(14336, screen)).toBe(0x42);
    // T = 14337, offset = 1, col=1, phase=1 → still pixel (phase < 2)
    expect(c.floatingBusRead(14337, screen)).toBe(0x42);
  });

  it('returns the attribute byte during the second half of each 4-T cell', () => {
    const { c, bank } = newContention('48k');
    const screen = bank(5);
    const attrAddr = vramAttrAddr(0, 0) - 0x4000;
    screen[attrAddr] = 0x47; // bright white ink
    // T = 14338, offset = 2, col=2, phase=2 → attribute byte of line 0 col 0
    expect(c.floatingBusRead(14338, screen)).toBe(0x47);
    expect(c.floatingBusRead(14339, screen)).toBe(0x47); // phase 3 also attr
  });

  it('reads progress across columns through one scanline', () => {
    const { c, bank } = newContention('48k');
    const screen = bank(5);
    // Different value in each column's pixel byte
    for (let col = 0; col < 32; col++) {
      screen[vramBitmapAddr(0) - 0x4000 + col] = 0x80 | col;
    }
    for (let col = 0; col < 32; col++) {
      const t = 14336 + col * 4;
      expect(c.floatingBusRead(t, screen)).toBe(0x80 | col);
    }
  });

  it('returns 0xFF during border T-states within a display line', () => {
    // 48K fetch window in absolute T is documented as 14336..14463 inclusive
    // (the 128 fetch T-states). After 14463 the beam crosses into the right
    // border and no more bus fetches occur until the next line.
    const { c, bank } = newContention('48k');
    bank(5).fill(0x99);
    expect(c.floatingBusRead(14464, bank(5))).toBe(0xFF);
    expect(c.floatingBusRead(14500, bank(5))).toBe(0xFF);
  });
});

describe('Floating bus — 128K/+2A use positive adjustment (+1)', () => {
  // 128K and +2A both report bus values one T-state earlier in the cycle
  // because the bus pipeline delay is opposite to 48K.
  it('128K: at T = contentionStart + 1, the previous beam slot has already advanced past col 0', () => {
    const { c, bank } = newContention('128k');
    // 128K's screen bank is also bank 5 by default
    const screen = bank(5);
    const pixelAddr = vramBitmapAddr(0) - 0x4000;
    screen[pixelAddr] = 0x33;
    // floatingBusAdjust = +1: offset = T - contentionStart + 1
    // At T=contentionStart-1, offset = 0 → col 0, phase 0 → pixel byte
    expect(c.floatingBusRead(14360, screen)).toBe(0x33);
    // Before that, offset < 0 → 0xFF
    expect(c.floatingBusRead(14359, screen)).toBe(0xFF);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-frame behaviour
// ─────────────────────────────────────────────────────────────────────────

describe('frameStartTStates anchors all relative timing', () => {
  it('shifting frameStartTStates moves the contention window with it', () => {
    const { c } = newContention('48k');
    c.frameStartTStates = 1_000_000;
    // Same relative T = 14335 from the new frame start
    expect(c.contentionDelay(1_000_000 + 14335)).toBe(6);
    // Absolute T below new frame start is in the previous frame → 0
    expect(c.contentionDelay(999_999)).toBe(0);
  });
});
