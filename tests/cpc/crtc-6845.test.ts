/**
 * CRTC 6845 raster sequencing for the CPC.
 *
 * Expectations are derived from the 6845 datasheet and the standard Amstrad CPC
 * CRTC programming, NOT from the implementation. Standard CPC values:
 *   R0=63 (64 chars/line), R1=40, R4=38 (39 char rows), R5=0, R6=25,
 *   R7=30 (VSYNC pos), R9=7 (8 rasters/row), R3=0x8E (VSYNC width 8).
 * That yields 64 chars/line and 312 scanlines/frame, with VSYNC starting at the
 * first scanline of character row 30 (scanline 30·8 = 240).
 */

import { describe, it, expect } from 'vitest';
import {
  Crtc6845,
  R_HORIZ_TOTAL, R_HORIZ_DISPLAYED, R_SYNC_WIDTHS, R_VERT_TOTAL,
  R_VERT_ADJUST, R_VERT_DISPLAYED, R_VSYNC_POS, R_MAX_RASTER,
  R_DISPLAY_START_H, R_DISPLAY_START_L,
} from '@/cores/crtc-6845.ts';

/** Program a register through the real select/write access path. */
function setReg(c: Crtc6845, reg: number, val: number): void {
  c.selectRegister(reg);
  c.writeRegister(val);
}

/** Standard Amstrad CPC firmware 6845 register set. */
function programStandard(c: Crtc6845): void {
  setReg(c, R_HORIZ_TOTAL, 63);     // R0 → 64 chars/line
  setReg(c, R_HORIZ_DISPLAYED, 40); // R1
  setReg(c, R_SYNC_WIDTHS, 0x8E);   // R3 → VSYNC width 8, HSYNC width 14
  setReg(c, R_VERT_TOTAL, 38);      // R4 → 39 char rows
  setReg(c, R_VERT_ADJUST, 0);      // R5
  setReg(c, R_VERT_DISPLAYED, 25);  // R6
  setReg(c, R_VSYNC_POS, 30);       // R7
  setReg(c, R_MAX_RASTER, 7);       // R9 → 8 rasters/row
}

describe('CRTC 6845 — frame geometry', () => {
  it('reports 64 chars/line and 312 lines/frame for standard CPC programming', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    expect(c.charsPerLine()).toBe(64);    // R0 + 1
    expect(c.linesPerFrame()).toBe(312);  // (R4+1)·(R9+1) + R5 = 39·8 + 0
  });

  it('adds the R5 vertical total adjust to the frame line count', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    setReg(c, R_VERT_ADJUST, 6);          // 6 extra padding scanlines
    expect(c.linesPerFrame()).toBe(39 * 8 + 6);
  });

  it('decodes the 14-bit display start from R12:R13', () => {
    const c = new Crtc6845(0);
    setReg(c, R_DISPLAY_START_H, 0x30);
    setReg(c, R_DISPLAY_START_L, 0x00);
    expect(c.displayStart).toBe(0x3000);  // standard CPC screen base
    setReg(c, R_DISPLAY_START_H, 0xFF);   // only the low 6 bits of R12 count
    setReg(c, R_DISPLAY_START_L, 0xFF);
    expect(c.displayStart).toBe(0x3FFF);  // masked to 14 bits
  });
});

describe('CRTC 6845 — register access', () => {
  it('reads back only R12–R17; write-only registers read 0', () => {
    const c = new Crtc6845(0);
    setReg(c, R_HORIZ_TOTAL, 63);
    c.selectRegister(R_HORIZ_TOTAL);
    expect(c.readRegister()).toBe(0);     // R0 is write-only
    setReg(c, R_DISPLAY_START_L, 0x42);
    c.selectRegister(R_DISPLAY_START_L);
    expect(c.readRegister()).toBe(0x42);  // R13 is readable
  });

  it('makes R10/R11 readable only on a type-1 CRTC', () => {
    const t0 = new Crtc6845(0);
    setReg(t0, 10, 0x55);
    t0.selectRegister(10);
    expect(t0.readRegister()).toBe(0);    // HD6845S (type 0): no read-back
    const t1 = new Crtc6845(1);
    setReg(t1, 10, 0x55);
    t1.selectRegister(10);
    expect(t1.readRegister()).toBe(0x55); // UM6845R (type 1): readable
  });

  it('masks the register select to 5 bits', () => {
    const c = new Crtc6845(0);
    setReg(c, R_DISPLAY_START_L, 0x12);   // R13
    c.selectRegister(13 + 0x20);          // 0x2D → masks to 13
    expect(c.readRegister()).toBe(0x12);
  });
});

describe('CRTC 6845 — raster sequencing', () => {
  it('cycles the raster counter 0..R9 within a character row', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    c.beginFrame();
    for (let ra = 0; ra <= 7; ra++) {
      expect(c.currentLine().ra).toBe(ra);
      c.advanceLine();
    }
    expect(c.currentLine().ra).toBe(0);   // wrapped into the next row
  });

  it('advances the memory address by R1 each character row', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    setReg(c, R_DISPLAY_START_H, 0x30);
    setReg(c, R_DISPLAY_START_L, 0x00);
    c.beginFrame();
    expect(c.currentLine().maRow).toBe(0x3000);
    for (let i = 0; i < 8; i++) c.advanceLine();   // one full character row
    expect(c.currentLine().maRow).toBe(0x3000 + 40);
    expect(c.currentLine().ra).toBe(0);
  });

  it('asserts VSYNC at the first scanline of character row R7', () => {
    const c = new Crtc6845(0);
    programStandard(c);                    // R7=30, R9=7 → row 30 at scanline 240
    c.beginFrame();
    for (let line = 0; line < 240; line++) {
      expect(c.vsyncActive).toBe(false);   // scanlines 0..239 are display/border
      c.advanceLine();
    }
    expect(c.vsyncActive).toBe(false);     // at scanline 240, before the check
    c.advanceLine();                       // advancing out of (vcc=30, ra=0)
    expect(c.vsyncActive).toBe(true);
    expect(c.vsyncStart).toBe(true);       // the single onset scanline
  });

  it('holds VSYNC for the width programmed in R3 (type-1 honours the nibble)', () => {
    const c = new Crtc6845(1);             // UM6845R honours R3 high nibble
    programStandard(c);                    // R3=0x8E → VSYNC width 8 lines
    c.beginFrame();
    for (let i = 0; i < 240; i++) c.advanceLine();
    let active = 0;
    for (let i = 0; i < 24; i++) {         // sweep well past the sync window
      c.advanceLine();
      if (c.vsyncActive) active++;
    }
    expect(active).toBe(8);                // exactly 8 scanlines of VSYNC
  });
});
