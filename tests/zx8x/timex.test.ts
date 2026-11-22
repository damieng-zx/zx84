/**
 * Timex Sinclair 1000 and 1500: the US ZX81. Same Z80, ULA and 8K ROM as the
 * ZX81, but the TS1000 carries 2K of RAM and the TS1500 16K, and both put out
 * a 60 Hz, 262-line picture (the ZX81's is 50 Hz, 312 lines) which the ULA
 * announces to the ROM on bit 6 of the keyboard port.
 *
 * Expected values come from the hardware, not from the implementation: a line
 * is 207T on every model; 262 x 207 = 54,234T and 312 x 207 = 64,584T; the
 * ZX81 manual's system-variable table gives MARGIN as 55 in Britain and 31 in
 * America and RAMTOP as the first address above RAM.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import { Zx8xMemory } from '@/machines/zx8x/memory.ts';
import { zx8xEntry } from '@/machines/zx8x/descriptor.ts';
import { isZx81Class, isZx8xModel, isZx8xNtsc, zx8xBuiltinRamKb, zx8xTakesRamPack } from '@/machines/zx8x/models.ts';
import { isZx8xProgramFile } from '@/machines/zx8x/services/tape.ts';
import { entryForModel } from '@/machines/registry.ts';
import { MODEL_LABELS, menuModels } from '@/ui/panes/model-menu.ts';
import { QUOTE, ZX81_ROM_PATH, boot, haveZx81Rom, settle, type, word } from './rom-harness.ts';

const MARGIN = 0x4028;
const RAMTOP = 0x4004;
const KEYBOARD_PORT = 0xfefe;

/** An 8K ROM that does nothing but spin: JR $ (12T per pass). */
function idleRom(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set([0x18, 0xfe], 0);
  return rom;
}

function idle(model: 'zx80' | 'zx81' | 'ts1000' | 'ts1500'): Zx8xMachine {
  const m = new Zx8xMachine(model);
  m.start = async () => {};
  m.loadROM(idleRom());
  m.reset();
  return m;
}

describe('Timex Sinclair model identity', () => {
  it('are ZX8x models running the ZX81 ROM, and only they are NTSC', () => {
    expect(isZx8xModel('ts1000')).toBe(true);
    expect(isZx8xModel('ts1500')).toBe(true);
    expect(isZx81Class('ts1000')).toBe(true);
    expect(isZx81Class('ts1500')).toBe(true);
    expect(isZx81Class('zx80')).toBe(false);
    expect(isZx8xNtsc('ts1000')).toBe(true);
    expect(isZx8xNtsc('ts1500')).toBe(true);
    expect(isZx8xNtsc('zx81')).toBe(false);
    expect(isZx8xNtsc('zx80')).toBe(false);
  });

  it('carry 1K (ZX81), 2K (TS1000) and 16K (TS1500) on the board', () => {
    expect(zx8xBuiltinRamKb('zx81')).toBe(1);
    expect(zx8xBuiltinRamKb('ts1000')).toBe(2);
    expect(zx8xBuiltinRamKb('ts1500')).toBe(16);
  });

  it('offer the 16K pack to every model but the TS1500, which has the RAM already', () => {
    expect(zx8xTakesRamPack('zx80')).toBe(true);
    expect(zx8xTakesRamPack('zx81')).toBe(true);
    expect(zx8xTakesRamPack('ts1000')).toBe(true);
    expect(zx8xTakesRamPack('ts1500')).toBe(false);
    expect(zx8xTakesRamPack('zx48k')).toBe(false);
  });

  it('are registered as ZX8x machines and reachable from the model menu', () => {
    expect(entryForModel('ts1000').kind).toBe('zx8x');
    expect(entryForModel('ts1500').kind).toBe('zx8x');
    expect(menuModels()).toEqual(expect.arrayContaining(['ts1000', 'ts1500']));
    expect(MODEL_LABELS.ts1000).toBe('Timex Sinclair 1000');
    expect(MODEL_LABELS.ts1500).toBe('Timex Sinclair 1500');
  });

  it('boot the ZX81 ROM image, and an 8K ROM drop keeps a Timex model instead of becoming a ZX81', () => {
    expect(zx8xEntry.romSources('ts1000')).toEqual(zx8xEntry.romSources('zx81'));
    expect(zx8xEntry.romSources('ts1500')).toEqual(zx8xEntry.romSources('zx81'));
    const rom = new Uint8Array(0x2000);
    expect(zx8xEntry.detectModelForRom!(rom, 'ts1000')).toBe('ts1000');
    expect(zx8xEntry.detectModelForRom!(rom, 'ts1500')).toBe('ts1500');
    expect(zx8xEntry.detectModelForRom!(rom, 'zx81')).toBe('zx81');
    expect(zx8xEntry.detectModelForRom!(rom, 'zx80')).toBe('zx81');
    expect(zx8xEntry.detectModelForRom!(new Uint8Array(0x1000), 'ts1000')).toBe('zx80');
  });

  it('take ZX81 program files (.p), not ZX80 ones (.o)', () => {
    expect(isZx8xProgramFile('ts1000', 'game.p')).toBe(true);
    expect(isZx8xProgramFile('ts1500', 'game.p81')).toBe(true);
    expect(isZx8xProgramFile('ts1000', 'game.o')).toBe(false);
  });
});

