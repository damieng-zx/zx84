/**
 * Acorn Atom keyboard matrix.
 *
 * Ten rows selected by PPI port A bits 0-3 and six columns read on port B bits
 * 0-5 (active low). Port B bits 6 and 7 are CTRL and SHIFT; REPT is a separate
 * line read on PPI port C bit 6. The matrix reads as a normal QWERTY deck: its
 * rows are the keyboard's physical columns, with digits and punctuation in
 * columns 0-2 and letters in columns 3-5.
 *
 * Printable characters are routed by the character the host produces
 * (`event.key`) so the Atom's own shifted symbols type correctly. Letters and
 * the editing keys are routed by physical position (`event.code`).
 */

import type { HostKeyEvent } from '@/machines/machine.ts';

/** [row, column] in the Atom's 10x6 matrix. */
export type AtomCell = readonly [number, number];

export const ATOM_KEY_MATRIX: Record<string, AtomCell> = {
  // Row 0
  Digit3: [0, 1], Minus: [0, 2], KeyG: [0, 3], KeyQ: [0, 4], Escape: [0, 5],
  // Row 1
  Digit2: [1, 1], Comma: [1, 2], KeyF: [1, 3], KeyP: [1, 4], KeyZ: [1, 5],
  // Row 2
  ArrowUp: [2, 0], ArrowDown: [2, 0],
  Digit1: [2, 1], Semicolon: [2, 2], KeyE: [2, 3], KeyO: [2, 4], KeyY: [2, 5],
  // Row 3
  ArrowRight: [3, 0], ArrowLeft: [3, 0],
  Digit0: [3, 1], Equal: [3, 2], KeyD: [3, 3], KeyN: [3, 4], KeyX: [3, 5],
  // Row 4
  CapsLock: [4, 0], Backspace: [4, 1],
  Digit9: [4, 2], KeyC: [4, 3], KeyM: [4, 4], KeyW: [4, 5],
  // Row 5
  Tab: [5, 1], Digit8: [5, 2], KeyB: [5, 3], KeyL: [5, 4], KeyV: [5, 5],
  // Row 6
  Backslash: [6, 0], Enter: [6, 1], Digit7: [6, 2], KeyA: [6, 3], KeyK: [6, 4], KeyU: [6, 5],
  // Row 7
  BracketRight: [7, 0], Digit6: [7, 2], BracketLeft: [7, 3], KeyJ: [7, 4], KeyT: [7, 5],
  // Row 8
  Quote: [8, 0], Digit5: [8, 2], Slash: [8, 3], KeyI: [8, 4], KeyS: [8, 5],
  // Row 9
  Space: [9, 0], Digit4: [9, 2], Period: [9, 3], KeyH: [9, 4], KeyR: [9, 5],
};

/** Letters by face, for the on-screen keyboard and typed listings. */
export const ATOM_LETTER_CELLS: Record<string, AtomCell> = {
  A: [6, 3], B: [5, 3], C: [4, 3], D: [3, 3], E: [2, 3], F: [1, 3], G: [0, 3],
  H: [9, 4], I: [8, 4], J: [7, 4], K: [6, 4], L: [5, 4], M: [4, 4], N: [3, 4],
  O: [2, 4], P: [1, 4], Q: [0, 4], R: [9, 5], S: [8, 5], T: [7, 5], U: [6, 5],
  V: [5, 5], W: [4, 5], X: [3, 5], Y: [2, 5], Z: [1, 5],
};

/** A produced character's Atom key cell and whether SHIFT is needed. */
export interface AtomCharKey {
  readonly cell: AtomCell;
  readonly shift: boolean;
}

/**
 * Printable character -> the Atom key that types it. The Atom's shifted
 * symbols differ from a PC's, so routing by the produced character lets a PC
 * user type Atom symbols without relearning the layout. Letters are handled
 * positionally (`ATOM_LETTER_CELLS`) and get no forced shift.
 */
