/**
 * The PCW's beam (docs/beam-debug-mcp-spec.md P1, P3).
 *
 * A PAL field of 312 lines, 64us each; at 3.4MHz a line is 218 T-states. Line
 * 0 is the first of the 256 displayed lines. The gate array's 300Hz timer
 * fires six times a field, two lines into flyback (line 258) and every 52
 * lines after: 258, 310, 50, 102, 154, 206. It holds /INT for about 100us
 * (340 T-states), so the pulse that starts on line L ends 122 T-states into
 * line L+1.
 *
 * A stop anywhere in a frame — before or after a timer pulse ends inside a
 * line — must resume to exactly what an uninterrupted run gives.
 */

import { describe, it, expect } from 'vitest';
import { PcwMachine } from '@/machines/pcw/pcw-machine.ts';
import { BeamLog, BEAM_IRQ } from '@/debug/beam-log.ts';

const LINE_T = 218;
const LINES = 312;

/** IM 1, a loop bumping bytes at 0x8000-0x80FF, and an interrupt handler that
 *  outlasts the 100us timer pulse before it re-enables interrupts (/INT is
 *  level-sensitive, so a quicker one would be re-entered by the same pulse). */
function boot(): PcwMachine {
  const m = new PcwMachine('pcw8256', null);
  m.reset();
  const program = [
    0xF3,             // DI
    0xED, 0x56,       // IM 1
    0x31, 0x00, 0xF0, // LD SP,0xF000
    0x21, 0x00, 0x80, // LD HL,0x8000
    0xFB,             // EI
    0x34,             // 000A: INC (HL)
    0x2C,             // INC L
    0x18, 0xFC,       // JR 000A
  ];
  const handler = [
    0xC5,             // PUSH BC
    0xF5,             // PUSH AF
    0xE5,             // PUSH HL
    0xDB, 0xF4,       // IN A,(0xF4)   timer ticks since the last read
    0xE6, 0x0F,       // AND 0x0F
    0x21, 0x00, 0x90, // LD HL,0x9000
    0x86,             // ADD A,(HL)    total them at 0x9000
    0x77,             // LD (HL),A
    0x06, 0x28,       // LD B,40
    0x10, 0xFE,       // DJNZ $
    0xE1,             // POP HL
    0xF1,             // POP AF
    0xC1,             // POP BC
    0xFB,             // EI
    0xC9,             // RET
  ];
  program.forEach((v, i) => m.memory.writeByte(i, v));
  handler.forEach((v, i) => m.memory.writeByte(0x38 + i, v));
  m.cpu.pc = 0;
  return m;
}

function runTo(m: PcwMachine, frames: number): void {
  for (let guard = 0; m.frameNumber < frames && guard < 100000; guard++) m.runUntil(1);
}

function fingerprint(m: PcwMachine) {
  return {
    t: m.cpu.tStates, pc: m.cpu.pc, frame: m.frameNumber,
    intCount: m.asic.intCount, timerPending: m.asic.timerPending,
    ram: Array.from(m.memory.allRam()),
    pixels: Array.from(m.pixels),
  };
}

describe('PCW beam geometry', () => {
  it('is a PAL field of 312 lines of 218 T-states', () => {
    const m = boot();
    try {
      const info = m.beamInfo();
      expect(info.cyclesPerLine).toBe(LINE_T);
      expect(info.linesPerFrame).toBe(LINES);
      m.runUntil(2);
      const pos = m.beam();
      expect(pos.frame).toBe(2);
      expect(pos.t).toBeLessThan(LINE_T);
    } finally { m.destroy(); }
  });

  it('takes the timer interrupts at the start of lines 50, 102, 154, 206, 258 and 310', () => {
    const m = boot();
    try {
      m.beamLog = new BeamLog(1000);
      m.interruptLogging = true;
      m.runUntil(3);
      const lines: number[] = [];
      for (let i = 0; i < m.beamLog.length; i++) {
        const e = m.beamLog.get(i);
        if (e.kind !== BEAM_IRQ || (e.flags & 2) !== 0 || e.frame !== 2) continue;
        // Taken within an instruction and the acknowledge of the line start.
        expect(e.t % LINE_T).toBeLessThan(40);
        lines.push(Math.floor(e.t / LINE_T));
      }
      expect(lines).toEqual([50, 102, 154, 206, 258, 310]);
    } finally { m.destroy(); }
  });
});

describe('PCW stops and resumes', () => {
  it('trap stops every 251 instructions resume as if never stopped', () => {
    const a = boot();
    const b = boot();
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

  it('a beam stop as a timer interrupt line starts resumes without counting the tick twice', () => {
    const a = boot();
    const b = boot();
    try {
      runTo(a, 3);
      b.beamTarget = { frame: 1, t: 50 * LINE_T + 2 };
      b.runUntil(10);
      expect(b.stopReason?.kind).toBe('beam');
      expect(Math.floor(b.beam().t / LINE_T)).toBe(50);
      runTo(b, 3);
      expect(fingerprint(b)).toEqual(fingerprint(a));
      // One tick per interrupt taken: 6 a frame for 3 frames (the handler
      // reads the counter in every one of them, so none pile up).
      expect(b.memory.readByte(0x9000)).toBe(18);
    } finally { a.destroy(); b.destroy(); }
  });

  it.each([
    ['before', 51 * LINE_T + 50],
    ['after', 51 * LINE_T + 150],
  ])('a beam stop %s a timer pulse ends lands there and resumes as if never stopped', (_side, t) => {
    const a = boot();
    const b = boot();
    try {
      runTo(a, 3);
      b.beamTarget = { frame: 1, t };
      b.runUntil(10);
      expect(b.stopReason?.kind).toBe('beam');
      const at = b.beam();
      expect(at.frame).toBe(1);
      expect(at.t).toBeGreaterThanOrEqual(t);
      expect(at.t).toBeLessThan(t + 24);
      // The pulse that started on line 50 is still up before 122 T-states in.
      expect(b.asic.timerPending).toBe(t - 51 * LINE_T < 340 - LINE_T);
      runTo(b, 3);
      expect(fingerprint(b)).toEqual(fingerprint(a));
    } finally { a.destroy(); b.destroy(); }
  });
});
