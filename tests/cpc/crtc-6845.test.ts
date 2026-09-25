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

  it('reports 200 displayed lines for a standard 25-row display', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    expect(c.displayedLines()).toBe(200); // R6·(R9+1) = 25·8
  });

  it('reports a taller displayed height for a vertical-overscan display', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    setReg(c, R_VERT_DISPLAYED, 32);      // 32 rows of overscan
    expect(c.displayedLines()).toBe(256); // 32·8 — would overflow the bottom if
                                          // anchored at the fixed top border
  });

  it('falls back to 200 displayed lines while R6 is still unprogrammed', () => {
    const c = new Crtc6845(0);            // all registers zero → R6·(R9+1) = 0
    expect(c.displayedLines()).toBe(200);
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

  it('R16/R17 (light pen position) are read-only — writes are ignored', () => {
    // Real hardware latches these from a light-pen strobe, never from the
    // CPU; nothing here models a light pen, so they simply never change.
    const c = new Crtc6845(0);
    setReg(c, 16, 0x55);
    c.selectRegister(16);
    expect(c.readRegister()).toBe(0);
    setReg(c, 17, 0x66);
    c.selectRegister(17);
    expect(c.readRegister()).toBe(0);
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

  it('asserts VSYNC on the first scanline of character row R7 itself', () => {
    // 6845: VSYNC rises at the start of the raster where VCC = R7, RA = 0, so
    // PPI port B bit 0 must already read 1 while that scanline runs.
    const c = new Crtc6845(0);
    programStandard(c);                    // R7=30, R9=7 → row 30 at scanline 240
    c.beginFrame();
    for (let line = 0; line < 239; line++) {
      c.advanceLine();
      expect(c.vsyncActive, `scanline ${line + 1}`).toBe(false);
    }
    c.advanceLine();                       // enter scanline 240 (vcc=30, ra=0)
    expect(c.currentLine().ra).toBe(0);
    expect(c.vsyncActive).toBe(true);
    expect(c.vsyncStart).toBe(true);       // the single onset scanline
    c.advanceLine();                       // scanline 241
    expect(c.vsyncStart).toBe(false);
    expect(c.vsyncActive).toBe(true);
  });

  it('holds VSYNC for exactly the R3 high-nibble width, scanlines 240..247', () => {
    const c = new Crtc6845(0);
    programStandard(c);                    // R3=0x8E → VSYNC width 8 lines
    c.beginFrame();
    const active: number[] = [];
    for (let line = 0; line < 312; line++) {
      if (c.vsyncActive) active.push(line);
      c.advanceLine();
    }
    expect(active).toEqual([240, 241, 242, 243, 244, 245, 246, 247]);
  });

  it('starts VSYNC on the first scanline of the frame when R7 = 0', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    setReg(c, R_VSYNC_POS, 0);
    c.beginFrame();
    expect(c.vsyncActive).toBe(true);
    expect(c.vsyncStart).toBe(true);
  });

  it('places the HSYNC trailing edge at R2 + HSYNC width characters', () => {
    const c = new Crtc6845(0);
    programStandard(c);                    // R3 low nibble = 14
    setReg(c, 2, 46);                      // standard R2
    expect(c.hsyncEndChar()).toBe(60);     // 46 + 14
    setReg(c, 2, 70);                      // R2 past R0: clamped to line end
    expect(c.hsyncEndChar()).toBe(64);
  });
});

describe('CRTC 6845 — frame restart & rupture', () => {
  /** Count scanlines until the frame restarts (MA reloaded to base at a row top). */
  function linesUntilRestart(c: Crtc6845, base: number): number {
    let lines = 0;
    do {
      c.advanceLine();
      lines++;
    } while (!(c.currentLine().maRow === base && c.currentLine().ra === 0) && lines < 1000);
    return lines;
  }

  it('restarts the frame after (R4+1)·(R9+1) scanlines, reloading MA from R12/R13', () => {
    const c = new Crtc6845(0);
    programStandard(c);                    // R4=38, R9=7, R5=0
    setReg(c, R_DISPLAY_START_H, 0x30);
    setReg(c, R_DISPLAY_START_L, 0x00);
    c.beginFrame();
    expect(c.currentLine().maRow).toBe(0x3000);
    expect(linesUntilRestart(c, 0x3000)).toBe(39 * 8);   // 312
    expect(c.currentLine().maRow).toBe(0x3000);          // reloaded from R12/R13
  });

  it('runs R5 vertical-adjust scanlines before the restart', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    setReg(c, R_VERT_ADJUST, 6);           // R5 = 6 extra scanlines
    setReg(c, R_DISPLAY_START_H, 0x30);
    setReg(c, R_DISPLAY_START_L, 0x00);
    c.beginFrame();
    expect(linesUntilRestart(c, 0x3000)).toBe(39 * 8 + 6);   // 318
  });

  it('restarts early when R4 is reduced mid-frame (rupture), reloading the new R12/R13', () => {
    const c = new Crtc6845(0);
    programStandard(c);                    // R4=38
    setReg(c, R_DISPLAY_START_H, 0x30);
    setReg(c, R_DISPLAY_START_L, 0x00);
    c.beginFrame();
    for (let i = 0; i < 80; i++) c.advanceLine();   // 10 character rows
    expect(c.currentLine().maRow).toBe(0x3000 + 10 * 40);   // row-10 base

    // Mid-frame: shorten the frame and point the screen at a new base.
    setReg(c, R_VERT_TOTAL, 10);           // R4 now equals the current row
    setReg(c, R_DISPLAY_START_H, 0x00);    // new base 0x0000
    setReg(c, R_DISPLAY_START_L, 0x00);

    for (let i = 0; i < 8; i++) c.advanceLine();    // finish row 10 → restart
    expect(c.currentLine().maRow).toBe(0x0000);     // lines below use the new base
    expect(c.currentLine().ra).toBe(0);
  });

  it('R9 written below the live raster counter runs RA on to 31 and wraps', () => {
    // Equality compare: RA=5 with R9 now 2 never matches until RA wraps
    // 31 → 0 and counts back up to 2. Lines from RA=5: 6..31 (26), 0,1,2 (3),
    // then the row ends → 30 advances to reach the next row's RA=0.
    const c = new Crtc6845(0);
    programStandard(c);
    c.beginFrame();
    for (let i = 0; i < 5; i++) c.advanceLine();
    expect(c.currentLine().ra).toBe(5);
    setReg(c, R_MAX_RASTER, 2);
    c.advanceLine();
    expect(c.currentLine().ra).toBe(6);            // did not end the row
    for (let i = 0; i < 25; i++) c.advanceLine();
    expect(c.currentLine().ra).toBe(31);
    c.advanceLine();
    expect(c.currentLine().ra).toBe(0);            // 5-bit wrap, same row
    expect(c.currentLine().maRow).toBe(0);
    for (let i = 0; i < 3; i++) c.advanceLine();   // RA 1, 2, then row end
    expect(c.currentLine().ra).toBe(0);
    expect(c.currentLine().maRow).toBe(40);        // next character row
  });

  it('R4 written below the live row counter runs VCC on to 127 and wraps', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    setReg(c, R_MAX_RASTER, 0);                    // one scanline per row
    setReg(c, R_HORIZ_DISPLAYED, 1);               // MA row = VCC (mod wrap)
    c.beginFrame();
    for (let i = 0; i < 20; i++) c.advanceLine();  // VCC = 20
    setReg(c, R_VERT_TOTAL, 10);                   // below the live VCC
    // 20 → 127 is 107 rows, wrap to 0, then 0 → 10 and the restart after row 10:
    // no restart for 107 + 1 + 10 lines, restart on the next one.
    for (let i = 0; i < 118; i++) {
      c.advanceLine();
      expect(c.currentLine().maRow, `line ${i}`).toBe((21 + i) & 0x3FFF);
    }
    c.advanceLine();
    expect(c.currentLine().maRow).toBe(0);         // restarted from R12/R13 = 0
  });

  it('latches R12/R13 at the restart, not per scanline (static base is unchanged)', () => {
    const c = new Crtc6845(0);
    programStandard(c);
    setReg(c, R_DISPLAY_START_H, 0x30);
    setReg(c, R_DISPLAY_START_L, 0x00);
    c.beginFrame();
    // Within a frame, MA advances by R1 each row and is NOT re-seeded from R12/R13
    // (writing R13 mid-row must not shift the current row's address).
    for (let i = 0; i < 8; i++) c.advanceLine();
    setReg(c, R_DISPLAY_START_L, 0x40);    // change base mid-frame
    expect(c.currentLine().maRow).toBe(0x3000 + 40);   // current row unaffected
  });
});
