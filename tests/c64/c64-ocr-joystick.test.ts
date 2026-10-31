/**
 * The 64's TEXT overlay (screen OCR for the character modes) and the default
 * control port of each player's joystick.
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { C64_PALETTE } from '@/machines/c64/palette.ts';
import { C64_JOY_PORT1, C64_JOY_PORT2 } from '@/machines/c64/services/input.ts';
import { c64OcrGrid } from '@/ocr/c64.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

const basic = romImage('basic-901226-01.rom');
const kernal = romImage('kernal-901227-03.rom');
const chargen = romImage('chargen-901225-01.rom');

function realC64(): C64Machine {
  const rom = new Uint8Array(0x5000);
  rom.set(basic!, 0);
  rom.set(kernal!, 0x2000);
  rom.set(chargen!, 0x4000);
  const m = new C64Machine('c64', null);
  m.loadROM(rom);
  m.reset();
  for (let f = 0; f < 150; f++) m.tick();
  return m;
}

describe('C64 joystick ports', () => {
  /** What the joystick lines read on CIA 1: port 2 is port A, port 1 is port B. */
  function lines(m: C64Machine): { portA: number; portB: number } {
    return { portA: m.cia1.read(0) & 0x1F, portB: m.cia1.read(1) & 0x1F };
  }

  it('puts a player on the port of the type chosen', () => {
    const m = new C64Machine('c64', null);
    m.services.input.joystick!.press('up', true, C64_JOY_PORT2, 0);
    expect(lines(m)).toEqual({ portA: 0x1E, portB: 0x1F });
    m.services.input.releaseAll();
    m.services.input.joystick!.press('up', true, C64_JOY_PORT1, 1);
    expect(lines(m)).toEqual({ portA: 0x1F, portB: 0x1E });
    m.destroy();
  });

  it('starts player 1 in port 1 and player 2 in port 2', () => {
    const m = new C64Machine('c64', null);
    // The shared settings default to the Spectrum's Kempston and Sinclair 2.
    m.services.input.joystick!.press('fire', true, 'kempston', 0);
    expect(lines(m)).toEqual({ portA: 0x1F, portB: 0x0F });
    m.services.input.releaseAll();
    m.services.input.joystick!.press('fire', true, 'sinclair2', 1);
    expect(lines(m)).toEqual({ portA: 0x0F, portB: 0x1F });
    m.destroy();
  });

  it('offers port 1 first, so it is player 1\'s default', () => {
    const m = new C64Machine('c64', null);
    expect(m.descriptor.ui.joystickTypes?.map(t => t.id)).toEqual([C64_JOY_PORT1, C64_JOY_PORT2]);
    m.destroy();
  });
});

