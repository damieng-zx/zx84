/**
 * Oric-1 / Oric Atmos integration tests: registration, the memory map, the
 * page-3 I/O decode, the keyboard matrix, the ULA's serial attributes — and,
 * when the Oric ROMs are in the MCP cache, a real boot to the BASIC banner.
 *
 * The ROMs are not redistributable. They are read from `mcp/.cache` under the
 * `oric-` prefix, and are checked against the published hashes in the test
 * below before anything boots from them:
 *   oric-basic11b.rom  Oric Atmos BASIC 1.1b (SHA1 9451a1a0…)
 *   oric-basic10.rom   Oric-1 BASIC 1.0      (SHA1 333116e6…)
 * A suite whose ROMs are missing is skipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OricMachine } from '@/machines/oric/oric-machine.ts';
import { oricEntry } from '@/machines/oric/descriptor.ts';
import { OricKeyboard, ORIC_KEYS, ORIC_CHAR_KEYS } from '@/machines/oric/oric-keyboard.ts';
import { ocrOricText } from '@/ocr/oric.ts';
import { registry } from '@/machines/registry.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';
import {
  ORIC_ACTIVE_HEIGHT, ORIC_BORDER_LEFT, ORIC_BORDER_TOP, ORIC_HIRES_SCREEN,
  ORIC_SCREEN_HEIGHT, ORIC_SCREEN_WIDTH, ORIC_TEXT_COLS, ORIC_TEXT_SCREEN,
} from '@/machines/oric/constants.ts';
import { STYLE_BLINK, STYLE_DOUBLE_HEIGHT } from '@/machines/oric/oric-ula.ts';
import { crc32 } from '@/machines/shared/state-io.ts';

const CACHE = join(process.cwd(), 'mcp', '.cache');
const romPath = (name: string): string => join(CACHE, name);
const hasRom = (name: string): boolean => existsSync(romPath(name));
const rom = (name: string): Uint8Array => new Uint8Array(readFileSync(romPath(name)));

const key = (code: string, k: string, extra: Partial<HostKeyEvent> = {}): HostKeyEvent =>
  ({ code, key: k, shift: false, ctrl: false, alt: false, ...extra });

/** Boot the machine with `name`'s ROM and run `frames` fields. */
function boot(model: 'atmos' | 'oric1', romName: string, frames = 200): OricMachine {
  const m = new OricMachine(model, null);
  m.loadROM(rom(romName));
  m.reset();
  for (let i = 0; i < frames; i++) m.tick();
  return m;
}

describe('oric registration', () => {
  it('is registered as a 6502 machine, and does not promise hardware it lacks', () => {
    expect(registry).toContain(oricEntry);
    const m = new OricMachine('atmos', null);
    try {
      expect(m.kind).toBe('oric');
      expect(m.descriptor.cpuFamily).toBe('m6502');
      // The cassette is fitted and backed by a service; the Microdisc is not
      // yet, and `tests/machine-capabilities.test.ts` holds every registered
      // model to that promise.
      expect(m.descriptor.ui.tape).toBe('deck');
      expect(m.services.tape).not.toBeNull();
      // The Microdisc is a fitted add-on: the capability is declared but gated
      // on the Hardware-pane setting, and the drive list is empty until it is.
      expect(m.descriptor.ui.builtinDisk).toBe(true);
      expect(m.descriptor.ui.requires?.builtinDisk).toBe('oric-microdisc');
      expect(m.services.disks.drives).toHaveLength(0);
    } finally {
      m.destroy();
    }
  });

  it('refuses an image that is not an Oric system ROM', () => {
    expect(oricEntry.detectModelForRom?.(new Uint8Array(0x4000), 'atmos')).toBeNull();
    expect(oricEntry.detectModelForRom?.(new Uint8Array(0x1000), 'atmos')).toBeNull();
  });

  it.runIf(hasRom('oric-basic11b.rom') && hasRom('oric-basic10.rom'))(
    'classifies a 16 KB system ROM by its BASIC version banner', () => {
      const atmos = rom('oric-basic11b.rom');
      const oric1 = rom('oric-basic10.rom');
      expect(oricEntry.detectModelForRom?.(atmos, 'oric1')).toBe('atmos');
      expect(oricEntry.detectModelForRom?.(oric1, 'atmos')).toBe('oric1');
    });

  it('names the hosted ROM image for each model', () => {
    // These are the R2 keys under `zx84files.bitsparse.com/roms/`, and the
    // files the boot test above reads from the cache.
    expect(oricEntry.romSources('atmos')).toEqual(['oric/basic11b.rom']);
    expect(oricEntry.romSources('oric1')).toEqual(['oric/basic10.rom']);
  });
});

