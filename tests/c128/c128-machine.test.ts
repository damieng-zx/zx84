/**
 * The Commodore 128 board in C128 mode: the Z80 starting the machine and
 * handing over to the 8502 through the MMU's mode register, the keyboard's
 * three extra lines through CIA 1, and — with the real ROMs under
 * mcp/.cache/c128-dev — booting to the BASIC 7.0 banner and READY, typing, and
 * moving a byte between the two RAM blocks with BANK.
 *
 * Expectations come from the hardware: the MMU register map in the C128
 * Programmer's Reference Guide, the 6526's port behaviour, and what BASIC 7.0
 * prints.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { C128_SCREEN_WIDTH } from '@/machines/c128/constants.ts';
import { VDC_FRAME_HEIGHT, VDC_FRAME_WIDTH, VDC_PIXEL_ASPECT_X } from '@/machines/c128/vdc-display.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

/** A system ROM image whose Z80 BIOS (at $1000) is `bios` and whose 8502 side is
 *  empty, for a board test with no firmware. */
function kernalWith(bios: number[], at = 0): Uint8Array {
  const k = new Uint8Array(0x4000);
  k.set(bios, 0x1000 + at);
  return k;
}

/** The Z80 side of a start-up like the real BIOS's: with I/O off it copies an
 *  8502 program into RAM at $1100 and points the reset vector at it, then with
 *  I/O on it sets the mode register's bit 0 and the 8502 runs it. */
const HANDOVER_BIOS = [
  0x3E, 0x3F, 0x32, 0x00, 0xFF,         // LD A,$3F : LD ($FF00),A    CR: RAM above $4000, I/O off
  0x21, 0x30, 0x00,                     // LD HL,table
  0x11, 0x00, 0x11,                     // LD DE,$1100
  0x01, 0x08, 0x00,                     // LD BC,8
  0xED, 0xB0,                           // LDIR
  0x21, 0x00, 0x11,                     // LD HL,$1100
  0x22, 0xFC, 0xFF,                     // LD ($FFFC),HL              the 8502's reset vector, in RAM
  0x3E, 0x3E, 0x32, 0x00, 0xFF,         // LD A,$3E : LD ($FF00),A    CR: I/O on again
  0x01, 0x05, 0xD5,                     // LD BC,$D505
  0x3E, 0xB1,                           // LD A,$B1
  0xED, 0x79,                           // OUT (C),A                  MCR bit 0: the 8502
  0x76,                                 // HALT
];
const HANDOVER_TABLE = [
  0xA9, 0x55,                           // LDA #$55
  0x8D, 0x00, 0x04,                     // STA $0400
  0x4C, 0x05, 0x11,                     // JMP $1105
];

function handoverMachine(): C128Machine {
  const bios = HANDOVER_BIOS.slice();
  const k = kernalWith(bios);
  k.set(HANDOVER_TABLE, 0x1030);
  const m = new C128Machine(null);
  m.loadRoms(null, null, k, null);
  m.reset();
  return m;
}

