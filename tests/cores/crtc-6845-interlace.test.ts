/**
 * 6845 interlace sync-and-video (R8 bits 1:0 = 11): the raster address steps by
 * two, so R9 is the last *even* raster and a character row lasts (R9/2)+1
 * scanlines of a field. That is how the BBC's Mode 7 (R4=30, R9=18, R5=2)
 * fits a 312-line, 50 Hz field; without it the frame would run 591 lines.
 * Reference: Motorola MC6845 datasheet, "Interlace Mode"; BBC Micro AUG ch. 18.
 */

import { describe, it, expect } from 'vitest';
import { Crtc6845 } from '@/cores/crtc-6845.ts';

function program(c: Crtc6845, regs: Record<number, number>): void {
  for (const [r, v] of Object.entries(regs)) {
    c.selectRegister(Number(r));
    c.writeRegister(v);
  }
}

/** Scanlines between consecutive VSYNC onsets after the first. */
function vsyncPeriods(c: Crtc6845, lines: number): number[] {
  const starts: number[] = [];
  c.beginFrame();
  for (let line = 0; line < lines; line++) {
    c.advanceLine();
    if (c.vsyncStart) starts.push(line);
  }
  return starts.slice(1).map((l, i) => l - starts[i]);
}

describe('6845 interlace sync-and-video', () => {
  it('runs a 312-line frame with the BBC Mode 7 registers (R8=0x93, R9=18)', () => {
    const c = new Crtc6845(0);
    program(c, { 3: 0x28, 4: 30, 5: 2, 6: 25, 7: 28, 8: 0x93, 9: 18 });
    expect(c.interlaceVideo).toBe(true);
    expect(c.linesPerFrame()).toBe(312);
    const periods = vsyncPeriods(c, 312 * 5);
    expect(periods.length).toBeGreaterThan(2);
    expect(periods.every(p => p === 312)).toBe(true);
  });

  it('runs a 312-line frame with the BBC Mode 0 registers (R8=0, R9=7)', () => {
    const c = new Crtc6845(0);
    program(c, { 3: 0x28, 4: 38, 5: 0, 6: 32, 7: 34, 8: 0, 9: 7 });
    expect(c.interlaceVideo).toBe(false);
    expect(vsyncPeriods(c, 312 * 4).every(p => p === 312)).toBe(true);
  });

  it('leaves interlace-sync-only (R8=0x01) scanning like a normal frame', () => {
    const c = new Crtc6845(0);
    program(c, { 3: 0x28, 4: 15, 5: 2, 6: 12, 7: 14, 8: 0x01, 9: 18 });
    expect(c.interlaceVideo).toBe(false);
    expect(c.linesPerFrame()).toBe(16 * 19 + 2);
  });

  it('counts displayed lines per field in interlace mode (25 rows × 10)', () => {
    const c = new Crtc6845(0);
    program(c, { 4: 30, 5: 2, 6: 25, 8: 0x93, 9: 18 });
    expect(c.displayedLines()).toBe(250);
  });
});
