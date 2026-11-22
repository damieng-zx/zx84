/**
 * Screen OCR on the Timex hi-res screen: 64-column text (8 pixels a column), and
 * the narrower 85- and 128-column grids.
 *
 * The text is drawn into screen memory the way a program writes it: in mode 6 a
 * 512-pixel row is 64 bytes, and they alternate between screen 0 (0x4000) and
 * screen 1 (0x6000), so even character columns live in one screen and odd ones
 * in the other. The expected text is what was drawn, with a synthetic font whose
 * glyphs are all different (so a misread column or screen can't match by chance).
 */

import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { PALETTES, vramBitmapAddr } from '@/machines/spectrum/ula.ts';

const rowOff = (y: number): number => vramBitmapAddr(y) - 0x4000;
const pal = PALETTES.basic;

/** A 768-byte font (codes 32..127) of distinct pseudo-random glyphs, space blank.
 *  `width` bits of each byte are used, MSB-aligned. */
function makeFont(width: number): Uint8Array {
  const mask = (0xFF << (8 - width)) & 0xFF;
  const font = new Uint8Array(768);
  const seen = new Set<string>();
  for (let c = 33; c < 128; c++) {
    let x = Math.imul(c, 2654435761) >>> 0;
    const glyph: number[] = [];
    for (let p = 0; p < 8; p++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      glyph.push((x >>> 16) & mask);
    }
    glyph[0] |= 1 << (8 - width);                       // the top row never blank
    glyph[7] &= ~(1 << (8 - width)) & 0xFF;
    seen.add(glyph.join());
    font.set(glyph, (c - 32) * 8);
  }
  expect(seen.size, 'every test glyph is distinct').toBe(95);
  return font;
}

/** The machine in Timex hi-res mode 6 with `dec` as port 0xFF, a font in RAM at 0x9000 and CHARS pointing at it. */
function hiresMachine(dec = 0x3E): Spectrum {
  const s = new Spectrum('tc2048', null);
  s.start = async () => {};
  s.loadROM(new Uint8Array(16384));
  s.reset();
  s.cpu.portOutHandler!(0x00FF, dec);
  return s;
}

/** Install `font` at 0x9000 and point CHARS at it (CHARS holds the address 256 below the space glyph). */
function installFont(s: Spectrum, font: Uint8Array, at = 0x9000): void {
  for (let i = 0; i < font.length; i++) s.memory.writeByte(at + i, font[i]);
  s.memory.writeByte(0x5C36, (at - 256) & 0xFF);
  s.memory.writeByte(0x5C37, (at - 256) >> 8);
}

/** Set byte `index` (0-63) of hi-res row `y`: even bytes are in screen 0, odd in screen 1. */
function putByte(s: Spectrum, y: number, index: number, value: number): void {
  const screen = index & 1 ? 0x6000 : 0x4000;
  s.memory.writeByte(screen + rowOff(y) + (index >> 1), value);
}

/** Draw `text` in 8-pixel cells starting at cell (col, row). */
function drawText8(s: Spectrum, font: Uint8Array, text: string, col: number, row: number): void {
  [...text].forEach((ch, i) => {
    const glyph = (ch.charCodeAt(0) - 32) * 8;
    for (let p = 0; p < 8; p++) putByte(s, row * 8 + p, col + i, font[glyph + p]);
  });
}

