/**
 * Expansion RAM and programs on the VIC-20: what each Hardware-pane choice
 * fits, the RAM a program's load address says it was written for, and a
 * .prg dropped on the machine going into memory the way LOAD and RUN leave
 * it.
 *
 * The memory sizes come from the VIC-20 Programmer's Reference Guide: BASIC
 * starts at $1001 on an unexpanded machine, at $0401 with the 3K cartridge,
 * and at $1201 with 8K or more (the screen moving to $1000); the 3K at
 * $0400-$0FFF, BLK1-3 at $2000-$7FFF, BLK5 at $A000-$BFFF. LOAD sets
 * VARTAB ($2D), ARYTAB ($2F) and STREND ($31) to the end of the program,
 * and the KERNAL types from its buffer at $0277, its count at $C6.
 */

import { describe, it, expect } from 'vitest';
import { VIC20_NO_EXPANSION } from '@/machines/vic20/memory.ts';
import {
  readVic20Expansion, vic20BasicStart, vic20Expansion, vic20ExpansionFor,
} from '@/machines/vic20/options.ts';
import { firmware, machine } from './firmware.ts';

const NONE = VIC20_NO_EXPANSION;

describe('VIC-20 expansion choices', () => {
  it.each([
    ['none', { ram123: false, blk1: false, blk2: false, blk3: false }, 0x1001],
    ['3k', { ram123: true, blk1: false, blk2: false, blk3: false }, 0x0401],
    ['8k', { ram123: false, blk1: true, blk2: false, blk3: false }, 0x1201],
    ['16k', { ram123: false, blk1: true, blk2: true, blk3: false }, 0x1201],
    ['24k', { ram123: false, blk1: true, blk2: true, blk3: true }, 0x1201],
    ['27k', { ram123: true, blk1: true, blk2: true, blk3: true }, 0x1201],
  ] as const)('%s fits its blocks and puts BASIC where the KERNAL does', (choice, blocks, basic) => {
    const e = vic20Expansion(choice, false);
    expect({ ram123: e.ram123, blk1: e.blk1, blk2: e.blk2, blk3: e.blk3 }).toEqual(blocks);
    expect(e.blk5).toBe(false);
    expect(vic20BasicStart(e)).toBe(basic);
  });

  it('reads the setting, falling back to unexpanded for nonsense', () => {
    const view = (ram: string, blk5: boolean) => ({
      get: <T>(key: string, fallback: T): T =>
        (key === 'vic20-ram' ? ram : key === 'vic20-blk5' ? blk5 : fallback) as T,
    });
    expect(readVic20Expansion(view('16k', true))).toEqual(vic20Expansion('16k', true));
    expect(readVic20Expansion(view('64k', false))).toEqual(NONE);
  });

  it('fits the RAM the Hardware pane asks for when the machine is prepared', () => {
    const m = machine(firmware());
    m.prepare({ get: <T>(key: string, fallback: T): T => (key === 'vic20-ram' ? '8k' : fallback) as T });
    m.memory.openBus = () => 0x5A;
    m.memory.writeByte(0x2000, 0x11);
    expect(m.memory.readByte(0x2000)).toBe(0x11);
    m.destroy();
  });
});

describe('the RAM a program needs', () => {
  it('leaves a BASIC program alone on the memory it was written for', () => {
    expect(vic20ExpansionFor(0x1001, 3000, NONE)).toBeNull();
    expect(vic20ExpansionFor(0x0401, 3000, vic20Expansion('3k', false))).toBeNull();
    expect(vic20ExpansionFor(0x1201, 3000, vic20Expansion('24k', false))).toBeNull();
  });

  it('fits the 3K for a program at $0401, and takes it out for one at $1001', () => {
    expect(vic20ExpansionFor(0x0401, 100, NONE)).toEqual(vic20Expansion('3k', false));
    expect(vic20ExpansionFor(0x1001, 100, vic20Expansion('8k', false))).toEqual(NONE);
  });

  it('fits as many 8K blocks as a $1201 program reaches into', () => {
    // $2DFF bytes from $1201: the last at $3FFF, the top of BLK1.
    expect(vic20ExpansionFor(0x1201, 0x2DFF, NONE)).toEqual(vic20Expansion('8k', false));
    // One byte more lands on $4000: BLK2.
    expect(vic20ExpansionFor(0x1201, 0x2E00, NONE)).toEqual(vic20Expansion('16k', false));
    expect(vic20ExpansionFor(0x1201, 0x5000, NONE)).toEqual(vic20Expansion('24k', false));
    // 8K fitted but the program needs 16K.
    expect(vic20ExpansionFor(0x1201, 0x4000, vic20Expansion('8k', false))).toEqual(vic20Expansion('16k', false));
  });

  it('fits RAM under machine code loaded elsewhere, keeping what is fitted', () => {
    expect(vic20ExpansionFor(0x6000, 0x100, NONE)).toEqual(vic20Expansion('24k', false));
    expect(vic20ExpansionFor(0xA000, 0x2000, NONE)).toEqual(vic20Expansion('none', true));
    expect(vic20ExpansionFor(0x2000, 0x100, vic20Expansion('16k', true))).toBeNull();
    // The 3K and a block together are only offered as 3K + 24K.
    expect(vic20ExpansionFor(0x0400, 0x1C10, NONE)).toEqual(vic20Expansion('27k', false));
    // Machine code in the board's own RAM needs nothing.
    expect(vic20ExpansionFor(0x1800, 0x100, NONE)).toBeNull();
  });
});