describe('Timex Sinclair memory', () => {
  it('TS1000: 2K RAM that echoes every 2K through the RAM window and across A15', () => {
    const memory = new Zx8xMemory('ts1000');
    expect(memory.ramSize).toBe(2048);
    memory.writeByte(0x4000, 0x11);
    memory.writeByte(0x47ff, 0x22);
    expect(memory.readByte(0x4800)).toBe(0x11);   // one 2K up
    expect(memory.readByte(0x7800)).toBe(0x11);   // top 2K of the 16K window
    expect(memory.readByte(0xc000)).toBe(0x11);   // A15 is not decoded
    expect(memory.readByte(0x4fff)).toBe(0x22);
    expect(memory.readByte(0x4400)).toBe(0);      // not the ZX81's 1K echo
  });

  it('TS1000: a 16K pack makes the window contiguous, and removing it restores the 2K', () => {
    const memory = new Zx8xMemory('ts1000');
    memory.writeByte(0x4010, 0x5a);
    memory.set16kExpansion(true);
    expect(memory.ramSize).toBe(0x4000);
    expect(memory.has16kExpansion).toBe(true);
    expect(memory.readByte(0x4010)).toBe(0x5a);   // contents survive fitting the pack
    memory.writeByte(0x4800, 0x77);
    expect(memory.readByte(0x4000)).toBe(0);      // no longer an echo
    memory.set16kExpansion(false);
    expect(memory.ramSize).toBe(2048);
    expect(memory.has16kExpansion).toBe(false);
    expect(memory.readByte(0x4010)).toBe(0x5a);
  });

  it('TS1500: 16K contiguous RAM from the start, and no pack to remove', () => {
    const memory = new Zx8xMemory('ts1500');
    expect(memory.ramSize).toBe(0x4000);
    expect(memory.has16kExpansion).toBe(true);
    memory.writeByte(0x4000, 0x01);
    memory.writeByte(0x7fff, 0x02);
    expect(memory.readByte(0x4800)).toBe(0);
    expect(memory.readByte(0x7fff)).toBe(0x02);
    expect(memory.readByte(0xc000)).toBe(0x01);   // only A15 is undecoded
    memory.set16kExpansion(false);
    expect(memory.ramSize).toBe(0x4000);
    expect(memory.readByte(0x7fff)).toBe(0x02);
  });

  it('the ZX81 is still 1K, so the TS1000 change left it alone', () => {
    const memory = new Zx8xMemory('zx81');
    expect(memory.ramSize).toBe(1024);
    memory.writeByte(0x4000, 0x33);
    expect(memory.readByte(0x4400)).toBe(0x33);
  });
});

