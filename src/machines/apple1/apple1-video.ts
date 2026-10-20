/**
 * Apple I video output: the terminal's 40×24 cells drawn white on black.
 *
 * Every character is a 5×7 glyph in a 7×8 dot cell, one frame-buffer pixel per
 * dot. The cursor is a blinking `@` that replaces the character under it. The
 * picture only changes when a character is written, the cursor blinks or the
 * font arrives, so a frame that needs none of those is not redrawn. The phosphor
 * colour (green, amber…) is the Monitor pane's job; this stays white.
 */

import type { Apple1Charset } from './apple1-charset.ts';
import type { Apple1Terminal } from './apple1-terminal.ts';
import {
  APPLE1_BORDER_LEFT, APPLE1_BORDER_TOP, APPLE1_CELL_HEIGHT, APPLE1_CELL_WIDTH, APPLE1_SCREEN_HEIGHT, APPLE1_SCREEN_WIDTH,
  APPLE1_TERMINAL_COLS, APPLE1_TERMINAL_ROWS,
} from './constants.ts';

const BLACK = 0xFF000000;
const WHITE = 0xFFFFFFFF;
/** The cursor character: code $40, glyph 0. */
const CURSOR = 0x40;

export class Apple1Video {
  readonly pixels = new Uint8Array(APPLE1_SCREEN_WIDTH * APPLE1_SCREEN_HEIGHT * 4);
  private readonly pixels32 = new Uint32Array(this.pixels.buffer);

  private drawnVersion = -1;
  private drawnGeneration = -1;
  private drawnCursor: boolean | null = null;
  private drawnCursorCell = -1;

  constructor() {
    this.pixels32.fill(BLACK);
  }

  /** Force the next `render` to redraw (after a reset or a font change). */
  invalidate(): void {
    this.drawnVersion = -1;
  }

  /** Draw the terminal if anything on screen has changed. Returns whether it did. */
  render(terminal: Apple1Terminal, charset: Apple1Charset, cursorOn: boolean): boolean {
    const cursorCell = terminal.row * APPLE1_TERMINAL_COLS + terminal.col;
    if (terminal.version === this.drawnVersion && charset.generation === this.drawnGeneration
      && cursorOn === this.drawnCursor && cursorCell === this.drawnCursorCell) {
      return false;
    }
    this.drawnVersion = terminal.version;
    this.drawnGeneration = charset.generation;
    this.drawnCursor = cursorOn;
    this.drawnCursorCell = cursorCell;

    const px = this.pixels32;
    px.fill(BLACK);
    for (let row = 0; row < APPLE1_TERMINAL_ROWS; row++) {
      for (let col = 0; col < APPLE1_TERMINAL_COLS; col++) {
        const cell = row * APPLE1_TERMINAL_COLS + col;
        const code = cell === cursorCell && cursorOn ? CURSOR : terminal.cells[cell];
        if (code === 0x20) continue;
        this.drawGlyph(charset, code, col, row);
      }
    }
    return true;
  }

  private drawGlyph(charset: Apple1Charset, code: number, col: number, row: number): void {
    const px = this.pixels32;
    const x0 = APPLE1_BORDER_LEFT + col * APPLE1_CELL_WIDTH;
    const y0 = APPLE1_BORDER_TOP + row * APPLE1_CELL_HEIGHT;
    for (let line = 0; line < APPLE1_CELL_HEIGHT; line++) {
      const bits = charset.glyphRow(code, line);
      if (bits === 0) continue;
      const base = (y0 + line) * APPLE1_SCREEN_WIDTH + x0;
      for (let dot = 0; dot < APPLE1_CELL_WIDTH; dot++) {
        if ((bits >> (6 - dot)) & 1) px[base + dot] = WHITE;
      }
    }
  }

  /** Blank the cells in `mask` (the transcribe overlay draws its own text over them). */
  blankCells(mask: readonly boolean[]): void {
    const px = this.pixels32;
    for (let row = 0; row < APPLE1_TERMINAL_ROWS; row++) {
      for (let col = 0; col < APPLE1_TERMINAL_COLS; col++) {
        if (!mask[row * APPLE1_TERMINAL_COLS + col]) continue;
        const x0 = APPLE1_BORDER_LEFT + col * APPLE1_CELL_WIDTH;
        for (let line = 0; line < APPLE1_CELL_HEIGHT; line++) {
          const base = (APPLE1_BORDER_TOP + row * APPLE1_CELL_HEIGHT + line) * APPLE1_SCREEN_WIDTH + x0;
          px.fill(BLACK, base, base + APPLE1_CELL_WIDTH);
        }
      }
    }
  }
}