describe.skipIf(!basic || !kernal || !chargen)('C64 TEXT overlay', () => {
  const rows = (text: string): string[] => text.split('\n');

  it('reads the boot screen, with each cell\'s colour and a blue paper', () => {
    const m = realC64();
    const r = m.ocrScreenStyled();
    expect(r.grid).toBe('40x25');
    expect(r.cols * r.rows).toBe(1000);
    expect(rows(r.text)[1].trim()).toBe('**** COMMODORE 64 BASIC V2 ****');
    expect(rows(r.text).some(l => /^READY\.\s*$/.test(l))).toBe(true);
    // Light blue letters on a blue screen.
    expect(r.html).toContain('<span style="color:#');
    const c = rows(r.text)[1].indexOf('C');
    expect(r.paper[40 + c]).toBe(6);
    expect(r.mask[40 + c]).toBe(true);        // the 'C' of COMMODORE
    expect(r.mask[40 + 0]).toBe(false);       // a blank cell
  });

  it('is what the plain text reads, apart from graphics', () => {
    const m = realC64();
    const styled = rows(m.ocrScreenStyled().text).map(l => l.replace(/\s+$/, ''));
    while (styled.length > 0 && styled[styled.length - 1] === '') styled.pop();
    expect(styled.join('\n')).toBe(m.ocrScreenForMcp());
  });

  it('blanks the matched cells to the background, leaving the rest', () => {
    const m = realC64();
    const r = m.ocrScreenStyled();
    const field = m.textField;
    expect(field).toEqual({ x: 32, y: 35, width: 320, height: 200 });
    const at = (row: number, col: number, x: number, y: number): number =>
      m.vic.pixels[(field.y + row * 8 + y) * 384 + field.x + col * 8 + x];
    const bg = C64_PALETTE[6];
    // Before: the 'C' has ink pixels in it.
    let ink = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (at(1, 5, x, y) !== bg) ink++;
    expect(ink).toBeGreaterThan(8);
    m.blankCells(r.mask, r.paper);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(at(1, 5, x, y)).toBe(bg);
  });

  it('runs through the probe with the grid and field for the overlay', () => {
    const m = realC64();
    const t = m.services.probe.transcribe!;
    expect(t.active).toBe(false);
    t.activate();
    const out = t.run();
    expect(t.active).toBe(true);
    expect(out.grid).toBe('40x25');
    expect(out.field).toEqual({ x: 32, y: 35, width: 320, height: 200 });
    expect(out.text).toContain('READY.');
    t.deactivate();
    expect(t.active).toBe(false);
  });

  it('follows the scroll registers', () => {
    const m = realC64();
    m.vic.regs[0x16] = (m.vic.regs[0x16] & ~7) | 5;
    m.vic.regs[0x11] = (m.vic.regs[0x11] & ~7) | 6;
    expect(m.textField).toMatchObject({ x: 32 + 5, y: 35 + 3 });
  });

  /** Make the VIC-II show a character set from RAM, with `glyphs` for codes. */
  function customSet(m: C64Machine, glyphs: Record<number, Uint8Array>): void {
    m.vic.regs[0x18] = 0x18;                       // screen $0400, characters $2000
    m.memory.ram.fill(0, 0x2000, 0x2800);
    for (const [code, g] of Object.entries(glyphs)) m.memory.ram.set(g, 0x2000 + Number(code) * 8);
  }
  const romGlyph = (code: number, set = 0): Uint8Array =>
    chargen!.slice(set * 0x800 + code * 8, set * 0x800 + code * 8 + 8);
  const invert = (g: Uint8Array): Uint8Array => g.map(b => ~b & 0xFF);

  it('reads a character set the program moved, by the glyphs it shows', () => {
    const m = realC64();
    // Code 1 shows a ROM 'Z', code 2 a ROM lower-case 'q' (from the other set),
    // code 3 is a tile that is no letter at all, the rest are blank.
    customSet(m, {
      1: romGlyph(26), 2: romGlyph(17, 1), 3: Uint8Array.of(0x18, 0x24, 0x42, 0x81, 0x81, 0x42, 0x24, 0x18),
    });
    m.memory.ram.fill(0, 0x400, 0x400 + 1000);
    m.memory.ram.set([1, 2, 3, 4], 0x400);
    const r = m.ocrScreenStyled();
    expect(rows(r.text)[0].slice(0, 5)).toBe('Zq   ');
    expect(r.mask.slice(0, 4)).toEqual([true, true, false, false]);
  });

  it('reads reverse video with the colours swapped', () => {
    const m = realC64();
    customSet(m, { 1: invert(romGlyph(26)) });
    m.memory.ram.fill(0, 0x400, 0x400 + 1000);
    m.memory.ram[0x400] = 1;
    m.memory.colorRam[0] = 1;                      // white ink
    m.vic.regs[0x21] = 6;                          // blue background
    const r = m.ocrScreenStyled();
    expect(rows(r.text)[0][0]).toBe('Z');
    // The block is white, so it is blanked to white and the letter is blue.
    expect(r.paper[0]).toBe(1);
    const blue = '#' + (C64_PALETTE[6] & 0xFFFFFF).toString(16).padStart(6, '0');
    const rgb = (abgr: number): string => {
      const v = ((abgr & 0xFF) << 16) | (((abgr >>> 8) & 0xFF) << 8) | ((abgr >>> 16) & 0xFF);
      return '#' + v.toString(16).padStart(6, '0');
    };
    expect(blue.length).toBe(7);
    expect(r.html.startsWith(`<span style="color:${rgb(C64_PALETTE[6])}">Z`)).toBe(true);
  });

  it('leaves a solid block (the cursor on a space) alone', () => {
    const m = realC64();
    m.memory.ram.fill(0x20, 0x400, 0x400 + 1000);
    m.memory.ram[0x400] = 0xA0;                    // reverse space
    const r = m.ocrScreenStyled();
    expect(r.mask[0]).toBe(false);
  });

  it('reads extended-colour text with the background of the code\'s top bits', () => {
    const m = realC64();
    m.vic.regs[0x11] |= 0x40;                      // ECM
    m.vic.regs[0x23] = 2;                          // background colour 2 (codes 128-191)
    m.memory.ram.fill(0x20, 0x400, 0x400 + 1000);
    m.memory.ram[0x400] = 0x80 | 1;                // 'A' on background 2
    const r = m.ocrScreenStyled();
    expect(rows(r.text)[0][0]).toBe('A');
    expect(r.paper[0]).toBe(2);
  });

  it('leaves the multicolour cells of multicolour text and bitmap screens alone', () => {
    const m = realC64();
    m.vic.regs[0x16] |= 0x10;                      // multicolour text
    m.memory.ram.fill(0x20, 0x400, 0x400 + 1000);
    m.memory.ram[0x400] = 1; m.memory.colorRam[0] = 0x0F;   // multicolour cell
    m.memory.ram[0x401] = 1; m.memory.colorRam[1] = 0x07;   // hires cell, yellow
    const r = m.ocrScreenStyled();
    expect(r.mask.slice(0, 2)).toEqual([false, true]);
    m.vic.regs[0x16] &= ~0x10;
    m.vic.regs[0x11] |= 0x20;                      // bitmap
    expect(m.ocrScreenStyled().mask.some(Boolean)).toBe(false);
  });
});

describe('C64 OCR with no ROM font', () => {
  it('reads nothing from a screen whose glyphs match no character', () => {
    const regs = new Uint8Array(0x40);
    const r = c64OcrGrid({
      regs, chargen: new Uint8Array(0x1000), palette: C64_PALETTE,
      vicRead: () => 0x55, colour: () => 1,
    });
    expect(r.mask.some(Boolean)).toBe(false);
  });
});
