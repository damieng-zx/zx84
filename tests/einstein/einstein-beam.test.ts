/**
 * The Einstein's beam stops (docs/beam-debug-mcp-spec.md P1, P3) with its CTC
 * interrupting: a run stopped mid-frame — on traps, on a watchpoint, at a
 * raster position — and resumed must end exactly where an uninterrupted run
 * does, on the TC-01's TMS9929A and on the 256's V9938 (whose per-line work
 * must not run twice for a line a stop split).
 */

import { describe, it, expect } from 'vitest';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { BeamLog, BEAM_IRQ } from '@/debug/beam-log.ts';
import type { EinsteinModel } from '@/models.ts';

/** Counter the main loop increments, and the one the interrupt handler does. */
const LOOP_COUNT = 0x9000;
const ISR_COUNT = 0x9001;
const HANDLER = 0x0040;

/** IM 2 with CTC channel 3 as a timer: 4MHz / 256 / 32 is 488Hz, about ten
 *  interrupts a frame, through the vector table entry at 0x8006 (I = 0x80,
 *  CTC vector base 0, channel 3 → 0x06). */
function program(): Uint8Array {
  const code = [
    0xF3,             // 0000 DI
    0x31, 0x00, 0xF0, // 0001 LD SP,F000h
    0x3E, 0x80,       // 0004 LD A,80h
    0xED, 0x47,       // 0006 LD I,A
    0xED, 0x5E,       // 0008 IM 2
    0x21, HANDLER & 0xFF, HANDLER >> 8, // 000A LD HL,HANDLER
    0x22, 0x06, 0x80, // 000D LD (8006h),HL
    0x3E, 0x00,       // 0010 LD A,00h     vector base 0
    0xD3, 0x28,       // 0012 OUT (28h),A
    0x3E, 0xA5,       // 0014 LD A,A5h     ch3: interrupt, timer, /256, TC follows
    0xD3, 0x2B,       // 0016 OUT (2Bh),A
    0x3E, 0x20,       // 0018 LD A,20h     time constant 32
    0xD3, 0x2B,       // 001A OUT (2Bh),A
    0x21, LOOP_COUNT & 0xFF, LOOP_COUNT >> 8, // 001C LD HL,LOOP_COUNT
    0xFB,             // 001F EI
    0x34,             // 0020 INC (HL)
    0x18, 0xFD,       // 0021 JR 0020h
  ];
  const isr = [
    0xF5,             // 0040 PUSH AF
    0x3A, ISR_COUNT & 0xFF, ISR_COUNT >> 8, // LD A,(ISR_COUNT)
    0x3C,             // INC A
    0x32, ISR_COUNT & 0xFF, ISR_COUNT >> 8, // LD (ISR_COUNT),A
    0xF1,             // POP AF
    0xFB,             // EI
    0xED, 0x4D,       // RETI
  ];
  const rom = new Uint8Array(0x4000);
  rom.set(code, 0);
  rom.set(isr, HANDLER);
  return rom;
}

function boot(model: EinsteinModel): EinsteinMachine {
  const m = new EinsteinMachine(model, null);
  const rom = program();
  m.loadROM(model === 'einstein-256' ? rom : rom.subarray(0, 0x2000));
  m.reset();
  return m;
}

function runTo(m: EinsteinMachine, frames: number): number {
  let stops = 0;
  for (let guard = 0; m.frameNumber < frames && guard < 100_000; guard++) {
    m.runUntil(1);
    if (m.stopReason !== null) stops++;
  }
  return stops;
}

function fingerprint(m: EinsteinMachine) {
  return {
    t: m.cpu.tStates, pc: m.cpu.pc, frame: m.frameNumber,
    memory: Array.from(m.memory.snapshot()),
  };
}

describe.each(['einstein-tc01', 'einstein-256'] as const)('Einstein beam stops (%s)', (model) => {
  it('resumes trap, watchpoint and raster stops exactly where an uninterrupted run is', () => {
    const a = boot(model);
    const b = boot(model);
    runTo(a, 6);
    // The program really is taking CTC interrupts.
    expect(a.memory.readByte(ISR_COUNT)).toBeGreaterThan(20);

    let insns = 0;
    b.onTrap = (_pc, resume) => !resume && ++insns % 997 === 0;
    b.memWatchpoints.push({ start: ISR_COUNT, end: ISR_COUNT, mode: 'write' });
    b.beamTarget = { frame: 3, t: 150 * b.beamInfo().cyclesPerLine + 11 };
    const stops = runTo(b, 6);
    expect(stops).toBeGreaterThan(50);
    expect(fingerprint(b)).toEqual(fingerprint(a));
  });

  it('logs each CTC interrupt with its handler and the pc it interrupted', () => {
    const m = boot(model);
    m.beamLog = new BeamLog(10_000);
    m.interruptLogging = true;
    m.runUntil(3);
    let entries = 0;
    for (let i = 0; i < m.beamLog.length; i++) {
      const e = m.beamLog.get(i);
      if (e.kind !== BEAM_IRQ || (e.flags & 2) !== 0) continue;
      entries++;
      expect(e.addr).toBe(HANDLER);
      // The main loop is the only code running with interrupts enabled.
      expect([0x0020, 0x0021]).toContain(e.pc);
    }
    expect(entries).toBeGreaterThan(20);
  });
});