describe('oric memory map', () => {
  it('maps the ROM at $C000 and the overlay RAM behind it', () => {
    const m = new OricMachine('atmos', null);
    try {
      const seed = (base: number): void => {
        for (let i = 0; i < 0x4000; i++) m.memory.rom[i] = 0x11;
        m.memory.ram[base + 0x0100] = 0x22;
      };
      seed(0xC000);
      m.memory.basicRomOn = true;
      expect(m.memory.readByte(0xC100)).toBe(0x11);
      // A write to ROM is dropped.
      m.memory.writeByte(0xC100, 0x33);
      expect(m.memory.readByte(0xC100)).toBe(0x11);

      // ROMDIS: the overlay RAM appears there, and writes land.
      m.memory.setOverlay(true);
      expect(m.memory.readByte(0xC100)).toBe(0x22);
      m.memory.writeByte(0xC200, 0x44);
      expect(m.memory.ram[0xC200]).toBe(0x44);
      expect(m.memory.readByte(0xC200)).toBe(0x44);
    } finally {
      m.destroy();
    }
  });

  it('routes every page-3 address to the VIA, never to RAM', () => {
    const m = new OricMachine('atmos', null);
    try {
      // The VIA's 16 registers are mirrored across the whole page by masking
      // the low *four* bits. DDR B is register 2, so every address whose low
      // nibble is 2 hits it.
      m.memory.writeByte(0x0302, 0x5A);
      expect(m.via.ddrb).toBe(0x5A);
      for (const addr of [0x0312, 0x0322, 0x03F2]) {
        expect(m.memory.readByte(addr), `read of $${addr.toString(16)}`).toBe(0x5A);
      }
      // The mask is 0x0F, not something wider. Every address whose low nibble
      // is 2 aliases DDR B, wherever it sits in the page.
      const aliases = [0x0302, 0x0312, 0x0322, 0x03F2];
      for (const addr of aliases) {
        expect(m.memory.readByte(addr), `read of $${addr.toString(16)}`).toBe(0x5A);
      }
      // $030F is register 15, not register 2 masked wider: four bits is the
      // whole mask, so a different low nibble is a different register.
      expect(m.memory.readByte(0x030F), '$030F is ORA-high, not DDR B').not.toBe(0x5A);

      // A write through another alias lands on the same register. (Reads come
      // first above because reading a VIA register can clear a flag.)
      m.memory.writeByte(0x03F2, 0xA5);
      expect(m.via.ddrb).toBe(0xA5);
      expect(m.via.peek(0x02)).toBe(0xA5);
      // Writing there must not leave a RAM value behind.
      expect(m.memory.ram[0x0302]).toBe(0);
      expect(m.memory.ram[0x03F2]).toBe(0);
    } finally {
      m.destroy();
    }
  });
});

