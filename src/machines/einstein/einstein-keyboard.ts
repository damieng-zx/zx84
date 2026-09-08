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
 * Matrix layout follows MAME's `einstein.cpp` matrix, corrected against each
 * MOS's own key-decode table (three 8-byte rows per line — unshifted, shifted,
 * control — at 0x10C5 in MOS 1.2 and 0x1687 in MOS 2.1, LINE1 first) and by
 * sweeping every cell and modifier against both real ROMs.
 *
 * MAME names four separate cursor cells; the TC-01's deck has only two cursor
 * caps, each printing two arrows, and MOS 1.2 agrees: [2,5] decodes to
 * cursor-right unshifted and left (0x08) shifted, [1,5] to down (0x0A) and up
 * (0x0B). The cells MAME calls LEFT, RIGHT and UP are the ←, → and ↑
 * *character* caps ([1,3], [2,4], [3,6]), and its TAB cell is the cursor cap —
 * the Einstein has no TAB key.
 *
 * The 256's four-wedge cursor pad works differently, and MOS 2.1 with it:
 * shifted [1,5] and [2,5] decode to the same codes as unshifted, so SHIFT no
 * longer picks a direction. Left moves to [0,1] — the cell MAME marks unused,
 * and which the TC-01 has no key for — and nothing produces up on its own, so
 * up goes through CONTROL+K, the only route to 0x0B in either ROM.
 *
 * The rest of the host-key map is best-effort by physical position (US layout).
 */

const LINES = 8;

/**
 * Synthetic row index for the status-port modifiers. SHIFT / CONTROL / GRAPH
 * are not wired into the scanned matrix — they live in the I/O 0x20 status byte
 * — but the on-screen keyboard wants to press them as ordinary `[line, bit]`
 * cells, so `rows` and `setKey` accept this ninth line, using the status byte's
 * own bit positions (b7 SHIFT, b6 CONTROL, b5 GRAPH).
 */
export const STATUS_LINE = LINES;

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
  Space: [0, 6], Enter: [0, 5], Escape: [0, 7],
  Backspace: [3, 4], Delete: [3, 4],       // → INS DEL
  CapsLock: [0, 4],                          // ALPHA LOCK
  // Cursor keys are per-model chords — see TC01_ARROWS / E256_ARROWS.
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

const SHIFT_CELL: Cell = [STATUS_LINE, 7];
const CONTROL_CELL: Cell = [STATUS_LINE, 6];

/**
 * Host cursor keys, as chords — see the file header. A chord's status-line cell
 * asserts that modifier for as long as the host key is held, on top of any the
 * user is holding themselves.
 */
const TC01_ARROWS: Record<string, readonly Cell[]> = {
  ArrowLeft: [SHIFT_CELL, [2, 5]],
  ArrowRight: [[2, 5]],
  ArrowUp: [SHIFT_CELL, [1, 5]],
  ArrowDown: [[1, 5]],
};

const E256_ARROWS: Record<string, readonly Cell[]> = {
  ArrowLeft: [[0, 1]],
  ArrowRight: [[2, 5]],
  ArrowUp: [CONTROL_CELL, [2, 0]],
  ArrowDown: [[1, 5]],
};

export class EinsteinKeyboard {
  /** The cursor-key chords for this model. */
  private readonly arrows: Record<string, readonly Cell[]>;

  constructor(model: string = 'einstein-tc01') {
    this.arrows = model === 'einstein-256' ? E256_ARROWS : TC01_ARROWS;
  }

  /** Per-row column state, active-low. 0xFF = all keys on that row released. */
  private readonly matrix = new Uint8Array(LINES).fill(0xFF);

  /** Scratch buffer behind `rows` — the matrix plus the status line. */
  private readonly view = new Uint8Array(LINES + 1).fill(0xFF);

  /** Row-select mask from AY port A, active-low (0 bit selects that row). */
  private selectMask = 0xFF;

  // Modifier / status keys read via I/O 0x20 (active-low in the status byte).
  private shift = false;
  private control = false;
  private graph = false;
  private fire1 = false;
  private fire2 = false;

  /** Cursor keys currently held — a set, not a count, so a key's auto-repeat
   *  cannot leave a chord's modifier stuck on. */
  private readonly heldArrows = new Set<string>();

  /** ALPHA LOCK latch (Einstein 256): toggled by any port 0x22 access, read
   *  back via port 0x26 bit0 and mirrored on the keyboard LED. */
  private alphaLock = true;

  /** Nine-byte view of the key state for the on-screen keyboard: the eight
   *  scanned lines followed by the status line's modifier bits (the joystick
   *  and printer bits are masked out — they are not keys). Live buffer; callers
   *  copy what they keep. */
  get rows(): Uint8Array {
    this.view.set(this.matrix);
    this.view[STATUS_LINE] = this.statusByte() | 0x1F;
    return this.view;
  }

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
    if (this.control || this.chordHolds(6)) v &= ~0x40;
    if (this.shift || this.chordHolds(7)) v &= ~0x80;
    return v & 0xFF;
  }

  setKey(line: number, bit: number, pressed: boolean): void {
    if (line === STATUS_LINE) {
      if (bit === 7) this.shift = pressed;
      else if (bit === 6) this.control = pressed;
      else if (bit === 5) this.graph = pressed;
      return;
    }
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
    const chord = this.arrows[code];
    if (chord) {
      if (pressed) this.heldArrows.add(code);
      else this.heldArrows.delete(code);
      for (const [line, bit] of chord) {
        // The status-line cells are asserted by chordHolds, not the matrix.
        if (line !== STATUS_LINE) this.setKey(line, bit, pressed);
      }
      return true;
    }
    const cell = KEY_MAP[code];
    if (!cell) return false;
    this.setKey(cell[0], cell[1], pressed);
    return true;
  }

  /** Whether a held cursor key's chord asserts the given status-byte bit. */
  private chordHolds(bit: number): boolean {
    for (const code of this.heldArrows) {
      for (const cell of this.arrows[code]) {
        if (cell[0] === STATUS_LINE && cell[1] === bit) return true;
      }
    }
    return false;
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
    this.heldArrows.clear();
    this.fire1 = this.fire2 = false;
    this.alphaLock = true;
  }
}