/** Draw `text` in `width`-pixel cells: the glyph's top `width` bits, placed bit by bit across the row. */
function drawTextN(s: Spectrum, font: Uint8Array, width: number, text: string, col: number, row: number): void {
  const bytes = new Uint8Array(64 * 192);
  [...text].forEach((ch, i) => {
    const glyph = (ch.charCodeAt(0) - 32) * 8;
    for (let p = 0; p < 8; p++) {
      for (let bit = 0; bit < width; bit++) {
        if (!(font[glyph + p] & (0x80 >> bit))) continue;
        const x = (col + i) * width + bit;
        bytes[(row * 8 + p) * 64 + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  });
  for (let y = row * 8; y < row * 8 + 8; y++) {
    for (let b = 0; b < 64; b++) if (bytes[y * 64 + b]) putByte(s, y, b, bytes[y * 64 + b]);
  }
}

/** The OCR text of the rows, right-trimmed, for the hi-res grid. */
const rows = (s: Spectrum): string[] => s.ocrScreenForMcp().split('\n').slice(1).map(r => r.trimEnd());

/** ABGR pixel at picture position (x, y) of the buffer (x in buffer pixels). */
function pixel(s: Spectrum, x: number, y: number): number {
  const u = s.ula;
  return new Uint32Array(u.pixels.buffer, u.pixels.byteOffset, u.pixels.length >> 2)[(y + u.borderTop) * u.screenWidth + u.borderLeft * u.xScale + x];
}

describe('OCR of Timex hi-res text', () => {
  it('reads 64 columns of 8x8 text, across both screens, as the 64x24h grid', () => {
    const s = hiresMachine();
    const font = makeFont(8);
    installFont(s, font);
    drawText8(s, font, 'THE QUICK BROWN FOX', 0, 0);
    drawText8(s, font, 'JUMPS OVER 64 COLUMNS OF TEXT WHICH RUN RIGHT ACROSS THE SCREEN', 0, 3);
    expect(s.ocrScreenForMcp().startsWith('[64x24h]\n')).toBe(true);
    const text = rows(s);
    expect(text[0]).toBe('THE QUICK BROWN FOX');
    expect(text[3]).toBe('JUMPS OVER 64 COLUMNS OF TEXT WHICH RUN RIGHT ACROSS THE SCREEN');
    expect(text[1]).toBe('');
  });

  it('reads the last column, which is in screen 1', () => {
    const s = hiresMachine();
    const font = makeFont(8);
    installFont(s, font);
    drawText8(s, font, 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXY', 0, 5);
    expect(rows(s)[5].length).toBe(64);
    expect(rows(s)[5].endsWith('XY')).toBe(true);
  });

  it('reports the grid, the cell size and the hi-res ink in the styled result', () => {
    const s = hiresMachine(0x36);                       // mode 6, colour 6: yellow ink on blue
    const font = makeFont(8);
    installFont(s, font);
    drawText8(s, font, 'HELLO WORLD', 2, 1);
    const r = s.ocrScreenStyled();
    expect(r.grid).toBe('64x24h');
    expect([r.cols, r.rows, r.cellWidth, r.cellHeight]).toEqual([64, 24, 8, 8]);
    expect(r.text.split('\n')[1].trimEnd()).toBe('  HELLO WORLD');
    expect(r.html).toContain('color:#ffff00');          // bright yellow, the ink, with no attribute file to read
    expect(r.html).not.toContain('color:#cdcd');        // not a normal-intensity attribute colour
  });

  it('follows the hi-res colour: white ink for pair 7', () => {
    const s = hiresMachine(0x3E);
    const font = makeFont(8);
    installFont(s, font);
    drawText8(s, font, 'WHITE INK TEXT', 0, 0);       // the font is only trusted once 10 cells match
    expect(s.ocrScreenStyled().html).toContain('color:#ffffff');
  });

  it('reads 85 columns of 6-pixel text with a font it finds in memory', () => {
    const s = hiresMachine();
    const font = makeFont(6);
    installFont(s, font, 0x9000);
    drawTextN(s, font, 6, 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG', 0, 0);
    drawTextN(s, font, 6, 'SIX PIXEL CHARACTERS FILL EIGHTY FIVE COLUMNS ACROSS A HI RES LINE OF TEXT', 0, 2);
    expect(s.ocrScreenForMcp().startsWith('[85x24h]\n')).toBe(true);
    const text = rows(s);
    expect(text[0]).toBe('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG');
    expect(text[2]).toBe('SIX PIXEL CHARACTERS FILL EIGHTY FIVE COLUMNS ACROSS A HI RES LINE OF TEXT');
  });

  it('leaves the standard screen on the standard grids, reading the usual layout', () => {
    const s = new Spectrum('tc2048', null);
    s.start = async () => {};
    s.loadROM(new Uint8Array(16384));
    s.reset();
    const font = makeFont(8);
    installFont(s, font);
    [...'STANDARD MODE TEXT'].forEach((ch, i) => {
      for (let p = 0; p < 8; p++) s.memory.writeByte(0x4000 + rowOff(p) + i, font[(ch.charCodeAt(0) - 32) * 8 + p]);
    });
    expect(s.ocrScreenForMcp().startsWith('[32x24]\n')).toBe(true);
    expect(rows(s)[0]).toBe('STANDARD MODE TEXT');
  });

  it('uses the grid that suits the picture on show when asked for the other kind', () => {
    const s = hiresMachine();
    const font = makeFont(8);
    installFont(s, font);
    drawText8(s, font, 'ASKED FOR THE WRONG GRID', 0, 0);
    expect(s.ocrScreen(undefined, '32x24').split('\n')[0].trimEnd()).toBe('ASKED FOR THE WRONG GRID');
    expect(s.ocrScreenForMcp('51x24').startsWith('[64x24h]\n')).toBe(true);
  });
});

describe('the TEXT overlay on a hi-res screen', () => {
  it('blanks the recognised cells in the doubled buffer, to the hi-res paper, and no further', () => {
    const s = hiresMachine(0x3E);                       // white on black, both bright
    const font = makeFont(8);
    installFont(s, font);
    drawText8(s, font, 'ABCDEFGHIJKL', 0, 0);
    s.ula.renderFrame(s.memory.screenBank, 0x4000);     // the hi-res frame as drawn
    const ink = pal[7 + 8], paper = pal[0 + 8];
    const cell = (c: number): number[] => {
      const out: number[] = [];
      for (let y = 0; y < 8; y++) for (let x = c * 8; x < c * 8 + 8; x++) out.push(pixel(s, x, y));
      return out;
    };
    expect(cell(0)).toContain(ink);                     // 'A' is drawn in ink
    expect(cell(1)).toContain(ink);
    s.services.probe.transcribe!.run();
    expect(cell(0).every(p => p === paper)).toBe(true);   // matched cell blanked to paper, 8 buffer pixels wide
    expect(cell(1).every(p => p === paper)).toBe(true);
    expect(pixel(s, 12 * 8, 0)).toBe(paper);            // past the text: blank paper already
    expect(cell(11).every(p => p === paper)).toBe(true);
  });
});
