/**
 * Commodore VIC-20 screen-text OCR.
 *
 * As on the C64, the screen holds character codes, so text is read from it
 * and the glyph each code shows is checked against the ROM font (the
 * VIC-20's character ROM has the C64's layout): a ROM character reads as
 * itself, its inverse as itself in reverse video, anything else (graphics,
 * a game's own tiles) is left alone. The text area is the VIC's own: its
 * column and row counts and its screen and character addresses. A
 * multicolour cell (colour bit 3) is a picture, and 8×16 characters are not
 * read.
 *
 * Self-contained: it takes the VIC's registers, the character ROM and two
 * readers, never the machine.
 */

import type { OcrGridName } from '@/ocr/ocr.ts';
import { cbmGridText, cbmMatchGlyph, cbmRomGlyphs, type C64OcrResult } from '@/ocr/c64.ts';

export interface Vic20OcrInput {
  /** The VIC's registers ($9000-$900F). */
  readonly regs: Uint8Array;
  /** The 4K character ROM. */
  readonly chargen: Uint8Array;
  /** Colour index to an ABGR palette entry. */
  readonly palette: Uint32Array;
  /** A byte of the VIC's 16K view of memory. */
  vicRead(addr14: number): number;
  /** The colour nybble beside the screen byte at VIC address `addr14`. */
  colour(addr14: number): number;
}

export function vic20OcrGrid(input: Vic20OcrInput): C64OcrResult {
  const { regs } = input;
  const cols = regs[2] & 0x7F;
  const rows = (regs[3] >> 1) & 0x3F;
  const n = cols * rows;
  const bg = regs[15] >> 4;
  const cells: string[] = new Array(n).fill(' ');
  const ink: number[] = new Array(n).fill(0);
  const paper: number[] = new Array(n).fill(bg);
  const mask: boolean[] = new Array(n).fill(false);

  if ((regs[3] & 1) === 0) {
    const screen = ((regs[5] & 0xF0) << 6) | ((regs[2] & 0x80) << 2);
    const charBase = (regs[5] & 0x0F) << 10;
    const reverseMode = (regs[15] & 8) === 0;
    const rom = cbmRomGlyphs(input.chargen);
    const seen = new Map<number, { ch: string; reversed: boolean }>();
    for (let i = 0; i < n; i++) {
      const cell = (screen + i) & 0x3FFF;
      const colour = input.colour(cell) & 0x0F;
      if ((colour & 8) !== 0) continue;
      const code = input.vicRead(cell) & 0xFF;
      const { ch, reversed } = cbmMatchGlyph(rom, a => input.vicRead(a & 0x3FFF), (charBase + code * 8) & 0x3FFF, seen);
      if (ch === ' ') continue;
      // Reverse mode swaps the character and background colours on screen.
      const swapped = reversed !== reverseMode;
      cells[i] = ch;
      mask[i] = true;
      ink[i] = swapped ? bg : colour;
      paper[i] = swapped ? colour : bg;
    }
  }

  const { text, html } = cbmGridText(cells, ink, cols, rows, input.palette);
  const grid = `${cols}x${rows}` as OcrGridName;
  return { text, html, mask, paper, grid, cellWidth: 8, cellHeight: 8, cols, rows };
}