describe('C128 start-up and the Z80/8502 hand-over', () => {
  it('starts with the Z80 running the BIOS from $0000', () => {
    const m = handoverMachine();
    expect(m.cpuIs8502).toBe(false);
    expect(m.z80.pc).toBe(0);
    expect(m.memory.mmu.cpu8502).toBe(false);
  });

  it('hands over when the Z80 sets the mode register: the 8502 starts from its vector in RAM', () => {
    const m = handoverMachine();
    m.tick();
    expect(m.cpuIs8502).toBe(true);
    expect(m.memory.mmu.cr).toBe(0x3E);
    expect(m.memory.ram[0x0400], 'the program the BIOS copied ran').toBe(0x55);
    expect(m.cpu.pc, 'and is looping on its last instruction').toBe(0x1105);
  });

  it('copies through the Z80 into RAM, not the colour RAM, while I/O is off', () => {
    const m = handoverMachine();
    m.tick();
    expect(Array.from(m.memory.ram.subarray(0x1100, 0x1108))).toEqual(HANDOVER_TABLE);
  });

  it('takes the 8502 back to the Z80 when the mode register says so', () => {
    const m = handoverMachine();
    m.tick();
    m.memory.mmu.write(5, 0x30);
    m.tick();
    expect(m.cpuIs8502).toBe(false);
  });

  it('gives the bus back to a Z80 that carries on where it left off, not from $0000', () => {
    const m = handoverMachine();
    m.tick();
    const pc = m.z80.pc;
    expect(pc, 'stopped after the OUT, at the HALT').toBe(HANDOVER_BIOS.length - 1);
    m.memory.mmu.write(5, 0x30);
    m.tick();
    expect(m.z80.halted, 'it ran the HALT it had reached').toBe(true);
    expect(m.z80.pc).toBe(pc + 1);
  });

  it('runs the Z80 at two T-states to every phi2 cycle of the machine clock', () => {
    // A Z80 that does nothing but JR to itself (12 T-states a time).
    const m = new C128Machine(null);
    m.loadRoms(null, null, kernalWith([0x18, 0xFE]), null);
    m.reset();
    m.tick();
    expect(Math.abs(m.z80.tStates - 2 * m.timing.cyclesPerFrame)).toBeLessThan(2 * 12);
    expect(m.cpuIs8502).toBe(false);
  });
});

describe('C128 keyboard through CIA 1', () => {
  function machine(): C128Machine {
    const m = new C128Machine(null);
    m.reset();
    return m;
  }

  /** Scan like the KERNAL: PA drives the columns, $D02F the extra lines. */
  function scan(m: C128Machine, portA: number, lines: number): number {
    m.cia1.write(0x2, 0xFF);
    m.cia1.write(0x3, 0x00);
    m.cia1.write(0x0, portA);
    m.memory.ioWrite(0xD02F, lines);
    return m.cia1.read(0x1);
  }

  it('reads a key of the 8 × 8 matrix as on the 64', () => {
    const m = machine();
    m.keyboard.setKey('a', true);                 // column 1, row 2
    expect(scan(m, 0xFD, 0xFF)).toBe(0xFF & ~(1 << 2));
    expect(scan(m, 0xFF, 0xFF), 'no column selected').toBe(0xFF);
    expect(scan(m, 0xFB, 0xFF), 'another column').toBe(0xFF);
  });

  it('reads the extra keys only while their line is selected through $D02F', () => {
    const m = machine();
    m.keyboard.setKey('esc', true);               // line K1, row 0
    expect(scan(m, 0xFF, 0xFF), 'no line selected').toBe(0xFF);
    expect(scan(m, 0xFF, 0xFD)).toBe(0xFE);       // K1 low
    expect(scan(m, 0xFF, 0xFE), 'K0 is not K1').toBe(0xFF);
    expect(scan(m, 0xFF, 0xFB), 'K2 is not K1').toBe(0xFF);
  });

  it('puts the keypad, cursor keys, HELP, TAB, ALT, LINE FEED and NO SCROLL on the lines the ROM scans', () => {
    const m = machine();
    const expectations: [string, number, number][] = [
      ['help', 0xFE, 0], ['kp8', 0xFE, 1], ['tab', 0xFE, 3], ['kp1', 0xFE, 7],
      ['kp+', 0xFD, 1], ['linefeed', 0xFD, 3], ['kp-enter', 0xFD, 4], ['kp3', 0xFD, 7],
      ['alt', 0xFB, 0], ['kp0', 0xFB, 1], ['up', 0xFB, 3], ['down', 0xFB, 4], ['left', 0xFB, 5], ['right', 0xFB, 6],
      ['no-scroll', 0xFB, 7],
    ];
    for (const [key, lines, row] of expectations) {
      m.keyboard.setKey(key, true);
      expect(scan(m, 0xFF, lines), key).toBe(0xFF & ~(1 << row));
      m.keyboard.setKey(key, false);
    }
  });

  it('joins a key to both of its lines: driving the rows reads the columns', () => {
    const m = machine();
    m.keyboard.setKey('3', true);                 // column 1, row 0
    m.cia1.write(0x2, 0x00);                      // PA all inputs
    m.cia1.write(0x3, 0xFF);                      // PB all outputs
    m.cia1.write(0x1, 0xFE);                      // row 0 low
    expect(m.cia1.read(0x0)).toBe(0xFF & ~(1 << 1));
  });

  it('reads CAPS LOCK on the 8502 port and the 40/80 key through the MMU', () => {
    const m = machine();
    expect(m.memory.readByte(1) & 0x40).toBe(0x40);
    m.setCapsLock(true);
    expect(m.memory.readByte(1) & 0x40).toBe(0);
    expect(m.memory.mmu.read(5) & 0x80, 'key up: 40 columns').toBe(0x80);
    m.setDisplay80(true);
    expect(m.memory.mmu.read(5) & 0x80, 'key down: 80 columns').toBe(0);
  });

  it('keeps the two latching keys across a reset, as a switch does', () => {
    const m = machine();
    m.setCapsLock(true);
    m.setDisplay80(true);
    m.reset();
    expect(m.memory.readByte(1) & 0x40).toBe(0);
    expect(m.memory.mmu.read(5) & 0x80).toBe(0);
  });
});