describe('Timex Sinclair video timing', () => {
  it('runs a 262-line frame of 207T (54,234T) where the ZX81 runs 312 (64,584T)', () => {
    expect(new Zx8xMachine('ts1000').tStatesPerFrame).toBe(54_234);
    expect(new Zx8xMachine('ts1500').tStatesPerFrame).toBe(54_234);
    expect(new Zx8xMachine('zx81').tStatesPerFrame).toBe(64_584);
    expect(new Zx8xMachine('zx80').tStatesPerFrame).toBe(64_584);
    expect(new Zx8xMachine('ts1000').beamInfo().linesPerFrame).toBe(262);
    expect(new Zx8xMachine('zx81').beamInfo().linesPerFrame).toBe(312);
    expect(new Zx8xMachine('ts1000').beamInfo().cyclesPerLine).toBe(207);
  });

  it('paces at 60 Hz, and the ZX81 stays at 50 Hz', () => {
    expect(new Zx8xMachine('ts1000')['frameHz']).toBe(60);
    expect(new Zx8xMachine('ts1500')['frameHz']).toBe(60);
    expect(new Zx8xMachine('zx81')['frameHz']).toBe(50);
    expect(new Zx8xMachine('zx80')['frameHz']).toBe(50);
  });

  it('a 3.25 MHz CPU through that frame refreshes at 59.9 Hz, not 50', () => {
    const hz = 3_250_000 / new Zx8xMachine('ts1000').tStatesPerFrame;
    expect(hz).toBeGreaterThan(59.9);
    expect(hz).toBeLessThan(60);
  });

  it('each frame advances the CPU by exactly one TS1000 frame of T-states, to within one instruction', () => {
    const m = idle('ts1000');
    const start = m.cpu.tStates;
    for (let f = 0; f < 10; f++) m.tick();
    const elapsed = m.cpu.tStates - start;
    expect(Math.abs(elapsed - 10 * 54_234)).toBeLessThan(24);   // JR $ is 12T; one pass of slack either side
  });

  it('the same loop on a ZX81 advances 64,584T a frame', () => {
    const m = idle('zx81');
    const start = m.cpu.tStates;
    for (let f = 0; f < 10; f++) m.tick();
    expect(Math.abs(m.cpu.tStates - start - 10 * 64_584)).toBeLessThan(24);
  });
});

describe('Timex Sinclair 50/60 Hz strap on the keyboard port', () => {
  /** What IN A,(FE) returns with no key held. */
  const idleRead = (model: 'zx80' | 'zx81' | 'ts1000' | 'ts1500'): number => new Zx8xMachine(model).cpu.portInHandler!(KEYBOARD_PORT);

  it('reads bit 6 high on the British 50 Hz models', () => {
    expect(idleRead('zx81') & 0x40).toBe(0x40);
    expect(idleRead('zx80') & 0x40).toBe(0x40);
  });

  it('reads bit 6 low on the US 60 Hz models', () => {
    expect(idleRead('ts1000') & 0x40).toBe(0);
    expect(idleRead('ts1500') & 0x40).toBe(0);
  });

  it('leaves the five key bits released (high) and bit 7 (EAR) alone', () => {
    expect(idleRead('ts1000') & 0x9f).toBe(0x1f);
  });
});

