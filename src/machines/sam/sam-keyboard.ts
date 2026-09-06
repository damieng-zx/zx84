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
 * Every position above is SimCoupe's `eSamKey` enum (`Base/Keyboard.h`) read in
 * order, eight to a row — including the nine punctuation keys, which is the
 * part that used to be reconstructed guesswork.
 *
 * Row selection follows the Spectrum: each clear bit of the port's high byte
 * selects a row, and the rows selected are ANDed together. The ninth row is
 * squeezed in by selecting it when the high byte is 0xFF — that is, when no
 * ordinary row is selected — so the cursor keys and CNTRL cost no address line.
 * Note that row 8 is reachable only through port 0xFE, never through 0xF9.
 *
 * ── Why the host mapping is by character, not by key position ──
 *
 * The SAM's punctuation is nothing like a PC's. It has dedicated MINUS, PLUS,
 * EQUALS, QUOTES, SEMICOLON and COLON keys, no bracket or slash keys at all,
 * and reaches `[ ] { } < > ? ^ |` through SYMBOL chords. Mapping by physical
 * position therefore puts the wrong character under most of the right-hand
 * keys, and leaves several — `"` among them — unreachable.
 *
 * So punctuation is routed by the character the host key *produced*
 * (`KeyboardEvent.key`), through `CHAR_MAP`, which is SimCoupe's `asSamKeys`
 * table. Type `"` however your layout makes it and the SAM sees its QUOTES key;
 * type `{` and it sees SYMBOL+F. Letters, digits and the navigation keys still
 * go by `code`, so gameplay keys stay where the key physically is.

 *
 * Transcribed from SimCoupe's `Base/Keyboard.cpp` / `Base/Keyboard.h` and the
 * port 0xFE / 0xF9 read paths in `Base/SAMIO.cpp`.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';

/** Rows in the matrix; row 8 holds CNTRL and the cursor keys. */
const ROWS = 9;
/** Bits per row. */
const BITS = 8;

/** Where a host key sits in the matrix, as [row, bit]. */
type Cell = readonly [number, number];

// The three modifier positions, named because the chord table is unreadable
// without them.
const SHIFT: Cell = [0, 0];
const SYMBOL: Cell = [7, 1];

// Keys the chord table reaches through.
const K_1: Cell = [3, 0], K_2: Cell = [3, 1], K_3: Cell = [3, 2];
const K_4: Cell = [3, 3], K_5: Cell = [3, 4];
const K_0: Cell = [4, 0], K_9: Cell = [4, 1], K_8: Cell = [4, 2];
const K_7: Cell = [4, 3], K_6: Cell = [4, 4];
const MINUS: Cell = [4, 5], PLUS: Cell = [4, 6], DELETE: Cell = [4, 7];
const EQUALS: Cell = [5, 5], QUOTES: Cell = [5, 6];
const SEMICOLON: Cell = [6, 5], COLON: Cell = [6, 6];
const COMMA: Cell = [7, 5], PERIOD: Cell = [7, 6], INV: Cell = [7, 7];
const K_Q: Cell = [2, 0], K_W: Cell = [2, 1], K_R: Cell = [2, 3], K_T: Cell = [2, 4];
const K_X: Cell = [0, 2], K_F: Cell = [1, 3], K_G: Cell = [1, 4];
const K_H: Cell = [6, 4], K_L: Cell = [6, 1];

/**
 * Host `KeyboardEvent.code` to matrix position.
 *
 * The two shift-like keys are deliberately split the way SimCoupe splits them:
 * the left Control key is the SAM's SYMBOL (the Spectrum's symbol-shift
 * position) and the right Control key is the SAM's own CNTRL. Alt is offered as
 * a second SYMBOL because a browser eats some Control chords.
 *
 * The SAM's F0-F9 are a numeric keypad, so both the PC's function keys and its
 * keypad reach them — whichever the host actually has.
 */