describe('C128 VIC-IIe extras', () => {
  it('stores the keyboard lines in $D02F bits 0-2 and reads the other bits as 1', () => {
    const m = new C128Machine(null);
    m.reset();
    m.memory.ioWrite(0xD02F, 0xA5);
    expect(m.memory.ioRead(0xD02F)).toBe(0xFD);
    m.memory.ioWrite(0xD02F, 0x00);
    expect(m.memory.ioRead(0xD02F)).toBe(0xF8);
  });

  it('keeps $D030 bits 0-1 and reads the rest as 1', () => {
    const m = new C128Machine(null);
    m.reset();
    m.memory.ioWrite(0xD030, 0x01);
    expect(m.memory.ioRead(0xD030)).toBe(0xFD);
    m.memory.ioWrite(0xD030, 0xFC);
    expect(m.memory.ioRead(0xD030)).toBe(0xFC);
  });
});

describe('C128 VDC register file', () => {
  it('selects a register at $D600 and reads or writes it at $D601; $D600 reads ready', () => {
    const m = new C128Machine(null);
    m.reset();
    expect(m.memory.ioRead(0xD600) & 0x80).toBe(0x80);
    m.memory.ioWrite(0xD600, 0x07);
    m.memory.ioWrite(0xD601, 0x20);
    expect(m.memory.ioRead(0xD601)).toBe(0x20);
  });

  it('moves the update address on by one for every byte through register 31', () => {
    const m = new C128Machine(null);
    m.reset();
    const w = (reg: number, v: number): void => { m.memory.ioWrite(0xD600, reg); m.memory.ioWrite(0xD601, v); };
    w(18, 0x01); w(19, 0x00);                   // update address $0100
    m.memory.ioWrite(0xD600, 31);
    m.memory.ioWrite(0xD601, 0xAA);
    m.memory.ioWrite(0xD601, 0xBB);
    expect(Array.from(m.vdc.ram.subarray(0x100, 0x103))).toEqual([0xAA, 0xBB, 0]);
    m.memory.ioWrite(0xD600, 19);
    expect(m.memory.ioRead(0xD601)).toBe(0x02);
  });

  it('fills with the last data byte when the word count is written, and copies when register 24 bit 7 is set', () => {
    const m = new C128Machine(null);
    m.reset();
    const w = (reg: number, v: number): void => { m.memory.ioWrite(0xD600, reg); m.memory.ioWrite(0xD601, v); };
    w(18, 0x02); w(19, 0x00);
    w(31, 0x5A);                                // the first byte, at $0200
    w(30, 7);                                   // 7 more
    expect(Array.from(m.vdc.ram.subarray(0x200, 0x209))).toEqual([0x5A, 0x5A, 0x5A, 0x5A, 0x5A, 0x5A, 0x5A, 0x5A, 0]);
    // Copy $0200-$0203 to $0300.
    w(24, 0x80);
    w(32, 0x02); w(33, 0x00);
    w(18, 0x03); w(19, 0x00);
    w(30, 4);
    expect(Array.from(m.vdc.ram.subarray(0x300, 0x305))).toEqual([0x5A, 0x5A, 0x5A, 0x5A, 0]);
    m.memory.ioWrite(0xD600, 19);
    expect(m.memory.ioRead(0xD601), 'the update address moved on').toBe(0x04);
  });
});

