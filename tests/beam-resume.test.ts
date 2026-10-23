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
