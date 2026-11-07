/**
 * Acorn Electron tests. Expectations come from the Electron Advanced User Guide
 * and the ULA register behaviour documented there (and by MAME's electron_ula):
 * a 16-byte register block at &FE00, ROM paging through &FE05, the keyboard
 * read through ROM pages 8/9 as a 14 × 4 matrix selected by A0-A13, 1200-baud
 * cassette through &FE04, and the display modes' memory layout.
 *
 * The OS is a few hand-assembled bytes, not the copyrighted ROM.
 */

import { describe, it, expect } from 'vitest';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import { electronEntry } from '@/machines/electron/descriptor.ts';
import { ELECTRON_BORDER_LEFT, ELECTRON_BORDER_TOP, ELECTRON_SCREEN_WIDTH } from '@/machines/electron/constants.ts';
import { buildUef, type UefChunk } from '@/media/tape/uef.ts';

const BLACK = 0xFF000000;
const WHITE = 0xFFFFFFFF;
const chunk = (id: number, ...data: number[]): UefChunk => ({ id, data: Uint8Array.from(data) });

/** Build a 32K system image (BASIC then OS) with `code` at `org` (default &C000)
 *  and the reset/IRQ vectors set. */
function makeRom(code: number[], org = 0xC000, irq = 0xC100, irqCode: number[] = [0x40]): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set(code, 0x4000 + (org - 0xC000));
  rom.set(irqCode, 0x4000 + (irq - 0xC000));
  rom[0x4000 + 0x3FFC] = org & 0xFF; rom[0x4000 + 0x3FFD] = org >> 8;
  rom[0x4000 + 0x3FFE] = irq & 0xFF; rom[0x4000 + 0x3FFF] = irq >> 8;
  return rom;
}

const SPIN = [0xEA, 0x4C, 0x00, 0xC0];                 // NOP ; JMP $C000

function machine(code: number[] = SPIN, irqCode?: number[]): ElectronMachine {
  const m = new ElectronMachine('electron', null);
  m.loadROM(makeRom(code, 0xC000, 0xC100, irqCode));
  m.reset();
  return m;
}

const px = (m: ElectronMachine, x: number, y: number): number =>
  new Uint32Array(m.pixels.buffer)[(ELECTRON_BORDER_TOP + y) * ELECTRON_SCREEN_WIDTH + ELECTRON_BORDER_LEFT + x];

/** Mode 0 palette with pen 8 (logical 1) white and pen 0 (logical 0) black. */
function whiteOnBlack(m: ElectronMachine): void {
  m.memory.writeByte(0xFE08, 0xBB);
  m.memory.writeByte(0xFE09, 0xFB);
}

function setMode(m: ElectronMachine, mode: number, extra = 0): void {
  m.memory.writeByte(0xFE07, (mode << 3) | extra);
}

describe('Electron registration', () => {
  it('is registered as a 6502 machine without an I/O port space', () => {
    expect(electronEntry.models).toContain('electron');
    const m = machine();
    expect(m.kind).toBe('electron');
    expect(m.descriptor.cpuFamily).toBe('m6502');
    expect(m.services.debug.ports).toBeNull();
    m.destroy();
  });

  it('loads BASIC from the first 16K of the system image and the OS from the second', () => {
    const m = new ElectronMachine('electron', null);
    const rom = new Uint8Array(0x8000);
    rom[0] = 0xB5; rom[0x4000] = 0x05;
    m.loadROM(rom);
    m.memory.romPage = 10;
    expect(m.memory.readByte(0x8000)).toBe(0xB5);
    expect(m.memory.readByte(0xC000)).toBe(0x05);
    m.destroy();
  });
});