/** A canvas that records what the machine tells it about the frame. */
function recordingDisplay(): { display: IScreenRenderer; log: string[] } {
  const log: string[] = [];
  const display = {
    resize: (w: number, h: number) => log.push(`resize ${w}x${h}`),
    setPixelAspectX: (a: number) => log.push(`aspect ${a.toFixed(3)}`),
  } as unknown as IScreenRenderer;
  return { display, log };
}

describe('C128 two displays on one canvas', () => {
  it('shows the VIC-IIe while the 40/80 key is up and the VDC while it is down, in Auto', () => {
    const m = new C128Machine(null);
    m.reset();
    expect(m.showing80).toBe(false);
    expect(m.frameWidth).toBe(C128_SCREEN_WIDTH);
    m.setDisplay80(true);
    expect(m.showing80).toBe(true);
    expect([m.frameWidth, m.frameHeight]).toEqual([VDC_FRAME_WIDTH, VDC_FRAME_HEIGHT]);
    expect(m.pixels.length).toBe(VDC_FRAME_WIDTH * VDC_FRAME_HEIGHT * 4);
  });

  it('shows the chip the Display menu names whatever the key says', () => {
    const m = new C128Machine(null);
    m.reset();
    m.setDisplayMode('80');
    expect(m.showing80).toBe(true);
    m.setDisplay80(true);
    m.setDisplayMode('40');
    expect(m.showing80).toBe(false);
    m.setDisplayMode('auto');
    expect(m.showing80, 'Auto follows the key again').toBe(true);
  });

  it('draws the VDC into the frame it reports, border colour included', () => {
    const m = new C128Machine(null);
    m.reset();
    m.vdc.regs[26] = 0x02;                       // background: dark blue
    m.setDisplayMode('80');
    m.tick();
    const px = new Uint32Array(m.pixels.buffer, m.pixels.byteOffset, VDC_FRAME_WIDTH * VDC_FRAME_HEIGHT);
    expect(px[0]).toBe(0xFFAA0000);              // ABGR: blue 0xAA
  });

  it('tells the canvas its new size and pixel shape when the chip it shows changes, and only then', () => {
    const { display, log } = recordingDisplay();
    const m = new C128Machine(display);
    m.reset();
    m.setDisplayMode('80');
    expect(log[0]).toBe(`resize ${VDC_FRAME_WIDTH}x${VDC_FRAME_HEIGHT}`);
    expect(log[1]).toBe(`aspect ${VDC_PIXEL_ASPECT_X.toFixed(3)}`);
    m.tick();
    m.setDisplayMode('80');
    expect(log, 'no change, no message').toHaveLength(2);
    m.setDisplayMode('40');
    expect(log.slice(2)).toEqual([`resize ${C128_SCREEN_WIDTH}x${m.frameHeight}`, 'aspect 1.000']);
  });

  it('puts the 80-column picture at 4:3 over the whole frame', () => {
    expect(VDC_PIXEL_ASPECT_X * VDC_FRAME_WIDTH / VDC_FRAME_HEIGHT).toBeCloseTo(4 / 3, 6);
  });

  it('reads the text of whichever screen is shown', () => {
    const m = new C128Machine(null);
    m.reset();
    m.vdc.regs[1] = 80; m.vdc.regs[6] = 25;
    m.vdc.ram.fill(32, 0, 0x0800);
    m.vdc.ram[0] = 8; m.vdc.ram[1] = 9;
    m.setDisplayMode('80');
    expect(m.ocrScreenForMcp()).toBe('HI');
    m.setDisplayMode('40');
    expect(m.ocrScreenForMcp()).not.toBe('HI');
  });

  it('counts the VDC frames, so its flash and cursor blink run', () => {
    const m = new C128Machine(null);
    m.reset();
    const before = m.vdc.frame;
    m.tick(); m.tick();
    expect(m.vdc.frame).toBe(before + 2);
  });
});

