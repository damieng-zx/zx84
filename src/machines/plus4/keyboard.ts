/**
 * Commodore Plus/4 keyboard: an 8 × 8 matrix, scanned with the TED and PIO 2.
 *
 * The scan is a little unusual. PIO 2 (`$FD30`) selects one of its eight lines
 * at a time, and the TED's keyboard register (`$FF08`) returns the eight column
 * lines of whichever rows are selected: one write and one read give a whole
 * row. A key joins its row line and its column line, so a selected row with a
 * key down pulls that column's bit low.
 *
 * The cells are the machine's real key positions (VICE's `win_sym.vkm`, which
 * is a table of the board's keys), given here as [PIO 2 line][TED bit]:
 *
 *   line 0  DEL RETURN £ HELP F1 F2 F3 @
 *   line 1  3 W A 4 Z S E SHIFT
 *   line 2  5 R D 6 C F T X
 *   line 3  7 Y G 8 B H U V
 *   line 4  9 I J 0 M K O N
 *   line 5  down P L up . : - ,
 *   line 6  left * ; right arrow-left = + /
 *   line 7  1 CLR/HOME CTRL 2 SPACE C= Q RUN/STOP
 *
 * There is no RESTORE key in the matrix (the Plus/4's RESET button is
 * hardware, outside it), and a two-way key carries both of its halves on one
 * cap: F1/F2 share F1's cap, F3/F4 F3's, F5/F6 F5's, F7/HELP F7's, and each
 * cursor key is one cap with the opposite direction shifted. Those second
 * halves are aliases onto the same cell.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import { CbmKeyboard } from '@/machines/shared/cbm/keyboard.ts';

/** The keys, by [PIO 2 line][TED $FF08 bit]. */
export const PLUS4_KEYS: readonly (readonly string[])[] = [
  ['del', 'return', 'pound', 'help', 'f1', 'f2', 'f3', '@'],
  ['3', 'w', 'a', '4', 'z', 's', 'e', 'lshift'],
  ['5', 'r', 'd', '6', 'c', 'f', 't', 'x'],
  ['7', 'y', 'g', '8', 'b', 'h', 'u', 'v'],
  ['9', 'i', 'j', '0', 'm', 'k', 'o', 'n'],
  ['crsr-ud', 'p', 'l', 'arrow-up', '.', ':', '-', ','],
  ['crsr-lr', '*', ';', 'right', 'arrow-left', '=', '+', '/'],
  ['1', 'home', 'ctrl', '2', 'space', 'cbm', 'q', 'stop'],
];

/**
 * The base class's matrix, indexed [column][row]. A key's "column" is the TED's
 * `$FF08` bit and its "row" the PIO 2 line.
 */
export const PLUS4_MATRIX: readonly (readonly string[])[] = (() => {
  const out: string[][] = [];
  for (let col = 0; col < 8; col++) out.push(PLUS4_KEYS.map(line => line[col]));
  return out;
})();

/**
 * The shifted half of each two-way key, on the same cell as its unshifted half
 * (which the matrix above holds).
 */
export const PLUS4_KEY_ALIASES: Readonly<Record<string, string>> = {
  f2: 'f1', f4: 'f3', f6: 'f5',
  up: 'arrow-up', left: 'crsr-lr',
};

/**
 * Host keys that press a Plus/4 cap the shared Commodore mapping does not know:
 * the four arrows are their own caps here (on the 64 the cursor keys are a
 * separate two-way key), HELP has no 64 equivalent, and the shifted halves of
 * the two-way keys are pressed with SHIFT as on the 64.
 */
const EXTRA_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: 'arrow-up', ArrowDown: 'crsr-ud', ArrowLeft: 'crsr-lr', ArrowRight: 'right',
  F9: 'help',
};

export class Plus4Keyboard extends CbmKeyboard {
  /** The cap each held host key pressed through `EXTRA_KEYS`. */
  private readonly extraHeld = new Map<string, string>();

  constructor() { super(PLUS4_MATRIX, PLUS4_KEY_ALIASES); }

  override handleEvent(event: HostKeyEvent, down: boolean): boolean {
    const extra = EXTRA_KEYS[event.code];
    if (!down) {
      const held = this.extraHeld.get(event.code);
      if (held !== undefined) {
        this.extraHeld.delete(event.code);
        this.setKey(held, false);
        return true;
      }
      return super.handleEvent(event, down);
    }
    if (extra) {
      if (!this.extraHeld.has(event.code)) { this.extraHeld.set(event.code, extra); this.setKey(extra, true); }
      return true;
    }
    return super.handleEvent(event, down);
  }

  override reset(): void {
    super.reset();
    this.extraHeld.clear();
  }

  /**
   * The eight column lines the TED reads back. `pioLines` is the PIO 2 latch:
   * a bit CLEAR is a keyboard line driven low, which is the row the KERNAL
   * selects, and a key down on it pulls its column's bit low. This is the base
   * class's `columnsFor` relation exactly.
   */
  columnsForSelectedLines(pioLines: number): number {
    return this.columnsFor(pioLines & 0xFF);
  }
}
