/**
 * SAM screen OCR.
 *
 * The SAM has no character grid in memory, so this matches 8x8 cells against
 * SAM BASIC's font. Three layout facts were measured from a real LIST and are
 * pinned here, because each silently ruins the output if wrong:
 *
 *   - columns are 8 pixels apart from x = 0;
 *   - rows are 9 pixels apart (8-pixel glyph + 1 leading), NOT 8;
 *   - everything is read from display memory, never the rendered frame buffer,
 *     because the ROM's wallpaper rewrites a palette entry mid-scanline.
 *
 * Screens here are synthesised rather than booted, so the tests are offline
 * and the expected text is stated up front rather than read back from the ROM.
 */

import { describe, expect, it } from 'vitest';
import { samFontMap, samScreenText } from '@/ocr/sam.ts';

const CELL_H = 8;
const ROW_PITCH = 9;

/** A toy font: a distinct, recognisable bitmap per printable ASCII code. */
function toyFont(): Uint8Array {
  const font = new Uint8Array(128 * CELL_H);
  for (let c = 33; c < 127; c++) {
    for (let r = 0; r < CELL_H; r++) {
      // Deterministic and distinct per character, and never all-zero.
      font[c * CELL_H + r] = ((c * 7 + r * 31) & 0xFE) | 1;
    }
  }
  // Space (32) stays blank, as a real font's does.
  return font;
}

/** A mode-4 display buffer plus a writer that stamps text through the font. */
function screen(font: Uint8Array) {
  const mem = new Uint8Array(0x8000);
  const vram = (off: number) => mem[off];

  const putPixel = (x: number, y: number, index: number) => {
    const off = (y << 7) + (x >> 1);
    mem[off] = (x & 1)
      ? ((mem[off] & 0xF0) | (index & 0x0F))
      : ((mem[off] & 0x0F) | ((index & 0x0F) << 4));
  };

  /** Draw `text` at character column `col`, text row `row` (9-pixel pitch). */
  const write = (col: number, row: number, text: string, ink = 15) => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      for (let r = 0; r < CELL_H; r++) {
        const bits = font[code * CELL_H + r];
        for (let b = 0; b < 8; b++) {
          if (bits & (0x80 >> b)) putPixel((col + i) * 8 + b, row * ROW_PITCH + r, ink);
        }
      }
    }
  };

  return { vram, write, mem };
}

/** Stamp a character INVERSE: the cell filled with ink, the glyph punched
 *  out of it in paper — how SAM BASIC draws the current-line marker. */
function writeInverse(mem: Uint8Array, font: Uint8Array, col: number, row: number, ch: string, ink = 15) {
  const code = ch.charCodeAt(0);
  for (let r = 0; r < CELL_H; r++) {
    const bits = font[code * CELL_H + r];
    for (let b = 0; b < 8; b++) {
      const on = (bits & (0x80 >> b)) === 0;      // inverted
      const x = col * 8 + b, y = row * ROW_PITCH + r;
      const off = (y << 7) + (x >> 1);
      const v = on ? ink : 0;
      mem[off] = (x & 1) ? ((mem[off] & 0xF0) | v) : ((mem[off] & 0x0F) | (v << 4));
    }
  }
}

describe('SAM OCR inverse video', () => {
  /**
   * "Ink" here means "not the dominant colour", so an inverse cell arrives as
   * the COMPLEMENT of its glyph and matches nothing in the font. SAM BASIC
   * marks the current line of a listing with an inverse `>` (LNCUR), so
   * without this the editor's own cursor transcribed as `?`.
   */
  it('reads an inverse character as itself', () => {
    const font = toyFont();
    const s = screen(font);
    s.write(0, 0, '10');
    writeInverse(s.mem, font, 2, 0, '>');
    s.write(3, 0, 'PRINT');
    expect(samScreenText(s.vram, 4, font)!.lines[0]).toBe('10>PRINT');
  });

  /**
   * A cell that inverts to BLANK is a solid block of graphics, not inverse
   * text. Matching it as an inverse space would mistranscribe it AND let the
   * TEXT overlay punch a hole in the picture.
   */
  it('leaves a solid block alone rather than calling it an inverse space', () => {
    const font = toyFont();
    const s = screen(font);
    for (let r = 0; r < CELL_H; r++) {
      for (let b = 0; b < 8; b++) {
        const x = b, y = r;
        const off = (y << 7) + (x >> 1);
        s.mem[off] = (x & 1) ? ((s.mem[off] & 0xF0) | 15) : ((s.mem[off] & 0x0F) | 0xF0);
      }
    }
    expect(samScreenText(s.vram, 4, font)!.lines[0]).toBe('?');
  });
});

