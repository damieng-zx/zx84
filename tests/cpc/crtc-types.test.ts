/**
 * Per-type 6845 behaviour as fitted to the CPC.
 *
 * Expectations come from CPCWiki's "CRTC" page (register read/write table,
 * &BExx function per type, R3/R8 per type, DISPTMG/VBORDER notes, UM6845R
 * specifics) and "Extra CPC Plus Hardware Information" (the Plus CRTC's read
 * map and status registers), not from the implementation:
 *   - type 0 (HD6845S/UM6845): R12–R17 read back, R31 does not exist (0).
 *   - type 1 (UM6845R): R12/R13 write-only (0), R31 reads &FF, status on &BExx
 *     with bit 5 set from VCC = R6 until VCC = 0; R6 = 0 forces the border;
 *     R12/R13 re-read at every line start while VCC = 0.
 *   - type 2 (MC6845): VSYNC fixed at 16 lines, HSYNC width 0 means 16.
 *   - types 3/4 (ASIC/Pre-ASIC): reads repeat every 8 registers as R16, R17,
 *     status 1, status 2, R12, R13, 0, 0; &BExx = &BFxx; VCC = R6 is only
 *     compared at the start of a character row.
 *   - types 0/1: HSYNC width 0 = no HSYNC. Types 0/3/4: R8 skew 3 = no display.
 */

import { describe, it, expect } from 'vitest';
import { Crtc6845, type CrtcType } from '@/cores/crtc-6845.ts';

function setReg(c: Crtc6845, reg: number, val: number): void {
  c.selectRegister(reg);
  c.writeRegister(val);
}

function read(c: Crtc6845, reg: number): number {
  c.selectRegister(reg);
  return c.readRegister();
}

/** Standard CPC firmware programming: 64 × 312, 25 rows of 8 lines. */
function standard(type: CrtcType): Crtc6845 {
  const c = new Crtc6845(type);
  const vals: [number, number][] = [
    [0, 63], [1, 40], [2, 46], [3, 0x8E], [4, 38], [5, 0], [6, 25], [7, 30], [9, 7],
    [12, 0x30], [13, 0x00],
  ];
  for (const [r, v] of vals) setReg(c, r, v);
  return c;
}

function advance(c: Crtc6845, lines: number): void {
  for (let i = 0; i < lines; i++) c.advanceLine();
}

describe('CRTC register read-back per type', () => {
  it('type 0 reads R12/R13 back; R31 does not exist and reads 0', () => {
    const c = standard(0);
    expect(read(c, 12)).toBe(0x30);
    expect(read(c, 13)).toBe(0x00);
    expect(read(c, 31)).toBe(0);
    expect(read(c, 18)).toBe(0);
  });

  it('type 1 reads R14/R15 back, R12/R13 as 0, and the dummy R31 as &FF', () => {
    const c = standard(1);
    setReg(c, 14, 0x12);
    setReg(c, 15, 0x34);
    expect(read(c, 14)).toBe(0x12);
    expect(read(c, 15)).toBe(0x34);
    expect(read(c, 12)).toBe(0);
    expect(read(c, 30)).toBe(0);
    expect(read(c, 31)).toBe(0xFF);
  });

  it('type 2 reads R31 as 0 (no dummy register)', () => {
    expect(read(standard(2), 31)).toBe(0);
  });

  it('types 3/4 map every 8 registers to R16, R17, status 1, status 2, R12, R13, 0, 0', () => {
    for (const type of [3, 4] as const) {
      const c = standard(type);
      setReg(c, 13, 0x42);
      setReg(c, 14, 0x15);                    // R14 exists but index 14 reads 0
      c.regs[16] = 0x07;                      // light pen latch (CPU read-only)
      c.regs[17] = 0x99;
      for (const base of [0, 8, 16, 24]) {
        expect(read(c, base + 0), `type ${type} index ${base}`).toBe(0x07);
        expect(read(c, base + 1)).toBe(0x99);
        expect(read(c, base + 4)).toBe(0x30);
        expect(read(c, base + 5)).toBe(0x42);
        expect(read(c, base + 6)).toBe(0);
        expect(read(c, base + 7)).toBe(0);
      }
    }
  });

  it('types 3/4 answer &BExx with the selected register, as &BFxx', () => {
    const c = standard(3);
    c.selectRegister(12);
    expect(c.readStatus()).toBe(0x30);
  });
});

describe('UM6845R (type 1) status register on &BExx', () => {
  it('bit 5 is clear in the display, set from VCC = R6, and clears at the next frame', () => {
    const c = standard(1);
    c.beginFrame();
    expect(c.readStatus()).toBe(0x00);
    advance(c, 25 * 8 - 1);                   // last line of row 24
    expect(c.readStatus()).toBe(0x00);
    c.advanceLine();                          // row 25 = R6: vertical border
    expect(c.readStatus()).toBe(0x20);
    advance(c, 312 - 200);                    // through the restart at row 0
    expect(c.readStatus()).toBe(0x00);
  });
});

