/**
 * EinsteinKeyboard — Tatung Einstein 8×8 keyboard matrix.
 *
 * The matrix is scanned through the AY-3-8910 (there is no separate keyboard
 * controller): the CPU writes AY port A (register 14) to select rows — 8 bits,
 * active-low, a 0 enables that row (LINE0–LINE7) — and reads AY port B
 * (register 15) to get that row's columns, active-low (0 = key down). Several
 * rows may be selected at once; the read returns the AND of the selected rows.
 *
 * SHIFT / CONTROL / GRAPH are NOT in this matrix — they (plus the joystick fire
 * buttons and printer status) are read from the I/O 0x20 status port instead.
 *
 * Matrix layout is the authoritative MAME `einstein.cpp` matrix. The host-key
 * map is best-effort by physical position (US layout).
 */

const LINES = 8;

/** [line, bit] for each matrix key. */
type Cell = readonly [number, number];

/** KeyboardEvent.code → Einstein matrix cell. */
const KEY_MAP: Record<string, Cell> = {
  // Letters
  KeyA: [6, 6], KeyB: [7, 2], KeyC: [7, 4], KeyD: [6, 4], KeyE: [5, 4],
  KeyF: [6, 3], KeyG: [6, 2], KeyH: [6, 1], KeyI: [1, 0], KeyJ: [6, 0],
  KeyK: [2, 0], KeyL: [2, 1], KeyM: [7, 0], KeyN: [7, 1], KeyO: [1, 1],
  KeyP: [1, 2], KeyQ: [5, 6], KeyR: [5, 3], KeyS: [6, 5], KeyT: [5, 2],
  KeyU: [5, 0], KeyV: [7, 3], KeyW: [5, 5], KeyX: [7, 5], KeyY: [5, 1],
  KeyZ: [7, 6],
  // Digits (unshifted)
  Digit0: [1, 7], Digit1: [4, 6], Digit2: [4, 5], Digit3: [4, 4], Digit4: [4, 3],
  Digit5: [4, 2], Digit6: [4, 1], Digit7: [4, 0], Digit8: [3, 3], Digit9: [2, 6],
  // Whitespace / control
  Space: [0, 6], Enter: [0, 5], Escape: [0, 7], Tab: [2, 5],
  Backspace: [3, 4], Delete: [3, 4],       // → DELETE
  CapsLock: [0, 4],                          // ALPHA LOCK
  // Cursor keys
  ArrowLeft: [1, 3], ArrowDown: [1, 5], ArrowRight: [2, 4], ArrowUp: [3, 6],
  // Punctuation (best-effort, US layout)
  Minus: [1, 4], Equal: [3, 5], Semicolon: [2, 2], Quote: [2, 3],
  Comma: [3, 0], Period: [3, 1], Slash: [3, 2], Backquote: [1, 6],
  Backslash: [1, 6],
  // Function keys F0–F7
  F1: [0, 2],  // F0
  F2: [6, 7],  // F1
  F3: [5, 7],  // F2
  F4: [4, 7],  // F3
  F5: [3, 7],  // F4
  F6: [2, 7],  // F5
  F7: [7, 7],  // F6
  F8: [0, 3],  // F7
  // BREAK
  Pause: [0, 0],
};

export class EinsteinKeyboard {
  /** Per-row column state, active-low. 0xFF = all keys on that row released. */
  private readonly matrix = new Uint8Array(LINES).fill(0xFF);

  /** Row-select mask from AY port A, active-low (0 bit selects that row). */
  private selectMask = 0xFF;

  // Modifier / status keys read via I/O 0x20 (active-low in the status byte).
  private shift = false;
  private control = false;
  private graph = false;
  private fire1 = false;
  private fire2 = false;

  /** ALPHA LOCK latch (Einstein 256): toggled by any port 0x22 access, read
   *  back via port 0x26 bit0 and mirrored on the keyboard LED. */
  private alphaLock = true;

  /** AY port A write — select the rows to scan. */
  selectRows(mask: number): void { this.selectMask = mask & 0xFF; }

  /** AY port B read — AND of the columns of every selected (0-bit) row. */
  readColumns(): number {
    let v = 0xFF;
    for (let r = 0; r < LINES; r++) {
      if ((this.selectMask & (1 << r)) === 0) v &= this.matrix[r];
    }
    return v;
  }

  /** I/O 0x20 status byte: b0/b1 fire, b2–b4 printer (idle=1), b5 GRAPH,
   *  b6 CONTROL, b7 SHIFT — all active-low. */
  statusByte(): number {
    let v = 0xFF;
    if (this.fire1) v &= ~0x01;
    if (this.fire2) v &= ~0x02;
    if (this.graph) v &= ~0x20;
    if (this.control) v &= ~0x40;
    if (this.shift) v &= ~0x80;
    return v & 0xFF;
  }

  setKey(line: number, bit: number, pressed: boolean): void {
    if (line < 0 || line >= LINES) return;
    const mask = 1 << (bit & 7);
    if (pressed) this.matrix[line] &= ~mask & 0xFF;
    else this.matrix[line] |= mask;
  }

  /** Handle a host key event by physical code. Returns true if mapped. */
  handleKeyEvent(code: string, pressed: boolean): boolean {
    switch (code) {
      case 'ShiftLeft': case 'ShiftRight': this.shift = pressed; return true;
      case 'ControlLeft': case 'ControlRight': this.control = pressed; return true;
      case 'AltLeft': case 'AltRight': this.graph = pressed; return true;
    }
    const cell = KEY_MAP[code];
    if (!cell) return false;
    this.setKey(cell[0], cell[1], pressed);
    return true;
  }

  setJoystick(dir: 'fire1' | 'fire2', pressed: boolean): void {
    if (dir === 'fire1') this.fire1 = pressed;
    else this.fire2 = pressed;
  }

  /** Port 0x22 (Einstein 256): any access toggles the ALPHA LOCK latch. */
  toggleAlphaLock(): void { this.alphaLock = !this.alphaLock; }
  /** ALPHA LOCK latch state (LED). */
  get alphaLockState(): boolean { return this.alphaLock; }
  /** Whether the ALPHA LOCK key itself is currently held (matrix line 0 bit 4)
   *  — port 0x26 bit0 on the 256. */
  alphaLockKeyPressed(): boolean { return (this.matrix[0] & 0x10) === 0; }

  /** Einstein 256 joystick port low nibble bits (active-low, b4 = fire).
   *  Directions are not mapped yet; fire rides the fire1/fire2 state. */
  joystickByte(stick: 1 | 2): number {
    const fire = stick === 1 ? this.fire1 : this.fire2;
    return fire ? 0x0F : 0x1F;
  }

  reset(): void {
    this.matrix.fill(0xFF);
    this.selectMask = 0xFF;
    this.shift = this.control = this.graph = false;
    this.fire1 = this.fire2 = false;
    this.alphaLock = true;
  }
}