describe('Electron memory map', () => {
  it('maps 32K RAM below &8000, the OS at &C000 and floats FRED/JIM high', () => {
    const m = machine();
    m.memory.writeByte(0x7FFF, 0x5A);
    expect(m.memory.readByte(0x7FFF)).toBe(0x5A);
    m.memory.writeByte(0xC000, 0x00);                         // ROM: ignored
    expect(m.memory.readByte(0xC000)).toBe(0xEA);
    expect(m.memory.readByte(0xFC00)).toBe(0xFF);
    expect(m.memory.readByte(0xFD80)).toBe(0xFF);
    m.destroy();
  });

  it('refuses a system ROM shorter than BASIC + OS rather than half-loading it', () => {
    const m = machine();
    expect(() => m.loadROM(new Uint8Array(0x4000))).toThrow(/too small/);
    m.destroy();
  });

  it('shows BASIC in pages 10 and 11, nothing (&FF) in an empty page, and an installed ROM', () => {
    const m = machine();
    m.memory.basicRom[0x123] = 0x77;
    m.memory.romPage = 10;
    expect(m.memory.readByte(0x8123)).toBe(0x77);
    m.memory.romPage = 11;
    expect(m.memory.readByte(0x8123)).toBe(0x77);
    m.memory.romPage = 4;
    expect(m.memory.readByte(0x8000)).toBe(0xFF);
    m.loadPagedRom(4, Uint8Array.from({ length: 0x4000 }, (_, i) => i & 0xFF));
    expect(m.memory.readByte(0x8005)).toBe(5);
    m.destroy();
  });

  it('mirrors an 8K ROM across the 16K window', () => {
    const m = machine();
    m.loadPagedRom(5, Uint8Array.from({ length: 0x2000 }, (_, i) => (i >> 8) + 1));
    m.memory.romPage = 5;
    expect(m.memory.readByte(0x8000)).toBe(1);
    expect(m.memory.readByte(0xA000)).toBe(1);
    m.destroy();
  });

  it('only lets writes to the page register leave pages 8-11 for 8-15', () => {
    const m = machine();
    m.memory.writeByte(0xFE05, 0x0A);                         // BASIC
    expect(m.memory.romPage).toBe(10);
    m.memory.writeByte(0xFE05, 0x03);                         // bit 3 clear: refused
    expect(m.memory.romPage).toBe(10);
    m.memory.writeByte(0xFE05, 0x0C);                         // bit 3 set: allowed
    expect(m.memory.romPage).toBe(12);
    m.memory.writeByte(0xFE05, 0x03);                         // from 12 any page is fine
    expect(m.memory.romPage).toBe(3);
    m.destroy();
  });

  it('decodes the ULA registers every 16 bytes through &FExx', () => {
    const m = machine();
    m.memory.writeByte(0xFE05, 0x0A);
    m.memory.writeByte(0xFEF5, 0x0D);                         // mirror of FE05
    expect(m.memory.romPage).toBe(13);
    m.destroy();
  });
});