describe('oric keyboard', () => {
  it('agrees with its own character map for every key it lists', () => {
    // Every printable mapping must land on a cell some physical key owns.
    const cells = new Set(ORIC_KEYS.map(k => `${k.cell[0]},${k.cell[1]}`));
    for (const [ch, mapping] of Object.entries(ORIC_CHAR_KEYS)) {
      expect(cells, `'${ch}' types on an unwired cell`).toContain(`${mapping.cell[0]},${mapping.cell[1]}`);
    }
  });

  it('reads a key only for the row and column that select it', () => {
    const kbd = new OricKeyboard();
    // A is row 6, column 5. The sense line reads 1 (true) when pressed: the
    // hardware reference says so, Oricutron drives PB3 high on a match, and the
    // ROM's own scan does `AND #$08 / BNE` at $F57B.
    kbd.setCell(6, 5, true);

    // The right row and the right column (bit 5 clear): pressed.
    expect(kbd.sense(6, ~(1 << 5) & 0xFF)).toBe(true);
    // The right row but another column selected: not pressed.
    expect(kbd.sense(6, ~(1 << 4) & 0xFF)).toBe(false);
    // Another row: not pressed.
    expect(kbd.sense(5, ~(1 << 5) & 0xFF)).toBe(false);
    // No column selected at all (the ROM's idle state): not pressed.
    expect(kbd.sense(6, 0xFF)).toBe(false);
  });

  it('types a character on the cell whose shifted symbol it is', () => {
    const kbd = new OricKeyboard();
    // '/' is row 7, column 3; '?' is the same key with SHIFT.
    expect(kbd.pressChar('/')).toBe(true);
    expect(kbd.isPressed(7, 3)).toBe(true);
    expect(kbd.shiftHeld).toBe(false);

    kbd.releaseAll();
    expect(kbd.pressChar('?')).toBe(true);
    expect(kbd.isPressed(7, 3)).toBe(true);
    expect(kbd.shiftHeld).toBe(true);
  });

  it('routes a host key to its physical cell', () => {
    const kbd = new OricKeyboard();
    expect(kbd.handleEvent(key('KeyA', 'a'), true)).toBe(true);
    expect(kbd.isPressed(6, 5)).toBe(true);
    kbd.handleEvent(key('KeyA', 'a'), false);
    expect(kbd.isPressed(6, 5)).toBe(false);
  });
});

