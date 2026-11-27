/**
 * Acorn Atom video output.
 *
 * The MC6847 draws a 256x192 field; the Atom's picture sits inside a black
 * border. The VDG core owns the mode decoding and character generator; this
 * wrapper owns the frame buffer and the border, and can blank the text cells a
 * transcribe overlay has replaced.
 */

import type { Mc6847 } from '@/cores/mc6847.ts';
import {
  ATOM_BORDER_LEFT, ATOM_BORDER_TOP, ATOM_SCREEN_HEIGHT, ATOM_SCREEN_WIDTH,
  ATOM_TEXT_CELL_HEIGHT, ATOM_TEXT_CELL_WIDTH,
} from './constants.ts';

const BLACK = 0xFF000000;
const WHITE = 0xFFFFFFFF;

export class AtomVideo {
  readonly pixels = new Uint8Array(ATOM_SCREEN_WIDTH * ATOM_SCREEN_HEIGHT * 4);
  readonly pixels32 = new Uint32Array(this.pixels.buffer);

  constructor() {
    this.pixels32.fill(BLACK);
  }

  /** Draw the whole frame: black border, then the VDG's active field. */
  render(vdg: Mc6847, vram: Uint8Array): void {
    this.pixels32.fill(BLACK);
    vdg.render(vram, this.pixels32, ATOM_SCREEN_WIDTH, ATOM_BORDER_LEFT, ATOM_BORDER_TOP);
  }

  /** Blank the cells the transcribe overlay covers, so its crisp text is not
   *  drawn over the machine's own glyphs. The Atom's text screen is 32x16. */
  blankCells(mask: readonly boolean[]): void {
    const px = this.pixels32;
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 32; col++) {
        if (!mask[row * 32 + col]) continue;
        const x0 = ATOM_BORDER_LEFT + col * ATOM_TEXT_CELL_WIDTH;
        for (let line = 0; line < ATOM_TEXT_CELL_HEIGHT; line++) {
          const base = (ATOM_BORDER_TOP + row * ATOM_TEXT_CELL_HEIGHT + line) * ATOM_SCREEN_WIDTH + x0;
          px.fill(BLACK, base, base + ATOM_TEXT_CELL_WIDTH);
        }
      }
    }
  }

  /** White pixel count in a text cell, for tests and diagnostics. */
  litPixels(col: number, row: number): number {
    let n = 0;
    const x0 = ATOM_BORDER_LEFT + col * ATOM_TEXT_CELL_WIDTH;
    const y0 = ATOM_BORDER_TOP + row * ATOM_TEXT_CELL_HEIGHT;
    for (let y = 0; y < ATOM_TEXT_CELL_HEIGHT; y++) {
      for (let x = 0; x < ATOM_TEXT_CELL_WIDTH; x++) {
        if (this.pixels32[(y0 + y) * ATOM_SCREEN_WIDTH + x0 + x] === WHITE) n++;
      }
    }
    return n;
  }
}
