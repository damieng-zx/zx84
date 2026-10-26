/**
 * The ZX81's beam: the CPU makes the picture, so a frame is a fixed slice of
 * 312 lines of 207T, and while the NMI generator is on (OUT to port 0xFE) it
 * raises an NMI every line, 207T apart — the line clock the ROM's blank-line
 * counting runs on. Each line starts with its NMI.
 */

import { describe, it, expect } from 'vitest';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import { BeamLog, BEAM_IRQ } from '@/debug/beam-log.ts';

const T_PER_LINE = 207;
const LINES = 312;

/** LD SP,0x4400; OUT (0xFE),A (NMI generator on); then HALT in a loop. The
 *  NMI handler is RETN; maskable interrupts stay disabled. */
function nmiLoopRom(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set([0x31, 0x00, 0x44, 0xd3, 0xfe, 0x76, 0x18, 0xfd], 0);
  rom.set([0xed, 0x45], 0x66);
  return rom;
}

function boot(): Zx8xMachine {
  const m = new Zx8xMachine('zx81');
  m.loadROM(nmiLoopRom());
  m.reset();
  m.beamLog = new BeamLog(5000);
  m.interruptLogging = true;
  return m;
}

/** NMI entries (not ends) in the log. */
function nmis(log: BeamLog) {
  const out: { frame: number; t: number; pc: number }[] = [];
  for (let i = 0; i < log.length; i++) {
    const e = log.get(i);
    if (e.kind === BEAM_IRQ && (e.flags & 2) === 0 && (e.flags & 1) !== 0) out.push({ frame: e.frame, t: e.t, pc: e.pc });
  }
  return out;
}

describe('ZX81 beam', () => {
  it('raises one NMI at the start of every 207T line', () => {
    const m = boot();
    try {
      m.runUntil(3);
      const frame2 = nmis(m.beamLog!).filter(e => e.frame === 2);
      expect(frame2.map(e => Math.floor(e.t / T_PER_LINE))).toEqual(Array.from({ length: LINES }, (_, i) => i));
      for (const e of frame2) {
        expect(e.pc).toBe(0x0006);
        // The HALT step that crosses the line boundary, then the 11T NMI entry.
        expect(e.t % T_PER_LINE).toBeLessThan(4 + 11);
      }
    } finally { m.destroy(); }
  });

  it('a stop part-way through a line resumes without raising its NMI again', () => {
    const a = boot();
    const b = boot();
    try {
      a.runUntil(3);
      b.beamTarget = { frame: 1, t: 100 * T_PER_LINE + 30 };
      b.runUntil(3);
      expect(b.stopReason?.kind).toBe('beam');
      expect(Math.floor(b.beam()!.t / T_PER_LINE)).toBe(100);
      b.runUntil(3 - b.frameNumber);
      expect(b.frameNumber).toBe(3);
      expect(b.cpu.tStates).toBe(a.cpu.tStates);
      expect(nmis(b.beamLog!)).toEqual(nmis(a.beamLog!));
    } finally { a.destroy(); b.destroy(); }
  });
});
