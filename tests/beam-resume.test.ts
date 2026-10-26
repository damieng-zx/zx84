/**
 * A resumable frame loop (docs/beam-debug-mcp-spec.md P3): stopping in the
 * middle of a frame and carrying on must change nothing about it. The program
 * writes a new background colour on every line, so the picture records exactly
 * when each write landed; two runs that differ only in where they paused must
 * match pixel for pixel, register for register and cycle for cycle.
 */

import { describe, it, expect } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';
import { StateWriter } from '@/machines/shared/state-io.ts';

/**
 * $E000: LDX #0
 * $E002: STA WSYNC
 * $E005: STX COLBK
 * $E008: INX
 * $E009: JMP $E002
 */
const RAINBOW = [0xa2, 0x00, 0x8d, 0x0a, 0xd4, 0x8e, 0x1a, 0xd0, 0xe8, 0x4c, 0x02, 0xe0];

function boot(): AtariMachine {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  rom.set(RAINBOW, 0x800);
  rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;
  const m = new AtariMachine('atari800', null, 'pal');
  m.services.roms.installSystemRom(rom);
  m.reset();
  return m;
}

function hash(px: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) { h ^= px[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function snapshot(m: AtariMachine): string {
  const c = m.cpu;
  return [c.a, c.x, c.y, c.sp, c.pc, c.p, c.tStates, m.frameNumber, hash(m.pixels)].join(',');
}

/** Run until `frames` frames are complete, whatever stops get in the way. */
function runToFrame(m: AtariMachine, frames: number): void {
  for (let guard = 0; m.frameNumber < frames && guard < 1000; guard++) m.runUntil(1);
}

describe('Atari resumable frame loop', () => {
  it('a plain run is the reference', () => {
    const a = boot();
    const b = boot();
    try {
      a.tick(); a.tick(); a.tick();
      b.tick(); b.tick(); b.tick();
      expect(snapshot(a)).toBe(snapshot(b));
      expect(a.frameNumber).toBe(3);
    } finally { a.destroy(); b.destroy(); }
  });

  it('stopping at a beam position mid-line and carrying on changes nothing', () => {
    const ref = boot();
    const m = boot();
    try {
      runToFrame(ref, 3);
      m.tick();
      // Stop in frame 1, line 31, 20 cycles in; then in the same frame at line 200.
      m.beamTarget = { frame: 1, t: 31 * 114 + 20 };
      expect(m.runUntil(5)).toBe(1);
      expect(m.stopReason?.kind).toBe('beam');
      expect(m.frameNumber).toBe(1);
      const at = m.beam();
      expect(at.frame).toBe(1);
      // The CPU sits in a WSYNC halt from cycle ~3 to the end of line 31, so the
      // first instruction boundary at or after 31:20 is the start of line 32.
      expect(at.t).toBe(32 * 114);
      m.beamTarget = { frame: 1, t: 200 * 114 + 3 };
      m.runUntil(5);
      expect(m.stopReason?.kind).toBe('beam');
      expect(m.beam().t).toBeGreaterThanOrEqual(200 * 114 + 3);
      m.beamTarget = null;
      runToFrame(m, 3);
      expect(snapshot(m)).toBe(snapshot(ref));
    } finally { ref.destroy(); m.destroy(); }
  });

  it('a beam stop between frames lands in the right frame, and a second one a frame later', () => {
    const m = boot();
    try {
      m.beamTarget = { frame: 0, t: 31 * 114 };
      m.runUntil(5);
      expect(m.beam().frame).toBe(0);
      expect(Math.floor(m.beam().t / 114)).toBe(31);
      m.beamTarget = { frame: 1, t: 31 * 114 };
      m.runUntil(5);
      expect(m.beam().frame).toBe(1);
      expect(Math.floor(m.beam().t / 114)).toBe(31);
    } finally { m.destroy(); }
  });

  it('single-stepping every instruction of two frames equals running them', () => {
    const ref = boot();
    const m = boot();
    try {
      ref.tick(); ref.tick();
      let steps = 0;
      while (m.frameNumber < 2 && steps < 20_000) { m.stepInstruction(); steps++; }
      expect(m.frameNumber).toBe(2);
      // Four instructions a line, 312 lines a frame.
      expect(steps).toBeGreaterThan(2000);
      expect(snapshot(m)).toBe(snapshot(ref));
    } finally { ref.destroy(); m.destroy(); }
  });

  it('a stop at a breakpoint, a beam stop and a step in between still match a plain run', () => {
    const ref = boot();
    const m = boot();
    try {
      runToFrame(ref, 3);
      m.breakpoints.add(0xE005);
      m.runUntil(1);                       // breakpoint, line 0 (after its first WSYNC)
      expect(m.stopReason?.kind).toBe('breakpoint');
      m.beamTarget = { frame: 0, t: 0 };   // already passed: stops at once, no progress
      const t0 = m.cpu.tStates;
      m.runUntil(1);
      expect(m.stopReason?.kind).toBe('beam');
      expect(m.cpu.tStates).toBe(t0);
      m.stepInstruction();                 // steps over the breakpoint's own pc
      expect(m.cpu.pc).toBe(0xE008);
      m.breakpoints.clear();
      runToFrame(m, 3);
      expect(snapshot(m)).toBe(snapshot(ref));
    } finally { ref.destroy(); m.destroy(); }
  });

  it('the skip after a breakpoint survives a beam stop in between', () => {
    const m = boot();
    try {
      m.breakpoints.add(0xE005);
      m.runUntil(1);
      const stoppedAt = m.cpu.tStates;
      m.beamTarget = { frame: 0, t: 0 };
      m.runUntil(1);                       // beam stop, no progress
      m.runUntil(1);                       // the breakpoint is still skipped once
      expect(m.stopReason?.kind).toBe('breakpoint');
      expect(m.cpu.tStates - stoppedAt).toBeGreaterThan(100); // a line later
      expect(m.cpu.pc).toBe(0xE005);
    } finally { m.destroy(); }
  });

  it('stepping over STA WSYNC halts the CPU to the end of the line, as a run does', () => {
    const m = boot();
    try {
      m.stepInstruction();                 // LDX #0
      m.stepInstruction();                 // STA WSYNC
      expect(m.cpu.pc).toBe(0xE005);
      // Released at the line boundary: line 1, cycle 0.
      expect(m.beam().t).toBe(114);
    } finally { m.destroy(); }
  });

  it('a snapshot taken mid-frame completes the frame first', () => {
    const m = boot();
    try {
      m.beamTarget = { frame: 0, t: 100 * 114 };
      m.runUntil(5);
      expect(m.frameNumber).toBe(0);
      m.saveState(new StateWriter(), false);
      expect(m.frameNumber).toBe(1);
      expect(m.beam().t).toBeLessThan(20);
    } finally { m.destroy(); }
  });

  it('a snapshot taken at a mid-frame stop restores into a fresh machine that then matches the original', async () => {
    // The browser's refresh-resume path saves whatever state the machine is in,
    // which after a debugger stop is the middle of a frame.
    const src = boot();
    const dst = boot();
    try {
      src.tick();
      src.beamTarget = { frame: 1, t: 100 * 114 };
      src.runUntil(5);
      expect(src.frameNumber).toBe(1);
      const file = await src.services.snapshots.save('.a8state');
      // Saving finished the frame, so the original is between frames again.
      expect(src.frameNumber).toBe(2);
      expect((await dst.services.snapshots.apply(file, 'mid.a8state')).ok).toBe(true);
      src.tick(); src.tick();
      dst.tick(); dst.tick();
      const regs = (m: AtariMachine) => [m.cpu.a, m.cpu.x, m.cpu.y, m.cpu.sp, m.cpu.pc, m.cpu.p, m.cpu.tStates, hash(m.pixels)].join(',');
      expect(regs(dst)).toBe(regs(src));
    } finally { src.destroy(); dst.destroy(); }
  });

  it('a reset in the middle of a frame starts over cleanly', () => {
    const m = boot();
    try {
      m.beamTarget = { frame: 0, t: 100 * 114 };
      m.runUntil(5);
      m.reset();
      m.tick();
      expect(m.frameNumber).toBe(1);
      expect(m.beam().t).toBeLessThan(20);
    } finally { m.destroy(); }
  });
});

// ── The Spectrum ───────────────────────────────────────────────────────────

import { Spectrum } from '@/machines/spectrum/spectrum.ts';

/**
 * $8000: LD A,0 ; loop: OUT (254),A ; INC A ; AND 7 ; JR loop — a new border
 * colour every 38 T-states, so the picture records exactly when each OUT landed.
 */
const BORDER_LOOP = [0x3e, 0x00, 0xd3, 0xfe, 0x3c, 0xe6, 0x07, 0x18, 0xf9];

function bootSpectrum(accuracy: 'high' | 'mid' | 'low' = 'high'): Spectrum {
  const s = new Spectrum('zx48k', null);
  s.loadROM(new Uint8Array(16384));
  BORDER_LOOP.forEach((b, i) => s.memory.writeByte(0x8000 + i, b));
  s.cpu.pc = 0x8000;
  s.scanlineAccuracy = accuracy;
  return s;
}

function spectrumState(s: Spectrum): string {
  const c = s.cpu;
  return [c.a, c.f, c.b, c.c, c.pc, c.sp, c.tStates, s.frameNumber, s.contention.frameStartTStates, hash(s.pixels)].join(',');
}

function runSpectrumToFrame(s: Spectrum, frames: number): void {
  for (let guard = 0; s.frameNumber < frames && guard < 1000; guard++) s.runUntil(1);
}

describe.each(['high', 'mid', 'low'] as const)('Spectrum resumable frame loop (%s accuracy)', (accuracy) => {
  it('supports run-to-beam', () => {
    const s = bootSpectrum(accuracy);
    try { expect(s.supportsBeamStops()).toBe(true); } finally { s.destroy(); }
  });

  it('stopping at a beam position and carrying on changes nothing, picture included', () => {
    const ref = bootSpectrum(accuracy);
    const s = bootSpectrum(accuracy);
    try {
      runSpectrumToFrame(ref, 3);
      s.tick();
      // Frame 1: stop in the top border, then deep in the display.
      s.beamTarget = { frame: 1, t: 20 * 224 + 50 };
      expect(s.runUntil(5)).toBe(1);
      expect(s.stopReason?.kind).toBe('beam');
      expect(s.frameNumber).toBe(1);
      const first = s.beam();
      expect(first.frame).toBe(1);
      expect(first.t).toBeGreaterThanOrEqual(20 * 224 + 50);
      expect(first.t).toBeLessThan(20 * 224 + 50 + 40);
      s.beamTarget = { frame: 1, t: 200 * 224 };
      s.runUntil(5);
      expect(s.stopReason?.kind).toBe('beam');
      expect(s.beam().t).toBeGreaterThanOrEqual(200 * 224);
      s.beamTarget = null;
      runSpectrumToFrame(s, 3);
      expect(spectrumState(s)).toBe(spectrumState(ref));
    } finally { ref.destroy(); s.destroy(); }
  });

  it('a breakpoint stop and a resume change nothing either', () => {
    const ref = bootSpectrum(accuracy);
    const s = bootSpectrum(accuracy);
    try {
      runSpectrumToFrame(ref, 3);
      s.tick();
      s.breakpoints.add(0x8004);
      s.runUntil(1);
      expect(s.stopReason?.kind).toBe('breakpoint');
      expect(s.frameNumber).toBe(1);
      s.breakpoints.clear();
      runSpectrumToFrame(s, 3);
      expect(spectrumState(s)).toBe(spectrumState(ref));
    } finally { ref.destroy(); s.destroy(); }
  });

  it('a second target for the same line is the next frame', () => {
    const s = bootSpectrum(accuracy);
    try {
      s.beamTarget = { frame: 0, t: 64 * 224 };
      s.runUntil(5);
      expect(s.beam().frame).toBe(0);
      expect(Math.floor(s.beam().t / 224)).toBe(64);
      s.beamTarget = { frame: 1, t: 64 * 224 };
      s.runUntil(5);
      expect(s.beam().frame).toBe(1);
      expect(Math.floor(s.beam().t / 224)).toBe(64);
    } finally { s.destroy(); }
  });

  it('a reset in the middle of a frame starts over cleanly', () => {
    const s = bootSpectrum(accuracy);
    try {
      s.beamTarget = { frame: 0, t: 100 * 224 };
      s.runUntil(5);
      s.reset();
      s.tick();
      expect(s.frameNumber).toBe(1);
      expect(s.beam().t).toBeLessThan(40);
    } finally { s.destroy(); }
  });
});

// ── The Spectrum on its real ROM ───────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROM48 = [process.env.SPECTRUM_ROM_DIR, resolve(__dirname, '../mcp/.cache')]
  .filter((d): d is string => !!d)
  .map(d => resolve(d, '48.rom'))
  .find(p => existsSync(p));

describe.skipIf(!ROM48)('Spectrum resumable frame loop on the 48K ROM', { timeout: 30_000 }, () => {
  function bootRom(): Spectrum {
    const s = new Spectrum('zx48k', null);
    s.loadROM(new Uint8Array(readFileSync(ROM48!)));
    s.reset();
    for (let f = 0; f < 150; f++) s.tick();      // to the "(c) 1982 Sinclair" banner and the idle loop
    return s;
  }
  const frames = (s: Spectrum): number => s.memory.readByte(23672) | (s.memory.readByte(23673) << 8);

  it('interrupts, HALT and the frame counter survive stops in the middle of frames', () => {
    const ref = bootRom();
    const s = bootRom();
    try {
      const base = s.frameNumber;
      runSpectrumToFrame(ref, base + 6);
      // Stop in six different frames, at lines through the picture, around the interrupt too.
      const lines = [0, 1, 70, 150, 230, 300];
      for (let k = 0; k < lines.length; k++) {
        s.beamTarget = { frame: base + k, t: lines[k] * 224 + 10 };
        s.runUntil(5);
        expect(s.stopReason?.kind).toBe('beam');
      }
      s.beamTarget = null;
      runSpectrumToFrame(s, base + 6);
      expect(spectrumState(s)).toBe(spectrumState(ref));
      // The ROM's own FRAMES counter (one a frame, from the interrupt) agrees with the frame count.
      expect(frames(s)).toBe(frames(ref));
      expect(frames(s) - frames(bootRom())).toBe(6);
    } finally { ref.destroy(); s.destroy(); }
  });
});
