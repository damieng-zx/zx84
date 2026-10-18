/**
 * EnterpriseKeyboard — the ten-row matrix Dave scans, active low.
 *
 * A row is selected by writing it to port 0xB5's low nibble and read back
 * from the same port. The layout (row, bit) is the one ep128emu documents in
 * `dave.hpp`. The built-in joystick is not a separate device: it is wired
 * across the cursor-key positions of row 7, with fire on the space bar.
 *
 *         b0     b1     b2     b3     b4     b5     b6     b7
 *   0     N      \      B      C      V      X      Z      SHIFT(L)
 *   1     H      LOCK   G      D      F      S      A      CTRL
 *   2     U      Q      Y      R      T      E      W      TAB
 *   3     7      1      6      4      5      3      2      ESC
 *   4     F4     F8     F3     F6     F5     F7     F2     F1
 *   5     8      -      9      -      0      ^      ERASE  -
 *   6     J      -      K      ;      L      :      ]      -
 *   7     STOP   DOWN   RIGHT  UP     HOLD   LEFT   ENTER  ALT
 *   8     M      DEL    ,      /      .      SHIFT(R) SPACE INS
 *   9     I      -      O      @      P      [      -      -
 *
 * Host keys map by position onto a UK-style layout: the keys right of P are
 * @ and [, right of L are ; : and ], and \ sits left of Z.
 */

const ROWS = 10;

type Cell = readonly [row: number, bit: number];

const KEY_MAP: Record<string, Cell> = {
  KeyN: [0, 0], IntlBackslash: [0, 1], KeyB: [0, 2], KeyC: [0, 3], KeyV: [0, 4],
  KeyX: [0, 5], KeyZ: [0, 6], ShiftLeft: [0, 7],
  KeyH: [1, 0], CapsLock: [1, 1], KeyG: [1, 2], KeyD: [1, 3], KeyF: [1, 4],
  KeyS: [1, 5], KeyA: [1, 6], ControlLeft: [1, 7], ControlRight: [1, 7],
  KeyU: [2, 0], KeyQ: [2, 1], KeyY: [2, 2], KeyR: [2, 3], KeyT: [2, 4],
  KeyE: [2, 5], KeyW: [2, 6], Tab: [2, 7],
  Digit7: [3, 0], Digit1: [3, 1], Digit6: [3, 2], Digit4: [3, 3], Digit5: [3, 4],
  Digit3: [3, 5], Digit2: [3, 6], Escape: [3, 7],
  F4: [4, 0], F8: [4, 1], F3: [4, 2], F6: [4, 3], F5: [4, 4], F7: [4, 5],
  F2: [4, 6], F1: [4, 7],
  Digit8: [5, 0], Digit9: [5, 2], Minus: [5, 3], Digit0: [5, 4], Equal: [5, 5],
  Backspace: [5, 6],
  KeyJ: [6, 0], KeyK: [6, 2], Semicolon: [6, 3], KeyL: [6, 4], Quote: [6, 5],
  Backslash: [6, 6],
  End: [7, 0], Pause: [7, 0], ArrowDown: [7, 1], ArrowRight: [7, 2], ArrowUp: [7, 3],
  Home: [7, 4], ArrowLeft: [7, 5], Enter: [7, 6], NumpadEnter: [7, 6],
  AltLeft: [7, 7], AltRight: [7, 7],
  KeyM: [8, 0], Delete: [8, 1], Comma: [8, 2], Slash: [8, 3], Period: [8, 4],
  ShiftRight: [8, 5], Space: [8, 6], Insert: [8, 7],
  KeyI: [9, 0], KeyO: [9, 2], BracketLeft: [9, 3], KeyP: [9, 4], BracketRight: [9, 5],
};

/** Where a typed character lives: its cell and whether it needs SHIFT. The
 *  Enterprise's shifted symbols follow the UK typewriter layout on the digit
 *  row and its own on the right-hand keys. */
const SHIFT: Cell = [0, 7];
const CHAR_MAP: Record<string, readonly [Cell, boolean]> = (() => {
  const m: Record<string, readonly [Cell, boolean]> = {};
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const ch of letters) {
    const cell = KEY_MAP[`Key${ch.toUpperCase()}`];
    m[ch] = [cell, false];
    m[ch.toUpperCase()] = [cell, true];
  }
  for (let d = 0; d <= 9; d++) m[String(d)] = [KEY_MAP[`Digit${d}`], false];
  const shifted: Record<string, string> = {
    '!': 'Digit1', '"': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5',
    '&': 'Digit6', "'": 'Digit7', '(': 'Digit8', ')': 'Digit9', '_': 'Digit0',
    '=': 'Minus', '~': 'Equal', '+': 'Semicolon', '*': 'Quote', '<': 'Comma',
    '>': 'Period', '?': 'Slash', '|': 'IntlBackslash', '`': 'BracketLeft',
    '{': 'BracketRight', '}': 'Backslash',
  };
  for (const [ch, code] of Object.entries(shifted)) m[ch] = [KEY_MAP[code], true];
  const plain: Record<string, string> = {
    ' ': 'Space', '-': 'Minus', '^': 'Equal', ';': 'Semicolon', ':': 'Quote',
    ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'IntlBackslash',
    '@': 'BracketLeft', '[': 'BracketRight', ']': 'Backslash', '\n': 'Enter',
  };
  for (const [ch, code] of Object.entries(plain)) m[ch] = [KEY_MAP[code], false];
  return m;
})();

export class EnterpriseKeyboard {
  private readonly matrix = new Uint8Array(ROWS).fill(0xFF);
  /** Keys held by the typer, kept apart from the host's so that releasing
   *  one does not drop the other. */
  private readonly typed = new Uint8Array(ROWS).fill(0xFF);

  /** The scanned rows, for the on-screen keyboard. Live buffer. */
  get rows(): Uint8Array { return this.matrix; }

  read(row: number): number {
    return row < ROWS ? this.matrix[row] & this.typed[row] : 0xFF;
  }

  setKey(row: number, bit: number, pressed: boolean): void {
    if (row < 0 || row >= ROWS) return;
    const mask = 1 << (bit & 7);
    if (pressed) this.matrix[row] &= ~mask & 0xFF;
    else this.matrix[row] |= mask;
  }

  handleKeyEvent(code: string, pressed: boolean): boolean {
    const cell = KEY_MAP[code];
    if (!cell) return false;
    this.setKey(cell[0], cell[1], pressed);
    return true;
  }

  /** Press (or with null, release) the keys that type `ch` on the typer's
   *  layer. Returns false for a character with no key. */
  setTypedChar(ch: string | null): boolean {
    this.typed.fill(0xFF);
    if (ch === null) return true;
    const entry = CHAR_MAP[ch];
    if (!entry) return false;
    const [cell, shift] = entry;
    this.typed[cell[0]] &= ~(1 << cell[1]) & 0xFF;
    if (shift) this.typed[SHIFT[0]] &= ~(1 << SHIFT[1]) & 0xFF;
    return true;
  }

  /** Whether `ch` can be typed. */
  static canType(ch: string): boolean { return ch in CHAR_MAP; }

  reset(): void {
    this.matrix.fill(0xFF);
    this.typed.fill(0xFF);
  }
}
