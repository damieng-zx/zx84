/**
 * BBC Micro keyboard matrix access.
 *
 * Host key events update the pressed set; the System VIA port A read hook asks
 * the matrix for the selected (column, row) cell via `isDown`.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import { BBC_KEY_MATRIX } from './bbc-keyboard-matrix.ts';

export class BbcKeyboard {
  private readonly pressed = new Set<string>();

  /** Fitted keyboard option links (row 0, columns 2-9; bit 0 = column 2). The
   *  MOS reads these at power-on to pick the default screen mode and boot
   *  options. 0x1F is the standard Model B/DFS configuration (boots in Mode 7). */
  links = 0x1F;

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    if (!(event.code in BBC_KEY_MATRIX)) return false;
    if (down) this.pressed.add(event.code);
    else this.pressed.delete(event.code);
    return true;
  }

  /** True when a pressed key sits at (column, row). */
  isDown(column: number, row: number): boolean {
    if (row === 0 && column >= 2 && column <= 9) {
      return ((this.links >> (column - 2)) & 1) === 1;
    }
    for (const code of this.pressed) {
      const cell = BBC_KEY_MATRIX[code];
      if (cell && cell[0] === column && cell[1] === row) return true;
    }
    return false;
  }

  /** True when any key in `column` is pressed. The keyboard hardware asserts
   *  CA2 on this (not on the selected cell's row), which is what gates the
   *  MOS's column-by-column scan. */
  anyInColumn(column: number): boolean {
    if (column >= 2 && column <= 9 && ((this.links >> (column - 2)) & 1) === 1) return true;
    for (const code of this.pressed) {
      const cell = BBC_KEY_MATRIX[code];
      if (cell && cell[0] === column) return true;
    }
    return false;
  }

  anyPressed(): boolean { return this.pressed.size > 0; }

  reset(): void { this.pressed.clear(); }
}