describe('Electron keyboard', () => {
  const key = (code: string, k = ''): { code: string; key: string; shift: boolean; ctrl: boolean; alt: boolean } =>
    ({ code, key: k, shift: false, ctrl: false, alt: false });

  /** Read the keyboard the way the OS does: ROM page 8, address with the wanted column low. */
  function readColumn(m: ElectronMachine, column: number): number {
    m.memory.romPage = 8;
    return m.memory.readByte(0x8000 | (0x3FFF & ~(1 << column)));
  }

  it('returns a pressed key as a set bit in the low nibble of its column', () => {
    const m = machine();
    m.services.input.keyDown(key('KeyA', 'a'));
    expect(readColumn(m, 12) & 0x0F).toBe(0x04);            // A: column 12, row 2
    expect(readColumn(m, 11)).toBe(0);
    m.services.input.keyUp(key('KeyA', 'a'));
    expect(readColumn(m, 12)).toBe(0);
    m.destroy();
  });

  it('passes host SHIFT to non-character keys but not to typed characters', () => {
    const m = machine();
    const shifted = (code: string, k: string) => ({ ...key(code, k), shift: true });
    m.services.input.keyDown(shifted('ArrowLeft', 'ArrowLeft'));
    expect(readColumn(m, 1) & 0x0F).toBe(0x01);             // left: column 1, row 0
    expect(readColumn(m, 13) & 0x08).toBe(0x08);            // SHIFT: column 13, row 3
    m.services.input.keyUp(shifted('ArrowLeft', 'ArrowLeft'));
    expect(readColumn(m, 13)).toBe(0);
    m.services.input.keyDown(shifted('Backslash', '~'));    // '~' is CTRL+left, already complete
    expect(readColumn(m, 13) & 0x0F).toBe(0x04);            // CTRL only, no SHIFT
    m.destroy();
  });

  it('Shift+BREAK resets and holds SHIFT', () => {
    const m = machine();
    m.services.input.keyDown({ ...key('Pause'), shift: true });
    expect(readColumn(m, 13) & 0x08).toBe(0x08);
    m.destroy();
  });

  it('ORs together every column whose address line is low', () => {
    const m = machine();
    m.services.input.keyDown(key('KeyQ', 'q'));             // column 12, row 1
    m.services.input.keyDown(key('KeyP', 'p'));             // column 3, row 1
    m.memory.romPage = 9;                                   // 9 reads the keyboard too
    expect(m.memory.readByte(0x8000 | (0x3FFF & ~(1 << 12) & ~(1 << 3))) & 0x0F).toBe(0x02);
    expect(m.memory.readByte(0xBFFF)).toBe(0);              // no column selected
    m.destroy();
  });

  it('presses SHIFT together with 2 for a typed double quote', () => {
    const m = machine();
    m.services.input.keyDown(key('Digit2', '"'));
    expect(readColumn(m, 11) & 1).toBe(1);                  // 2 key: column 11, row 0
    expect(readColumn(m, 13) & 8).toBe(8);                  // SHIFT: column 13, row 3
    m.services.input.keyUp(key('Digit2', '"'));
    expect(readColumn(m, 13)).toBe(0);
    m.destroy();
  });

  it('types symbols on the cursor keys with SHIFT or CTRL', () => {
    const m = machine();
    m.services.input.keyDown(key('Backslash', '|'));        // Shift + the → key
    expect(readColumn(m, 0) & 1).toBe(1);
    expect(readColumn(m, 13) & 8).toBe(8);
    m.services.input.keyUp(key('Backslash', '|'));
    m.services.input.keyDown(key('Backslash', '\\'));       // Ctrl + the → key
    expect(readColumn(m, 13) & 4).toBe(4);
    m.destroy();
  });

  it('uses SHIFT for capitals unless caps lock is on, then for lower case', () => {
    const m = machine();
    // Caps lock off: A needs SHIFT, a does not.
    m.services.input.keyDown(key('KeyA', 'A'));
    expect(readColumn(m, 13) & 8).toBe(8);
    m.services.input.keyUp(key('KeyA', 'A'));
    m.services.input.keyDown(key('KeyA', 'a'));
    expect(readColumn(m, 13) & 8).toBe(0);
    m.services.input.keyUp(key('KeyA', 'a'));
    // Caps lock on (FE07 bit 7 lights the LED): the other way round.
    m.memory.writeByte(0xFE07, 0x80);
    m.services.input.keyDown(key('KeyA', 'A'));
    expect(readColumn(m, 13) & 8).toBe(0);
    m.services.input.keyUp(key('KeyA', 'A'));
    m.services.input.keyDown(key('KeyA', 'a'));
    expect(readColumn(m, 13) & 8).toBe(8);
    m.destroy();
  });

  it('releases exactly the cells a key pressed, even if caps lock changed meanwhile', () => {
    const m = machine();
    m.services.input.keyDown(key('KeyA', 'A'));             // caps off: A + SHIFT
    m.memory.writeByte(0xFE07, 0x80);                       // caps on while held
    m.services.input.keyUp(key('KeyA', 'A'));
    expect(readColumn(m, 13)).toBe(0);
    expect(readColumn(m, 12)).toBe(0);
    m.destroy();
  });

  it('keeps SHIFT held while two keys that both need it are down', () => {
    const m = machine();
    m.services.input.keyDown(key('Digit1', '!'));
    m.services.input.keyDown(key('Digit2', '"'));
    m.services.input.keyUp(key('Digit1', '!'));
    expect(readColumn(m, 13) & 8).toBe(8);
    m.services.input.keyUp(key('Digit2', '"'));
    expect(readColumn(m, 13) & 8).toBe(0);
    m.destroy();
  });

  it('maps F1-F10 to FUNC + 1-9, 0', () => {
    const m = machine();
    m.services.input.keyDown(key('F10', ''));
    expect(readColumn(m, 3) & 1).toBe(1);                   // the 0 key
    expect(readColumn(m, 13) & 2).toBe(2);                  // FUNC
    m.destroy();
  });

  it('BREAK resets the CPU but keeps RAM and does not flag a cold start', () => {
    const m = machine();
    m.memory.writeByte(0x1234, 0x99);
    m.memory.readByte(0xFE00);                              // the OS reads (and so clears) power-on reset
    m.memory.writeByte(0xFE05, 0x0A);
    m.cpu.pc = 0xDEAD;
    m.services.input.keyDown(key('Pause', ''));
    expect(m.cpu.pc).toBe(0xC000);
    expect(m.memory.readByte(0x1234)).toBe(0x99);
    expect(m.memory.readByte(0xFE00) & 0x02).toBe(0);
    m.destroy();
  });
});

