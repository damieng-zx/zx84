/**
 * The CPC's beam (docs/beam-debug-mcp-spec.md P1, P3) with the CRTC programmed
 * as the firmware leaves it, on a Plus so the ASIC path is covered too.
 *
 * The frame is the CRTC's: every frame restarts it, so line 0 is row 0 raster
 * 0. With the firmware's registers (R0 = 63, R4 = 38, R9 = 7, R5 = 0) a line is
 * 64 characters of 1µs (256 T-states) and a frame (38+1)·(7+1) = 312 lines.
 * The Gate Array counts the end of HSYNC (R2 + R3 width = 46 + 14 = character
 * 60, t 240 of the line), raises an interrupt every 52 of them and re-syncs
 * the count on the 2nd HSYNC after VSYNC begins (row R7 = 30, line 240), so
 * the interrupts fall on the HSYNCs of lines 241, 293, then 33, 85, 137, 189.
 *
 * A stop anywhere in a frame, on either side of a line's HSYNC, must resume
 * to exactly what an uninterrupted run gives.
 */

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { Asic } from '@/machines/cpc/asic.ts';
import { BeamLog, BEAM_IRQ } from '@/debug/beam-log.ts';

const LINE_T = 256;
const LINES = 312;
const FRAME_T = LINE_T * LINES;
const HSYNC_END_T = 60 * 4;

/** Cartridge page 0: IM 1, a loop bumping bytes at 0x8100-0x81FF, and an
 *  interrupt handler that counts at 0x8000 and recolours the border (so the
 *  picture shows where in the frame each interrupt landed). */
function firmwarePage(): Uint8Array {
  const fw = new Uint8Array(0x4000);
  fw.set([
    0xF3,             // DI
    0xED, 0x56,       // IM 1
    0x31, 0xF0, 0xBF, // LD SP,0xBFF0
    0x21, 0x00, 0x81, // LD HL,0x8100
    0xFB,             // EI
    0x34,             // 000A: INC (HL)
    0x2C,             // INC L
    0x18, 0xFC,       // JR 000A
  ], 0);
  fw.set([
    0xF5,             // PUSH AF
    0xC5,             // PUSH BC
    0x01, 0x10, 0x7F, // LD BC,0x7F10
    0xED, 0x49,       // OUT (C),C   select the border
    0x3A, 0x00, 0x80, // LD A,(0x8000)
    0x3C,             // INC A
    0xE6, 0x1F,       // AND 0x1F
    0x32, 0x00, 0x80, // LD (0x8000),A
    0xF6, 0x40,       // OR 0x40
    0xED, 0x79,       // OUT (C),A   border colour
    0xC1,             // POP BC
    0xF1,             // POP AF
    0xFB,             // EI
    0xED, 0x4D,       // RETI
  ], 0x38);
  return fw;
}

/** The firmware's CRTC set-up for the standard 40×25 screen. */
const CRTC_REGS = [63, 40, 46, 0x8E, 38, 0, 25, 30, 0, 7, 0, 0, 0x30, 0];

function boot(unlocked: boolean): CpcMachine {
  const m = new CpcMachine('cpc6128plus', null);
  const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
  pages[0] = firmwarePage();
  m.memory.loadCartridge(pages);
  m.reset();
  CRTC_REGS.forEach((v, r) => { m.crtc.selectRegister(r); m.crtc.writeRegister(v); });
  if (unlocked) {
    const asic = m.gateArray as Asic;
    asic.locked = false;
    asic.interruptSl = 100;    // a Plus programmable raster interrupt
  }
  return m;
}

function runTo(m: CpcMachine, frames: number): void {
  for (let guard = 0; m.frameNumber < frames && guard < 100000; guard++) m.runUntil(1);
}

function fingerprint(m: CpcMachine) {
  return {
    t: m.cpu.tStates, pc: m.cpu.pc, frame: m.frameNumber,
    ram: Array.from(m.memory.ramSnapshot()),
    pixels: Array.from(m.pixels),
  };
}

