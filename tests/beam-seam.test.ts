/**
 * The beam seam (docs/beam-debug-mcp-spec.md P1 and P4): `beam()`,
 * `beamInfo()` and the frame counter, on the two machines that implement them.
 */

import { describe, it, expect } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';

function bootAtari(): AtariMachine {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  // $E000: LDA #$1E ; STA COLBK ; JMP $E000
  rom.set([0xa9, 0x1e, 0x8d, 0x1a, 0xd0, 0x4c, 0x00, 0xe0], 0x800);
  rom[0x27fc] = 0x00;
  rom[0x27fd] = 0xe0;
  const m = new AtariMachine('atari800', null, 'ntsc');
  m.services.roms.installSystemRom(rom);
  m.reset();
  return m;
}

/** A 48K Spectrum whose ROM is all NOPs, so it runs straight through. */
function nopSpectrum(): Spectrum {
  const s = new Spectrum('zx48k', null);
  s.loadROM(new Uint8Array(16384));
  return s;
}

describe('Atari beam seam', () => {
  it('describes the raster: 114 cycles a line, display from line 8', () => {
    const m = bootAtari();
    try {
      const info = m.beamInfo();
      expect(info.cyclesPerLine).toBe(114);
      expect(info.linesPerFrame).toBe(262);
      expect(info.displayStart).toBe(8 * 114);
    } finally { m.destroy(); }
  });

  it('counts one frame per completed frame, and reports a small t between frames', () => {
    const m = bootAtari();
    try {
      expect(m.beam()).toEqual({ frame: 0, t: 0 });
      for (let i = 1; i <= 3; i++) {
        m.tick();
        const b = m.beam();
        expect(m.frameNumber).toBe(i);
        expect(b.frame).toBe(i);
        // The overshoot of the last instruction past the frame end, never a frame.
        expect(b.t).toBeGreaterThanOrEqual(0);
        expect(b.t).toBeLessThan(20);
      }
    } finally { m.destroy(); }
  });

  it('inside a frame, t rises through the frame and the frame is the one in progress', () => {
    const m = bootAtari();
    try {
      m.tick(); // frame 0 done; the next is frame 1
      const seen: number[] = [];
      m.onTrap = () => {
        const b = m.beam();
        expect(b.frame).toBe(1);
        seen.push(b.t);
        return false;
      };
      m.tick();
      m.onTrap = null;
      expect(seen.length).toBeGreaterThan(1000);
      expect(seen[0]).toBeLessThan(20);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
      expect(seen[seen.length - 1]).toBeGreaterThan(262 * 114 - 200);
      expect(seen[seen.length - 1]).toBeLessThan(262 * 114);
    } finally { m.destroy(); }
  });

  it('a cold reset zeroes the counter and a warm reset keeps it', () => {
    const m = bootAtari();
    try {
      m.tick(); m.tick();
      m.reset(true);
      expect(m.frameNumber).toBe(2);
      m.reset();
      expect(m.frameNumber).toBe(0);
      expect(m.beam().frame).toBe(0);
    } finally { m.destroy(); }
  });

  it('a cold reset from inside the frame (the autostart script) leaves the counter at 0', () => {
    const m = bootAtari();
    try {
      m.tick(); m.tick();
      m.onTrap = () => { m.onTrap = null; m.reset(); return false; };
      m.tick();
      expect(m.frameNumber).toBe(0);
    } finally { m.destroy(); }
  });
});

describe('Spectrum beam seam', () => {
  it('describes the raster from the model timing', () => {
    const s = nopSpectrum();
    try {
      const info = s.beamInfo();
      expect(info.cyclesPerLine).toBe(224);
      expect(info.linesPerFrame).toBe(312);
      expect(info.displayStart).toBe(14336);
    } finally { s.destroy(); }
  });

  it('counts completed frames and reports a small t between them', () => {
    const s = nopSpectrum();
    try {
      expect(s.beam()).toEqual({ frame: 0, t: 0 });
      for (let i = 1; i <= 3; i++) {
        s.tick();
        const b = s.beam();
        expect(s.frameNumber).toBe(i);
        expect(b.frame).toBe(i);
        expect(b.t).toBeGreaterThanOrEqual(0);
        expect(b.t).toBeLessThan(30);
      }
    } finally { s.destroy(); }
  });

  it('a breakpoint stop leaves the frame open, and resuming counts it once', () => {
    const s = nopSpectrum();
    try {
      s.tick();
      expect(s.frameNumber).toBe(1);
      // The ROM and RAM are all NOPs, so PC walks forward four T-states a step:
      // 256 steps ahead is about 1024 T-states into the frame.
      const stopAt = (s.cpu.pc + 0x100) & 0xFFFF;
      s.breakpoints.add(stopAt);
      const ran = s.runUntil(5);
      expect(ran).toBe(1);
      expect(s.breakpointHit).toBe(stopAt);
      // Stopped inside frame 1: the counter has not moved, and t is 256 NOPs in.
      expect(s.frameNumber).toBe(1);
      const stopped = s.beam();
      expect(stopped.frame).toBe(1);
      expect(stopped.t).toBeGreaterThan(900);
      expect(stopped.t).toBeLessThan(1200);
      // Let it finish the frame.
      s.breakpoints.clear();
      s.tick();
      expect(s.frameNumber).toBe(2);
      expect(s.beam().t).toBeLessThan(30);
    } finally { s.destroy(); }
  });

  it('reset() zeroes the counter', () => {
    const s = nopSpectrum();
    try {
      s.tick(); s.tick();
      s.reset();
      expect(s.frameNumber).toBe(0);
      expect(s.beam().frame).toBe(0);
    } finally { s.destroy(); }
  });
});
