/**
 * CpcKeyboard — Amstrad CPC keyboard matrix.
 *
 * The keyboard is read through the AY-3-8912's I/O port A: the 8255 PPI port C
 * low nibble selects one of the 10 matrix lines and a PSG port-A read returns
 * that line's state (active-low: 0 = pressed). Line 9 doubles as joystick 0.
 *
 * Matrix layout (line, bit) is the authoritative CPC matrix (CPCTech). The
 * host-key map below is best-effort by physical key position (US layout); the
 * CPC's own SHIFT/CTRL keys in the matrix produce shifted characters, so we map
 * each host key to its base matrix cell.
 */

import type { CpcAmxMouse } from '@/machines/cpc/peripherals/cpc-amx-mouse.ts';

const LINES = 10;

/** Matrix line carrying joystick 0 — and the AMX mouse, which is wired here. */
const JOY0_LINE = 9;

/** [line, bit] for each matrix key. */
type Cell = readonly [number, number];

/** KeyboardEvent.code → CPC matrix cell. */
const KEY_MAP: Record<string, Cell> = {
  // Letters
  KeyA: [8, 5], KeyB: [6, 6], KeyC: [7, 6], KeyD: [7, 5], KeyE: [7, 2],
  KeyF: [6, 5], KeyG: [6, 4], KeyH: [5, 4], KeyI: [4, 3], KeyJ: [5, 5],
  KeyK: [4, 5], KeyL: [4, 4], KeyM: [4, 6], KeyN: [5, 6], KeyO: [4, 2],
  KeyP: [3, 3], KeyQ: [8, 3], KeyR: [6, 2], KeyS: [7, 4], KeyT: [6, 3],
  KeyU: [5, 2], KeyV: [6, 7], KeyW: [7, 3], KeyX: [7, 7], KeyY: [5, 3],
  KeyZ: [8, 7],
  // Digits
  Digit0: [4, 0], Digit1: [8, 0], Digit2: [8, 1], Digit3: [7, 1], Digit4: [7, 0],
  Digit5: [6, 1], Digit6: [6, 0], Digit7: [5, 1], Digit8: [5, 0], Digit9: [4, 1],
  // Whitespace / control
  Space: [5, 7], Enter: [2, 2], Tab: [8, 4], Escape: [8, 2],
  Backspace: [9, 7], Delete: [2, 0], // Backspace→DEL, Delete→CLR
  ShiftLeft: [2, 5], ShiftRight: [2, 5], ControlLeft: [2, 7], ControlRight: [2, 7],
  CapsLock: [8, 6],
  // Cursor keys
  ArrowUp: [0, 0], ArrowRight: [0, 1], ArrowDown: [0, 2], ArrowLeft: [1, 0],
  // Punctuation (best-effort, US layout)
  Minus: [3, 1], Equal: [3, 0], BracketLeft: [2, 1], BracketRight: [2, 3],
  Backslash: [2, 6], Semicolon: [3, 4], Quote: [3, 5], Backquote: [2, 6],
  Comma: [4, 7], Period: [3, 7], Slash: [3, 6],
  // UK ISO key left of Z (\ / |) → the CPC @/| key (line 3 bit 2), so
  // Shift+this gives | (needed for RSX commands like |CPM, |CAT).
  IntlBackslash: [3, 2],
  // Numeric keypad → CPC function keys
  Numpad0: [1, 7], Numpad1: [1, 5], Numpad2: [1, 6], Numpad3: [0, 5],
  Numpad4: [2, 4], Numpad5: [1, 4], Numpad6: [0, 4], Numpad7: [1, 2],
  Numpad8: [1, 3], Numpad9: [0, 3], NumpadDecimal: [0, 7], NumpadEnter: [0, 6],
};

export class CpcKeyboard {
  /** Per-line state, active-low. 0xFF = all keys on that line released. */
  private readonly matrix = new Uint8Array(LINES).fill(0xFF);

  /** Live matrix view for the CPC-owned on-screen keyboard highlighter. */
  get rows(): Uint8Array {
    return this.matrix;
  }

  /** Currently selected line (PPI port C bits 0–3). */
  private selectedLine = 0;

  /** AMX mouse, when fitted — it presents on line 9 (the joystick-0 lines) and
   *  retires a movement mickey each time the firmware deselects that line. */
  amx: CpcAmxMouse | null = null;

  selectLine(line: number): void {
    const next = line & 0x0F;
    // The AMX mouse updates (consumes a mickey) when line 9 is deselected.
    if (this.amx?.enabled && this.selectedLine === JOY0_LINE && next !== JOY0_LINE) {
      this.amx.consumeStep();
    }
    this.selectedLine = next;
  }

  read(): number {
    const v = this.selectedLine < LINES ? this.matrix[this.selectedLine] : 0xFF;
    if (this.amx?.enabled && this.selectedLine === JOY0_LINE) return this.amx.applyToLine9(v);
    return v;
  }

  setKey(line: number, bit: number, pressed: boolean): void {
    if (line < 0 || line >= LINES) return;
    const mask = 1 << (bit & 7);
    if (pressed) this.matrix[line] &= ~mask & 0xFF;
    else this.matrix[line] |= mask;
  }

  /** Handle a host key event by physical code. Returns true if mapped. */
  handleKeyEvent(code: string, pressed: boolean): boolean {
    const cell = KEY_MAP[code];
    if (!cell) return false;
    this.setKey(cell[0], cell[1], pressed);
    return true;
  }

  /**
   * Joystick directions share matrix bits: bit0 up, bit1 down, bit2 left,
   * bit3 right, bit4 fire2, bit5 fire1. Joystick 0 lives on line 9; joystick 1
   * is multiplexed onto line 6 (the hardware reads the second joystick — wired
   * through the splitter on the single port — in parallel with the 6/5/R/T/G/F
   * keys), which is how CPC games poll player 2.
   */
  setJoystick(dir: 'up' | 'down' | 'left' | 'right' | 'fire1' | 'fire2', pressed: boolean, player = 0): void {
    const bit = { up: 0, down: 1, left: 2, right: 3, fire2: 4, fire1: 5 }[dir];
    this.setKey(player === 1 ? 6 : 9, bit, pressed);
  }

  reset(): void {
    this.matrix.fill(0xFF);
    this.selectedLine = 0;
  }
}
