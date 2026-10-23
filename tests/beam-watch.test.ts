/**
 * Watchpoints and beam-stamped logging (docs/beam-debug-mcp-spec.md P5, 1a,
 * 1b): the Atari's watchpoints work and stop the run, a log-mode watchpoint
 * records every access with the accessing pc and the instruction's last cycle,
 * a log trap writes pc rows, and no row is reported for an interrupt-entry
 * step.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { BeamLog, BEAM_IO, BEAM_PC } from '@/debug/beam-log.ts';
import { installTrapHook, traps, trapLog, type Trap } from '../mcp/traps.ts';
import { armBeamLog, formatEntry, FLAG_REGS, type BeamReadOptions } from '../mcp/beam.ts';

const OPTS: BeamReadOptions = { offset: 0, limit: 100, showT: false, relDisplay: false };

/** An OS that runs `program` at $E000 forever; NMI vector -> $E100 (a JMP loop). */
function bootAtari(program: number[]): AtariMachine {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  rom.set(program, 0x800);
  rom.set([0x4c, 0x00, 0xe1], 0x900);          // $E100: JMP $E100
  rom[0x27fa] = 0x00; rom[0x27fb] = 0xe1;      // NMI -> $E100
  rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;      // reset -> $E000
  const m = new AtariMachine('atari800', null, 'ntsc');
  m.services.roms.installSystemRom(rom);
  m.reset();
  return m;
}

/** $E000: LDA #$1E ; STA COLBK ; JMP $E000 — a nine-cycle loop. */
const COLBK_LOOP = [0xa9, 0x1e, 0x8d, 0x1a, 0xd0, 0x4c, 0x00, 0xe0];
/** $E000: STA WSYNC ; JMP $E000 — one line per trip. */
const WSYNC_LOOP = [0x8d, 0x0a, 0xd4, 0x4c, 0x00, 0xe0];

describe('Atari memory watchpoints (break mode)', () => {
  it('stops the run on a write and says so', () => {
    const m = bootAtari(COLBK_LOOP);
    try {
      m.memWatchpoints.push({ start: 0xD01A, end: 0xD01A, mode: 'write' });
      expect(m.runUntil(3)).toBe(1);
      expect(m.stopReason?.kind).toBe('watch');
      expect(m.memWatchHit).toEqual({ addr: 0xD01A, value: 0x1E, dir: 'write' });
      expect(m.cpu.pc).toBe(0xE005); // the instruction after the STA
    } finally { m.destroy(); }
  });

  it('stops on the store that ends a line (a WSYNC leaves the instruction loop early)', () => {
    const m = bootAtari(WSYNC_LOOP);
    try {
      m.memWatchpoints.push({ start: 0xD40A, end: 0xD40A, mode: 'write' });
      expect(m.runUntil(3)).toBe(1);
      expect(m.stopReason?.kind).toBe('watch');
      expect(m.cpu.pc).toBe(0xE003);
    } finally { m.destroy(); }
  });

  it('a read watchpoint sees the CPU read, and a write-only one ignores it', () => {
    // $E000: LDA $D01A... GTIA reads of D01A are not readable registers but the bus access still happens.
    const m = bootAtari([0xad, 0x1a, 0xd0, 0x4c, 0x00, 0xe0]);
    try {
      m.memWatchpoints.push({ start: 0xD01A, end: 0xD01A, mode: 'write' });
      m.tick();
      expect(m.stopReason).toBeNull();
      m.memWatchpoints.length = 0;
      m.memWatchpoints.push({ start: 0xD01A, end: 0xD01A, mode: 'read' });
      m.tick();
      expect(m.stopReason?.kind).toBe('watch');
    } finally { m.destroy(); }
  });
});

describe('Atari memory watchpoints (log mode)', () => {
  it('records every write with the accessing pc and the last cycle of the store, and does not stop', () => {
    const m = bootAtari(COLBK_LOOP);
    try {
      m.beamLog = new BeamLog();
      m.memWatchpoints.push({ start: 0xD01A, end: 0xD01A, mode: 'write', action: 'log' });
      m.tick();
      expect(m.stopReason).toBeNull();
      expect(m.frameNumber).toBe(1);
      const log = m.beamLog!;
      expect(log.length).toBeGreaterThan(1000);
      const first = log.get(0);
      expect(first).toMatchObject({ kind: BEAM_IO, frame: 0, pc: 0xE002, addr: 0xD01A, value: 0x1E, flags: 1 });
      // The loop is nine cycles a trip, plus the DMA cycles the core spreads
      // across each line: consecutive stamps are 9 to 11 apart, except across
      // a line end.
      let near = 0;
      for (let i = 1; i < 500; i++) {
        const d = log.get(i).t - log.get(i - 1).t;
        if (d >= 9 && d <= 11) near++;
      }
      expect(near).toBeGreaterThan(450);
      // The first store is the last cycle of LDA(2) + STA(4) from the first
      // instruction: 5 cycles in, plus whatever reset left t at.
      expect(first.t).toBeGreaterThanOrEqual(5);
      expect(first.t).toBeLessThan(40);
    } finally { m.destroy(); }
  });

  it('the values filter keeps only those writes', () => {
    const m = bootAtari(COLBK_LOOP);
    try {
      m.beamLog = new BeamLog();
      m.memWatchpoints.push({ start: 0xD01A, end: 0xD01A, mode: 'write', action: 'log', values: [0x00] });
      m.tick();
      expect(m.beamLog.length).toBe(0);
      m.memWatchpoints.length = 0;
      m.memWatchpoints.push({ start: 0xD01A, end: 0xD01A, mode: 'write', action: 'log', values: [0x1E] });
      m.tick();
      expect(m.beamLog.length).toBeGreaterThan(1000);
    } finally { m.destroy(); }
  });

  it('the frame filter drops events outside it at capture time', () => {
    const m = bootAtari(COLBK_LOOP);
    try {
      const log = armBeamLog(m, '1', undefined)!;
      m.memWatchpoints.push({ start: 0xD01A, end: 0xD01A, mode: 'write', action: 'log' });
      m.tick();
      expect(log.length).toBe(0);
      m.tick();
      expect(log.length).toBeGreaterThan(1000);
      expect(log.get(0).frame).toBe(1);
    } finally { m.destroy(); }
  });

  it('the line filter keeps only those lines', () => {
    const m = bootAtari(COLBK_LOOP);
    try {
      const log = armBeamLog(m, undefined, '100-101')!;
      m.memWatchpoints.push({ start: 0xD01A, end: 0xD01A, mode: 'write', action: 'log' });
      m.tick();
      expect(log.length).toBeGreaterThan(10);
      for (let i = 0; i < log.length; i++) {
        const line = Math.floor(log.get(i).t / 114);
        expect(line === 100 || line === 101).toBe(true);
      }
    } finally { m.destroy(); }
  });
});