describe('Electron ULA interrupts', () => {
  it('flags power-on reset until the status is read once, but not after BREAK', () => {
    const m = machine();
    expect(m.memory.readByte(0xFE00) & 0x82).toBe(0x82);    // bit 7 always set, POR set
    expect(m.memory.readByte(0xFE00) & 0x02).toBe(0);
    m.reset();
    expect(m.memory.readByte(0xFE00) & 0x02).toBe(0x02);
    m.destroy();
  });

  it('leaves the power-on flag and keyboard activity alone when inspected through peek/readBlock', () => {
    const m = machine();
    expect(m.memory.peekByte(0xFE00)).toBe(0xFF);
    m.memory.readBlock(0xFE00, 16);
    expect(m.memory.readByte(0xFE00) & 0x02).toBe(0x02);     // still flagged for the OS
    m.memory.romPage = 8;
    m.keyboard.reads = 0;
    m.memory.readBlock(0x8000, 0x100);
    expect(m.keyboard.reads).toBe(0);
    m.destroy();
  });

  it('raises the 50 Hz RTC interrupt only when enabled, and clears it through FE05 bit 5', () => {
    const m = machine();
    m.tick();
    expect(m.memory.readByte(0xFE00) & 0x08).toBe(0x08);     // flag set
    expect(m.memory.readByte(0xFE00) & 0x01).toBe(0);        // but IRQ not asserted: masked
    m.memory.writeByte(0xFE00, 0x08);                        // enable RTC
    expect(m.memory.readByte(0xFE00) & 0x01).toBe(0x01);
    m.memory.writeByte(0xFE05, 0x20);                        // clear RTC
    expect(m.memory.readByte(0xFE00) & 0x09).toBe(0);
    m.destroy();
  });

  it('raises display end after the 256th line in mode 0 and the 250th in mode 6', () => {
    const m = machine();
    m.tick();
    expect(m.memory.readByte(0xFE00) & 0x04).toBe(0x04);
    m.memory.writeByte(0xFE05, 0x10);                        // clear display end
    expect(m.memory.readByte(0xFE00) & 0x04).toBe(0);
    setMode(m, 6);
    m.tick();
    expect(m.memory.readByte(0xFE00) & 0x04).toBe(0x04);
    m.destroy();
  });

  it('delivers one RTC and one display-end interrupt per frame to the CPU, 312 lines apart', () => {
    // IRQ handler: INC $0300 ; clear RTC + display end ; RTI
    const irq = [0xEE, 0x00, 0x03, 0xA9, 0x30, 0x8D, 0x05, 0xFE, 0x40];
    // Main: CLI, enable RTC + display end, spin.
    const main = [0x58, 0xA9, 0x0C, 0x8D, 0x00, 0xFE, 0xEA, 0x4C, 0x06, 0xC0];
    const m = machine(main, irq);
    for (let f = 0; f < 10; f++) m.tick();
    // Two interrupts per frame (RTC and display end), the first frame partly spent starting up.
    const count = m.memory.ram[0x300];
    expect(count).toBeGreaterThanOrEqual(2 * 9);
    expect(count).toBeLessThanOrEqual(2 * 11);
    m.destroy();
  });
});

