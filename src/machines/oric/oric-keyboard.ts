/**
 * Oric keyboard matrix.
 *
 * A passive 8x8 matrix with no encoder. The ROM drives a row (0-7) out of VIA
 * port B bits 0-2 into a demultiplexer, drives a column mask out of the PSG's
 * port A (negative logic — one bit clear selects a column), and reads VIA port
 * B bit 3, where a 1 means no key is pressed at that intersection. An
 * interrupt every hundredth of a second runs the scan, three jiffies in four.
 *
 * The layout below is MAME's `tangerine/oric.cpp` transcription of the UK
 * machine's port definitions: it is the only public source that gives both the
 * physical cell and the unshifted and shifted symbols each key produces. Cells
 * MAME leaves unused are absent (they are unwired on both machines).
 *
 * The Atmos adds one key to the Oric-1: Funct, at row 5, column 4.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';

/** [row, column] in the Oric's 8x8 matrix. `row` is VIA PB0-PB2, `column` is
 *  the PSG port A bit the ROM clears to select it. */
export type OricCell = readonly [number, number];

export interface OricKeyDef {
  readonly cell: OricCell;
  /** Unshifted symbol, or null for a key with no character of its own. */
  readonly plain: string | null;
  /** Shifted symbol, or null when SHIFT does nothing to it. */
  readonly shifted: string | null;
}

/**
 * Every wired key, in physical order. `hostCode` is the browser key code that
 * presses it.
 */
export const ORIC_KEYS: readonly (OricKeyDef & { readonly hostCode: string })[] = [
  // ── Row 0 ── 7 N 5 V right-CTRL 1 X 3
  { hostCode: 'Digit7', cell: [0, 0], plain: '7', shifted: '&' },
  { hostCode: 'KeyN', cell: [0, 1], plain: 'n', shifted: 'N' },
  { hostCode: 'Digit5', cell: [0, 2], plain: '5', shifted: '%' },
  { hostCode: 'KeyV', cell: [0, 3], plain: 'v', shifted: 'V' },
  { hostCode: 'ControlRight', cell: [0, 4], plain: null, shifted: null },
  { hostCode: 'Digit1', cell: [0, 5], plain: '1', shifted: '!' },
  { hostCode: 'KeyX', cell: [0, 6], plain: 'x', shifted: 'X' },
  { hostCode: 'Digit3', cell: [0, 7], plain: '3', shifted: '#' },

  // ── Row 1 ── J T R F (unused) ESC Q D
  { hostCode: 'KeyJ', cell: [1, 0], plain: 'j', shifted: 'J' },
  { hostCode: 'KeyT', cell: [1, 1], plain: 't', shifted: 'T' },
  { hostCode: 'KeyR', cell: [1, 2], plain: 'r', shifted: 'R' },
  { hostCode: 'KeyF', cell: [1, 3], plain: 'f', shifted: 'F' },
  { hostCode: 'Escape', cell: [1, 5], plain: null, shifted: null },
  { hostCode: 'KeyQ', cell: [1, 6], plain: 'q', shifted: 'Q' },
  { hostCode: 'KeyD', cell: [1, 7], plain: 'd', shifted: 'D' },

  // ── Row 2 ── M 6 B 4 CTRL Z 2 C
  { hostCode: 'KeyM', cell: [2, 0], plain: 'm', shifted: 'M' },
  { hostCode: 'Digit6', cell: [2, 1], plain: '6', shifted: '^' },
  { hostCode: 'KeyB', cell: [2, 2], plain: 'b', shifted: 'B' },
  { hostCode: 'Digit4', cell: [2, 3], plain: '4', shifted: '$' },
  { hostCode: 'ControlLeft', cell: [2, 4], plain: null, shifted: null },
  { hostCode: 'KeyZ', cell: [2, 5], plain: 'z', shifted: 'Z' },
  { hostCode: 'Digit2', cell: [2, 6], plain: '2', shifted: '@' },
  { hostCode: 'KeyC', cell: [2, 7], plain: 'c', shifted: 'C' },

  // ── Row 3 ── K 9 ; - (unused) (unused) \ '
  { hostCode: 'KeyK', cell: [3, 0], plain: 'k', shifted: 'K' },
  { hostCode: 'Digit9', cell: [3, 1], plain: '9', shifted: '(' },
  { hostCode: 'Semicolon', cell: [3, 2], plain: ';', shifted: ':' },
  { hostCode: 'Minus', cell: [3, 3], plain: '-', shifted: '\u00a3' },
  { hostCode: 'Backslash', cell: [3, 6], plain: '\\', shifted: '|' },
  { hostCode: 'Quote', cell: [3, 7], plain: "'", shifted: '"' },

  // ── Row 4 ── SPACE , . up L-SHIFT left down right
  { hostCode: 'Space', cell: [4, 0], plain: ' ', shifted: ' ' },
  { hostCode: 'Comma', cell: [4, 1], plain: ',', shifted: '<' },
  { hostCode: 'Period', cell: [4, 2], plain: '.', shifted: '>' },
  { hostCode: 'ArrowUp', cell: [4, 3], plain: null, shifted: null },
  { hostCode: 'ShiftLeft', cell: [4, 4], plain: null, shifted: null },
  { hostCode: 'ArrowLeft', cell: [4, 5], plain: null, shifted: null },
  { hostCode: 'ArrowDown', cell: [4, 6], plain: null, shifted: null },
  { hostCode: 'ArrowRight', cell: [4, 7], plain: null, shifted: null },

  // ── Row 5 ── U I O P FUNCT DEL ] [
  { hostCode: 'KeyU', cell: [5, 0], plain: 'u', shifted: 'U' },
  { hostCode: 'KeyI', cell: [5, 1], plain: 'i', shifted: 'I' },
  { hostCode: 'KeyO', cell: [5, 2], plain: 'o', shifted: 'O' },
  { hostCode: 'KeyP', cell: [5, 3], plain: 'p', shifted: 'P' },
  // The Atmos's Funct key is where the Oric-1 leaves row 5 column 4 unwired.
  { hostCode: 'AltLeft', cell: [5, 4], plain: null, shifted: null },
  { hostCode: 'Backspace', cell: [5, 5], plain: null, shifted: null },
  { hostCode: 'BracketRight', cell: [5, 6], plain: ']', shifted: '}' },
  { hostCode: 'BracketLeft', cell: [5, 7], plain: '[', shifted: '{' },

  // ── Row 6 ── Y H G E ALTGR A S W
  { hostCode: 'KeyY', cell: [6, 0], plain: 'y', shifted: 'Y' },
  { hostCode: 'KeyH', cell: [6, 1], plain: 'h', shifted: 'H' },
  { hostCode: 'KeyG', cell: [6, 2], plain: 'g', shifted: 'G' },
  { hostCode: 'KeyE', cell: [6, 3], plain: 'e', shifted: 'E' },
  { hostCode: 'AltRight', cell: [6, 4], plain: null, shifted: null },
  { hostCode: 'KeyA', cell: [6, 5], plain: 'a', shifted: 'A' },
  { hostCode: 'KeyS', cell: [6, 6], plain: 's', shifted: 'S' },
  { hostCode: 'KeyW', cell: [6, 7], plain: 'w', shifted: 'W' },

  // ── Row 7 ── 8 L 0 / R-SHIFT RET (unwired) =
  { hostCode: 'Digit8', cell: [7, 0], plain: '8', shifted: '*' },
  { hostCode: 'KeyL', cell: [7, 1], plain: 'l', shifted: 'L' },
  { hostCode: 'Digit0', cell: [7, 2], plain: '0', shifted: ')' },
  { hostCode: 'Slash', cell: [7, 3], plain: '/', shifted: '?' },
  { hostCode: 'ShiftRight', cell: [7, 4], plain: null, shifted: null },
  { hostCode: 'Enter', cell: [7, 5], plain: null, shifted: null },
  { hostCode: 'Equal', cell: [7, 7], plain: '=', shifted: '+' },
];

