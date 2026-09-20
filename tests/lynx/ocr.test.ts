/**
 * Camputers Lynx screen OCR.
 *
 * The Lynx has no character memory — text is plotted into three one-bit colour
 * planes — so it is recovered by cutting the picture into the ROM font's 6x10
 * cells and matching each one. These tests drive the matcher with a synthetic
 * font and pixel reader, so they say nothing about where the font lives, only
 * about the recognition and the grid.
 */

import { describe, expect, it } from 'vitest';
import {
  LYNX_CELL_HEIGHT, LYNX_CELL_WIDTH, LYNX_FONT_BYTES, LYNX_FONT_CHARS,
  LYNX_FONT_FIRST_CHAR, LYNX_GEOMETRY_40, LYNX_GEOMETRY_80,
  looksLikeLynxFont, lynxOcrResult, lynxScreenCells, lynxScreenText,
  type LynxOcrGeometry,
} from '@/ocr/lynx.ts';
import { LYNX_PALETTE } from '@/machines/lynx/constants.ts';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';

/**
 * A font that spells each glyph's own index across its first two rows, so no
 * two of the table's 96 entries collide. Blank at 0x20 and never setting a bit
 * above the sixth, which is everything the matcher and its check require.
 * Ten rows of six bits hold far more than 96 patterns; two are enough.
 */
function testFont(): Uint8Array {
  const font = new Uint8Array(LYNX_FONT_BYTES);
  for (let i = 1; i < LYNX_FONT_CHARS; i++) {
    font[i * LYNX_CELL_HEIGHT] = i & 0x3f;
    font[i * LYNX_CELL_HEIGHT + 1] = (i >> 6) & 0x3f;
  }
  return font;
}

/**
 * A pixel reader that paints `lines` from the grid origin in `ink` on `paper`,
 * drawing each character with `font`'s glyph. Anything off the text is paper.
 */
function screenOf(
  lines: string[], font: Uint8Array, geo: LynxOcrGeometry, ink = 7, paper = 0,
) {
  return (x: number, y: number): number => {
    const col = Math.floor((x - geo.originX) / LYNX_CELL_WIDTH);
    const row = Math.floor((y - geo.originY) / LYNX_CELL_HEIGHT);
    const text = lines[row];
    if (text === undefined || col < 0 || col >= text.length) return paper;
    const code = text.charCodeAt(col);
    const glyph = font[(code - LYNX_FONT_FIRST_CHAR) * LYNX_CELL_HEIGHT
      + ((y - geo.originY) % LYNX_CELL_HEIGHT)];
    const bit = (x - geo.originX) % LYNX_CELL_WIDTH;
    return (glyph & (1 << (LYNX_CELL_WIDTH - 1 - bit))) !== 0 ? ink : paper;
  };
}

describe('looksLikeLynxFont', () => {
  it('accepts a plausible character set', () => {
    expect(looksLikeLynxFont(testFont())).toBe(true);
  });

  it('rejects a buffer too short to be the table', () => {
    expect(looksLikeLynxFont(new Uint8Array(LYNX_FONT_BYTES - 1))).toBe(false);
  });

  it('rejects one whose space is not blank', () => {
    const font = testFont();
    font[0] = 0x01;
    expect(looksLikeLynxFont(font)).toBe(false);
  });

  it('rejects a table setting a bit above the sixth', () => {
    // Only the low six bits are pixels, so a 0x40 says this is not a font —
    // which is how code or RAM at the same address gets caught.
    const font = testFont();
    font[0x41 * LYNX_CELL_HEIGHT] = 0x40;
    expect(looksLikeLynxFont(font)).toBe(false);
  });

  it('rejects mostly-empty RAM wearing a font address', () => {
    const font = new Uint8Array(LYNX_FONT_BYTES);
    font.fill(0x1f, 0x21 * LYNX_CELL_HEIGHT, 0x25 * LYNX_CELL_HEIGHT);
    expect(looksLikeLynxFont(font)).toBe(false);
  });
});

describe('lynxScreenText', () => {
  const font = testFont();

  it('reads text back off the bitmap', () => {
    const read = screenOf(['Ready', '', '>PRINT 1'], font, LYNX_GEOMETRY_40);
    expect(lynxScreenText(read, font, LYNX_GEOMETRY_40)).toBe('Ready\n\n>PRINT 1');
  });

  it('gives the 128K its 80 columns', () => {
    const wide = 'X'.repeat(80);
    const read = screenOf([wide], font, LYNX_GEOMETRY_80);
    expect(lynxScreenText(read, font, LYNX_GEOMETRY_80)).toBe(wide);
    // The 40-column grid would only reach half of it, and at the wrong pitch.
    expect(lynxScreenText(read, font, LYNX_GEOMETRY_40)!.length).toBeLessThan(80);
  });

  it('says nothing when the font is not a font', () => {
    const read = screenOf(['Ready'], font, LYNX_GEOMETRY_40);
    expect(lynxScreenText(read, new Uint8Array(LYNX_FONT_BYTES), LYNX_GEOMETRY_40)).toBeNull();
  });

  it('keeps leading blank lines but trims trailing ones', () => {
    const read = screenOf(['', '', 'here'], font, LYNX_GEOMETRY_40);
    expect(lynxScreenText(read, font, LYNX_GEOMETRY_40)).toBe('\n\nhere');
  });
});

