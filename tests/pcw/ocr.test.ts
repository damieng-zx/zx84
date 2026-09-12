/**
 * PCW screen OCR.
 *
 * The PCW has no character memory — the screen is a 720x256 bitmap — so text is
 * recovered by cutting it into 8x8 cells and matching each against the CP/M
 * character set in RAM. These tests drive the matcher directly with a synthetic
 * font and cell reader, so they say nothing about where the font lives, only
 * about the recognition.
 */

import { describe, expect, it } from 'vitest';
import {
  PCW_FONT_BYTES, PCW_OCR_COLS, PCW_OCR_ROWS,
  looksLikeFont, pcwScreenCells, pcwScreenText,
} from '@/ocr/pcw.ts';
import { pcwEntry } from '@/machines/pcw/descriptor.ts';

/** A font whose glyph for code `c` is eight bytes of `c` — distinct per code,
 *  blank at 0x20, which is all the matcher and its sanity check need. */
function testFont(): Uint8Array {
  const font = new Uint8Array(PCW_FONT_BYTES);
  for (let c = 0; c < 256; c++) {
    if (c === 0x20) continue;
    font.fill(c, c * 8, c * 8 + 8);
  }
  return font;
}

/** A cell reader that paints `lines` at the top-left, using `font`'s glyphs. */
function screenOf(lines: string[], font: Uint8Array) {
  return (col: number, row: number, line: number): number => {
    const text = lines[row];
    if (text === undefined || col >= text.length) return 0;
    const code = text.charCodeAt(col);
    return font[code * 8 + line];
  };
}

describe('looksLikeFont', () => {
  it('accepts a plausible character set', () => {
    expect(looksLikeFont(testFont())).toBe(true);
  });

  it('rejects a buffer that is too short', () => {
    expect(looksLikeFont(new Uint8Array(64))).toBe(false);
  });

  it('rejects one whose space is not blank', () => {
    const font = testFont();
    font[0x20 * 8] = 0xFF;
    expect(looksLikeFont(font)).toBe(false);
  });

  it('rejects mostly-empty RAM wearing a font address', () => {
    const font = new Uint8Array(PCW_FONT_BYTES);
    font.fill(0xFF, 0x41 * 8, 0x45 * 8);   // only a handful of glyphs drawn
    expect(looksLikeFont(font)).toBe(false);
  });
});

describe('pcwScreenCells', () => {
  const font = testFont();

  it('returns the full grid, whatever is on screen', () => {
    const cells = pcwScreenCells(screenOf(['HI'], font), font)!;
    expect(cells.cols).toBe(PCW_OCR_COLS);
    expect(cells.rows).toBe(PCW_OCR_ROWS);
    expect(cells.chars).toHaveLength(PCW_OCR_COLS * PCW_OCR_ROWS);
    expect(cells.mask).toHaveLength(PCW_OCR_COLS * PCW_OCR_ROWS);
  });

  it('recognises characters at their cell positions', () => {
    const cells = pcwScreenCells(screenOf(['A>'], font), font)!;
    expect(cells.chars[0]).toBe('A');
    expect(cells.chars[1]).toBe('>');
    expect(cells.chars[2]).toBe(' ');
  });

  it('marks blank and matched cells for blanking, but not unmatched ones', () => {
    // A cell of ink matching no glyph — the cursor block is the real case.
    const read = (col: number, row: number, line: number): number =>
      (col === 0 && row === 0) ? 0xFF : screenOf(['  X'], font)(col, row, line);
    const cells = pcwScreenCells(read, font)!;
    expect(cells.chars[0]).toBe('?');
    expect(cells.mask[0]).toBe(false);       // stays as picture
    expect(cells.mask[1]).toBe(true);        // blank
    expect(cells.chars[2]).toBe('X');
    expect(cells.mask[2]).toBe(true);        // matched
  });

  it('refuses to transcribe when the font is not a font', () => {
    expect(pcwScreenCells(screenOf(['HI'], font), new Uint8Array(PCW_FONT_BYTES))).toBeNull();
  });
});

describe('pcwScreenText', () => {
  const font = testFont();

  it('joins the rows, trimming trailing space and trailing blank lines', () => {
    const text = pcwScreenText(screenOf(['CP/M Plus', '', 'A>'], font), font);
    expect(text).toBe('CP/M Plus\n\nA>');
  });

  it('keeps leading blank lines, which are screen position', () => {
    const text = pcwScreenText(screenOf(['', '', 'A>'], font), font);
    expect(text).toBe('\n\nA>');
  });

  it('returns null when there is no usable character set', () => {
    expect(pcwScreenText(screenOf(['HI'], font), new Uint8Array(PCW_FONT_BYTES))).toBeNull();
  });
});

describe('PCW TEXT overlay capability', () => {
  it('offers the TEXT status LED, which is what toggles the overlay', () => {
    for (const model of pcwEntry.models) {
      expect(pcwEntry.descriptor(model).ui.statusLeds).toContain('text');
    }
  });
});