describe('Electron palette and display', () => {
  it('draws mode 0 as 640 one-bit pixels, MSB leftmost, from the screen start', () => {
    const m = machine();
    whiteOnBlack(m);
    m.memory.writeByte(0xFE03, 0x18);                        // screen start &3000
    m.memory.ram[0x3000] = 0x81;
    m.tick();
    expect(px(m, 0, 0)).toBe(WHITE);
    expect(px(m, 1, 0)).toBe(BLACK);
    expect(px(m, 7, 0)).toBe(WHITE);
    expect(px(m, 8, 0)).toBe(BLACK);
    m.destroy();
  });

  it('reads successive scanlines of a character row from successive bytes', () => {
    const m = machine();
    whiteOnBlack(m);
    for (let i = 0; i < 8; i++) m.memory.ram[0x3000 + i] = 1 << (7 - i);   // a diagonal
    m.tick();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) expect(px(m, x, y)).toBe(x === y ? WHITE : BLACK);
    }
    m.destroy();
  });

  it('steps 8 bytes per pixel column and 640 bytes per character row in mode 0', () => {
    const m = machine();
    whiteOnBlack(m);
    m.memory.ram[0x3008] = 0x80;                             // second character column, line 0
    m.memory.ram[0x3000 + 0x280] = 0x80;                     // next character row, line 0
    m.tick();
    expect(px(m, 8, 0)).toBe(WHITE);
    expect(px(m, 0, 8)).toBe(WHITE);
    expect(px(m, 0, 0)).toBe(BLACK);
    m.destroy();
  });

  it('doubles every pixel across in mode 4 (40 bytes, 320 pixels)', () => {
    const m = machine();
    whiteOnBlack(m);
    setMode(m, 4);
    m.memory.ram[0x3000] = 0x80;
    m.tick();
    expect(px(m, 0, 0)).toBe(WHITE);
    expect(px(m, 1, 0)).toBe(WHITE);
    expect(px(m, 2, 0)).toBe(BLACK);
    m.destroy();
  });

  it('interleaves the two bits of each mode 1 pixel across the byte (bits 7 and 3 are pixel 0)', () => {
    const m = machine();
    // Logical 0-3 are pens 0, 2, 8, 10. Wire pen 2 red (p1 bit 1), pen 8 green
    // (p0 bit 2) and pen 10 white (p1 bit 3, p0 bits 3 and 7); registers hold
    // the written value inverted.
    m.memory.writeByte(0xFE08, 0x8C ^ 0xFF);
    m.memory.writeByte(0xFE09, 0x0A ^ 0xFF);
    setMode(m, 1);
    m.memory.ram[0x3000] = 0x80;                                // bit 7 only: pen 8
    m.memory.ram[0x3008] = 0x08;                                // bit 3 only: pen 2
    m.memory.ram[0x3010] = 0x88;                                // both: pen 10
    m.tick();
    // Four pixels per byte, each two screen pixels wide: 8 screen pixels per byte column.
    expect(px(m, 0, 0)).toBe(0xFF00FF00);                       // green
    expect(px(m, 1, 0)).toBe(0xFF00FF00);
    expect(px(m, 8, 0)).toBe(0xFF0000FF);                       // red
    expect(px(m, 16, 0)).toBe(WHITE);
    expect(px(m, 2, 0)).toBe(BLACK);                            // pixel 1 of the first byte is pen 0
    m.destroy();
  });

  it('decodes mode 2 pixels from bits 7,5,3,1 then 6,4,2,0 using all eight palette registers', () => {
    const m = machine();
    // Byte 0xA5: pixel 0 = bits 7,5,3,1 = 1,1,0,0 → pen 12; pixel 1 = bits 6,4,2,0 = 0,0,1,1 → pen 3.
    // Pen 12 sits in the second register pair (FE0A/FE0B): green from p0 bit 2.
    m.memory.writeByte(0xFE0A, 0x04 ^ 0xFF);
    m.memory.writeByte(0xFE0B, 0x00 ^ 0xFF);
    setMode(m, 2);
    m.memory.ram[0x3000] = 0xA5;
    m.tick();
    expect(px(m, 0, 0)).toBe(0xFF00FF00);
    expect(px(m, 3, 0)).toBe(0xFF00FF00);                       // each pixel is four wide
    expect(px(m, 4, 0)).toBe(BLACK);
    m.destroy();
  });

  it('blanks the two spare lines of each ten-line row in the gapped modes 3 and 6', () => {
    const m = machine();
    whiteOnBlack(m);
    setMode(m, 6);
    for (let i = 0; i < 0x2000; i++) m.memory.ram[0x3000 + i] = 0xFF;
    m.memory.ram[0x3000 + 8] = 0xFF;
    m.tick();
    expect(px(m, 0, 7)).toBe(WHITE);
    expect(px(m, 0, 8)).toBe(BLACK);
    expect(px(m, 0, 9)).toBe(BLACK);
    expect(px(m, 0, 10)).toBe(WHITE);
    m.destroy();
  });

  it('wraps the screen address round the top of memory by the mode size', () => {
    const m = machine();
    whiteOnBlack(m);
    // Mode 4 holds &2800 bytes and a character row is 320 bytes. Starting at
    // &7E00, row 0 is &7E00, row 1 &7F40 and row 2 would be &8080 → &5880.
    setMode(m, 4);
    m.memory.writeByte(0xFE03, 0x3F);
    m.memory.writeByte(0xFE02, 0x00);
    expect(m.ula.screenStart).toBe(0x7E00);
    m.memory.ram[0x5880] = 0x80;
    m.tick();
    expect(px(m, 0, 16)).toBe(WHITE);
    expect(px(m, 0, 8)).toBe(BLACK);
    m.destroy();
  });

  it('applies a palette change made mid-frame to the lines below it', () => {
    // Raster IRQ-less: change the palette from the host between two half frames.
    const m = machine();
    whiteOnBlack(m);
    for (let i = 0; i < 0x5000; i++) m.memory.ram[0x3000 + i] = 0xFF;
    m.tick();
    expect(px(m, 0, 0)).toBe(WHITE);
    m.memory.writeByte(0xFE08, 0xFF);                        // all pens now black
    m.memory.writeByte(0xFE09, 0xFF);
    m.tick();
    expect(px(m, 0, 0)).toBe(BLACK);
    m.destroy();
  });

  it('inverts the written palette value: &FF is black, &00 is white', () => {
    const m = machine();
    setMode(m, 2);                                           // 16 colours: all eight registers matter
    for (let r = 0; r < 8; r++) m.memory.writeByte(0xFE08 + r, 0x00);
    for (let i = 0; i < 16; i++) expect(m.ula.pens[i]).toBe(7);
    for (let r = 0; r < 8; r++) m.memory.writeByte(0xFE08 + r, 0xFF);
    for (let i = 0; i < 16; i++) expect(m.ula.pens[i]).toBe(0);
    m.destroy();
  });

  it('latches the screen start from FE02 (bits 7-5) and FE03 (bits 5-0)', () => {
    const m = machine();
    m.memory.writeByte(0xFE03, 0x18);
    m.memory.writeByte(0xFE02, 0x00);
    expect(m.ula.screenStart).toBe(0x3000);
    m.memory.writeByte(0xFE02, 0xE0);
    expect(m.ula.screenStart).toBe(0x3000 + 0x1C0);
    m.memory.writeByte(0xFE03, 0xFF);                        // bits 7-6 ignored
    expect(m.ula.screenStart).toBe(0x7E00 + 0x1C0);
    m.destroy();
  });
});