const KEY_MAP: Record<string, Cell | readonly Cell[]> = {
  // Row 0
  ShiftLeft: SHIFT, ShiftRight: SHIFT,
  KeyZ: [0, 1], KeyX: K_X, KeyC: [0, 3], KeyV: [0, 4],
  F1: [0, 5], F2: [0, 6], F3: [0, 7],
  Numpad1: [0, 5], Numpad2: [0, 6], Numpad3: [0, 7],
  // Row 1
  KeyA: [1, 0], KeyS: [1, 1], KeyD: [1, 2], KeyF: K_F, KeyG: K_G,
  F4: [1, 5], F5: [1, 6], F6: [1, 7],
  Numpad4: [1, 5], Numpad5: [1, 6], Numpad6: [1, 7],
  // Row 2
  KeyQ: K_Q, KeyW: K_W, KeyE: [2, 2], KeyR: K_R, KeyT: K_T,
  F7: [2, 5], F8: [2, 6], F9: [2, 7],
  Numpad7: [2, 5], Numpad8: [2, 6], Numpad9: [2, 7],
  // Row 3
  Digit1: K_1, Digit2: K_2, Digit3: K_3, Digit4: K_4, Digit5: K_5,
  Escape: [3, 5], Tab: [3, 6], CapsLock: [3, 7],
  // Row 4
  Digit0: K_0, Digit9: K_9, Digit8: K_8, Digit7: K_7, Digit6: K_6,
  Minus: MINUS, Equal: PLUS, Backspace: DELETE,
  // The PC's Delete is the SAM's SHIFT+DELETE (delete forwards).
  Delete: [SHIFT, DELETE],
  // Row 5
  KeyP: [5, 0], KeyO: [5, 1], KeyI: [5, 2], KeyU: [5, 3], KeyY: [5, 4],
  F10: [5, 7], Numpad0: [5, 7],
  // Row 6
  Enter: [6, 0], NumpadEnter: [6, 0],
  KeyL: K_L, KeyK: [6, 2], KeyJ: [6, 3], KeyH: K_H,
  Semicolon: SEMICOLON, Home: [6, 7], ContextMenu: [6, 7],
  // Row 7
  Space: [7, 0],
  ControlLeft: SYMBOL, AltLeft: SYMBOL, AltRight: SYMBOL,
  KeyM: [7, 2], KeyN: [7, 3], KeyB: [7, 4],
  Comma: COMMA, Period: PERIOD, Insert: INV,
  // Row 8 — reachable only when no other row is selected
  ControlRight: [8, 0],
  ArrowUp: [8, 1], ArrowDown: [8, 2], ArrowLeft: [8, 3], ArrowRight: [8, 4],
};

/**
 * Printable character to the keys that produce it on a SAM — SimCoupe's
 * `asSamKeys`.
 *
 * Consulted before `KEY_MAP` for anything that is not a letter, digit or space,
 * so it is the host *layout* that decides which SAM key a symbol reaches. A UK
 * keyboard's Shift+2 gives `"` and lands on QUOTES; a US keyboard's Shift+2
 * gives `@` and lands on SHIFT+2. Neither needs to know about the other.
 */
const CHAR_MAP: Record<string, readonly Cell[]> = {
  '!': [SHIFT, K_1], '@': [SHIFT, K_2], '#': [SHIFT, K_3],
  '$': [SHIFT, K_4], '%': [SHIFT, K_5], '&': [SHIFT, K_6],
  "'": [SHIFT, K_7], '(': [SHIFT, K_8], ')': [SHIFT, K_9],
  '~': [SHIFT, K_0],
  '-': [MINUS], '/': [SHIFT, MINUS],
  '+': [PLUS], '*': [SHIFT, PLUS],
  '=': [EQUALS], '_': [SHIFT, EQUALS],
  '"': [QUOTES], '`': [SHIFT, QUOTES],
  ';': [SEMICOLON], ':': [COLON],
  ',': [COMMA], '.': [PERIOD],
  '<': [SYMBOL, K_Q], '>': [SYMBOL, K_W],
  '[': [SYMBOL, K_R], ']': [SYMBOL, K_T],
  '{': [SYMBOL, K_F], '}': [SYMBOL, K_G],
  '^': [SYMBOL, K_H], '?': [SYMBOL, K_X],
  '|': [SYMBOL, K_9], '\\': [SHIFT, INV],
  '£': [SYMBOL, K_L],
  // Mac layouts put the two pound-ish symbols elsewhere; SimCoupe offers these
  // so UK and US Mac users can reach both.
  '§': [SHIFT, K_3], '±': [SYMBOL, K_L],
};

/** The `code` a bare character would have arrived with, for codeless hosts. */
function codeForChar(key: string): string | null {
  if (key.length !== 1) return null;
  if (key === ' ') return 'Space';
  if (key >= 'a' && key <= 'z') return `Key${key.toUpperCase()}`;
  if (key >= 'A' && key <= 'Z') return `Key${key}`;
  if (key >= '0' && key <= '9') return `Digit${key}`;
  return null;
}

export class SamKeyboard {
  /** One byte per row; a CLEAR bit means that key is currently down. */
  private readonly matrix = new Uint8Array(ROWS).fill(0xFF);

  /**
   * How many sources are holding each position down. A chord and a physical
   * key can both want SHIFT, and the bit must survive until the last of them
   * lets go.
   */
  private readonly pressCount = new Uint8Array(ROWS * BITS);

  /** Chords in flight, by the `code` that started them, so a release undoes
   *  exactly what the press did even if the host's modifiers changed between.
   *  `hidden` are the modifier positions the press had to take out of the
   *  matrix, put back on release if something is still holding them. */
  private readonly active = new Map<string, { cells: readonly Cell[]; hidden: readonly Cell[] }>();

