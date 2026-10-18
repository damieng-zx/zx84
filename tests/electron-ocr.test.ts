/**
 * Electron screen OCR: the OS font is located inside the ROM by its first
 * glyphs, and character cells are decoded through each mode's memory layout
 * (cell-major, 1/2/4 bits per pixel, bit-interleaved) and matched against it.
 */

import { describe, it, expect } from 'vitest';
import { findElectronFont, ocrElectronBitmap, ELECTRON_FONT_BYTES } from '@/ocr/electron.ts';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';

/** A 96-glyph table with the BBC/Electron signature (space, '!', '"') and 'A', 'B'. */
function fontTable(): Uint8Array {
  const f = new Uint8Array(ELECTRON_FONT_BYTES);
  f.set([0x18, 0x18, 0x18, 0x18, 0x18, 0x00, 0x18, 0x00], 1 * 8);          // !
  f.set([0x6C, 0x6C, 0x6C, 0x00, 0x00, 0x00, 0x00, 0x00], 2 * 8);          // "
  f.set([0x18, 0x24, 0x42, 0x7E, 0x42, 0x42, 0x42, 0x00], ('A'.charCodeAt(0) - 32) * 8);
  f.set([0x7C, 0x42, 0x42, 0x7C, 0x42, 0x42, 0x7C, 0x00], ('B'.charCodeAt(0) - 32) * 8);
  return f;
}

const A = [0x18, 0x24, 0x42, 0x7E, 0x42, 0x42, 0x42, 0x00];
const B = [0x7C, 0x42, 0x42, 0x7C, 0x42, 0x42, 0x7C, 0x00];

describe('findElectronFont', () => {
  it('finds the font wherever it sits in the OS ROM', () => {
    const os = new Uint8Array(0x4000);
    os.set(fontTable(), 0x0C40);
    const font = findElectronFont(os);
    expect(font.length).toBe(ELECTRON_FONT_BYTES);
    expect(font[('A'.charCodeAt(0) - 32) * 8 + 3]).toBe(0x7E);
  });

  it('returns an all-blank table when the ROM has no font', () => {
    const font = findElectronFont(new Uint8Array(0x4000));
    expect(font.every(b => b === 0)).toBe(true);
  });
});

function ocr(ram: Uint8Array, mode: number, start = 0x3000) {
  const pens = new Uint8Array(16);
  pens[8] = 7;                                        // logical 1 (pen 8) white, others black
  return ocrElectronBitmap({
    ram, screenStart: start, mode, font: fontTable(), pens,
    palette: Uint32Array.from([0xFF000000, 0xFF0000FF, 0xFF00FF00, 0xFF00FFFF, 0xFFFF0000, 0xFFFF00FF, 0xFFFFFF00, 0xFFFFFFFF]),
  });
}

describe('ocrElectronBitmap', () => {
  it('reads mode 6 (one bit per pixel, 40 × 25) from character-cell-major memory', () => {
    const ram = new Uint8Array(0x8000);
    // Character (col 3, row 2): a row is 320 bytes and each column 8 bytes.
    for (let ra = 0; ra < 8; ra++) ram[0x3000 + 2 * 320 + 3 * 8 + ra] = A[ra];
    for (let ra = 0; ra < 8; ra++) ram[0x3000 + 2 * 320 + 4 * 8 + ra] = B[ra];
    const r = ocr(ram, 6);
    expect(r.grid).toBe('40x25');
    const rows = r.text.split('\n');
    expect(rows).toHaveLength(25);
    expect(rows[2].slice(3, 5)).toBe('AB');
    expect(rows[2].trim()).toBe('AB');
    expect(rows[0].trim()).toBe('');
    expect(r.mask[2 * 40 + 3]).toBe(true);
    expect(r.mask[2 * 40 + 5]).toBe(false);
  });

  it('reads inverse video (paper and ink swapped)', () => {
    const ram = new Uint8Array(0x8000).fill(0xFF);
    for (let ra = 0; ra < 8; ra++) ram[0x3000 + ra] = A[ra] ^ 0xFF;
    expect(ocr(ram, 4).text.split('\n')[0][0]).toBe('A');
  });

  it('reads mode 1 (two bits per pixel): a character spans two display bytes', () => {
    const ram = new Uint8Array(0x8000);
    // Ink = logical 3 (bits 7-i and 3-i set for pixel i of its byte).
    const enc = (bits: number): number => {
      let b = 0;
      for (let i = 0; i < 4; i++) if ((bits >> (3 - i)) & 1) b |= (0x80 >> i) | (0x08 >> i);
      return b;
    };
    const col = 1;
    for (let ra = 0; ra < 8; ra++) {
      ram[0x3000 + (col * 2) * 8 + ra] = enc(A[ra] >> 4);           // left four pixels
      ram[0x3000 + (col * 2 + 1) * 8 + ra] = enc(A[ra] & 0x0F);     // right four
    }
    const r = ocr(ram, 1);
    expect(r.grid).toBe('40x32');
    expect(r.text.split('\n')[0].slice(0, 3)).toBe(' A ');
  });

  it('wraps the screen address round the top of memory', () => {
    const ram = new Uint8Array(0x8000);
    // Mode 4 holds &2800 bytes. From &7E00 the third character row is &8080 → &5880.
    for (let ra = 0; ra < 8; ra++) ram[0x5880 + ra] = B[ra];
    expect(ocr(ram, 4, 0x7E00).text.split('\n')[2][0]).toBe('B');
  });
});

describe('Electron machine OCR', () => {
  it('transcribes the screen through the machine, trimming trailing blank rows', () => {
    const rom = new Uint8Array(0x8000);
    rom.set(fontTable(), 0x4000 + 0x0200);
    const m = new ElectronMachine('electron', null);
    m.loadROM(rom);
    m.reset();
    m.memory.writeByte(0xFE03, 0x18);
    m.memory.writeByte(0xFE07, 6 << 3);
    for (let ra = 0; ra < 8; ra++) m.memory.ram[0x3000 + ra] = A[ra];
    expect(m.ocrScreenForMcp()).toBe('A');
    const g = m.textLayout();
    expect(g.cols).toBe(40);
    expect(g.rows).toBe(25);
    expect(g.cellH).toBe(10);
    m.destroy();
  });
});