describe('Electron memory timing', () => {
  /** Cycles taken by `LDA abs` placed in ROM, measured around the instruction. */
  function ldaCycles(addr: number, setup: (m: ElectronMachine) => void = () => {}): number {
    const m = machine([0xAD, addr & 0xFF, addr >> 8, 0xEA, 0x4C, 0x03, 0xC0]);
    setup(m);
    const before = m.cpu.tStates;
    m.cpu.step();
    const taken = m.cpu.tStates - before;
    m.destroy();
    return taken;
  }

  it('runs ROM reads at 2 MHz: LDA abs from ROM is the nominal 4 cycles', () => {
    expect(ldaCycles(0xC200)).toBe(4);
  });

  it('slows a RAM read to the 1 MHz clock, costing one or two extra cycles', () => {
    const taken = ldaCycles(0x0200, m => { m.memory.writeByte(0xFE07, 4 << 3); });
    expect(taken === 5 || taken === 6).toBe(true);
  });

  it('halts a RAM access in modes 0-3 while the ULA is fetching the line, until 80 cycles in', () => {
    const m = machine([0xAD, 0x00, 0x02, 0xEA]);
    // Start of the first picture line: the CPU is at cycle 0 of a fetching line.
    m.tick();                                                // reach a steady state, then time one instruction
    const cpu = m.cpu;
    (m as unknown as { fetchLine: boolean }).fetchLine = true;
    (m as unknown as { lineStart: number }).lineStart = cpu.tStates;
    cpu.pc = 0xC000;
    const before = cpu.tStates;
    cpu.step();
    expect(cpu.tStates - before).toBeGreaterThanOrEqual(80);
    m.destroy();
  });

  it('does not halt RAM access in modes 4-6', () => {
    const m = machine([0xAD, 0x00, 0x02, 0xEA]);
    m.memory.writeByte(0xFE07, 4 << 3);
    const cpu = m.cpu;
    (m as unknown as { fetchLine: boolean }).fetchLine = true;
    (m as unknown as { lineStart: number }).lineStart = cpu.tStates;
    cpu.pc = 0xC000;
    const before = cpu.tStates;
    cpu.step();
    expect(cpu.tStates - before).toBeLessThan(10);
    m.destroy();
  });
});