  reset(): void {
    this.matrix.fill(0xFF);
    this.pressCount.fill(0);
    this.active.clear();
  }

  /** Live matrix rows, one byte each, a CLEAR bit meaning held. Read by the
   *  on-screen keyboard so a physical keystroke lights its cap too. */
  get rows(): Uint8Array { return this.matrix; }

  /** Press or release a matrix position directly (tests, on-screen keyboard). */
  setKey(row: number, bit: number, down: boolean): void {
    if (row < 0 || row >= ROWS || bit < 0 || bit >= BITS) return;
    const i = row * BITS + bit;
    if (down) {
      this.pressCount[i]++;
      this.matrix[row] &= ~(1 << bit);
    } else if (this.pressCount[i] > 0 && --this.pressCount[i] === 0) {
      this.matrix[row] |= (1 << bit);
    }
  }

  /** Force a bit up without touching its count — used to hide a modifier the
   *  host is holding but the SAM must not see. `restore` puts it back, and
   *  only if the reference count says something still wants it down. */
  private hide(cell: Cell): void { this.matrix[cell[0]] |= (1 << cell[1]); }
  private restore(cell: Cell): void {
    if (this.pressCount[cell[0] * BITS + cell[1]] > 0) {
      this.matrix[cell[0]] &= ~(1 << cell[1]);
    }
  }

  /** Press `cells`, first taking any of `mask` that the host is holding out of
   *  the matrix. Records both so the release can undo exactly this. */
  private start(slot: string, cells: readonly Cell[], mask: readonly Cell[]): void {
    const hidden = mask.filter(cell => (this.matrix[cell[0]] & (1 << cell[1])) === 0
      && !cells.includes(cell));
    for (const cell of hidden) this.hide(cell);
    this.active.set(slot, { cells, hidden });
    for (const cell of cells) this.setKey(cell[0], cell[1], true);
  }

  /** Route a host key event. Returns true when the key exists on this machine. */
  handleKeyEvent(e: HostKeyEvent, down: boolean): boolean {
    // A release always undoes the chord its press recorded, whatever the host
    // reports now — the modifiers may well have moved on since.
    if (!down) {
      const slot = this.slotFor(e);
      const started = this.active.get(slot);
      if (started) {
        for (const c of started.cells) this.setKey(c[0], c[1], false);
        for (const c of started.hidden) this.restore(c);
        this.active.delete(slot);
        return true;
      }
    }

    const chord = this.chordFor(e);
    if (chord) {
      // A chord that does not want SHIFT must not see the physical one, or
      // `"` (Shift+2 on a UK layout) arrives as SHIFT+QUOTES, which is `@`.
      if (down) this.start(this.slotFor(e), chord, [SHIFT]);
      return true;
    }

    const plain = this.plainFor(e);
    if (!plain) return false;
    if (down) this.start(this.slotFor(e), plain, []);
    else for (const c of plain) this.setKey(c[0], c[1], false);
    return true;
  }

  /**
   * The keys for a non-symbol press: `code` first, and failing that the
   * character itself.
   *
   * The character fallback is for hosts that send no `code` at all — the MCP's
   * `type`, an on-screen keyboard — so a bare "a" or "7" still lands somewhere.
   * A real browser event always carries a code and never reaches it.
   */
  private plainFor(e: HostKeyEvent): readonly Cell[] | null {
    const mapping = KEY_MAP[e.code] ?? KEY_MAP[codeForChar(e.key) ?? ''];
    if (!mapping) return null;
    const cells: readonly Cell[] = typeof mapping[0] === 'number'
      ? [mapping as Cell]
      : mapping as readonly Cell[];
    // An upper-case character with no code of its own still wants SHIFT.
    if (!KEY_MAP[e.code] && e.key.length === 1 && e.key >= 'A' && e.key <= 'Z') {
      return [SHIFT, ...cells];
    }
    return cells;
  }

  /** What to file an in-flight press under. Codeless hosts get the character,
   *  so two of them can be down at once without clobbering each other. */
  private slotFor(e: HostKeyEvent): string { return e.code || e.key; }

  /**
   * The chord for a printable symbol, or null to fall through to `KEY_MAP`.
   *
   * Single characters only, and never a letter, digit or space: those are the
   * keys whose physical position matters (games read the matrix directly), and
   * their unshifted form is already on the SAM where the PC puts it.
   */
  private chordFor(e: HostKeyEvent): readonly Cell[] | null {
    const key = e.key;
    if (!key || key.length !== 1) return null;
    if (key === ' ') return null;
    if ((key >= 'a' && key <= 'z') || (key >= 'A' && key <= 'Z')) return null;
    if (key >= '0' && key <= '9') return null;
    return CHAR_MAP[key] ?? null;
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
