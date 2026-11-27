/**
 * Commodore Plus/4 screen-text OCR.
 *
 * As on the C64 and VIC-20, the text modes hold character codes, so text is
 * read from the video matrix and the glyph each code shows is checked against
 * the character set the TED is fetching through (`$FF13` picks the base and the
 * set). A ROM character reads as itself, its inverse as itself in reverse
 * video, and anything else (graphics, a game's own tiles) is left alone.
 *
 * The two bitmap modes have no character codes, so the hires one is read from
 * the bitmap itself: each 8x8 tile is matched against the ROM's text glyphs and
 * a match reads as that character (in either video). The TED's multicolour
 * bitmap stores four double-width pixels a byte, so its glyphs are half the
 * width and are not read yet.
 *
 * Multicolour text cells (colour bit 3) are read as text: their code still
 * names the glyph, which the chip draws as four double-width pixels.
 *
 * Self-contained: it takes the TED's register values and a reader for the CPU's
 * address space, never the machine.
 */

import type { OcrGridName } from '@/ocr/ocr.ts';
import { cbmGridText, cbmMatchGlyph, cbmRomGlyphs, type C64OcrResult } from '@/ocr/c64.ts';

export interface Plus4OcrInput {
  /** Where the character patterns are (`$FF13`). */
  readonly charAddress: number;
  /** Where the video matrix is (`$FF14` + the chip's `$400`). */
  readonly screenAddress: number;
  /** Where the colour bytes are (`$FF14` without the `$400`). */
  readonly colourAddress: number;
  /** Where the bitmap is (`$FF12` bits 3-5). */
  readonly bitmapAddress: number;
  /** The TED's video mode (`$FF06`/`$FF07` mode bits). */
  readonly mode: number;
  /** `$FF07` bit 7: reverse video. */
  readonly reverse: boolean;
  /** The background colour (`$FF15`), the paper behind the text. */
  readonly background: number;
  /** Colour index (0-127) to an ABGR palette entry. */
  readonly palette: Uint32Array;
  /** A byte of the CPU's address space. */
  read(addr: number): number;
}

const COLS = 40;
const ROWS = 25;
const BITMAP_COLS = 40;
const BITMAP_BYTES_ROW = 320;

export function plus4OcrGrid(input: Plus4OcrInput): C64OcrResult {
  const cells: string[] = new Array(COLS * ROWS).fill(' ');
  const ink: number[] = new Array(COLS * ROWS).fill(0);
  const paper: number[] = new Array(COLS * ROWS).fill(input.background);
  const mask: boolean[] = new Array(COLS * ROWS).fill(false);

  const read = (a: number) => input.read(a & 0xFFFF);
  const rom = cbmRomGlyphs(chargen(input, read));

  // Modes 0 (standard), 1 (multicolour) and 4 (extended) have a matrix; the
  // illegal ones paint nothing. Modes 2 and 3 are bitmaps.
  if (input.mode === 0 || input.mode === 1 || input.mode === 4) {
    const multicolour = input.mode === 1;
    const seen = new Map<number, { ch: string; reversed: boolean }>();

    for (let i = 0; i < COLS * ROWS; i++) {
      const raw = read(input.screenAddress + i) & 0xFF;
      const colour = read(input.colourAddress + i) & 0x7F;
      const code = raw & (input.reverse ? 0x7F : 0xFF);
      // The character patterns are addressed through the CPU's 64K map (they
      // live in a banked ROM), so the glyph's address is not masked.
      const addr = input.charAddress + (code & 0x7F) * 8;
      const { ch, reversed } = cbmMatchGlyph(rom, read, addr, seen);
      if (ch === ' ') continue;
      cells[i] = ch;
      mask[i] = true;
      // A multicolour cell's ink is its colour, drawn four double pixels wide;
      // the others are one colour a pixel.
      const cellInk = multicolour && (colour & 0x08) !== 0 ? colour & 0x77 : colour;
      if (reversed) { ink[i] = input.background; paper[i] = cellInk; }
      else { ink[i] = cellInk; paper[i] = input.background; }
    }
  } else if (input.mode === 2) {
    // Hires bitmap: each cell is eight bytes of eight pixels, which the ROM's
    // font glyphs can be matched against exactly (or inverted).
    const seen = new Map<string, { ch: string; reversed: boolean }>();
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < BITMAP_COLS; col++) {
        let key = '';
        let blank = true;
        let solid = true;
        for (let line = 0; line < 8; line++) {
          const b = read(input.bitmapAddress + (row * 8 + line) * BITMAP_BYTES_ROW + col) & 0xFF;
          if (b !== 0) blank = false;
          if (b !== 0xFF) solid = false;
          key += String.fromCharCode(b);
        }
        if (blank || solid) continue;
        let hit = seen.get(key);
        if (!hit) {
          const direct = rom.get(key);
          const inverse = direct === undefined ? rom.get(invertKey(key)) : undefined;
          hit = direct !== undefined
            ? { ch: direct, reversed: false }
            : inverse !== undefined ? { ch: inverse, reversed: true } : { ch: ' ', reversed: false };
          seen.set(key, hit);
        }
        if (hit.ch === ' ') continue;
        const i = row * COLS + col;
        const colour = read(input.colourAddress + i) & 0x0F;
        cells[i] = hit.ch;
        mask[i] = true;
        if (hit.reversed) { ink[i] = input.background; paper[i] = colour; }
        else { ink[i] = colour; paper[i] = input.background; }
      }
    }
  }

  const { text, html } = cbmGridText(cells, ink, COLS, ROWS, input.palette);
  const grid = `${COLS}x${ROWS}` as OcrGridName;
  return { text, html, mask, paper, grid, cellWidth: 8, cellHeight: 8, cols: COLS, rows: ROWS };
}

/** A cell's bytes as a glyph key, ready for the ROM font's map. */
function invertKey(key: string): string {
  let out = '';
  for (let i = 0; i < key.length; i++) out += String.fromCharCode(~key.charCodeAt(i) & 0xFF);
  return out;
}

/**
 * The character set as a byte array, for the shared glyph matcher. The TED reads
 * the patterns through the CPU's map, so they are gathered here rather than
 * pointed at in place (the set lives in a banked ROM).
 */
function chargen(input: Plus4OcrInput, read: (a: number) => number): Uint8Array {
  const out = new Uint8Array(0x1000);
  for (let i = 0; i < 0x1000; i++) out[i] = read(input.charAddress + i) & 0xFF;
  return out;
}
