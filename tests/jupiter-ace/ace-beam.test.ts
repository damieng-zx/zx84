/**
 * The Jupiter Ace's beam: frame line 0 is the first of the 192 active lines
 * and the ULA's /INT starts with line 192, as on the hardware, where the
 * display window is lines 56-247 and /INT is raised at line 248 (MAME
 * cantab/jupace.cpp). Lines are 208T (416 dots at 6.5MHz, CPU at half that).
 */

import { describe, it, expect } from 'vitest';
import { JupiterAceMachine } from '@/machines/jupiter-ace/ace-machine.ts';
import { BeamLog, BEAM_IRQ } from '@/debug/beam-log.ts';

const T_PER_LINE = 208;

/** LD SP,0x4000; IM 1; EI; then HALT in a loop. The IM 1 handler is EI; RET. */
function haltLoopRom(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set([0x31, 0x00, 0x40, 0xed, 0x56, 0xfb, 0x76, 0x18, 0xfd], 0);
  rom.set([0xfb, 0xc9], 0x38);
  return rom;
}

function boot(): JupiterAceMachine {
  const m = new JupiterAceMachine('jupiter-ace');
  m.loadROM(haltLoopRom());
  m.reset();
  return m;
}

/** Interrupt entries (not ends) in the log: frame, t, interrupted pc, handler. */
function entries(log: BeamLog) {
  const out: { frame: number; t: number; pc: number; handler: number }[] = [];
  for (let i = 0; i < log.length; i++) {
    const e = log.get(i);
    if (e.kind === BEAM_IRQ && (e.flags & 2) === 0) out.push({ frame: e.frame, t: e.t, pc: e.pc, handler: e.addr });
  }
  return out;
}

describe('Jupiter Ace beam', () => {
  it('takes the frame interrupt once a frame, at the start of line 192', () => {
    const m = boot();
    try {
      m.beamLog = new BeamLog(1000);
      m.interruptLogging = true;
      m.runUntil(4);
      const ints = entries(m.beamLog);
      expect(ints.map(e => e.frame)).toEqual([0, 1, 2, 3]);
      for (const e of ints) {
        expect(e.handler).toBe(0x38);
        // Interrupted in the HALT loop: the return address is the JR after it.
        expect(e.pc).toBe(0x0007);
        expect(Math.floor(e.t / T_PER_LINE)).toBe(192);
        // A 4T HALT step to finish, then the 13T IM 1 acknowledge.
        expect(e.t - 192 * T_PER_LINE).toBeLessThan(4 + 13);
      }
    } finally { m.destroy(); }
  });

  it('a stop just after the interrupt resumes without raising it again', () => {
    const a = boot();
    const b = boot();
    try {
      a.beamLog = new BeamLog(1000);
      a.interruptLogging = true;
      b.beamLog = new BeamLog(1000);
      b.interruptLogging = true;
      a.runUntil(3);
      b.beamTarget = { frame: 1, t: 192 * T_PER_LINE + 20 };
      b.runUntil(3);
      expect(b.stopReason?.kind).toBe('beam');
      expect(b.beam()!.frame).toBe(1);
      b.runUntil(3 - b.frameNumber);
      expect(b.frameNumber).toBe(3);
      expect(b.cpu.tStates).toBe(a.cpu.tStates);
      expect(entries(b.beamLog)).toEqual(entries(a.beamLog));
    } finally { a.destroy(); b.destroy(); }
  });
});
