/**
 * The Enterprise's beam: a line is one of Nick's 64µs lines (256T), and what
 * it shows is whatever the line parameter table says. A table of 100 lines,
 * 2 lines with VINT set and 210 more is 312 lines, one frame; Dave latches
 * INT1 on the falling edge of VINT, which comes as Nick fetches the first
 * block after the VINT block, so the interrupt arrives at the start of the
 * line that shows that block, the same frame line every frame.
 */

import { describe, it, expect } from 'vitest';
import { EnterpriseMachine } from '@/machines/enterprise/enterprise-machine.ts';
import { BeamLog, BEAM_IRQ } from '@/debug/beam-log.ts';

const T_PER_LINE = 256;

/** An LPB: `lines` lines of mode byte `mode`, the rest zero. */
function lpb(lines: number, mode: number): number[] {
  const b = new Array(16).fill(0);
  b[0] = 256 - lines;
  b[1] = mode;
  return b;
}

/**
 * Pages video segment 0xFF in at 0x4000 and copies the table there (video
 * address 0xC000), points Nick at it (stop, start at the base, run on), enables INT1 and
 * HALTs with interrupts on. The IM 1 handler clears the INT1 latch.
 */
function program(): Uint8Array {
  const rom = new Uint8Array(0x4000);
  rom.set([
    0x31, 0x00, 0x80,       // LD SP,0x8000
    0x3e, 0xff, 0xd3, 0xb1, // OUT (B1),0xFF
    0x21, 0x40, 0x00,       // LD HL,0x0040
    0x11, 0x00, 0x40,       // LD DE,0x4000
    0x01, 0x30, 0x00,       // LD BC,48
    0xed, 0xb0,             // LDIR
    0xaf, 0xd3, 0x82,       // OUT (82),0x00   LPT base low
    0x3e, 0x0c, 0xd3, 0x83, // OUT (83),0x0C   base high 0xC, stopped
    0x3e, 0x4c, 0xd3, 0x83, // OUT (83),0x4C   start: restart at the base
    0x3e, 0xcc, 0xd3, 0x83, // OUT (83),0xCC   and run on from there
    0x3e, 0x10, 0xd3, 0xb4, // OUT (B4),0x10   INT1 enabled
    0xed, 0x56, 0xfb,       // IM 1; EI
    0x76, 0x18, 0xfd,       // HALT; JR -3
  ], 0);
  // PUSH AF; OUT (B4),0x30 (clear the INT1 latch); POP AF; EI; RET
  rom.set([0xf5, 0x3e, 0x30, 0xd3, 0xb4, 0xf1, 0xfb, 0xc9], 0x38);
  // Pixel mode, pixel mode with VINT, then 256-character mode (whose font
  // pointer LD2 steps on at every line's fetch) with RELOAD.
  rom.set([...lpb(100, 0x02), ...lpb(2, 0x82), ...lpb(210, 0x07)], 0x40);
  return rom;
}

function boot(): EnterpriseMachine {
  const m = new EnterpriseMachine('ep128');
  m.loadROM(program());
  m.reset();
  m.beamLog = new BeamLog(5000);
  m.interruptLogging = true;
  return m;
}

function interrupts(log: BeamLog) {
  const out: { frame: number; t: number; pc: number }[] = [];
  for (let i = 0; i < log.length; i++) {
    const e = log.get(i);
    if (e.kind === BEAM_IRQ && (e.flags & 2) === 0) out.push({ frame: e.frame, t: e.t, pc: e.pc });
  }
  return out;
}

describe('Enterprise beam', () => {
  it('takes the VINT interrupt at the start of the line after the VINT block, the same line every frame', () => {
    const m = boot();
    try {
      m.runUntil(5);
      // Frame 0 sets the table up; from then on it repeats with the frame.
      const ints = interrupts(m.beamLog!).filter(e => e.frame >= 1);
      expect(ints.map(e => e.frame)).toEqual([1, 2, 3, 4]);
      const line = Math.floor(ints[0].t / T_PER_LINE);
      for (const e of ints) {
        expect(e.pc).toBe(0x0029);
        expect(Math.floor(e.t / T_PER_LINE)).toBe(line);
        // The HALT step that crosses into the line, then the acknowledge.
        expect(e.t % T_PER_LINE).toBeLessThan(32);
      }

      // The beam's line is the one Nick is showing: the line before is the
      // last of the VINT block (video 0xC010), the interrupt's line the first
      // of the block after it (0xC020).
      const b = boot();
      try {
        b.beamTarget = { frame: 3, t: (line - 1) * T_PER_LINE + 100 };
        b.runUntil(5);
        expect(b.stopReason?.kind).toBe('beam');
        expect(b.nick.lptAddr).toBe(0xc010);
        expect(b.nick.interruptFlag).toBe(true);
        b.beamTarget = { frame: 3, t: line * T_PER_LINE + 100 };
        b.runUntil(5);
        expect(b.stopReason?.kind).toBe('beam');
        expect(b.nick.lptAddr).toBe(0xc020);
        expect(b.nick.interruptFlag).toBe(false);
      } finally { b.destroy(); }
    } finally { m.destroy(); }
  });

  it('a stop part-way through a line resumes without Nick fetching it again', () => {
    const a = boot();
    const b = boot();
    try {
      a.runUntil(4);
      const last = interrupts(a.beamLog!)[3];
      expect(last.frame).toBe(3);
      // Stop just after an interrupt, in the first line of the character
      // block, which the frame then ends in.
      b.beamTarget = { frame: last.frame, t: last.t + 1 };
      b.runUntil(4);
      expect(b.stopReason?.kind).toBe('beam');
      b.runUntil(4 - b.frameNumber);
      expect(b.frameNumber).toBe(4);
      expect(b.cpu.tStates).toBe(a.cpu.tStates);
      expect(b.nick.lptAddr).toBe(a.nick.lptAddr);
      expect(b.nick.ld2).toBe(a.nick.ld2);
      expect(interrupts(b.beamLog!)).toEqual(interrupts(a.beamLog!));
      expect(Array.from(b.pixels)).toEqual(Array.from(a.pixels));
    } finally { a.destroy(); b.destroy(); }
  });
});
