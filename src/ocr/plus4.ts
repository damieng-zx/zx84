/**
 * Commodore Plus/4 screen-text OCR.
 *
 * As on the C64 and VIC-20, the screen holds character codes, so text is read
 * from the video matrix and the glyph each code shows is checked against the
 * character set the TED is fetching through (`$FF13` picks the base and the
 * set). A ROM character reads as itself, its inverse as itself in reverse
 * video, and anything else (graphics, a game's own tiles) is left alone.
 *
 * Only the character modes are read: the two bitmap modes have no text, and a
 * multicolour cell (colour bit 3) is a picture.
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
  /** The TED's video mode (`$FF06`/`$FF07` mode bits). */
  readonly mode: number;
  /** `$FF07` bit 7: reverse video. */
  readonly reverse: boolean;
  /** Colour index (0-127) to an ABGR palette entry. */
  readonly palette: Uint32Array;
  /** A byte of the CPU's address space. */
  read(addr: number): number;
}

const COLS = 40;
const ROWS = 25;

export function plus4OcrGrid(input: Plus4OcrInput): C64OcrResult {
  const cells: string[] = new Array(COLS * ROWS).fill(' ');
  const ink: number[] = new Array(COLS * ROWS).fill(0);
  const paper: number[] = new Array(COLS * ROWS).fill(0);
  const mask: boolean[] = new Array(COLS * ROWS).fill(false);

  const read = (a: number) => input.read(a & 0xFFFF);
  // The colour behind the text, which the TED fetches at the top of the matrix.
  const background = read(input.colourAddress + 40 * 24 + 39) & 0x7F;
  paper.fill(background);

  // Modes 0 (standard), 1 (multicolour) and 4 (extended) have a matrix; the
  // illegal ones paint nothing.
  if (input.mode === 0 || input.mode === 1 || input.mode === 4) {
    const multicolour = input.mode === 1;
    const rom = cbmRomGlyphs(chargen(input, read));
    const seen = new Map<number, { ch: string; reversed: boolean }>();

    for (let i = 0; i < COLS * ROWS; i++) {
      const raw = read(input.screenAddress + i) & 0xFF;
      const colour = read(input.colourAddress + i) & 0x7F;
      if (multicolour && (colour & 0x08) !== 0) continue;
      const code = raw & (input.reverse ? 0x7F : 0xFF);
      // The character patterns are addressed through the CPU's 64K map (they
      // live in a banked ROM), so the glyph's address is not masked.
      const addr = input.charAddress + (code & 0x7F) * 8;
      const { ch, reversed } = cbmMatchGlyph(rom, read, addr, seen);
      if (ch === ' ') continue;
      cells[i] = ch;
      mask[i] = true;
      if (reversed) { ink[i] = background; paper[i] = colour; }
      else { ink[i] = colour; paper[i] = background; }
    }
  }

  const { text, html } = cbmGridText(cells, ink, COLS, ROWS, input.palette);
  const grid = `${COLS}x${ROWS}` as OcrGridName;
  return { text, html, mask, paper, grid, cellWidth: 8, cellHeight: 8, cols: COLS, rows: ROWS };
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