describe('samFontMap', () => {
  it('rejects a table whose space glyph is not blank', () => {
    const font = toyFont();
    font[32 * CELL_H] = 0xFF;
    expect(samFontMap(font)).toBeNull();
  });

  it('rejects a table with too few distinct shapes', () => {
    // Guards against reading the wrong address and emitting confident nonsense.
    const font = new Uint8Array(128 * CELL_H);
    for (let c = 33; c < 40; c++) font.fill(c, c * CELL_H, c * CELL_H + CELL_H);
    expect(samFontMap(font)).toBeNull();
  });

  it('accepts a plausible table', () => {
    expect(samFontMap(toyFont())).not.toBeNull();
  });
});

describe('SAM OCR', () => {
  it('reads a line of text back', () => {
    const font = toyFont();
    const s = screen(font);
    s.write(3, 0, '10 REM HELLO');

    const r = samScreenText(s.vram, 4, font)!;
    expect(r).not.toBeNull();
    expect(r.lines).toEqual(['   10 REM HELLO']);
  });

  it('reads several rows at the 9-pixel pitch', () => {
    // The load-bearing fact: an 8-pixel row grid decodes row 0 and then drifts
    // into garbage, which is exactly the bug this pins.
    const font = toyFont();
    const s = screen(font);
    s.write(0, 0, 'FIRST');
    s.write(0, 1, 'SECOND');
    s.write(0, 2, 'THIRD');

    const r = samScreenText(s.vram, 4, font)!;
    expect(r.lines).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });

  it('keeps leading spaces and trims trailing ones', () => {
    const font = toyFont();
    const s = screen(font);
    s.write(5, 0, 'X');
    const r = samScreenText(s.vram, 4, font)!;
    expect(r.lines).toEqual(['     X']);
  });

  it('reads a row pinned to the bottom of the screen', () => {
    // The status line does not sit on the 9-pixel grid, so rows are found by
    // segmenting inked scanlines rather than assuming a fixed grid.
    const font = toyFont();
    const s = screen(font);
    const mem = s.mem;
    // Stamp "OK" at y = 183, which is 192 - 9 and not a multiple of 9.
    for (let i = 0; i < 2; i++) {
      const code = 'OK'.charCodeAt(i);
      for (let r = 0; r < CELL_H; r++) {
        const bits = font[code * CELL_H + r];
        for (let b = 0; b < 8; b++) {
          if (!(bits & (0x80 >> b))) continue;
          const x = i * 8 + b, y = 183 + r;
          const off = (y << 7) + (x >> 1);
          mem[off] = (x & 1) ? ((mem[off] & 0xF0) | 15) : ((mem[off] & 0x0F) | 0xF0);
        }
      }
    }
    const r = samScreenText(s.vram, 4, font)!;
    expect(r.lines).toEqual(['OK']);
  });

  it('separates two rows whose bands merge', () => {
    const font = toyFont();
    const s = screen(font);
    // Fill every scanline of both rows so the bands touch with no gap.
    for (let row = 0; row < 2; row++) s.write(0, row, 'AB');
    for (let y = 0; y < 18; y++) {
      const off = (y << 7) + 60;
      s.mem[off] = 0xFF;                     // a continuous vertical rule
    }
    const r = samScreenText(s.vram, 4, font)!;
    expect(r.lines.length).toBe(2);
    expect(r.lines[0].startsWith('AB')).toBe(true);
    expect(r.lines[1].startsWith('AB')).toBe(true);
  });

  it('marks an unrecognised glyph rather than guessing', () => {
    const font = toyFont();
    const s = screen(font);
    s.write(0, 0, 'AB');
    // Scribble a shape that is in no font entry.
    for (let r = 0; r < CELL_H; r++) {
      const off = (r << 7) + 8;
      s.mem[off] = 0xF0;
      s.mem[off + 1] = 0x0F;
    }
    const r = samScreenText(s.vram, 4, font)!;
    expect(r.lines[0]).toContain('?');
  });

  it('returns nothing for a blank screen', () => {
    const font = toyFont();
    const s = screen(font);
    const r = samScreenText(s.vram, 4, font)!;
    expect(r.lines).toEqual([]);
    expect(r.text).toBe('');
  });

  it('refuses when the font table is not usable', () => {
    const s = screen(toyFont());
    expect(samScreenText(s.vram, 4, new Uint8Array(128 * CELL_H))).toBeNull();
  });

  it('reads mode 3 at 64 columns', () => {
    // Mode 3 is 512 pixels wide, so twice as many character cells fit.
    const font = toyFont();
    const mem = new Uint8Array(0x8000);
    const vram = (off: number) => mem[off];
    const put = (x: number, y: number, v: number) => {
      const off = (y << 7) + (x >> 2);
      const shift = 6 - 2 * (x & 3);
      mem[off] = (mem[off] & ~(3 << shift)) | ((v & 3) << shift);
    };
    const text = 'MODE3';
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      for (let r = 0; r < CELL_H; r++) {
        const bits = font[code * CELL_H + r];
        for (let b = 0; b < 8; b++) if (bits & (0x80 >> b)) put(i * 8 + b, r, 3);
      }
    }
    const r = samScreenText(vram, 3, font)!;
    expect(r.lines).toEqual(['MODE3']);
  });
});