export const ATOM_CHAR_KEYS: Record<string, AtomCharKey> = {
  '0': { cell: [3, 1], shift: false },
  '1': { cell: [2, 1], shift: false }, '!': { cell: [2, 1], shift: true },
  '2': { cell: [1, 1], shift: false }, '"': { cell: [1, 1], shift: true },
  '3': { cell: [0, 1], shift: false }, '#': { cell: [0, 1], shift: true },
  '4': { cell: [9, 2], shift: false }, '$': { cell: [9, 2], shift: true },
  '5': { cell: [8, 2], shift: false }, '%': { cell: [8, 2], shift: true },
  '6': { cell: [7, 2], shift: false }, '&': { cell: [7, 2], shift: true },
  '7': { cell: [6, 2], shift: false }, "'": { cell: [6, 2], shift: true },
  '8': { cell: [5, 2], shift: false }, '(': { cell: [5, 2], shift: true },
  '9': { cell: [4, 2], shift: false }, ')': { cell: [4, 2], shift: true },
  '-': { cell: [0, 2], shift: false }, '=': { cell: [0, 2], shift: true },
  ',': { cell: [1, 2], shift: false }, '<': { cell: [1, 2], shift: true },
  ';': { cell: [2, 2], shift: false }, '+': { cell: [2, 2], shift: true },
  ':': { cell: [3, 2], shift: false }, '*': { cell: [3, 2], shift: true },
  '[': { cell: [8, 0], shift: false }, '{': { cell: [8, 0], shift: true },
  '\\': { cell: [7, 0], shift: false }, '|': { cell: [7, 0], shift: true },
  ']': { cell: [6, 0], shift: false }, '}': { cell: [6, 0], shift: true },
  '@': { cell: [7, 3], shift: false }, '`': { cell: [7, 3], shift: true },
  '/': { cell: [8, 3], shift: false }, '?': { cell: [8, 3], shift: true },
  '.': { cell: [9, 3], shift: false }, '>': { cell: [9, 3], shift: true },
  // The Atom has no `^` cap; its top-row up-arrow key stands in for it.
  '^': { cell: [5, 0], shift: false }, '~': { cell: [5, 0], shift: true },
  '_': { cell: [3, 0], shift: true },
  ' ': { cell: [9, 0], shift: false },
};

const cellKey = (row: number, col: number): number => row * 6 + col;

export class AtomKeyboard {
  /** Pressed matrix cells, keyed row*6+column. */
  private readonly cells = new Set<number>();
  shiftHeld = false;
  ctrlHeld = false;
  reptHeld = false;

  /** Press/release a raw matrix cell (the on-screen keyboard's path). */
  setCell(row: number, col: number, down: boolean): void {
    const key = cellKey(row, col);
    if (down) this.cells.add(key); else this.cells.delete(key);
  }

  isPressed(row: number, col: number): boolean {
    return this.cells.has(cellKey(row, col));
  }

  /** Press the Atom key that types `ch`, with SHIFT when the symbol needs it.
   *  The caller releases it (`releaseAll`) after the program has read it. */
  pressChar(ch: string): boolean {
    const mapped = ATOM_CHAR_KEYS[ch] ?? ATOM_LETTER_CELLS[ch.toUpperCase()];
    if (!mapped) return false;
    if ('cell' in mapped) {
      this.setCell(mapped.cell[0], mapped.cell[1], true);
      if (mapped.shift) this.shiftHeld = true;
    } else {
      this.setCell(mapped[0], mapped[1], true);
    }
    return true;
  }

  /** Decode a host key into the matrix. Returns true when the event was
   *  consumed. Modifier state is tracked from the event's own flags, so the
   *  host's Shift/CTRL behave as the Atom's. */
  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    // Handle the modifier keys before copying the event's flags: the host
    // reports CTRL for both CTRL and the right-hand key the Atom uses for REPT,
    // which must not also assert the CTRL matrix line.
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.shiftHeld = down;
      return true;
    }
    if (event.code === 'ControlLeft') {
      this.ctrlHeld = down;
      return true;
    }
    if (event.code === 'ControlRight' || event.code === 'AltRight') {
      this.reptHeld = down;
      return true;
    }
    this.shiftHeld = event.shift;
    this.ctrlHeld = event.ctrl;

    if (event.key.length === 1) {
      const mapped = ATOM_CHAR_KEYS[event.key];
      if (mapped) {
        // The Atom's produced character is the authority: '#' is its own key
        // cell plus SHIFT, wherever the host puts '#'. Keep SHIFT asserted for
        // a shifted key even after the host's own shift flag clears.
        this.setCell(mapped.cell[0], mapped.cell[1], down);
        if (mapped.shift && down) this.shiftHeld = true;
        return true;
      }
      const letter = ATOM_LETTER_CELLS[event.key.toUpperCase()];
      if (letter && /^[A-Za-z]$/.test(event.key)) {
        this.setCell(letter[0], letter[1], down);
        return true;
      }
    }

    const cell = ATOM_KEY_MATRIX[event.code];
    if (!cell) return false;
    this.setCell(cell[0], cell[1], down);
    return true;
  }

  /** Port B: six active-low column bits, then CTRL and SHIFT. Idle is $FF:
   *  a high bit means the switch is open. */
  readRow(row: number): number {
    let value = 0xFF;
    if (row < 10) {
      for (let col = 0; col < 6; col++) {
        if (this.cells.has(cellKey(row, col))) value &= ~(1 << col);
      }
    }
    if (this.ctrlHeld) value &= ~0x40;
    if (this.shiftHeld) value &= ~0x80;
    return value & 0xFF;
  }

  /** REPT is active (port C bit 6 reads low). */
  get repeat(): boolean { return this.reptHeld; }

  anyPressed(): boolean { return this.cells.size > 0; }

  releaseAll(): void {
    this.cells.clear();
    this.shiftHeld = this.ctrlHeld = this.reptHeld = false;
  }
}