/** host key code -> matrix cell. */
export const ORIC_KEY_CELLS: Record<string, OricCell> = Object.fromEntries(
  ORIC_KEYS.map(k => [k.hostCode, k.cell]),
);

/** Printable character -> the key that types it and whether SHIFT is needed.
 *  Routing by the produced character lets a PC user type the Oric's own shifted
 *  symbols (which are not a PC keyboard's) without relearning the layout. */
export const ORIC_CHAR_KEYS: Record<string, { cell: OricCell; shift: boolean }> = buildCharKeys();

function buildCharKeys(): Record<string, { cell: OricCell; shift: boolean }> {
  const out: Record<string, { cell: OricCell; shift: boolean }> = {};
  for (const key of ORIC_KEYS) {
    if (key.plain !== null && out[key.plain] === undefined && !/[A-Z]/.test(key.plain)) {
      out[key.plain] = { cell: key.cell, shift: false };
    }
    if (key.shifted !== null && out[key.shifted] === undefined && !/[A-Z]/.test(key.shifted)) {
      out[key.shifted] = { cell: key.cell, shift: true };
    }
  }
  return out;
}

const cellKey = (row: number, col: number): number => row * 8 + col;

export class OricKeyboard {
  /** Pressed matrix cells, keyed row*8+column. */
  private readonly cells = new Set<number>();
  /** SHIFT is a matrix cell of its own (row 4 column 4, and row 7 column 4) and
   *  also the modifier that produces the upper symbols; both are tracked. */
  shiftHeld = false;
  ctrlHeld = false;

  /** Press/release a raw matrix cell (the on-screen keyboard's path). */
  setCell(row: number, col: number, down: boolean): void {
    const key = cellKey(row, col);
    if (down) this.cells.add(key); else this.cells.delete(key);
  }

  isPressed(row: number, col: number): boolean {
    return this.cells.has(cellKey(row, col));
  }

