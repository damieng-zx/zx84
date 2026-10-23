/**
 * Stop reasons and resuming (docs/beam-debug-mcp-spec.md P2): a stop says why,
 * a trap that asks to break actually stops the run on the Atari, and resuming
 * from a stop at the same pc makes progress instead of stopping again at once.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { installTrapHook, traps, trapLog, type Trap } from '../mcp/traps.ts';

/** $E000: LDA #$1E ; STA COLBK ($D01A) ; JMP $E000 — a nine-cycle loop. */
function bootAtari(): AtariMachine {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  rom.set([0xa9, 0x1e, 0x8d, 0x1a, 0xd0, 0x4c, 0x00, 0xe0], 0x800);
  rom[0x27fc] = 0x00;
  rom[0x27fd] = 0xe0;
  const m = new AtariMachine('atari800', null, 'ntsc');
  m.services.roms.installSystemRom(rom);
  m.reset();
  return m;
}

function nopSpectrum(): Spectrum {
  const s = new Spectrum('zx48k', null);
  s.loadROM(new Uint8Array(16384));
  return s;
}

describe('Atari stops', () => {
  it('a breakpoint stop carries its reason', () => {
    const m = bootAtari();
    try {
      m.breakpoints.add(0xE002);
      expect(m.runUntil(3)).toBe(1);
      expect(m.stopReason).toEqual({ kind: 'breakpoint', pc: 0xE002, detail: '' });
      expect(m.breakpointHit).toBe(0xE002);
    } finally { m.destroy(); }
  });

  it('resuming from a breakpoint steps over it, then stops at it again next time round', () => {
    const m = bootAtari();
    try {
      m.breakpoints.add(0xE002);
      m.runUntil(3);
      const first = m.cpu.tStates;
      expect(m.cpu.pc).toBe(0xE002);
      m.runUntil(3);
      expect(m.cpu.pc).toBe(0xE002);
      // One trip round the nine-cycle loop: without the skip it would be 0.
      expect(m.cpu.tStates - first).toBe(9);
    } finally { m.destroy(); }
  });

  it('a trap that returns true stops the run (it used to spin to the frame limit)', () => {
    const m = bootAtari();
    try {
      m.onTrap = (pc, resume) => pc === 0xE002 && !resume;
      expect(m.runUntil(50)).toBe(1);
      expect(m.stopReason).toEqual({ kind: 'trap', pc: 0xE002, detail: '' });
      expect(m.breakpointHit).toBe(0xE002);
    } finally { m.destroy(); }
  });

  it('resuming from a trap stop tells the hook so, once, and makes progress', () => {
    const m = bootAtari();
    try {
      const calls: Array<[number, boolean]> = [];
      m.onTrap = (pc, resume) => {
        if (pc === 0xE002) calls.push([pc, resume === true]);
        return pc === 0xE002 && !resume;
      };
      m.runUntil(3);
      const first = m.cpu.tStates;
      m.runUntil(3);
      expect(calls).toEqual([[0xE002, false], [0xE002, true], [0xE002, false]]);
      expect(m.cpu.tStates - first).toBe(9);
    } finally { m.destroy(); }
  });

  it('a cold reset forgets the skip', () => {
    const m = bootAtari();
    try {
      m.breakpoints.add(0xE002);
      m.runUntil(3);
      m.reset();
      m.cpu.pc = 0xE002;
      const before = m.cpu.tStates;
      m.runUntil(3);
      // Not skipped: it stops straight away, without running an instruction.
      expect(m.cpu.tStates).toBe(before);
      expect(m.stopReason?.kind).toBe('breakpoint');
    } finally { m.destroy(); }
  });

  it('a run that ends normally has no stop reason', () => {
    const m = bootAtari();
    try {
      m.breakpoints.add(0xE002);
      m.runUntil(3);
      m.breakpoints.clear();
      m.tick();
      expect(m.stopReason).toBeNull();
      expect(m.breakpointHit).toBe(-1);
    } finally { m.destroy(); }
  });
});

describe('Spectrum stops', () => {
  it('resuming from a breakpoint steps over it', () => {
    const s = nopSpectrum();
    try {
      s.tick();
      const stopAt = (s.cpu.pc + 0x100) & 0xFFFF;
      s.breakpoints.add(stopAt);
      expect(s.runUntil(1)).toBe(1);
      expect(s.stopReason).toEqual({ kind: 'breakpoint', pc: stopAt, detail: '' });
      // The breakpoint is still set; the frame must finish without stopping.
      s.runUntil(1);
      expect(s.breakpointHit).toBe(-1);
      expect(s.stopReason).toBeNull();
      expect(s.cpu.pc).not.toBe(stopAt);
    } finally { s.destroy(); }
  });

  it('a memory watchpoint stop is reported as one', () => {
    const s = nopSpectrum();
    try {
      // A tight loop at $8000 that writes $8100: LD ($8100),A ; JR -5.
      const prog = [0x32, 0x00, 0x81, 0x18, 0xFB];
      prog.forEach((b, i) => s.memory.writeByte(0x8000 + i, b));
      s.cpu.pc = 0x8000;
      s.memWatchpoints.push({ start: 0x8100, end: 0x8100, mode: 'write' });
      s.runUntil(1);
      expect(s.stopReason?.kind).toBe('watch');
      expect(s.memWatchHit?.addr).toBe(0x8100);
    } finally { s.destroy(); }
  });
});

describe('server trap hook on resume', () => {
  beforeEach(() => {
    traps.clear();
    trapLog.length = 0;
  });

  it('a break trap stops the run and logs once; resuming steps over it without logging again', () => {
    const m = bootAtari();
    try {
      installTrapHook(m);
      const brk: Trap = { address: 0xE002, action: 'break', label: 'B', responses: [] };
      traps.set(0xE002, [brk]);

      expect(m.runUntil(3)).toBe(1);
      expect(m.stopReason?.kind).toBe('trap');
      expect(trapLog.length).toBe(1);
      const first = m.cpu.tStates;

      m.runUntil(3);
      // Stepped over E002 once without a second [BREAK] line, went round the
      // nine-cycle loop, and stopped at it again: one more line, not two.
      expect(trapLog.length).toBe(2);
      expect(m.cpu.tStates - first).toBe(9);
    } finally { m.destroy(); }
  });

  it('a respond trap still runs on resume', () => {
    const m = bootAtari();
    try {
      installTrapHook(m);
      // Empty queue: the trap breaks. The user then queues an answer and resumes.
      const respond: Trap = { address: 0xE002, action: 'respond', label: 'R', responses: [] };
      traps.set(0xE002, [respond]);
      expect(m.runUntil(3)).toBe(1);
      expect(m.stopReason?.kind).toBe('trap');
      respond.responses.push({ regs: { A: 0x42 } });
      m.cpu.sp = 0xFD; // a return address for the synthetic RTS to pop
      m.runUntil(1);
      expect(trapLog.some(l => l.includes('RESPOND {"A":66}'))).toBe(true);
    } finally { m.destroy(); }
  });
});