/** A .prg file: the load address, then the bytes. */
function prg(start: number, bytes: number[]): Uint8Array {
  return Uint8Array.from([start & 0xFF, start >> 8, ...bytes]);
}

describe('loading a .prg', () => {
  it('puts a BASIC program at the start of BASIC, sets the pointers and types RUN', async () => {
    const m = machine(firmware(0x1001));
    const body = [0x0B, 0x10, 0x0A, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00];
    const r = await m.services.media.mount(prg(0x1001, body), 'hello.prg');
    expect(r.ok, r.message).toBe(true);
    for (let f = 0; f < 15; f++) m.tick();
    const ram = m.memory.ram;
    expect(Array.from(ram.subarray(0x1001, 0x1001 + body.length))).toEqual(body);
    const end = 0x1001 + body.length;
    for (const ptr of [0x2D, 0x2F, 0x31]) expect(ram[ptr] | (ram[ptr + 1] << 8), `pointer $${ptr.toString(16)}`).toBe(end);
    expect(Array.from(ram.subarray(0x0277, 0x027B))).toEqual([0x52, 0x55, 0x4E, 0x0D]);
    expect(ram[0xC6]).toBe(4);
    m.destroy();
  });

  it('waits for BASIC to be at READY before putting the program in', async () => {
    const m = machine(firmware());                    // never shows READY.
    await m.services.media.mount(prg(0x1001, [0xAA, 0xBB]), 'x.prg');
    for (let f = 0; f < 20; f++) m.tick();
    expect(m.memory.ram[0x1001], 'not yet').not.toBe(0xAA);
    m.destroy();
  });

  it('fits 8K for a program at $1201 and says so', async () => {
    const m = machine(firmware(0x1201));
    const r = await m.services.media.mount(prg(0x1201, [1, 2, 3]), 'big.prg');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('8K');
    expect(m.memory.expansion.blk1).toBe(true);
    for (let f = 0; f < 15; f++) m.tick();
    expect(Array.from(m.memory.ram.subarray(0x1201, 0x1204))).toEqual([1, 2, 3]);
    m.destroy();
  });

  it('refuses a file too short to be a program', async () => {
    const m = machine(firmware());
    const r = await m.services.media.mount(Uint8Array.from([0x01]), 'bad.prg');
    expect(r.ok).toBe(false);
    m.destroy();
  });
});

describe('VIC-20 paddles', () => {
  it('read $FF with nothing plugged in, and follow the mouse when plugged in', () => {
    const m = machine(firmware());
    const mice = m.services.input.mice!;
    expect(m.memory.readByte(0x9008)).toBe(0xFF);
    expect(m.memory.readByte(0x9009)).toBe(0xFF);
    mice.setMode('vic20-paddles');
    const x0 = m.memory.readByte(0x9008);
    mice.motion(10, 0, 'vic20-paddles');
    expect(m.memory.readByte(0x9008), 'clockwise reads lower').toBe(x0 - 10);
    mice.motion(-1000, 0, 'vic20-paddles');
    expect(m.memory.readByte(0x9008), 'stops at the end of its travel').toBe(0xFF);
    mice.motion(0, 1000, 'vic20-paddles');
    expect(m.memory.readByte(0x9009)).toBe(0x00);
    mice.setMode('none');
    expect(m.memory.readByte(0x9008)).toBe(0xFF);
    m.destroy();
  });

  it('puts the fire buttons on the joystick left and right lines', () => {
    const m = machine(firmware());
    const mice = m.services.input.mice!;
    mice.setMode('vic20-paddles');
    m.memory.writeByte(0x9113, 0x00);                 // VIA 1 port A inputs
    m.memory.writeByte(0x9122, 0x7F);                 // VIA 2 PB7 an input
    m.memory.writeByte(0x9120, 0xFF);
    expect(m.memory.readByte(0x9111) & 0x10).toBe(0x10);
    expect(m.memory.readByte(0x9120) & 0x80).toBe(0x80);
    mice.button(0, true, 'vic20-paddles');
    expect(m.memory.readByte(0x9111) & 0x10, 'X fire is joystick left (VIA 1 PA4)').toBe(0);
    mice.button(2, true, 'vic20-paddles');
    expect(m.memory.readByte(0x9120) & 0x80, 'Y fire is joystick right (VIA 2 PB7)').toBe(0);
    m.destroy();
  });
});