describe('Electron sound', () => {
  it('toggles the speaker every 32 × (divider + 1) cycles in sound mode', () => {
    const m = machine();
    m.memory.writeByte(0xFE06, 3);                          // half period 128 cycles
    m.memory.writeByte(0xFE07, 0x02);                       // comms mode 1: sound generation
    let toggles = 0, last = m.ula.soundLevel;
    for (let t = 0; t < 12800; t += 4) {
      m.ula.tick(4, t);
      if (m.ula.soundLevel !== last) { toggles++; last = m.ula.soundLevel; }
    }
    expect(toggles).toBe(100);
    m.destroy();
  });

  it('is silent in cassette mode', () => {
    const m = machine();
    for (let t = 0; t < 4000; t += 4) m.ula.tick(4, t);
    expect(m.ula.soundLevel).toBe(0);
    m.destroy();
  });
});

describe('Electron cassette', () => {
  /** RX loop: wait for receive-full, store the byte at $0200+X. */
  const RX = [
    0xA2, 0x00,                       // LDX #0
    0xAD, 0x00, 0xFE,                 // loop: LDA $FE00
    0x29, 0x10,                       // AND #$10
    0xF0, 0xF9,                       // BEQ loop
    0xAD, 0x04, 0xFE,                 // LDA $FE04
    0x9D, 0x00, 0x02,                 // STA $0200,X
    0xE8,                             // INX
    0x4C, 0x02, 0xC0,                 // JMP loop
  ];

  const MOTOR_ON = 0x40;

  it('moves the tape only while the ULA motor bit is set', async () => {
    const m = machine();
    await m.services.tape.mountBytes(buildUef([chunk(0x0110, 0xE8, 0x03)]), 't.uef');
    m.tick();
    expect(m.cassette.running).toBe(false);
    setMode(m, 0, MOTOR_ON);
    expect(m.cassette.running).toBe(true);
    setMode(m, 0, 0);
    expect(m.cassette.running).toBe(false);
    m.destroy();
  });

  it('flags high tone during the leader, then receive-full for each byte at 1200 baud', async () => {
    const m = machine(RX);
    const payload = [0x2A, 0x48, 0x49, 0x00, 0xFF, 0x80, 0x01, 0x55];
    await m.services.tape.mountBytes(buildUef([
      chunk(0x0110, 0xB0, 0x04), chunk(0x0100, ...payload), chunk(0x0110, 0x60, 0x00),
    ]), 't.uef');
    setMode(m, 0, MOTOR_ON);
    let highTone = false;
    for (let f = 0; f < 60; f++) {
      m.tick();
      if (m.memory.readByte(0xFE00) & 0x40) highTone = true;   // peeks at status only
    }
    expect(highTone).toBe(true);
    expect(Array.from(m.memory.ram.subarray(0x200, 0x200 + payload.length))).toEqual(payload);
    expect(m.memory.ram[0x200 + payload.length]).toBe(0);
    m.destroy();
  });

  it('clears receive-full when the data register is read', async () => {
    const m = machine();
    await m.services.tape.mountBytes(buildUef([
      chunk(0x0110, 0xB0, 0x04), chunk(0x0100, 0x42), chunk(0x0110, 0x60, 0x00),
    ]), 't.uef');
    setMode(m, 0, MOTOR_ON);
    for (let f = 0; f < 40 && !(m.memory.readByte(0xFE00) & 0x10); f++) m.tick();
    expect(m.memory.readByte(0xFE00) & 0x10).toBe(0x10);
    expect(m.memory.readByte(0xFE04)).toBe(0x42);
    expect(m.memory.readByte(0xFE00) & 0x10).toBe(0);
    m.destroy();
  });

  it('clears high tone through FE05 bit 6', async () => {
    const m = machine();
    await m.services.tape.mountBytes(buildUef([chunk(0x0110, 0xB0, 0x04)]), 't.uef');
    setMode(m, 0, MOTOR_ON);
    for (let f = 0; f < 10; f++) m.tick();
    expect(m.memory.readByte(0xFE00) & 0x40).toBe(0x40);
    m.memory.writeByte(0xFE05, 0x40);
    expect(m.memory.readByte(0xFE00) & 0x40).toBe(0);
    m.destroy();
  });

  it('flags transmit-empty and receive-full on entering cassette output, and records written bytes', () => {
    // TX loop: wait for transmit-empty (bit 5), write the next byte from a table.
    const tx = [
      0xA2, 0x00,                     // LDX #0
      0xAD, 0x00, 0xFE,               // loop: LDA $FE00
      0x29, 0x20,                     // AND #$20
      0xF0, 0xF9,                     // BEQ loop
      0xBD, 0x00, 0xC2,               // LDA $C200,X
      0x8D, 0x04, 0xFE,               // STA $FE04
      0xE8,                           // INX
      0xE0, 0x03,                     // CPX #3
      0xD0, 0xEE,                     // BNE loop
      0x4C, 0x14, 0xC0,               // done: JMP done
    ];
    const rom = makeRom(tx);
    rom.set([0x41, 0x42, 0x43], 0x4000 + 0x200);
    const m = new ElectronMachine('electron', null);
    m.loadROM(rom);
    m.reset();
    setMode(m, 0, MOTOR_ON | 0x04);                           // comms mode 2: cassette output, motor on
    expect(m.memory.readByte(0xFE00) & 0x30).toBe(0x30);
    for (let f = 0; f < 30; f++) m.tick();
    const rec = m.services.tape.recordedBytes();
    expect(rec).not.toBeNull();
    expect(rec!.filename).toBe('electron-tape.uef');
    const bytes = Array.from(rec!.data);
    const at = bytes.findIndex((b, i) => b === 0x41 && bytes[i + 1] === 0x42 && bytes[i + 2] === 0x43);
    expect(at).toBeGreaterThan(12);
    m.destroy();
  });
});