describe('beam-stamped log traps', () => {
  beforeEach(() => {
    traps.clear();
    trapLog.length = 0;
  });

  it('a log trap writes a pc row with the label, registers and beam, and a stamped text line', () => {
    const m = bootAtari(COLBK_LOOP);
    try {
      installTrapHook(m);
      armBeamLog(m);
      const trap: Trap = { address: 0xE002, action: 'log', label: 'colbk', regs: true, responses: [] };
      traps.set(0xE002, [trap]);
      m.tick();
      const log = m.beamLog!;
      expect(log.length).toBeGreaterThan(1000);
      const e = log.get(0);
      expect(e).toMatchObject({ kind: BEAM_PC, frame: 0, pc: 0xE002, flags: FLAG_REGS });
      // LDA #$1E has run: A = $1E.
      expect(e.regLo & 0xFF).toBe(0x1E);
      expect(formatEntry(m, e, OPTS)).toMatch(/^0 \d+ \d+ E002 colbk \[A=1E /);
      expect(trapLog[0]).toMatch(/^\[E002\] colbk .* B=0\/\d+\/\d+$/);
    } finally { m.destroy(); }
  });

  it('no row is reported for the step that enters an interrupt', () => {
    const m = bootAtari(COLBK_LOOP);
    try {
      const seen: number[] = [];
      m.onTrap = (pc) => { if (seen.length < 5) seen.push(pc); return false; };
      m.cpu.nmi();
      m.tick();
      // The first step enters the NMI handler; the first instruction reported
      // is the one at the handler, not the interrupted $E000.
      expect(seen[0]).toBe(0xE100);
      expect(seen).not.toContain(0xE000);
    } finally { m.destroy(); }
  });
});

describe('Z80 register snapshot in a log trap', () => {
  beforeEach(() => {
    traps.clear();
    trapLog.length = 0;
  });

  it('records IX, IY, SP, I and IM as well as AF, BC, DE and HL', () => {
    const s = new Spectrum('zx48k', null);
    s.loadROM(new Uint8Array(16384));
    try {
      installTrapHook(s);
      armBeamLog(s);
      s.cpu.pc = 0x8000;                       // RAM is all NOPs
      s.cpu.ix = 0x1234; s.cpu.iy = 0xABCD; s.cpu.sp = 0xBFF0;
      s.cpu.i = 0x3F; s.cpu.im = 2;
      s.cpu.bc = 0x0102; s.cpu.de = 0x0304; s.cpu.hl = 0x0506;
      const trap: Trap = { address: 0x8003, action: 'log', label: 'z', regs: true, responses: [] };
      traps.set(0x8003, [trap]);
      s.tick();
      const e = s.beamLog!.get(0);
      expect(e).toMatchObject({ kind: BEAM_PC, pc: 0x8003, flags: FLAG_REGS });
      expect(formatEntry(s, e, OPTS)).toMatch(
        /^0 \d+ \d+ 8003 z \[AF=\w{4} BC=0102 DE=0304 HL=0506 IX=1234 IY=ABCD SP=BFF0 I=3F IM=2\]$/);
    } finally { s.destroy(); }
  });
});

describe('Spectrum port log', () => {
  it('records an OUT (C),r to a logged port with the pc and a t inside the instruction', () => {
    const s = new Spectrum('zx48k', null);
    s.loadROM(new Uint8Array(16384));
    try {
      // LD BC,$00FE ; loop: OUT (C),A ; JR loop
      [0x01, 0xFE, 0x00, 0xED, 0x79, 0x18, 0xFC].forEach((b, i) => s.memory.writeByte(0x8000 + i, b));
      s.cpu.pc = 0x8000;
      s.beamLog = new BeamLog();
      s.portWatchpoints.add(0x00FE);
      s.portLogPorts.add(0x00FE);
      let startT = -1;
      s.onTrap = (pc) => {
        if (pc === 0x8003 && startT < 0) startT = s.beam().t;
        return false;
      };
      s.tick();
      expect(s.stopReason).toBeNull();
      const log = s.beamLog;
      expect(log.length).toBeGreaterThan(1000);
      const e = log.get(0);
      expect(e).toMatchObject({ kind: BEAM_IO, frame: 0, pc: 0x8003, addr: 0x00FE, flags: 3 });
      // OUT (C),A is 12 T-states; the port write happens inside it.
      expect(e.t - startT).toBeGreaterThanOrEqual(4);
      expect(e.t - startT).toBeLessThanOrEqual(12);
      expect(formatEntry(s, e, OPTS)).toMatch(/^0 \d+ \d+ 8003 00FE \d\d out$/);
    } finally { s.destroy(); }
  });
});