  /** Press the key that types `ch`, with SHIFT when the symbol needs it. The
   *  caller releases it (`releaseAll`) after the ROM has read it. */
  pressChar(ch: string): boolean {
    const mapped = ORIC_CHAR_KEYS[ch];
    if (mapped) {
      if (mapped.shift) this.pressShift(true);
      this.setCell(mapped.cell[0], mapped.cell[1], true);
      return true;
    }
    // A letter: by face, with SHIFT for the capital.
    const lower = ch.toLowerCase();
    if (/^[a-z]$/.test(lower)) {
      const key = ORIC_KEYS.find(k => k.plain === lower);
      if (key) {
        if (ch !== lower) this.pressShift(true);
        this.setCell(key.cell[0], key.cell[1], true);
        return true;
      }
    }
    return false;
  }

  /**
   * Hold or release SHIFT as the matrix itself, which is where the ROM reads it.
   *
   * SHIFT is not a modifier the machine infers: it is two ordinary matrix keys
   * (row 4 column 4 and row 7 column 4) that the scan finds like any other, and
   * the ROM then uses the result to translate the character it found. Setting
   * only an emulator-side flag leaves the ROM convinced nothing is shifted,
   * which is how `"` used to arrive as `'` and `*` as `8`.
   */
  pressShift(down: boolean): void {
    this.shiftHeld = down;
    this.setCell(4, 4, down);
    this.setCell(7, 4, down);
  }

  /** Decode a host key event into the matrix. Returns true when consumed. */
  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.pressShift(down);
      return true;
    }
    if (event.code === 'ControlLeft' || event.code === 'ControlRight') {
      this.ctrlHeld = down;
      const cell = ORIC_KEY_CELLS[event.code];
      if (cell) this.setCell(cell[0], cell[1], down);
      return true;
    }
    // The host's own modifier state drives SHIFT, which is a matrix cell: a
    // user holding Shift gets the Oric's shifted symbols, exactly as on the
    // real keyboard.
    this.pressShift(event.shift);
    this.ctrlHeld = event.ctrl;

    // Printable characters route by what they produce: the Oric's shifted
    // symbols live on different keys from a PC's.
    if (event.key.length === 1) {
      const mapped = ORIC_CHAR_KEYS[event.key];
      if (mapped) {
        // The needed symbol's own shift is asserted whatever the host reports,
        // so a shifted character always arrives as itself.
        if (mapped.shift) this.pressShift(true);
        this.setCell(mapped.cell[0], mapped.cell[1], down);
        return true;
      }
      const lower = event.key.toLowerCase();
      if (/^[a-z]$/.test(lower)) {
        const key = ORIC_KEYS.find(k => k.plain === lower);
        if (key) {
          if (event.key !== lower) this.pressShift(true);
          this.setCell(key.cell[0], key.cell[1], down);
          return true;
        }
      }
    }

    const cell = ORIC_KEY_CELLS[event.code];
    if (!cell) return false;
    this.setCell(cell[0], cell[1], down);
    return true;
  }

  /**
   * The sense line (VIA port B bit 3) for the row the VIA has selected and the
   * column mask the PSG's port A holds. **1 means a key is pressed.**
   *
   * The polarity is the one thing that is easy to get backwards, so it is
   * pinned by three independent sources: the hardware reference ("reading the
   * result in PB3: a 1 means the key is pressed"), Oricutron writing `0x08` to
   * PB3 when it finds a match, and the ROM itself — `$F578` reads port B and
   * `$F57B` does `AND #$08 / BNE` to take its key-found branch.
   *
   * The PSG's port A selects a column by *clearing* its bit, so the selected
   * column joins a pressed key in the selected row to the sense line. The ROM
   * clears one bit at a time, so in practice one column is selected per read;
   * an "any key on this row" scan clears several.
   */
  sense(row: number, columnMask: number): boolean {
    if (row >= 8) return false;
    for (let col = 0; col < 8; col++) {
      if ((columnMask & (1 << col)) !== 0) continue;
      if (this.cells.has(cellKey(row, col))) return true;
    }
    return false;
  }

  anyPressed(): boolean { return this.cells.size > 0; }

  /**
   * The live matrix as eight row bytes, active **high**: bit `col` is set when
   * that cell is pressed. This is the shape the on-screen keyboard mirrors, so
   * a physical keystroke lights the cap as well as a pointer press.
   */
  get rows(): readonly number[] {
    if (!this.rowCache) this.rowCache = new Uint8Array(8);
    this.rowCache.fill(0);
    for (const key of this.cells) {
      this.rowCache[key >> 3] |= 1 << (key & 7);
    }
    return Array.from(this.rowCache);
  }

  /** Reused row buffer, so `rows` allocates nothing per frame. */
  private rowCache: Uint8Array | null = null;

  releaseAll(): void {
    this.cells.clear();
    this.shiftHeld = this.ctrlHeld = false;
  }
}
