/**
 * The Lynx's beam (docs/beam-debug-mcp-spec.md P1, P3) with its 6845 VSYNC
 * interrupting: a run stopped mid-frame — on traps, on a watchpoint, at a
 * raster position — and resumed must end exactly where an uninterrupted run
 * does, and the VSYNC interrupt must land on the line the 6845 starts VSYNC.
 */

import { describe, it, expect } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import { BeamLog, BEAM_IRQ } from '@/debug/beam-log.ts';

/** Counter the main loop increments, and the one the interrupt handler does. */
const LOOP_COUNT = 0x9000;
const ISR_COUNT = 0x9001;
const CRTC_TABLE = 0x0050;

/** 39 rows (R4 = 38) of 8 lines (R9 = 7), no adjust: 312 lines, the PAL
 *  frame. VSYNC starts on the first line of row R7 = 35, line 35 × 8 = 280. */
const CRTC = [4, 38, 9, 7, 5, 0, 6, 32, 7, 35, 3, 0x20, 1, 32];
const VSYNC_LINE = 280;

/** IM 1: program the 6845 from the table, then count in a loop while VSYNC
 *  interrupts through RST 38h. */
function program(): Uint8Array {
  const code = [
    0xF3,             // 0000 DI
    0x31, 0x00, 0xF0, // 0001 LD SP,F000h
    0xED, 0x56,       // 0004 IM 1
    0x21, CRTC_TABLE & 0xFF, CRTC_TABLE >> 8, // 0006 LD HL,CRTC_TABLE
    0x06, CRTC.length / 2, // 0009 LD B,pairs
    0x7E,             // 000B LD A,(HL)
    0xD3, 0x86,       // 000C OUT (86h),A   6845 address
    0x23,             // 000E INC HL
    0x7E,             // 000F LD A,(HL)
    0xD3, 0x87,       // 0010 OUT (87h),A   6845 register
    0x23,             // 0012 INC HL
    0x10, 0xF6,       // 0013 DJNZ 000Bh
    0x21, LOOP_COUNT & 0xFF, LOOP_COUNT >> 8, // 0015 LD HL,LOOP_COUNT
    0xFB,             // 0018 EI
    0x34,             // 0019 INC (HL)
    0x18, 0xFD,       // 001A JR 0019h
  ];
  const isr = [
    0xF5,             // 0038 PUSH AF
    0x3A, ISR_COUNT & 0xFF, ISR_COUNT >> 8, // LD A,(ISR_COUNT)
    0x3C,             // INC A
    0x32, ISR_COUNT & 0xFF, ISR_COUNT >> 8, // LD (ISR_COUNT),A
    0xF1,             // POP AF
    0xFB,             // EI
    0xC9,             // RET
  ];
  const rom = new Uint8Array(0x4000);
  rom.set(code, 0);
  rom.set(isr, 0x0038);
  rom.set(CRTC, CRTC_TABLE);
  return rom;
}

function boot(): LynxMachine {
  const m = new LynxMachine('lynx48', null);
  m.loadROM(program());
  m.reset();
  return m;
}

function runTo(m: LynxMachine, frames: number): number {
  let stops = 0;
  for (let guard = 0; m.frameNumber < frames && guard < 100_000; guard++) {
    m.runUntil(1);
    if (m.stopReason !== null) stops++;
  }
  return stops;
}

function fingerprint(m: LynxMachine) {
  return {
    t: m.cpu.tStates, pc: m.cpu.pc, frame: m.frameNumber,
    memory: Array.from(m.memory.snapshot()),
  };
}

describe('Lynx beam', () => {
  it('resumes trap, watchpoint and raster stops exactly where an uninterrupted run is', () => {
    const a = boot();
    const b = boot();
    runTo(a, 8);
    // One VSYNC interrupt a frame.
    expect(a.memory.readByte(ISR_COUNT)).toBeGreaterThanOrEqual(7);

    let insns = 0;
    b.onTrap = (_pc, resume) => !resume && ++insns % 997 === 0;
    b.memWatchpoints.push({ start: ISR_COUNT, end: ISR_COUNT, mode: 'write' });
    b.beamTarget = { frame: 3, t: VSYNC_LINE * b.beamInfo().cyclesPerLine - 5 };
    const stops = runTo(b, 8);
    expect(stops).toBeGreaterThan(50);
    expect(fingerprint(b)).toEqual(fingerprint(a));
  });

  it('reports 312 lines and logs the VSYNC interrupt on the line VSYNC starts', () => {
    const m = boot();
    m.runUntil(1);
    const info = m.beamInfo();
    expect(info.linesPerFrame).toBe(312);
    m.beamLog = new BeamLog(10_000);
    m.interruptLogging = true;
    m.runUntil(3);
    const lines: number[] = [];
    for (let i = 0; i < m.beamLog.length; i++) {
      const e = m.beamLog.get(i);
      if (e.kind !== BEAM_IRQ || (e.flags & 2) !== 0) continue;
      expect(e.addr).toBe(0x0038);
      lines.push(Math.floor(e.t / info.cyclesPerLine));
    }
    expect(lines).toEqual([VSYNC_LINE, VSYNC_LINE, VSYNC_LINE]);
  });
});
