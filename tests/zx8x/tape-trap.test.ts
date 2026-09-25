import { describe, expect, it, vi } from 'vitest';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import { Zx81TapeShelf, programNameFromFilename, zx81NameToAscii } from '@/machines/zx8x/tape-shelf.ts';

/** An 8K ROM carrying the ZX81 ROM's LOAD ($0340), IN-NAME ($0364), SAVE
 *  ($02F6) and SLOW/FAST ($0207) byte sequences the traps key on, with a
 *  HALT after SLOW/FAST's first instruction so the test can see the resume. */
function cassetteRom(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set([0xcd, 0xa8, 0x03, 0xcb, 0x12, 0xcb, 0x0a, 0xcd, 0x4c, 0x03], 0x0340);
  rom.set([0x62, 0x6b, 0xcd, 0x4c, 0x03], 0x0364);
  rom.set([0xcd, 0xa8, 0x03, 0x38, 0xf9, 0xeb], 0x02f6);
  rom.set([0x21, 0x3b, 0x40, 0x76], 0x0207);
  rom[0x034c] = 0x18; rom[0x034d] = 0xfe; // IN-BYTE stand-in: JR $ (no signal)
  return rom;
}

function machineAt(pc: number): Zx8xMachine {
  const machine = new Zx8xMachine('zx81');
  machine.loadROM(cassetteRom());
  machine.cpu.pc = pc;
  machine.cpu.sp = 0x43f0;
  machine.breakpoints.add(0x020a); // the HALT placed after SLOW/FAST's LD HL
  return machine;
}

/** ZX81 codes: A=$26 … Z=$3F; the last character of a name has bit 7 set. */
function writeName(machine: Zx8xMachine, addr: number, codes: number[]): void {
  codes.forEach((code, i) => machine.memory.writeByte(addr + i, i === codes.length - 1 ? code | 0x80 : code));
  machine.cpu.d = addr >> 8;
  machine.cpu.e = addr & 0xff;
}

function ramFrom(machine: Zx8xMachine, addr: number, length: number): number[] {
  return Array.from({ length }, (_, i) => machine.memory.readByte(addr + i));
}

describe('ZX81 cassette LOAD/SAVE traps', () => {
  it('LOAD "" reads the next unplayed program into VERSN onward and resumes at SLOW/FAST', () => {
    const machine = machineAt(0x0347);
    machine.tapeShelf.insert('FIRST', new Uint8Array([1, 2, 3]), true);   // already auto-loaded
    machine.tapeShelf.insert('SECOND', new Uint8Array([7, 8, 9]), false);
    machine.cpu.d = 0xc1; // bit 7 set: null name
    machine.tick();
    expect(machine.breakpointHit).toBe(0x020a);
    expect(ramFrom(machine, 0x4009, 3)).toEqual([7, 8, 9]);
    expect(machine.memory.readByte(0x4008)).toBe(0); // bytes below VERSN untouched
  });

  it('LOAD "NAME" skips programs whose name does not match', () => {
    const machine = machineAt(0x0347);
    machine.tapeShelf.insert('A', new Uint8Array([0x11]), false);
    machine.tapeShelf.insert('B', new Uint8Array([0x22]), false);
    writeName(machine, 0x4200, [0x27]); // "B"
    machine.tick();
    expect(machine.breakpointHit).toBe(0x020a);
    expect(machine.memory.readByte(0x4009)).toBe(0x22);
  });

  it('keeps LOAD waiting when the named program is not on the tape', () => {
    const machine = machineAt(0x0347);
    machine.tapeShelf.insert('A', new Uint8Array([0x11]), false);
    writeName(machine, 0x4200, [0x27]); // "B"
    machine.tick();
    expect(machine.breakpointHit).toBe(-1);
    expect(machine.memory.readByte(0x4009)).toBe(0);
    expect(machine.awaitingTapeLoad).toBe(true);
  });

  it('SAVE captures VERSN up to but excluding E_LINE under its name', () => {
    const machine = machineAt(0x02fb);
    writeName(machine, 0x4200, [0x3d, 0x31]); // "XL"
    for (let i = 0; i < 16; i++) machine.memory.writeByte(0x4009 + i, 0xa0 + i);
    machine.memory.writeByte(0x4014, 0x0c); // E_LINE = $400C
    machine.memory.writeByte(0x4015, 0x40);
    machine.tick();
    expect(machine.breakpointHit).toBe(0x020a);
    const saved = machine.tapeShelf.list();
    expect(saved.map(p => p.name)).toEqual(['XL']);
    expect(Array.from(saved[0].data)).toEqual([0xa0, 0xa1, 0xa2]);
  });

  it('mounting a program while LOAD waits plays it into that LOAD instead of resetting', async () => {
    const machine = machineAt(0x0366);
    writeName(machine, 0x4200, [0x27]); // LOAD "B", but the user plays another tape
    const reload = vi.spyOn(machine, 'loadProgram');
    const result = await machine.services.media.mount(new Uint8Array([0x5a, 0x5b]), 'part two.p');
    expect(result.ok).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    machine.tick();
    expect(machine.breakpointHit).toBe(0x020a);
    expect(ramFrom(machine, 0x4009, 2)).toEqual([0x5a, 0x5b]);
  });

  it('does not trap a ROM without the standard cassette routines', () => {
    const machine = new Zx8xMachine('zx81');
    machine.loadROM(new Uint8Array(0x2000));
    machine.cpu.pc = 0x0347;
    machine.tapeShelf.insert('A', new Uint8Array([0x11]), false);
    machine.cpu.d = 0x80;
    machine.tick();
    expect(machine.memory.readByte(0x4009)).toBe(0);
  });
});

describe('ZX81 tape names', () => {
  it('decodes the ZX81 character set, ignoring the inverse bit', () => {
    // 0x0B '"', 0x0D '$', 0x1C '0', 0x25 '9', 0x26 'A', 0x3F 'Z', 0x1B '.'
    expect(zx81NameToAscii([0x0b, 0x0d, 0x1c, 0x25, 0x26, 0x3f, 0x1b | 0x80])).toBe('"$09AZ.');
  });

  it('derives the tape name from a host filename', () => {
    expect(programNameFromFilename('games/Mazogs.p')).toBe('MAZOGS');
    expect(programNameFromFilename('3d monster maze.P81')).toBe('3D MONSTER MAZE');
  });

  it('winds forward from the play position and wraps once', () => {
    const shelf = new Zx81TapeShelf();
    shelf.insert('A', new Uint8Array([1]), false);
    shelf.insert('B', new Uint8Array([2]), false);
    expect(shelf.take('B')?.data[0]).toBe(2);
    expect(shelf.take(null)).toBeNull();      // nothing after B
    expect(shelf.take('A')?.data[0]).toBe(1); // wrap back to A
    expect(shelf.take(null)?.data[0]).toBe(2);
  });
});
