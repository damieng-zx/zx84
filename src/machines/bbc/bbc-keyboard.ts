/**
 * BBC Micro keyboard matrix access.
 *
 * Printable characters are routed by the character the host produces
 * (`event.key`) via {@link BBC_CHAR_KEYS}, so the BBC's own shifted symbols
 * type correctly. Everything else (letters, digits handled by the char map,
 * Enter, Backspace, arrows, control) is routed by physical position
 * (`event.code`). SHIFT is driven purely by the character map — the host's
 * physical Shift key is not mapped, so a shifted host key presses the BBC key
 * that actually produces that character.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import { BBC_CHAR_KEYS, BBC_KEY_MATRIX } from './bbc-keyboard-matrix.ts';

export class BbcKeyboard {
  /** Pressed host key codes (from `BBC_KEY_MATRIX`). */
  private readonly pressed = new Set<string>();
  /** Whether the emulated SHIFT line is asserted. */
  private shiftDown = false;

  /** Fitted keyboard option links (row 0, columns 2-9; bit 0 = column 2). The
   *  MOS reads these at power-on to pick the default screen mode and boot
   *  options. 0x1F is the standard Model B/DFS configuration (boots in Mode 7). */
  links = 0x1F;

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    const mapped = event.key.length === 1 ? BBC_CHAR_KEYS[event.key] : undefined;
    if (mapped) {
      if (down) this.pressed.add(mapped.code); else this.pressed.delete(mapped.code);
      if (mapped.shift) this.shiftDown = down;
      return true;
    }
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') return false;
    if (!(event.code in BBC_KEY_MATRIX)) return false;
    if (down) this.pressed.add(event.code); else this.pressed.delete(event.code);
    return true;
  }

  /** True when a pressed key sits at (column, row). */
  isDown(column: number, row: number): boolean {
    if (row === 0 && column >= 2 && column <= 9) {
      return ((this.links >> (column - 2)) & 1) === 1;
    }
    if (column === 0 && row === 0) return this.shiftDown;
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
    if (column === 0 && this.shiftDown) return true;
    for (const code of this.pressed) {
      const cell = BBC_KEY_MATRIX[code];
      if (cell && cell[0] === column) return true;
    }
    return false;
  }

  anyPressed(): boolean { return this.pressed.size > 0 || this.shiftDown; }

  reset(): void { this.pressed.clear(); this.shiftDown = false; }
}
