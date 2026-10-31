/**
 * LynxKeyboard — Camputers Lynx 10-line keyboard matrix, active low.
 *
 * The lines are not selected by a write: a read of port 0x80 carries the line
 * number in address bits A8-A11, so `IN A,(0x80)` with B holding 3 reads line
 * 3. Line 0 doubles as the cassette input — bit 0 becomes the tape signal
 * while the motor bit is set — which is why the read goes through the machine
 * rather than straight to this class.
 *
 * The matrix is MAME's `camplynx.cpp` LINE0-LINE9, plus SHIFT LOCK at [0,3] —
 * a cell MAME leaves unnamed and the MiSTer Lynx48 core identifies. Between
 * them they account for every cap on the deck but BREAK, and for every cell
 * but [9,4], which no cap reaches. The host map is by physical position; the
 * Lynx has no function keys, so nothing here competes with the browser for
 * F1-F12.
 *
 * BREAK is not a matrix key at all. Camputers' keyboard circuit diagram draws
 * it as a lone push-button from keyboard-connector pin 6 to 0V (R9, 4K7, pulls
 * the pin up), and the 128K motherboard diagram (sheet 5, "Input/Output") runs
 * that pin, PL1/6 "BREAK", straight onto the Z80's /INT line, wire-ORed with
 * the 6845's interrupt one-shot. Holding BREAK therefore holds /INT low: a
 * maskable interrupt the CPU takes whenever it has interrupts enabled, for as
 * long as the key is down. What that does is the ROM's business (Computing
 * Today's June 1983 review found it "appears to do nothing in particular";
 * ESC is the key that stops a program). The host's Pause key is BREAK.
 */

const LINES = 10;

/** [line, bit] for each matrix key. */
type Cell = readonly [line: number, bit: number];

/** KeyboardEvent.code → Lynx matrix cell. */
const KEY_MAP: Record<string, Cell> = {
  // Digits
  Digit1: [0, 0], Digit2: [2, 0], Digit3: [1, 0], Digit4: [1, 1], Digit5: [3, 0],
  Digit6: [4, 0], Digit7: [5, 0], Digit8: [5, 1], Digit9: [6, 0], Digit0: [7, 0],

  // Letters
  KeyA: [2, 5], KeyB: [4, 5], KeyC: [1, 5], KeyD: [1, 4], KeyE: [1, 2],
  KeyF: [3, 5], KeyG: [3, 4], KeyH: [4, 2], KeyI: [6, 1], KeyJ: [5, 5],
  KeyK: [6, 5], KeyL: [7, 2], KeyM: [5, 3], KeyN: [4, 4], KeyO: [6, 2],
  KeyP: [7, 1], KeyQ: [2, 1], KeyR: [3, 1], KeyS: [2, 4], KeyT: [3, 2],
  KeyU: [5, 2], KeyV: [3, 3], KeyW: [2, 2], KeyX: [1, 3], KeyY: [4, 1],
  KeyZ: [2, 3],

  // Punctuation, in the Lynx's own places
  Comma: [6, 3], Period: [7, 3], Semicolon: [7, 5], Quote: [8, 5],
  Slash: [8, 3], BracketLeft: [8, 2], BracketRight: [9, 1],
  Equal: [8, 1], Minus: [8, 0],

  // Whitespace and control
  Space: [4, 3], Enter: [9, 3], Backspace: [9, 0], Escape: [0, 6],
  ShiftLeft: [0, 7], ShiftRight: [0, 7],
  ControlLeft: [2, 6], ControlRight: [2, 6],
  CapsLock: [0, 3],

  // Cursor keys
  ArrowUp: [0, 4], ArrowDown: [0, 5], ArrowLeft: [9, 2], ArrowRight: [9, 5],
};

/** The host key that is BREAK: Pause, the PC keyboard's own break key. */
const BREAK_CODE = 'Pause';

export class LynxKeyboard {
  /** Per-line column state, active low. 0xFF = every key on that line up. */
  private readonly matrix = new Uint8Array(LINES).fill(0xFF);

  /** BREAK is down, holding the CPU's /INT line low (see the header). */
  breakDown = false;

  /** The ten scanned lines, for the on-screen keyboard to read state from.
   *  Live buffer; callers copy what they keep. */
  get rows(): Uint8Array { return this.matrix; }

  /** The columns of one line, active low. Lines outside 0-9 read as idle. */
  read(line: number): number {
    return line >= 0 && line < LINES ? this.matrix[line] : 0xFF;
  }

  setKey(line: number, bit: number, pressed: boolean): void {
    if (line < 0 || line >= LINES) return;
    const mask = 1 << (bit & 7);
    if (pressed) this.matrix[line] &= ~mask & 0xFF;
    else this.matrix[line] |= mask;
  }

  /** Press or release BREAK. */
  setBreak(pressed: boolean): void { this.breakDown = pressed; }

  /** Handle a host key event by physical code. Returns true if mapped. */
  handleKeyEvent(code: string, pressed: boolean): boolean {
    if (code === BREAK_CODE) { this.breakDown = pressed; return true; }
    const cell = KEY_MAP[code];
    if (!cell) return false;
    this.setKey(cell[0], cell[1], pressed);
    return true;
  }

  reset(): void {
    this.matrix.fill(0xFF);
    this.breakDown = false;
  }
}