const REAL = 'c128-dev/';
const basicLo = romImage(REAL + 'basiclo');
const basicHi = romImage(REAL + 'basichi');
const kernal = romImage(REAL + 'kernal');
const chargen = romImage(REAL + 'chargen');

/** What a letter, digit or sign is to the keyboard: the key, and whether SHIFT is down. */
function chord(ch: string): { key: string; shift?: boolean } {
  if (ch === ' ') return { key: 'space' };
  if (ch === '\n') return { key: 'return' };
  if (ch === '"') return { key: '2', shift: true };
  if (ch === '(') return { key: '8', shift: true };
  if (ch === ')') return { key: '9', shift: true };
  return { key: ch.toLowerCase() };
}

function type(m: C128Machine, text: string): void {
  for (const ch of text) {
    const { key, shift } = chord(ch);
    if (shift) m.keyboard.setKey('lshift', true);
    m.keyboard.setKey(key, true);
    for (let f = 0; f < 4; f++) m.tick();
    m.keyboard.setKey(key, false);
    if (shift) m.keyboard.setKey('lshift', false);
    for (let f = 0; f < 3; f++) m.tick();
  }
}

function boot(): C128Machine {
  const m = new C128Machine(null);
  m.loadRoms(basicLo, basicHi, kernal, chargen);
  m.reset();
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

describe.skipIf(!basicLo || !basicHi || !kernal || !chargen)('C128 with the Commodore ROMs', () => {
  it('boots in C128 mode to the BASIC 7.0 banner and READY on the 40-column screen', () => {
    const m = boot();
    const text = m.ocrScreenForMcp();
    expect(text).toContain('COMMODORE BASIC V7.0 122365 BYTES FREE');
    expect(text).toContain('(C)1986 COMMODORE ELECTRONICS, LTD.');
    expect(text.endsWith('READY.')).toBe(true);
    expect(m.cpuIs8502, 'the Z80 handed over').toBe(true);
    expect(m.memory.mmu.c64Mode, 'C128 mode').toBe(false);
  });

  it('leaves the MMU as the KERNAL sets it: ROM and I/O in view, 1K of common RAM at the bottom', () => {
    const m = boot();
    expect(m.memory.mmu.cr).toBe(0x00);
    expect(m.memory.mmu.rcr & 0x0F).toBe(0x04);
  });

  it('types a line, runs it, and prints the answer', () => {
    const m = boot();
    type(m, 'PRINT 6*7\n');
    for (let f = 0; f < 20; f++) m.tick();
    const lines = m.ocrScreenForMcp().split('\n');
    const at = lines.lastIndexOf('PRINT 6*7');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(' 42');
    expect(lines[at + 2], 'BASIC leaves a blank line').toBe('');
    expect(lines[at + 3]).toBe('READY.');
  });

  it('keeps a byte per RAM block: BANK 0 and BANK 1 PEEK different values at the same address', () => {
    const m = boot();
    type(m, 'BANK 0:POKE 3072,65:BANK 1:POKE 3072,66\n');
    for (let f = 0; f < 20; f++) m.tick();
    expect([m.memory.ram[0x0C00], m.memory.ram[0x10C00]]).toEqual([65, 66]);
    for (const [bank, value] of [[0, 65], [1, 66]]) {
      type(m, `BANK ${bank}:PRINT PEEK(3072)\n`);
      for (let f = 0; f < 20; f++) m.tick();
      const lines = m.ocrScreenForMcp().split('\n');
      const at = lines.lastIndexOf(`BANK ${bank}:PRINT PEEK(3072)`);
      expect(at, `bank ${bank}`).toBeGreaterThan(0);
      expect(lines[at + 1], `bank ${bank}`).toBe(` ${value}`);
    }
  });

  it('boots to the same banner on the 80-column screen when the 40/80 key is down at reset', () => {
    const m = new C128Machine(null);
    m.loadRoms(basicLo, basicHi, kernal, chargen);
    m.setDisplay80(true);
    m.reset();
    for (let f = 0; f < 150; f++) m.tick();
    expect(m.showing80).toBe(true);
    const text = m.ocrScreenForMcp();
    expect(text).toContain('COMMODORE BASIC V7.0 122365 BYTES FREE');
    expect(text.endsWith('READY.')).toBe(true);
    // The editor's 80-column set-up: 80 × 25 cells of 8 × 8, attributes on, set at $2000.
    const r = m.vdc.regs;
    expect([r[1], r[6], r[9], r[22], r[23]]).toEqual([80, 25, 7, 0x78, 8]);
    expect(r[25] & 0x40, 'colour attributes on').toBe(0x40);
    // And it is drawn: the cursor block and the letters are not the background.
    const px = new Uint32Array(m.pixels.buffer, m.pixels.byteOffset, VDC_FRAME_WIDTH * VDC_FRAME_HEIGHT);
    const background = px[0];
    expect(px.filter((p) => p !== background).length).toBeGreaterThan(500);
  });

  it('types on the 80-column screen', () => {
    const m = new C128Machine(null);
    m.loadRoms(basicLo, basicHi, kernal, chargen);
    m.setDisplay80(true);
    m.reset();
    for (let f = 0; f < 150; f++) m.tick();
    type(m, 'PRINT 6*7\n');
    for (let f = 0; f < 20; f++) m.tick();
    const lines = m.ocrScreenForMcp().split('\n');
    const at = lines.lastIndexOf('PRINT 6*7');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(' 42');
  });

  it('programs the VDC at start-up whichever screen is chosen, so the last chip programmed cannot pick the display', () => {
    const m = boot();
    const r = m.vdc.regs;
    expect([r[1], r[6]]).toEqual([80, 25]);
    expect(m.showing80).toBe(false);
  });

  it('reads the 40/80 key as released and the cartridge pins as empty in the mode register', () => {
    const m = boot();
    expect(m.memory.mmu.read(5) & 0xB0).toBe(0xB0);
  });

  it('shows the MMU to BASIC: PEEK of the mode register follows the 40/80 key', () => {
    const m = boot();
    // $D505 = 54533: the 8502 running (bit 0), the pins and the key up (bits 7, 5, 4), and
    // bits 1-2 as the KERNAL stored them.
    const peek = (): string => {
      type(m, 'PRINT PEEK(54533)\n');
      for (let f = 0; f < 20; f++) m.tick();
      const lines = m.ocrScreenForMcp().split('\n');
      return lines[lines.lastIndexOf('PRINT PEEK(54533)') + 1];
    };
    const up = peek();
    expect(Number(up) & 0xB1).toBe(0xB1);
    m.setDisplay80(true);
    m.setDisplayMode('40');            // the editor is still on the 40-column screen: read that
    expect(Number(peek()), 'the key down clears bit 7').toBe(Number(up) & 0x7F);
  });
});