describe('CPC beam geometry', () => {
  it('is the CRTC frame: 256 T-states a line, 312 lines', () => {
    const m = boot(false);
    try {
      const info = m.beamInfo();
      expect(info.cyclesPerLine).toBe(LINE_T);
      expect(info.linesPerFrame).toBe(LINES);
      expect(info.displayStart).toBe(0);
      m.runUntil(2);
      const pos = m.beam();
      expect(pos.frame).toBe(2);
      expect(pos.t).toBeLessThan(LINE_T);
    } finally { m.destroy(); }
  });

  it('puts the Gate Array interrupts on the HSYNCs of lines 33, 85, 137, 189, 241 and 293', () => {
    const m = boot(false);
    try {
      m.beamLog = new BeamLog(1000);
      m.interruptLogging = true;
      m.runUntil(3);
      const lines: number[] = [];
      for (let i = 0; i < m.beamLog.length; i++) {
        const e = m.beamLog.get(i);
        if (e.kind !== BEAM_IRQ || (e.flags & 2) !== 0 || e.frame !== 2) continue;
        // Taken within a few instructions of the HSYNC end that raised it.
        const sinceHsync = e.t - HSYNC_END_T;
        expect(sinceHsync).toBeGreaterThanOrEqual(0);
        expect(sinceHsync % LINE_T).toBeLessThan(64);
        lines.push(Math.floor(sinceHsync / LINE_T));
      }
      expect(lines).toEqual([33, 85, 137, 189, 241, 293]);
    } finally { m.destroy(); }
  });

  it('puts the Plus raster interrupt on the HSYNC of its scan line', () => {
    const m = boot(true);
    try {
      m.beamLog = new BeamLog(1000);
      m.interruptLogging = true;
      m.runUntil(3);
      const lines: number[] = [];
      for (let i = 0; i < m.beamLog.length; i++) {
        const e = m.beamLog.get(i);
        if (e.kind !== BEAM_IRQ || (e.flags & 2) !== 0 || e.frame !== 2) continue;
        lines.push(Math.floor((e.t - HSYNC_END_T) / LINE_T));
      }
      expect(lines).toEqual([100]);
    } finally { m.destroy(); }
  });
});

describe.each([false, true])('CPC Plus stops and resumes (ASIC unlocked: %s)', (unlocked) => {
  it('trap stops every 251 instructions resume as if never stopped', () => {
    const a = boot(unlocked);
    const b = boot(unlocked);
    try {
      runTo(a, 3);
      let calls = 0;
      let stops = 0;
      b.onTrap = (_pc, resume) => !resume && ++calls % 251 === 0;
      for (let guard = 0; b.frameNumber < 3 && guard < 100000; guard++) {
        b.runUntil(1);
        if (b.stopReason?.kind === 'trap') stops++;
      }
      expect(stops).toBeGreaterThan(50);
      expect(fingerprint(b)).toEqual(fingerprint(a));
    } finally { a.destroy(); b.destroy(); }
  });

  // The loop writes 0x81xx every few instructions, so these stops land on
  // instructions after which the Gate Array's interrupt is waiting: the resume
  // must take it where an uninterrupted run would, not an instruction late.
  it('watchpoint stops on every loop write resume as if never stopped', () => {
    const a = boot(unlocked);
    const b = boot(unlocked);
    try {
      runTo(a, 3);
      b.memWatchpoints.push({ start: 0x8100, end: 0x81FF, mode: 'write' });
      let stops = 0;
      for (let guard = 0; b.frameNumber < 3 && guard < 1_000_000; guard++) {
        b.runUntil(1);
        if (b.stopReason?.kind === 'watch') stops++;
      }
      expect(stops).toBeGreaterThan(1000);
      expect(fingerprint(b)).toEqual(fingerprint(a));
    } finally { a.destroy(); b.destroy(); }
  });

  it.each([
    ['before', 100 * LINE_T + 100],
    ['after', 100 * LINE_T + 250],
  ])('a beam stop %s a line\'s HSYNC lands there and resumes as if never stopped', (_side, t) => {
    const a = boot(unlocked);
    const b = boot(unlocked);
    try {
      runTo(a, 3);
      b.beamTarget = { frame: 1, t };
      b.runUntil(10);
      expect(b.stopReason?.kind).toBe('beam');
      const at = b.beam();
      expect(at.frame).toBe(1);
      expect(at.t).toBeGreaterThanOrEqual(t);
      expect(at.t).toBeLessThan(t + 32);
      runTo(b, 3);
      expect(fingerprint(b)).toEqual(fingerprint(a));
      expect(b.cpu.tStates).toBeGreaterThanOrEqual(3 * FRAME_T);
    } finally { a.destroy(); b.destroy(); }
  });
});