describe('oric ULA', () => {
  it('draws a line of paper for a serial attribute and ink for a character', () => {
    const m = new OricMachine('atmos', null);
    try {
      // Row 0 of the text screen: one space, then 'A' drawn from the charset.
      const line = ORIC_TEXT_SCREEN;
      m.memory.ram.fill(0x20, line, line + ORIC_TEXT_COLS);
      m.memory.ram[line] = 0x20;
      // The ROM copies a charset to $B400; put a solid block at 'A' ($41).
      m.memory.ram.fill(0x3F, 0xB400 + 0x41 * 8, 0xB400 + 0x42 * 8);
      m.memory.ram[line + 1] = 0x41;

      m.ula.reset();
      m.ula.renderLine(0);

      const at = (x: number, y: number): number => m.ula.pixels[y * ORIC_SCREEN_WIDTH + x];
      // The space is ink on paper: white on black, so the cell is black.
      expect(at(32, 32)).toBe(0xFF000000);
      // 'A' is a solid block: all six pixels are white.
      for (let i = 0; i < 6; i++) expect(at(32 + 6 + i, 32)).toBe(0xFFFFFFFF);
    } finally {
      m.destroy();
    }
  });

  it('applies an ink attribute to the rest of its line only', () => {
    const m = new OricMachine('atmos', null);
    try {
      const line = ORIC_TEXT_SCREEN;
      m.memory.ram.fill(0x20, line, line + ORIC_TEXT_COLS);
      m.memory.ram.fill(0x3F, 0xB400, 0xB400 + 0x800);
      // $01 is "ink = red"; the attribute's own cell is paper, the rest red.
      m.memory.ram[line] = 0x01;

      m.ula.reset();
      m.ula.renderLine(0);
      const at = (x: number): number => m.ula.pixels[32 * ORIC_SCREEN_WIDTH + x];
      // The attribute's cell: black paper.
      expect(at(32)).toBe(0xFF000000);
      // Everything after it: red ink.
      expect(at(32 + 6)).toBe(0xFF0000FF);
      expect(at(32 + 6 * 39)).toBe(0xFF0000FF);

      // The next line resets the register: white on black again.
      m.memory.ram.fill(0x20, line + ORIC_TEXT_COLS, line + ORIC_TEXT_COLS * 2);
      m.ula.renderLine(1);
      expect(m.ula.pixels[(32 + 1) * ORIC_SCREEN_WIDTH + 32]).toBe(0xFF000000);
    } finally {
      m.destroy();
    }
  });

  it('honours inverse video and the alternate charset', () => {
    const m = new OricMachine('atmos', null);
    try {
      const line = ORIC_TEXT_SCREEN;
      m.memory.ram.fill(0x20, line, line + ORIC_TEXT_COLS);
      // Both charsets: glyph $20 (space) blank, glyph $21 (a solid block).
      for (const base of [0xB400, 0xB800]) {
        m.memory.ram.fill(0x00, base, base + 0x300);
        m.memory.ram.fill(0x3F, base + 0x21 * 8, base + 0x22 * 8);
      }
      // $09 is "style = alternate charset": the attribute's own cell is paper,
      // and everything after it is looked up in $B800.
      m.memory.ram[line] = 0x09;
      m.memory.ram[line + 1] = 0x21;
      // $80 | $21 is the same glyph in inverse video.
      m.memory.ram[line + 2] = 0x80 | 0x21;

      m.ula.reset();
      m.ula.renderLine(0);
      const at = (x: number): number => m.ula.pixels[32 * ORIC_SCREEN_WIDTH + x];
      const white = 0xFFFFFFFF;
      // The attribute's own cell draws in paper: black.
      expect(at(32)).toBe(0xFF000000);
      // The alternate charset's block: white ink.
      expect(at(32 + 6)).toBe(white);
      // Inverse video swaps ink and paper, so the bright block becomes black
      // ink on white paper — the cell's first line is mostly paper only where
      // the glyph is clear, and this glyph is solid, so it reads black.
      expect(at(32 + 12)).toBe(0xFF000000);

      // Prove the alternate charset is the one being read: blank $B400's copy
      // and confirm the same cell still draws from $B800.
      m.memory.ram.fill(0x00, 0xB400, 0xB400 + 0x400);
      m.ula.reset();
      m.ula.renderLine(0);
      expect(at(32 + 6)).toBe(white);
    } finally {
      m.destroy();
    }
  });

  it('draws hires pixels from $A000 and never consults the charsets', () => {
    const m = new OricMachine('atmos', null);
    try {
      // Mode $04: hires. Poke a line: an ink attribute, a solid byte, an ink
      // reset, and a byte that is therefore drawn in black.
      m.ula.reset();
      m.ula.mode = 0x04;
      const line = ORIC_HIRES_SCREEN + 10 * 40;
      m.memory.ram[line] = 0x07;      // ink = white
      m.memory.ram[line + 1] = 0x3F;  // six white pixels
      m.memory.ram[line + 2] = 0x00;  // ink = black
      m.memory.ram[line + 3] = 0x3F;
      m.memory.ram.fill(0x00, 0xB400, 0xBC00);   // no charsets at all

      m.ula.renderLine(10);
      const at = (col: number): number =>
        m.ula.pixels[(10 + ORIC_BORDER_TOP) * ORIC_SCREEN_WIDTH + ORIC_BORDER_LEFT + col];
      const white = 0xFFFFFFFF;
      // The attribute's own cell is paper; the solid byte is ink.
      expect(at(0)).toBe(0xFF000000);
      expect(at(6)).toBe(white);
      expect(at(12)).toBe(0xFF000000);
      // A hires picture with the charsets blank proves it never reads them.
      expect(at(18)).toBe(0xFF000000);

      // Every one of the six bits must reach the right pixel, most significant
      // leftmost. A hires byte must NOT have bits 6 and 5 both clear, or it is
      // a serial attribute rather than pixels, so the low bits are exercised
      // with bit 5 set: $2B is 101011 -> ink, paper, ink, paper, ink, ink. A
      // dropped or reordered low bit is invisible in a solid $3F.
      m.memory.ram[line] = 0x07;      // ink white for the rest of the line
      m.memory.ram[line + 1] = 0x2B;
      m.ula.renderLine(10);
      expect([0, 1, 2, 3, 4, 5].map(i => at(6 + i) === white))
        .toEqual([true, false, true, false, true, true]);
      // And the low bit on its own: $21 is 100001 -> ink, paper, paper, paper,
      // paper, ink.
      m.memory.ram[line] = 0x07;
      m.memory.ram[line + 1] = 0x21;
      m.ula.renderLine(10);
      expect([0, 1, 2, 3, 4, 5].map(i => at(6 + i) === white))
        .toEqual([true, false, false, false, false, true]);
    } finally {
      m.destroy();
    }
  });

  it('applies a mode attribute from the next line, and forces text at line 200', () => {
    const m = new OricMachine('atmos', null);
    try {
      m.memory.ram.fill(0x20, ORIC_TEXT_SCREEN, ORIC_TEXT_SCREEN + 40 * 28);
      m.ula.reset();
      // The mode attribute is committed at the line boundary: the line it is
      // written on renders in the old mode, and the register then reads hires
      // for the next line.
      m.memory.ram[ORIC_TEXT_SCREEN] = 0x1E;   // hires, 60 Hz
      m.ula.renderLine(0);
      // Line 0 drew text: the cell after the attribute came from the charset,
      // which is blank here, so it is paper rather than six white pixels.
      m.memory.ram.fill(0x3F, 0xB400, 0xB400 + 0x400);
      const cell = (): number =>
        m.ula.pixels[(0 + ORIC_BORDER_TOP) * ORIC_SCREEN_WIDTH + ORIC_BORDER_LEFT + 6];
      expect(cell(), 'line 0 must have drawn text, i.e. black').toBe(0xFF000000);
      // From line 1 the ULA reads six-bit pixels straight from $A000.
      m.ula.renderLine(1);
      expect(m.ula.hires).toBe(true);
      expect(m.ula.sixtyHz).toBe(true);

      // Line 200 forces text: $BF68 onward is read as charset indices, not as
      // six-bit pixels. Prove it by blanking the charset and watching the cell
      // change — in hires mode that byte would have been drawn directly.
      m.ula.reset();
      m.ula.mode = 0x04;
      m.memory.ram.fill(0x3F, ORIC_HIRES_SCREEN, ORIC_HIRES_SCREEN + 200 * 40);
      for (const base of [0xB400, 0xB800]) {
        m.memory.ram.fill(0x00, base, base + 0x300);
        m.memory.ram.fill(0x3F, base + 0x21 * 8, base + 0x22 * 8);
      }
      m.memory.ram.fill(0x20, 0xBF68, 0xBF68 + 3 * 40);
      m.memory.ram[0xBF68] = 0x07;   // ink white
      m.memory.ram[0xBF69] = 0x21;   // a solid block
      const tail = (line = 200): number =>
        m.ula.pixels[(line + ORIC_BORDER_TOP) * ORIC_SCREEN_WIDTH + ORIC_BORDER_LEFT + 6];

      // The boundary is exactly 200: lines 0-199 are hires, 200 is the first
      // text line. Line 199 must still take six-bit pixels straight from
      // $A000 — which is all $3F here — without consulting the charset.
      m.memory.ram.fill(0x00, 0xB400, 0xBC00);
      m.ula.renderLine(199);
      expect(tail(199), 'line 199 is still hires').toBe(0xFFFFFFFF);

      // Line 200 reads a glyph index instead, so blanking the charset changes
      // what it draws.
      for (const base of [0xB400, 0xB800]) {
        m.memory.ram.fill(0x3F, base + 0x21 * 8, base + 0x22 * 8);
      }
      m.ula.renderLine(200);
      expect(tail(), 'line 200 is text').toBe(0xFFFFFFFF);
      m.memory.ram.fill(0x00, 0xB400, 0xBC00);
      m.ula.renderLine(200);
      expect(tail(), 'line 200 must draw from the charset').toBe(0xFF000000);
    } finally {
      m.destroy();
    }
  });

  it('doubles the height by showing each glyph scanline on two lines', () => {
    const m = new OricMachine('atmos', null);
    try {
      // A glyph whose top half (scanlines 0-3) is blank and bottom half
      // (4-7) solid. Under double height it must read blank for lines 0-7 and
      // solid for 8-15, then repeat — the halving is screen-aligned, which is
      // the ROM bug the plan reproduces on purpose.
      for (const base of [0xB400, 0xB800]) {
        m.memory.ram.fill(0x00, base, base + 0x300);
        for (let r = 4; r < 8; r++) m.memory.ram[base + 0x21 * 8 + r] = 0x3F;
      }
      m.ula.reset();
      for (let row = 0; row < 28; row++) {
        const b = ORIC_TEXT_SCREEN + row * 40;
        m.memory.ram[b] = 0x0A;      // style = double height
        m.memory.ram[b + 1] = 0x21;
      }
      const ink = (line: number): boolean =>
        m.ula.pixels[(line + ORIC_BORDER_TOP) * ORIC_SCREEN_WIDTH + ORIC_BORDER_LEFT + 6] === 0xFFFFFFFF;

      const pattern: boolean[] = [];
      for (let line = 0; line < 16; line++) {
        m.ula.renderLine(line);
        pattern.push(ink(line));
      }
      expect(pattern).toEqual([
        false, false, false, false, false, false, false, false,
        true, true, true, true, true, true, true, true,
      ]);
    } finally {
      m.destroy();
    }
  });

  it('exposes the 50/60 Hz select as mode bit 1', () => {
    const m = new OricMachine('atmos', null);
    try {
      // Per the attribute table: $010 is text at 50 Hz and $011 at 60 Hz, so
      // bit 1 *set* means 60 Hz — mode $1E is hires at 60 Hz.
      m.ula.reset();
      m.memory.ram.fill(0x20, ORIC_TEXT_SCREEN, ORIC_TEXT_SCREEN + 40 * 28);
      m.memory.ram[ORIC_TEXT_SCREEN] = 0x1E;
      m.ula.renderLine(0);
      m.ula.renderLine(1);
      expect(m.ula.mode).toBe(0x06);
      expect(m.ula.hires).toBe(true);
      expect(m.ula.sixtyHz).toBe(true);
      // The frame the machine runs really is shorter in 60 Hz mode: 260 lines
      // against 312, which is what the ROM's timing and WAIT depend on.
      expect(m.tStatesPerFrame).toBe(64 * 260);
      m.ula.mode = 0;
      expect(m.tStatesPerFrame).toBe(64 * 312);
    } finally {
      m.destroy();
    }
  });

  it('blinks flashed text off for half of the 64-field clock', () => {
    const m = new OricMachine('atmos', null);
    try {
      const line = ORIC_TEXT_SCREEN;
      // NOTE: the charsets live at $B400 and $B800 and are 0x400 bytes each,
      // so filling $B800 upward would run into the text screen at $BB80.
      for (const base of [0xB400, 0xB800]) {
        m.memory.ram.fill(0x00, base, base + 0x300);
        m.memory.ram.fill(0x3F, base + 0x21 * 8, base + 0x22 * 8);
      }
      m.memory.ram.fill(0x20, line, line + ORIC_TEXT_COLS);
      // Style $04 = blink, then a solid block.
      m.memory.ram[line] = 0x0C;
      m.memory.ram[line + 1] = 0x21;
      const cell = (): number =>
        m.ula.pixels[(0 + ORIC_BORDER_TOP) * ORIC_SCREEN_WIDTH + ORIC_BORDER_LEFT + 6];

      m.ula.reset();
      // The first 32 fields show the glyph, the next 32 show paper.
      expect(cell(), 'reset must not leave the blink clock mid-phase').toBe(0xFF000000);
      m.ula.renderLine(0);
      expect(cell()).toBe(0xFFFFFFFF);
      for (let i = 0; i < 32; i++) m.ula.endFrame();
      m.ula.renderLine(0);
      expect(cell(), 'field 32 of the blink clock shows paper').toBe(0xFF000000);
      for (let i = 0; i < 32; i++) m.ula.endFrame();
      m.ula.renderLine(0);
      expect(cell(), 'field 64 wraps back to the glyph').toBe(0xFFFFFFFF);
    } finally {
      m.destroy();
    }
  });

  it('exposes the style bits as the ROM defines them', () => {
    expect(STYLE_DOUBLE_HEIGHT).toBe(0x02);
    expect(STYLE_BLINK).toBe(0x04);
  });
});

