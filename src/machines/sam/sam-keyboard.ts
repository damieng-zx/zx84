/**
 * SAM Coupé keyboard.
 *
 * The matrix is nine rows of eight bits, all active low (a CLEAR bit means the
 * key is down). The first five bits of a row are read through port 0xFE — the
 * Spectrum's half-row convention, and indeed the first five columns are the
 * Spectrum's own layout — while bits 5-7 carry the SAM's extra keys and are
 * read through the top three bits of port 0xF9.
 *
 *        bit 0     1      2      3      4   |   5       6       7
 *   0    SHIFT     Z      X      C      V   |   F1      F2      F3
 *   1    A         S      D      F      G   |   F4      F5      F6
 *   2    Q         W      E      R      T   |   F7      F8      F9
 *   3    1         2      3      4      5   |   ESC     TAB     CAPS
 *   4    0         9      8      7      6   |   MINUS   PLUS    DELETE
 *   5    P         O      I      U      Y   |   EQUALS  QUOTES  F0
 *   6    RETURN    L      K      J      H   |   SEMI    COLON   EDIT
 *   7    SPACE     SYMBOL M      N      B   |   COMMA   PERIOD  INV
 *   8    CNTRL     UP     DOWN   LEFT   RIGHT
 *
 * TODO(verify): the first five columns, the function keys, and ESC / TAB /
 * CAPS / DELETE / F0 come straight from SimCoupe's table. The nine punctuation
 * positions do not: SimCoupe reaches those through a separate SK_* enum whose
 * matrix coordinates were not to hand, so columns 5-6 of rows 4-6 above are
 * RECONSTRUCTED from the physical key layout. Row 7 is not a guess — pressing
 * (7,5) and (7,6) against the real ROM types "," and "." — and it was that
 * confirmation which gave grounds for the same-shaped reading of rows 4-6.
 * Check the remaining seven against hardware before relying on them.
 *
 * Row selection follows the Spectrum: each clear bit of the port's high byte
 * selects a row, and the rows selected are ANDed together. The ninth row is
 * squeezed in by selecting it when the high byte is 0xFF — that is, when no
 * ordinary row is selected — so the cursor keys and CNTRL cost no address line.
 * Note that row 8 is reachable only through port 0xFE, never through 0xF9.
 *
 * Transcribed from SimCoupe's `Base/Keyboard.cpp` matrix and the port 0xFE /
 * 0xF9 read paths in `Base/SAMIO.cpp`.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';

/** Rows in the matrix; row 8 holds CNTRL and the cursor keys. */
const ROWS = 9;

/** Where a host key sits in the matrix, as [row, bit]. */
type Cell = readonly [number, number];

/**
 * Host `KeyboardEvent.code` to matrix position.
 *
 * The two shift-like keys are deliberately split the way SimCoupe splits them:
 * the left Control key is the SAM's SYMBOL (the Spectrum's symbol-shift
 * position) and the right Control key is the SAM's own CNTRL. Alt is offered as
 * a second SYMBOL because a browser eats some Control chords.
 */
const KEY_MAP: Record<string, Cell> = {
  // Row 0
  ShiftLeft: [0, 0], ShiftRight: [0, 0],
  KeyZ: [0, 1], KeyX: [0, 2], KeyC: [0, 3], KeyV: [0, 4],
  F1: [0, 5], F2: [0, 6], F3: [0, 7],
  // Row 1
  KeyA: [1, 0], KeyS: [1, 1], KeyD: [1, 2], KeyF: [1, 3], KeyG: [1, 4],
  F4: [1, 5], F5: [1, 6], F6: [1, 7],
  // Row 2
  KeyQ: [2, 0], KeyW: [2, 1], KeyE: [2, 2], KeyR: [2, 3], KeyT: [2, 4],
  F7: [2, 5], F8: [2, 6], F9: [2, 7],
  // Row 3
  Digit1: [3, 0], Digit2: [3, 1], Digit3: [3, 2], Digit4: [3, 3], Digit5: [3, 4],
  Escape: [3, 5], Tab: [3, 6], CapsLock: [3, 7],
  // Row 4
  Digit0: [4, 0], Digit9: [4, 1], Digit8: [4, 2], Digit7: [4, 3], Digit6: [4, 4],
  Minus: [4, 5], Equal: [4, 6], Backspace: [4, 7],
  // Row 5
  KeyP: [5, 0], KeyO: [5, 1], KeyI: [5, 2], KeyU: [5, 3], KeyY: [5, 4],
  BracketLeft: [5, 5], Quote: [5, 6], F10: [5, 7],
  // Row 6
  Enter: [6, 0], NumpadEnter: [6, 0],
  KeyL: [6, 1], KeyK: [6, 2], KeyJ: [6, 3], KeyH: [6, 4],
  Semicolon: [6, 5], BracketRight: [6, 6], Home: [6, 7],
  // Row 7
  Space: [7, 0],
  ControlLeft: [7, 1], AltLeft: [7, 1], AltRight: [7, 1],
  KeyM: [7, 2], KeyN: [7, 3], KeyB: [7, 4],
  Comma: [7, 5], Period: [7, 6], Insert: [7, 7],
  // Row 8 — reachable only when no other row is selected
  ControlRight: [8, 0],
  ArrowUp: [8, 1], ArrowDown: [8, 2], ArrowLeft: [8, 3], ArrowRight: [8, 4],
};

export class SamKeyboard {
  /** One byte per row; a CLEAR bit means that key is currently down. */
  private readonly matrix = new Uint8Array(ROWS).fill(0xFF);

  reset(): void { this.matrix.fill(0xFF); }

  /** Press or release a matrix position directly (tests, on-screen keyboard). */
  setKey(row: number, bit: number, down: boolean): void {
    if (row < 0 || row >= ROWS) return;
    if (down) this.matrix[row] &= ~(1 << bit);
    else this.matrix[row] |= (1 << bit);
  }

  /** Route a host key event. Returns true when the key exists on this machine. */
  handleKeyEvent(e: HostKeyEvent, down: boolean): boolean {
    const cell = KEY_MAP[e.code];
    if (!cell) return false;
    this.setKey(cell[0], cell[1], down);
    return true;
  }

  /**
   * Port 0xFE read — the low five bits.
   *
   * Every row whose select line is low is ANDed in, so chorded keys across
   * rows read correctly. When no row is selected (high byte 0xFF) the ninth
   * row answers instead, which is where CNTRL and the cursor keys live.
   */
  readLow(portHigh: number): number {
    let keys = 0x1F;
    const sel = portHigh & 0xFF;
    if (sel === 0xFF) {
      keys &= this.matrix[8];
    } else {
      for (let row = 0; row < 8; row++) {
        if ((sel & (1 << row)) === 0) keys &= this.matrix[row];
      }
    }
    return keys & 0x1F;
  }

  /**
   * Port 0xF9 read — the top three bits, carrying the SAM's extra keys.
   *
   * Unlike port 0xFE this has no 0xFF special case: row 8 is not reachable
   * here, because its keys occupy only bits 0-4.
   */
  readHigh(portHigh: number): number {
    let keys = 0xE0;
    const sel = portHigh & 0xFF;
    for (let row = 0; row < 8; row++) {
      if ((sel & (1 << row)) === 0) keys &= this.matrix[row];
    }
    return keys & 0xE0;
  }

  /** True while any key is down (drives the keyboard activity LED). */
  get anyDown(): boolean {
    for (let i = 0; i < ROWS; i++) if (this.matrix[i] !== 0xFF) return true;
    return false;
  }
}
