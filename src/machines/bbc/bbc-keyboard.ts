/**
 * BBC Micro keyboard matrix access.
 *
 * Printable characters are routed by the character the host produces
 * (`event.key`) via {@link BBC_CHAR_KEYS}, so the BBC's own shifted symbols
 * type correctly. Everything else (letters, Enter, Backspace, arrows, control)
 * is routed by physical position (`event.code`). SHIFT is just the (0,0) cell.
 *
 * The pressed set holds matrix cells (`column*8 + row`), so the on-screen
 * keyboard can drive cells directly via `setCell`.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import { BBC_CHAR_KEYS, BBC_KEY_MATRIX } from './bbc-keyboard-matrix.ts';

const cellKey = (col: number, row: number): number => (col << 3) | (row & 7);

export class BbcKeyboard {
  /** Pressed matrix cells, keyed `column*8 + row`. */
  private readonly cells = new Set<number>();

  /** Fitted keyboard option links (row 0, columns 2-9; bit 0 = column 2). The
   *  MOS reads these at power-on into the *FX255 startup byte, inverted and
   *  bit-reversed (column 9 = bit 0). None fitted gives &FF — Mode 7, and
   *  SHIFT+BREAK auto-boots the disc — the standard Model B configuration.
   *  (0x1F would read as &07: a plain BREAK boots, SHIFT+BREAK doesn't.) */
  links = 0x00;

  /** Press/release a raw matrix cell — used by the on-screen keyboard. */
  setCell(column: number, row: number, down: boolean): void {
    const key = cellKey(column, row);
    if (down) this.cells.add(key); else this.cells.delete(key);
  }

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    const mapped = event.key.length === 1 ? BBC_CHAR_KEYS[event.key] : undefined;
    if (mapped) {
      const cell = BBC_KEY_MATRIX[mapped.code];
      if (cell) this.setCell(cell[0], cell[1], down);
      if (mapped.shift) this.setCell(0, 0, down);
      return true;
    }
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') return false;
    const cell = BBC_KEY_MATRIX[event.code];
    if (!cell) return false;
    this.setCell(cell[0], cell[1], down);
    return true;
  }

  /** Whether a physical/on-screen cell is held (ignores the option links). */
  isPressed(column: number, row: number): boolean {
    return this.cells.has(cellKey(column, row));
  }

  /** True when a pressed key sits at (column, row), including fitted links. */
  isDown(column: number, row: number): boolean {
    if (row === 0 && column >= 2 && column <= 9) {
      return ((this.links >> (column - 2)) & 1) === 1;
    }
    return this.isPressed(column, row);
  }

  /** True when any key in `column` is pressed. The keyboard hardware asserts
   *  CA2 on this (not on the selected cell's row), which is what gates the
   *  MOS's column-by-column scan. */
  anyInColumn(column: number): boolean {
    if (column >= 2 && column <= 9 && ((this.links >> (column - 2)) & 1) === 1) return true;
    for (const key of this.cells) {
      if ((key >> 3) === column) return true;
    }
    return false;
  }

  anyPressed(): boolean { return this.cells.size > 0; }

  reset(): void { this.cells.clear(); }
}