describe('Electron services', () => {
  it('accepts .uef, .csw and .wav tapes and reports a tape service', async () => {
    const m = machine();
    expect(m.services.media.accepts().map(t => t.ext)).toEqual(['.uef', '.csw', '.wav', '.elkstate']);
    const bad = await m.services.media.mount(new Uint8Array(40), 'x.uef');
    expect(bad.ok).toBe(false);
    const ok = await m.services.media.mount(buildUef([chunk(0x0100, 1, 2, 3)]), 'x.uef');
    expect(ok.ok).toBe(true);
    expect(ok.target).toBe('tape');
    expect(m.services.tape?.loaded).toBe(true);
    m.destroy();
  });

  it('lists the BASIC program at PAGE, wherever a filing system has put it', () => {
    // 10 PRINT 1 as BASIC stores it: 0x0D, line hi/lo, length, tokens, 0x0D, then 0xFF.
    const program = [0x0D, 0x00, 0x0A, 0x07, 0xF1, 0x20, 0x31, 0x0D, 0xFF];
    for (const page of [0x0E, 0x19]) {          // tape/ADFS PAGE, then DFS PAGE
      const m = machine();
      m.memory.ram[0x18] = page;
      m.memory.ram.set(program, page << 8);
      expect(m.services.probe.panes?.basicListing?.()).toEqual([{ lineNumber: 10, text: 'PRINT 1' }]);
      m.destroy();
    }
  });

  it('shows no BASIC listing or variables for RAM that holds no program', () => {
    const m = machine();
    expect(m.services.probe.panes?.basicListing?.()).toEqual([]);
    expect(m.services.probe.panes?.basicVars?.()).toEqual([]);
    m.destroy();
  });

  it('lists the paged-ROM sockets other than the keyboard and BASIC pages', () => {
    const m = machine();
    const idx = m.services.roms.sidewaysSlots.map(s => s.index);
    expect(idx).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15]);
    m.services.roms.installSidewaysRom(12, new Uint8Array(0x4000).fill(0x11));
    expect(m.services.roms.sidewaysSlots.find(s => s.index === 12)!.size).toBe(0x4000);
    m.destroy();
  });
});
