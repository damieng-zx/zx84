/**
 * MsxKeyboard — MSX1 keyboard matrix (Toshiba HX-10, international layout).
 *
 * The MSX matrix is 11 rows × 8 columns, scanned through the 8255 PPI (NOT the
 * AY, unlike the Tatung Einstein): the BIOS writes the row number 0–10 to the
 * low nibble of PPI port C (0xAA), then reads that row's 8 columns from PPI port
 * B (0xA9). Both are active-low — a 0 bit means the key is pressed. Only one row
 * is selected at a time (a plain 4-bit index, not a bitmask).
 *
 * Matrix layout is the authoritative MSX International matrix (MSX Assembly Page,
 * map.grauw.nl/articles/keymatrix.php):
 *
 *   bit    7      6      5      4      3      2      1      0
 *   row0   7      6      5      4      3      2      1      0
 *   row1   ;      ]      [      \      =      -      9      8
 *   row2   B      A     DEAD    /      .      ,      `      '
 *   row3   J      I      H      G      F      E      D      C
 *   row4   R      Q      P      O      N      M      L      K
 *   row5   Z      Y      X      W      V      U      T      S
 *   row6   F3     F2     F1    CODE   CAPS  GRAPH   CTRL   SHIFT
 *   row7   RET   SELECT   BS    STOP   TAB    ESC     F5     F4
 *   row8  RIGHT  DOWN    UP    LEFT    DEL    INS    HOME  SPACE
 *   row9  num4   num3   num2   num1   num0   num/   num+   num*
 *   row10 num.   num,   num-   num9   num8   num7   num6   num5
 *
 * The host-key map is by physical `KeyboardEvent.code`, best-effort for a UK/US
 * layout. SHIFT/CTRL/CAPS/GRAPH/CODE are ordinary matrix keys here, so the BIOS
 * resolves shifted characters itself.
 */

const ROWS = 11;

/** [row, bit] for each matrix key. */
type Cell = readonly [number, number];

/** KeyboardEvent.code → MSX matrix cell. */
const KEY_MAP: Record<string, Cell> = {
  // Letters
  KeyA: [2, 6], KeyB: [2, 7], KeyC: [3, 0], KeyD: [3, 1], KeyE: [3, 2],
  KeyF: [3, 3], KeyG: [3, 4], KeyH: [3, 5], KeyI: [3, 6], KeyJ: [3, 7],
  KeyK: [4, 0], KeyL: [4, 1], KeyM: [4, 2], KeyN: [4, 3], KeyO: [4, 4],
  KeyP: [4, 5], KeyQ: [4, 6], KeyR: [4, 7], KeyS: [5, 0], KeyT: [5, 1],
  KeyU: [5, 2], KeyV: [5, 3], KeyW: [5, 4], KeyX: [5, 5], KeyY: [5, 6],
  KeyZ: [5, 7],
  // Digits
  Digit0: [0, 0], Digit1: [0, 1], Digit2: [0, 2], Digit3: [0, 3], Digit4: [0, 4],
  Digit5: [0, 5], Digit6: [0, 6], Digit7: [0, 7], Digit8: [1, 0], Digit9: [1, 1],
  // Symbols (row 1 / row 2)
  Minus: [1, 2], Equal: [1, 3], Backslash: [1, 4], BracketLeft: [1, 5],
  BracketRight: [1, 6], Semicolon: [1, 7], Quote: [2, 0], Backquote: [2, 1],
  Comma: [2, 2], Period: [2, 3], Slash: [2, 4], IntlRo: [2, 5], IntlYen: [1, 4],
  // Modifiers
  ShiftLeft: [6, 0], ShiftRight: [6, 0], ControlLeft: [6, 1], ControlRight: [6, 1],
  AltLeft: [6, 2],   // GRAPH
  CapsLock: [6, 3],
  AltRight: [6, 4],  // CODE
  // Function keys
  F1: [6, 5], F2: [6, 6], F3: [6, 7], F4: [7, 0], F5: [7, 1],
  // Whitespace / control / editing
  Escape: [7, 2], Tab: [7, 3], Pause: [7, 4], Backspace: [7, 5], End: [7, 6],
  Enter: [7, 7], Space: [8, 0], Home: [8, 1], Insert: [8, 2], Delete: [8, 3],
  // Cursor keys
  ArrowLeft: [8, 4], ArrowUp: [8, 5], ArrowDown: [8, 6], ArrowRight: [8, 7],
  // Numeric keypad
  NumpadMultiply: [9, 0], NumpadAdd: [9, 1], NumpadDivide: [9, 2],
  Numpad0: [9, 3], Numpad1: [9, 4], Numpad2: [9, 5], Numpad3: [9, 6], Numpad4: [9, 7],
  Numpad5: [10, 0], Numpad6: [10, 1], Numpad7: [10, 2], Numpad8: [10, 3],
  Numpad9: [10, 4], NumpadSubtract: [10, 5], NumpadDecimal: [10, 7],
};

export class MsxKeyboard {
  /** Per-row column state, active-low. 0xFF = all keys on that row released. */
  private readonly matrix = new Uint8Array(ROWS).fill(0xFF);

  /** Selected row (PPI port C low nibble). Rows 11–15 read as no keys. */
  private selectedRow = 0;

  /** PPI port C low nibble — select the row to scan (0–10). */
  selectRow(row: number): void { this.selectedRow = row & 0x0F; }

  /** PPI port B read — the selected row's columns, active-low. */
  readColumns(): number {
    return this.selectedRow < ROWS ? this.matrix[this.selectedRow] : 0xFF;
  }

  setKey(row: number, bit: number, pressed: boolean): void {
    if (row < 0 || row >= ROWS) return;
    const mask = 1 << (bit & 7);
    if (pressed) this.matrix[row] &= ~mask & 0xFF;
    else this.matrix[row] |= mask;
  }

  /** Handle a host key event by physical code. Returns true if mapped. */
  handleKeyEvent(code: string, pressed: boolean): boolean {
    const cell = KEY_MAP[code];
    if (!cell) return false;
    this.setKey(cell[0], cell[1], pressed);
    return true;
  }

  reset(): void {
    this.matrix.fill(0xFF);
    this.selectedRow = 0;
  }
}