describe('lynxScreenCells', () => {
  const font = testFont();

  it('marks an unrecognised cell as ? and leaves it unmasked', () => {
    // One inked row halfway down the first cell. The test font only ever draws
    // on a glyph's first two rows, so nothing matches. It has to be a *partial*
    // fill: a uniformly inked cell is the same picture as a blank one in
    // another colour, and reads as a space by design.
    const read = (x: number, y: number): number =>
      (x >= LYNX_GEOMETRY_40.originX && x < LYNX_GEOMETRY_40.originX + LYNX_CELL_WIDTH
        && y === LYNX_GEOMETRY_40.originY + 5) ? 7 : 0;
    const cells = lynxScreenCells(read, font, LYNX_GEOMETRY_40)!;
    expect(cells.chars[0]).toBe('?');
    expect(cells.mask[0]).toBe(false);
    // A blank cell is a space, and the overlay may blank it.
    expect(cells.chars[1]).toBe(' ');
    expect(cells.mask[1]).toBe(true);
  });

  it('reads inverse video, because the cell picks its own background', () => {
    // Ink and paper swapped: the majority colour is the background either way,
    // so the same glyph table still matches.
    const read = screenOf(['Hi'], font, LYNX_GEOMETRY_40, 0, 7);
    const cells = lynxScreenCells(read, font, LYNX_GEOMETRY_40)!;
    expect(cells.chars.slice(0, 2).join('')).toBe('Hi');
    expect(cells.paper[0]).toBe(7);
    expect(cells.ink[0]).toBe(0);
  });

  it('records the colour each character was drawn in', () => {
    const read = screenOf(['A'], font, LYNX_GEOMETRY_40, 2);
    const cells = lynxScreenCells(read, font, LYNX_GEOMETRY_40)!;
    expect(cells.ink[0]).toBe(2);
    expect(cells.paper[0]).toBe(0);
  });
});

describe('lynxOcrResult', () => {
  const font = testFont();

  it('emits full-width rows and the grid the cells came from', () => {
    const read = screenOf(['Hi'], font, LYNX_GEOMETRY_40);
    const cells = lynxScreenCells(read, font, LYNX_GEOMETRY_40)!;
    const result = lynxOcrResult(cells, LYNX_PALETTE, '40x24');
    expect(result.grid).toBe('40x24');
    expect(result.cols).toBe(40);
    expect(result.rows).toBe(24);
    expect(result.cellWidth).toBe(LYNX_CELL_WIDTH);
    expect(result.cellHeight).toBe(LYNX_CELL_HEIGHT);
    // Rows keep their full width so the overlay lines up with the picture.
    expect(result.text.split('\n')[0]).toHaveLength(40);
    expect(result.text.split('\n')).toHaveLength(24);
  });

  it('converts the ABGR palette to CSS RGB', () => {
    // Pen 1 is red: 0xFF0000FF as ABGR is #ff0000 in CSS, not #0000ff.
    const read = screenOf(['A'], font, LYNX_GEOMETRY_40, 1);
    const cells = lynxScreenCells(read, font, LYNX_GEOMETRY_40)!;
    const result = lynxOcrResult(cells, LYNX_PALETTE, '40x24');
    expect(result.html).toContain('color:#ff0000');
  });

  it('escapes markup characters it transcribes', () => {
    const read = screenOf(['<&>'], font, LYNX_GEOMETRY_40);
    const cells = lynxScreenCells(read, font, LYNX_GEOMETRY_40)!;
    const result = lynxOcrResult(cells, LYNX_PALETTE, '40x24');
    expect(result.html).toContain('&lt;&amp;&gt;');
    expect(result.text.startsWith('<&>')).toBe(true);
  });
});

describe('LynxMachine screen OCR', () => {
  it('says so rather than transcribing nonsense with no character set', () => {
    // A machine with no ROM installed has 0xFF where the font should be, which
    // is not a font — the MCP tool should say that, not print 960 characters
    // of rubbish.
    const m = new LynxMachine('lynx48', null);
    m.loadROM(new Uint8Array(0));
    expect(m.ocrScreenForMcp()).toContain('OCR unavailable');
    expect(m.ocrScreenStyled()).toBeNull();
  });

  it('tells the overlay where the grid sits, since it does not fill the screen', () => {
    // 40 columns of 6px is 240 of the 48K's 256 active pixels, inset by 6 —
    // an overlay stretched across the whole active area would drift out of
    // step with the text underneath it.
    const m = new LynxMachine('lynx48', null);
    expect(m.ocrFieldBox()).toEqual({ x: 32 + 6, y: 24 + 6, width: 240, height: 240 });

    // The 128K's pixels are half as wide, so 80 columns cover twice the span
    // from twice the inset.
    const wide = new LynxMachine('lynx128', null);
    expect(wide.ocrFieldBox()).toEqual({ x: 64 + 12, y: 24 + 6, width: 480, height: 240 });
  });

  it('stamps the grid its model actually uses', () => {
    // The font table is the machine's own ROM area, so writing a plausible one
    // there is enough to get a transcription out of a blank screen.
    for (const [model, grid] of [['lynx48', '40x24'], ['lynx128', '80x24']] as const) {
      const m = new LynxMachine(model, null);
      m.loadROM(new Uint8Array(0));
      const font = testFont();
      const at = model === 'lynx128' ? 0x0101 : 0x01d5;
      m.memory.ram.set(font, at);
      expect(m.ocrScreenForMcp().startsWith(`[${grid}]`)).toBe(true);
      expect(m.ocrScreenStyled()!.grid).toBe(grid);
    }
  });
});
