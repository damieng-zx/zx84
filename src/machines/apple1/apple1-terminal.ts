/**
 * The Apple I's video terminal.
 *
 * The CPU does not draw the screen: it writes characters to the PIA and a
 * separate terminal circuit puts them in a 40×24 shift-register display. The
 * terminal accepts one character per 1/60 s (the machine's busy timing lives in
 * the PIA's port B bit 7, not here), understands carriage return and nothing
 * else, wraps at column 40 and scrolls when the cursor leaves the bottom row.
 *
 * Only 64 glyphs exist ($20-$5F); lower-case codes display as their capitals
 * and the other control codes are ignored.
 */

import { APPLE1_TERMINAL_COLS, APPLE1_TERMINAL_ROWS } from './constants.ts';

const COLS = APPLE1_TERMINAL_COLS;
const ROWS = APPLE1_TERMINAL_ROWS;
const SPACE = 0x20;

export class Apple1Terminal {
  /** Displayed character codes ($20-$5F), row-major. */
  readonly cells = new Uint8Array(COLS * ROWS).fill(SPACE);
  col = 0;
  row = 0;
  /** Bumped on every change so a renderer can tell when to repaint. */
  version = 0;

  /** Accept a character from the PIA (bit 7 is not part of the code). */
  put(byte: number): void {
    const code = byte & 0x7F;
    if (code === 0x0D) { this.newline(); return; }
    if (code < SPACE) return;
    this.cells[this.row * COLS + this.col] = code >= 0x60 ? code - 0x20 : code;
    this.version++;
    if (++this.col >= COLS) this.newline();
  }

  private newline(): void {
    this.col = 0;
    this.version++;
    if (++this.row < ROWS) return;
    this.row = ROWS - 1;
    this.cells.copyWithin(0, COLS);
    this.cells.fill(SPACE, (ROWS - 1) * COLS);
  }

  /** The CLEAR SCREEN key: blank the display and home the cursor. */
  clear(): void {
    this.cells.fill(SPACE);
    this.col = 0;
    this.row = 0;
    this.version++;
  }

  /** The screen as text, one string per row, trailing spaces trimmed. */
  lines(): string[] {
    const out: string[] = [];
    for (let row = 0; row < ROWS; row++) {
      let text = '';
      for (let col = 0; col < COLS; col++) text += String.fromCharCode(this.cells[row * COLS + col]);
      out.push(text.replace(/\s+$/, ''));
    }
    return out;
  }
}
