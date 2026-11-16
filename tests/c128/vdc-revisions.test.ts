/**
 * The VDC's chip revision and the things that depend on it or on how it is
 * wired: the smooth scroll's zero point (R22 >> 4 on the 8563 R8/R9 and the
 * 8568, 0 on the early R7A) and its direction (raising R25 moves the picture
 * right), double-pixel mode (the "40 columns"), the display stop and line
 * count, the RAM addressing modes (R28 bit 4), the light pen's counters, the
 * bits that read as 1, and what a block copy leaves for a fill.
 */

import { describe, it, expect } from 'vitest';
import { Vdc, VDC_RAM_64K } from '@/machines/c128/vdc.ts';
import { renderVdc, VDC_FRAME_HEIGHT, VDC_FRAME_WIDTH, VDC_PALETTE } from '@/machines/c128/vdc-display.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const FG = VDC_PALETTE[15];
const BG = VDC_PALETTE[1];
const X0 = 32;
const Y0 = 24;

function setReg(v: Vdc, reg: number, value: number): void {
  v.write(0, reg);
  v.write(1, value);
}
function getReg(v: Vdc, reg: number): number {
  v.write(0, reg);
  return v.read(1);
}
function setUpdate(v: Vdc, addr: number): void {
  setReg(v, 18, addr >> 8);
  setReg(v, 19, addr & 0xFF);
}
function put(v: Vdc, ...bytes: number[]): void {
  v.write(0, 31);
  for (const b of bytes) v.write(1, b);
}

/** The editor's 80-column set-up without attributes, character set at $2000. */
function editor(chip: number = 0x4000): Vdc {
  const v = new Vdc(chip);
  const regs: [number, number][] = [
    [1, 80], [6, 25], [9, 7], [22, 0x78], [23, 8], [26, 0xF1], [28, 0x20], [29, 7], [10, 0x20],
  ];
  for (const [r, value] of regs) v.regs[r] = value;
  return v;
}
function frame(v: Vdc): Uint32Array {
  const out = new Uint32Array(VDC_FRAME_WIDTH * VDC_FRAME_HEIGHT);
  renderVdc(v, out);
  return out;
}
const at = (f: Uint32Array, x: number, y: number): number => f[y * VDC_FRAME_WIDTH + x];
/** Character 1 is a pixel at the top left of the cell, and screen cell 0 holds it. */
function litCell(v: Vdc, ...lines: number[]): void {
  v.ram.set(lines.length > 0 ? lines : [0x80], 0x2000 + 16);
  v.ram[0] = 1;
}

describe('VDC smooth scroll by chip version', () => {
  function lit(version: number, r25: number): Vdc {
    const v = editor();
    v.version = version;
    v.regs[25] = r25;
    litCell(v);
    return v;
  }

  it('leaves the picture where it is at R22 >> 4 on an 8563 R8/R9 or an 8568 (the editor\'s $07 for an 8-pixel cell)', () => {
    for (const version of [1, 2]) {
      const f = frame(lit(version, 0x07));
      expect(at(f, X0, Y0), `version ${version}`).toBe(FG);
      expect(at(f, X0 - 1, Y0)).toBe(BG);
    }
  });

  it('moves it right when R25 goes up and left when it comes down, on the later chips', () => {
    const right = frame(lit(1, 0x09));              // 2 above the unscrolled 7
    expect(at(right, X0 + 2, Y0)).toBe(FG);
    expect(at(right, X0, Y0)).toBe(BG);
    const left = frame(lit(2, 0x04));               // 3 below it
    expect(at(left, X0 - 3, Y0)).toBe(FG);
    expect(at(left, X0, Y0)).toBe(BG);
  });

  it('is unscrolled at 0 on the early R7A, and moves right from there', () => {
    expect(at(frame(lit(0, 0x00)), X0, Y0)).toBe(FG);
    expect(at(frame(lit(0, 0x03)), X0 + 3, Y0)).toBe(FG);
  });
});

describe('VDC double-pixel mode (R25 bit 4: the "40 columns")', () => {
  /** 40 cells of the 8-pixel font in a 2 x 8 = 16-pixel pitch, as the 40-column program sets it. */
  function forty(): Vdc {
    const v = editor();
    v.version = 1;
    v.regs[1] = 40;
    v.regs[22] = 0x89;            // 8 doubled pixels a cell; the ninth is out of reach
    v.regs[25] = 0x10 | 0x08;     // double-pixel; scroll 8 = the unscrolled R22 >> 4
    litCell(v, 0xA0);
    v.ram[1] = 1;
    return v;
  }

  it('makes every font pixel two wide and the cell twice R22 >> 4 across', () => {
    const f = frame(forty());
    const x0 = (VDC_FRAME_WIDTH - 40 * 16) >> 1;
    // $A0: pixels 0 and 2 on.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(x => at(f, x0 + x, Y0))).toEqual([FG, FG, BG, BG, FG, FG, BG, BG]);
    expect(at(f, x0 + 16, Y0), 'the next cell is 16 on').toBe(FG);
  });

  it('stays inside the frame however many cells are asked for (R1 = 255)', () => {
    const v = forty();
    v.regs[1] = 255;
    v.regs[22] = 0xF8;
    expect(frame(v).length).toBe(VDC_FRAME_WIDTH * VDC_FRAME_HEIGHT);
  });
});