describe.skipIf(!haveZx81Rom)(`on the real ZX81 ROM (skipped without ${ZX81_ROM_PATH.split(/[\\/]/).pop()})`, () => {
  it('the ZX81 reports the British MARGIN (55) and 1K RAMTOP (0x4400)', () => {
    const m = boot({}, 'zx81');
    expect(m.memory.readByte(MARGIN)).toBe(55);
    expect(word(m, RAMTOP)).toBe(0x4400);
  });

  it('the TS1000 reads the 60 Hz strap: MARGIN is the American 31, and the ROM finds its 2K (RAMTOP 0x4800)', () => {
    const m = boot({}, 'ts1000');
    expect(m.memory.readByte(MARGIN)).toBe(31);
    expect(word(m, RAMTOP)).toBe(0x4800);
  });

  it('the TS1000 with the 16K pack finds 16K (RAMTOP 0x8000)', () => {
    const m = boot({ 'zx8x-16k-ram': true }, 'ts1000');
    expect(m.memory.readByte(MARGIN)).toBe(31);
    expect(word(m, RAMTOP)).toBe(0x8000);
  });

  it('the TS1500 finds its built-in 16K (RAMTOP 0x8000) at 60 Hz (MARGIN 31)', () => {
    const m = boot({}, 'ts1500');
    expect(m.memory.readByte(MARGIN)).toBe(31);
    expect(word(m, RAMTOP)).toBe(0x8000);
  });

  describe.each(['ts1000', 'ts1500'] as const)('%s viewers on a typed program', (model) => {
    /** Type one program line and wait for the ROM to take it. */
    const enter = (m: ReturnType<typeof boot>, keys: Parameters<typeof type>[1]): void => { type(m, keys); settle(m); };
    /** 10 PRINT 42 / 20 LET A=7 / 30 LET B$="HI". */
    const typed = () => {
      const m = boot({}, model);
      enter(m, ['Digit1', 'Digit0', 'KeyP', 'Digit4', 'Digit2', 'Enter']);
      enter(m, ['Digit2', 'Digit0', 'KeyL', 'KeyA', ['ShiftLeft', 'KeyL'], 'Digit7', 'Enter']);
      enter(m, ['Digit3', 'Digit0', 'KeyL', 'KeyB', ['ShiftLeft', 'KeyU'], ['ShiftLeft', 'KeyL'],
        QUOTE, 'KeyH', 'KeyI', QUOTE, 'Enter']);
      return m;
    };
    const run = (m: ReturnType<typeof boot>): void => { enter(m, ['KeyR', 'Enter']); };

    it('lists the program from the ROM-built program area', () => {
      const m = typed();
      expect(m.services.probe.panes!.basicListing!()).toEqual([
        { lineNumber: 10, text: 'PRINT 42' },
        { lineNumber: 20, text: 'LET A=7' },
        { lineNumber: 30, text: 'LET B$="HI"' },
      ]);
    });

    it('shows its variables once it has run, numbers and strings', () => {
      const m = typed();
      run(m);
      expect(m.services.probe.panes!.basicVars!()).toEqual([
        { name: 'A', kind: 'number', value: '7' },
        { name: 'B$', kind: 'string', value: 'HI' },
      ]);
    });

    it('reads the screen as text: the program output and the 0/30 report', () => {
      const m = typed();
      run(m);
      const rows = m.ocrScreenForMcp().split(/\r?\n/);
      expect(rows[0]).toBe('[32x24]');
      expect(rows[1]).toBe('42');
      expect(rows.some(row => row.startsWith('0/30'))).toBe(true);
      const styled = m.ocrScreenStyled();
      expect(styled.text.split(/\r?\n/)[0].trimEnd()).toBe('42');
      expect(styled.mask[0]).toBe(true);
      expect(styled.mask[2]).toBe(false);
    });
  });

  it('the TS1000 reaches the BASIC prompt and keeps the display going: the NMI generator runs at 262 lines', () => {
    const m = boot({}, 'ts1000');
    const rom = new Uint8Array(readFileSync(ZX81_ROM_PATH));
    expect(m.memory.getRom().slice(0, 16)).toEqual(rom.slice(0, 16));
    const before = m.cpu.tStates;
    m.tick();
    expect(m.cpu.tStates - before).toBeGreaterThan(54_000);
    expect(m.cpu.tStates - before).toBeLessThan(54_500);
  });
});