describe('Plus CRTC (type 3) status registers', () => {
  it('status 2: bit 7 set only on raster 0, bit 5 clear only on the row\'s last raster (R9)', () => {
    const c = standard(3);
    c.beginFrame();
    expect(read(c, 3) & 0xA0).toBe(0xA0);     // RA 0: bit 7 = 1, RA != R9: bit 5 = 1
    c.advanceLine();
    expect(read(c, 3) & 0xA0).toBe(0x20);     // RA 1
    advance(c, 6);
    expect(read(c, 3) & 0xA0).toBe(0x00);     // RA 7 = R9
  });

  it('status 1: bit 0 set only at HCC = R0, bit 3 clear at HCC = R2, bit 2 clear at HCC = R1', () => {
    const c = standard(3);
    c.beginFrame();
    c.hcc = 63;
    expect(read(c, 2) & 0x01).toBe(0x01);
    c.hcc = 10;
    expect(read(c, 2) & 0x0D).toBe(0x0C);     // bit 0 clear, bits 2/3 set
    c.hcc = 46;
    expect(read(c, 2) & 0x08).toBe(0);
    c.hcc = 40;
    expect(read(c, 2) & 0x04).toBe(0);
  });
});

describe('HSYNC width 0 and R2 beyond R0', () => {
  it('width 0 is no HSYNC on types 0 and 1, but 16 characters on types 2 and 3', () => {
    for (const [type, present] of [[0, false], [1, false], [2, true], [3, true]] as const) {
      const c = standard(type);
      setReg(c, 3, 0x80);
      expect(c.hsyncPresent, `type ${type}`).toBe(present);
    }
  });

  it('an HSYNC position past the horizontal total never starts an HSYNC', () => {
    const c = standard(0);
    expect(c.hsyncPresent).toBe(true);
    setReg(c, 2, 64);                         // R0 = 63
    expect(c.hsyncPresent).toBe(false);
  });
});

describe('VSYNC width per type', () => {
  it('type 2 holds VSYNC 16 lines whatever R3 says; type 3 uses the programmed 8', () => {
    for (const [type, lines] of [[2, 16], [3, 8]] as const) {
      const c = standard(type);               // R3 = 0x8E
      c.beginFrame();
      let active = 0;
      for (let i = 0; i < 312; i++) { if (c.vsyncActive) active++; c.advanceLine(); }
      expect(active, `type ${type}`).toBe(lines);
    }
  });

  it('switching to type 1 drops the VSYNC width nibble', () => {
    const c = standard(0);
    c.setType(1);
    expect(c.regs[3]).toBe(0x0E);
  });
});

describe('R8 DISPTMG skew 3', () => {
  it('forces the display off on types 0, 3 and 4 but not on 1 and 2', () => {
    for (const [type, off] of [[0, true], [1, false], [2, false], [3, true], [4, true]] as const) {
      const c = standard(type);
      setReg(c, 8, 0x30);
      expect(c.displaySkewOff, `type ${type}`).toBe(off);
    }
  });

  it('skew 1 or 2 does not blank the display', () => {
    const c = standard(0);
    setReg(c, 8, 0x10);
    expect(c.displaySkewOff).toBe(false);
  });
});

describe('Vertical display (VCC = R6)', () => {
  it('R6 lowered below the live row leaves the display on until the frame restarts', () => {
    // The 6845 compares VCC = R6 for equality: a value already passed is missed.
    const c = standard(0);
    c.beginFrame();
    advance(c, 10 * 8);                       // row 10
    setReg(c, 6, 5);
    c.advanceLine();
    expect(c.inVerticalDisplay).toBe(true);
    advance(c, 312 - 81);                     // restart at row 0, then...
    expect(c.inVerticalDisplay).toBe(true);
    advance(c, 5 * 8);                        // ...row 5 = R6 ends it
    expect(c.inVerticalDisplay).toBe(false);
  });

  it('R6 set to the current row mid-row: type 0 ends the display on the next line, type 3 not until the frame ends', () => {
    // Types 0/1/2 test VCC = R6 all the time; types 3/4 only at a row start.
    for (const [type, onNext] of [[0, false], [3, true]] as const) {
      const c = standard(type);
      c.beginFrame();
      advance(c, 10 * 8 + 3);                 // row 10, raster 3
      setReg(c, 6, 10);
      c.advanceLine();
      expect(c.inVerticalDisplay, `type ${type}`).toBe(onNext);
    }
  });

  it('R6 = 0 forces the border on type 1 at once, and the display returns when R6 is restored', () => {
    const c = standard(1);
    c.beginFrame();
    advance(c, 3 * 8);
    setReg(c, 6, 0);
    expect(c.inVerticalDisplay).toBe(false);
    setReg(c, 6, 25);
    expect(c.inVerticalDisplay).toBe(true);   // the flip-flop never cleared
  });

  it('R6 = 0 written mid-frame on type 0 does not end the display (VCC is past 0)', () => {
    const c = standard(0);
    c.beginFrame();
    advance(c, 3 * 8);
    setReg(c, 6, 0);
    c.advanceLine();
    expect(c.inVerticalDisplay).toBe(true);
  });
});

describe('UM6845R R12/R13 re-read in row 0', () => {
  it('type 1 picks up a new screen base on the next line while VCC = 0; type 0 waits for the next frame', () => {
    for (const [type, expected] of [[1, 0x1000], [0, 0x3000]] as const) {
      const c = standard(type);
      c.beginFrame();
      advance(c, 2);                          // row 0, raster 2
      setReg(c, 12, 0x10);
      c.advanceLine();
      expect(c.rowAddress, `type ${type}`).toBe(expected);
    }
  });

  it('type 1 does not re-read R12/R13 below row 0', () => {
    const c = standard(1);
    c.beginFrame();
    advance(c, 8 + 2);                        // row 1, raster 2
    setReg(c, 12, 0x10);
    c.advanceLine();
    expect(c.rowAddress).toBe(0x3000 + 40);
  });
});