describe('VDC cell display stop (R22 low nibble) and the lines shown (R23)', () => {
  it('shows one pixel more than the low nibble when it is below the cell width, none when it equals it, the cell when above', () => {
    const shown = (r22: number): number => {
      const v = editor();
      v.regs[1] = 40;
      v.regs[22] = r22;
      v.regs[25] = r22 >> 4;                    // unscrolled on this chip
      litCell(v, 0xFF);
      const x0 = (VDC_FRAME_WIDTH - 40 * ((r22 >> 4) + 1)) >> 1;
      const f = frame(v);
      let n = 0;
      for (let x = 0; x < (r22 >> 4) + 1; x++) if (at(f, x0 + x, Y0) === FG) n++;
      return n;
    };
    expect(shown(0x63), '3 below 6: 4 pixels').toBe(4);
    expect(shown(0x66), 'the same: none').toBe(0);
    expect(shown(0x78), 'above: the cell').toBe(8);
  });

  it('shows R23 + 1 scan lines of the cell', () => {
    const v = editor();
    v.regs[23] = 0;
    v.regs[25] = 0x07;
    litCell(v, 0x80, 0x80);
    const f = frame(v);
    expect(at(f, X0, Y0)).toBe(FG);
    expect(at(f, X0, Y0 + 1), 'only the first line').toBe(BG);
  });
});

describe('VDC chip revision in the ports', () => {
  it('is an 8563 R8/R9 (version 1) unless fitted otherwise, and the editor reads it from the status register', () => {
    expect(new Vdc().version).toBe(1);
    const v = new Vdc();
    v.version = 2;
    expect(v.read(0) & 7).toBe(2);
  });

  it('is kept in a snapshot', () => {
    const a = new Vdc();
    a.version = 2;
    const w = new StateWriter();
    a.saveState(w);
    const b = new Vdc();
    b.loadState(new StateReader(w.finish()));
    expect(b.version).toBe(2);
  });
});

describe('VDC RAM addressing (R28 bit 4)', () => {
  it('is linear when the mode matches the chip, a 16K chip wrapping at 16K', () => {
    const big = new Vdc(VDC_RAM_64K);
    setReg(big, 28, 0x10);
    setUpdate(big, 0x4000);
    put(big, 0x77);
    expect(big.ram[0x4000]).toBe(0x77);
    const small = new Vdc(0x4000);
    setReg(small, 28, 0);
    setUpdate(small, 0x4000);
    put(small, 0x66);
    expect(small.ram[0]).toBe(0x66);
  });

  it('puts a 64K chip in 16K mode out of order: page 1 is at page 3, page 2 at 4, page 3 at 7', () => {
    const v = new Vdc(VDC_RAM_64K);
    setReg(v, 28, 0);
    for (const [logical, physical] of [[0, 0], [1, 3], [2, 4], [3, 7], [4, 8], [5, 11]] as const) {
      setUpdate(v, logical << 8);
      put(v, 0x40 + logical);
      expect(v.ram[physical << 8], `logical page ${logical}`).toBe(0x40 + logical);
    }
  });

  it('drops bit 8 of the address and halves the page on a 16K chip in 64K mode: pages come in pairs', () => {
    const v = new Vdc(0x4000);
    setReg(v, 28, 0x10);
    setUpdate(v, 0x0100);
    put(v, 0x21);
    setUpdate(v, 0x0200);
    put(v, 0x22);
    expect(v.ram[0x0000], '$0100 is in the same page as $0000').toBe(0x21);
    expect(v.ram[0x0100], '$0200 is the next one on').toBe(0x22);
  });
});

describe('VDC registers the light pen owns and the bits that read as 1', () => {
  it('ignores writes to R16 and R17 (the pen\'s counters)', () => {
    const v = new Vdc();
    setReg(v, 16, 0x55);
    setReg(v, 17, 0x66);
    expect([getReg(v, 16), getReg(v, 17)]).toEqual([0, 0]);
  });

  it('reads the unused bits of R8, R9, R23 and R29 as 1', () => {
    const v = new Vdc();
    for (const [reg, ones] of [[8, 0xFC], [9, 0xE0], [23, 0xE0], [29, 0xE0]] as const) {
      setReg(v, reg, 0);
      expect(getReg(v, reg), `R${reg}`).toBe(ones);
    }
  });

  it('leaves the last byte it copied as the byte a fill writes next', () => {
    const v = new Vdc();
    setUpdate(v, 0);
    put(v, 0x11, 0x22, 0x33);
    setReg(v, 24, 0x80);                       // copy
    setReg(v, 32, 0); setReg(v, 33, 0);
    setUpdate(v, 0x100);
    setReg(v, 30, 3);
    setReg(v, 24, 0);                          // fill, with no data written
    setUpdate(v, 0x200);
    setReg(v, 30, 2);
    expect(Array.from(v.ram.subarray(0x200, 0x203))).toEqual([0x33, 0x33, 0]);
  });
});