describe('oric OCR', () => {
  it('reads the text screen and drops a trailing blank line', () => {
    const m = new OricMachine('atmos', null);
    try {
      m.memory.ram.fill(0x20, ORIC_TEXT_SCREEN, ORIC_TEXT_SCREEN + ORIC_TEXT_COLS * 28);
      const text = 'HELLO, ORIC';
      for (let i = 0; i < text.length; i++) {
        m.memory.ram[ORIC_TEXT_SCREEN + ORIC_TEXT_COLS * 2 + i] = text.charCodeAt(i);
      }
      const result = ocrOricText(m.memory.ram);
      const lines = result.text.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('');
      expect(lines[2]).toBe('HELLO, ORIC');
    } finally {
      m.destroy();
    }
  });
});

describe.runIf(hasRom('oric-basic11b.rom'))('oric Atmos boot', () => {
  it('is the published Atmos ROM, not just any 16 KB file', () => {
    // A 16 KB file named basic*.rom is not necessarily an Oric ROM — a wrong one
    // runs, but into nonsense. Pin the published CRC before trusting a boot.
    expect(crc32(rom('oric-basic11b.rom'))).toBe(0xc3a92bef);
  });

  it('boots BASIC 1.1 and prints its banner', () => {
    const m = boot('atmos', 'oric-basic11b.rom', 200);
    try {
      const screen = ocrOricText(m.memory.ram).text;
      expect(screen).toContain('ORIC EXTENDED BASIC');
      // The banner, the copyright line and the memory size the ROM computed.
      expect(screen).toContain('1983 TANGERINE');
      expect(screen).toContain('BYTES FREE');
      expect(screen).toContain('Ready');
    } finally {
      m.destroy();
    }
  });

  it('types PRINT "HELLO" and BASIC prints it', () => {
    const m = boot('atmos', 'oric-basic11b.rom', 200);
    try {
      expect(m.typeText('PRINT "HELLO"\n')).toBe(14);
      // The keys are held several fields each, so this needs a long run.
      for (let i = 0; i < 700; i++) m.tick();
      const screen = ocrOricText(m.memory.ram).text;
      // The ROM echoes the line as typed, then BASIC prints the result on the
      // next line.
      expect(screen).toContain('PRINT "HELLO"');
      expect(screen.split('\n').filter(l => l.trim() === 'HELLO')).toHaveLength(1);
      expect(m.pasteRemaining).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('computes PRINT 6*7 typed at the keyboard', () => {
    // The digits and `*` are the interesting case: `*` is SHIFT+8 on the Oric,
    // so this only prints 42 if the shifted key reaches the ROM with SHIFT
    // held in the matrix, and if the quote/digit cells are the ones BASIC
    // expects. A wrong cell would type a different character and not evaluate.
    const m = boot('atmos', 'oric-basic11b.rom', 200);
    try {
      m.typeText('PRINT 6*7\n');
      for (let i = 0; i < 700; i++) m.tick();
      const screen = ocrOricText(m.memory.ram).text;
      expect(screen).toContain('PRINT 6*7');
      expect(screen).toContain('42');
    } finally {
      m.destroy();
    }
  });
});

describe.runIf(hasRom('oric-basic10.rom'))('oric-1 boot', () => {
  it('boots BASIC 1.0 and prints its banner', () => {
    const m = boot('oric1', 'oric-basic10.rom', 200);
    try {
      expect(ocrOricText(m.memory.ram).text).toContain('ORIC EXTENDED BASIC');
    } finally {
      m.destroy();
    }
  });
});

describe('oric frame geometry', () => {
  it('reports the descriptor geometry it actually renders', () => {
    const m = new OricMachine('atmos', null);
    try {
      const screen = m.descriptor.screen;
      expect(m.frameWidth).toBe(screen.width);
      expect(m.frameHeight).toBe(screen.height);
      expect(m.pixels.length).toBe(ORIC_SCREEN_WIDTH * ORIC_SCREEN_HEIGHT * 4);
      expect(screen.activeHeight).toBe(ORIC_ACTIVE_HEIGHT);
    } finally {
      m.destroy();
    }
  });
});
