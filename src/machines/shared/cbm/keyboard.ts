/**
 * A Commodore keyboard: an 8 × 8 matrix of the same 64 keys on every
 * Commodore of the breadbin family (the C64, the VIC-20), wired differently
 * on each, plus the RESTORE key (an NMI, not part of the matrix), and the
 * host mapping.
 *
 * The matrix is given as `[column][row]`: the column lines are the ones the
 * KERNAL drives low to scan (CIA 1 port A on the 64, VIA 2 port B on the
 * VIC-20) and the row lines the ones it reads. A pressed key joins its two
 * lines, so a line driven low pulls the other low too. That works in both
 * directions (programs that drive the rows and read the columns see the
 * keyboard as well), and it is how the joysticks share the same ports.
 *
 * Host keys map by the character they type where the Commodore has that
 * character (so `"` is SHIFT+2 whatever the host layout), and by position for
 * the keys that do not type (cursors, RETURN, function keys).
 */

import type { HostKeyEvent } from '@/machines/machine.ts';

interface Chord { key: string; shift?: boolean }

/** Printable characters: the key that types each, and whether it is shifted. */
const CHAR_CHORDS: Record<string, Chord> = {
  '1': { key: '1' }, '2': { key: '2' }, '3': { key: '3' }, '4': { key: '4' }, '5': { key: '5' },
  '6': { key: '6' }, '7': { key: '7' }, '8': { key: '8' }, '9': { key: '9' }, '0': { key: '0' },
  '!': { key: '1', shift: true }, '"': { key: '2', shift: true }, '#': { key: '3', shift: true },
  '$': { key: '4', shift: true }, '%': { key: '5', shift: true }, '&': { key: '6', shift: true },
  '\'': { key: '7', shift: true }, '(': { key: '8', shift: true }, ')': { key: '9', shift: true },
  '+': { key: '+' }, '-': { key: '-' }, '*': { key: '*' }, '/': { key: '/' }, '=': { key: '=' },
  ':': { key: ':' }, ';': { key: ';' }, ',': { key: ',' }, '.': { key: '.' }, '@': { key: '@' },
  '<': { key: ',', shift: true }, '>': { key: '.', shift: true }, '?': { key: '/', shift: true },
  '[': { key: ':', shift: true }, ']': { key: ';', shift: true },
  '£': { key: 'pound' }, '^': { key: 'arrow-up' }, '_': { key: 'arrow-left' }, ' ': { key: 'space' },
};

/** Keys that do not type a character, by host key code. A `shift` entry is
 *  the Commodore's shifted half of a two-way key (cursor up/left, F2/F4/F6/F8). */
const CODE_KEYS: Record<string, Chord> = {
  Enter: { key: 'return' }, NumpadEnter: { key: 'return' },
  Backspace: { key: 'del' }, Delete: { key: 'del' }, Insert: { key: 'del', shift: true },
  Home: { key: 'home' }, End: { key: 'home', shift: true },
  ArrowRight: { key: 'crsr-lr' }, ArrowLeft: { key: 'crsr-lr', shift: true },
  ArrowDown: { key: 'crsr-ud' }, ArrowUp: { key: 'crsr-ud', shift: true },
  F1: { key: 'f1' }, F2: { key: 'f1', shift: true }, F3: { key: 'f3' }, F4: { key: 'f3', shift: true },
  F5: { key: 'f5' }, F6: { key: 'f5', shift: true }, F7: { key: 'f7' }, F8: { key: 'f7', shift: true },
  Escape: { key: 'stop' }, Tab: { key: 'ctrl' },
  ControlLeft: { key: 'ctrl' }, ControlRight: { key: 'ctrl' },
  AltLeft: { key: 'cbm' }, MetaLeft: { key: 'cbm' },
  Backquote: { key: 'arrow-left' },
};

/** The host key that presses RESTORE (an NMI, not a matrix key). */
const RESTORE_CODE = 'PageUp';

export class CbmKeyboard {
  /** Each key's cell (column × 8 + row). */
  private readonly cellOf = new Map<string, number>();
  /** Hold counts per cell, so a typed character's SHIFT and the user's own
   *  SHIFT do not release each other. */
  private readonly holds = new Uint8Array(64);
  /** Pressed rows per column (bit = row line), and columns per row. */
  readonly columns = new Uint8Array(8);
  readonly rows = new Uint8Array(8);
  private readonly held = new Map<string, number[]>();
  /** RESTORE is down. */
  restore = false;
  /** Matrix reads this frame (the KBD LED). */
  reads = 0;

  /** `matrix[column][row]` names the key on each crossing. */
  constructor(readonly matrix: readonly (readonly string[])[]) {
    matrix.forEach((rows, col) => rows.forEach((name, row) => this.cellOf.set(name, col * 8 + row)));
  }

  /** The cell index (column × 8 + row) of a named key. */
  keyCell(name: string): number {
    const cell = this.cellOf.get(name);
    if (cell === undefined) throw new Error(`no key ${name}`);
    return cell;
  }

  private press(cell: number): void {
    if (this.holds[cell]++ === 0) this.update(cell, true);
  }

  private release(cell: number): void {
    if (this.holds[cell] > 0 && --this.holds[cell] === 0) this.update(cell, false);
  }

  private update(cell: number, down: boolean): void {
    const col = cell >> 3, row = cell & 7;
    if (down) { this.columns[col] |= 1 << row; this.rows[row] |= 1 << col; }
    else { this.columns[col] &= ~(1 << row); this.rows[row] &= ~(1 << col); }
  }

  /** Press or release a named key (the on-screen keyboard and boot helpers). */
  setKey(name: string, down: boolean): void {
    const cell = this.keyCell(name);
    if (down) this.press(cell); else this.release(cell);
  }

  isPressed(name: string): boolean { return this.holds[this.keyCell(name)] > 0; }

  /** The row lines: rows of every column driven low pull low. */
  rowsFor(columnsDriven: number): number {
    let v = 0xFF;
    for (let col = 0; col < 8; col++) {
      if (((columnsDriven >> col) & 1) === 0) v &= ~this.columns[col];
    }
    return v;
  }

  /** The column lines: columns of every row driven low pull low. */
  columnsFor(rowsDriven: number): number {
    let v = 0xFF;
    for (let row = 0; row < 8; row++) {
      if (((rowsDriven >> row) & 1) === 0) v &= ~this.rows[row];
    }
    return v;
  }

  private cellsFor(event: HostKeyEvent): number[] | null {
    const ch = event.key;
    if (ch.length === 1) {
      const chord = CHAR_CHORDS[ch];
      if (chord) {
        const cells = [this.keyCell(chord.key)];
        if (chord.shift) cells.push(this.keyCell('lshift'));
        return cells;
      }
      // Letters: a Commodore types capitals unshifted (in its power-on
      // character set), so a host capital is the plain key and a shifted
      // letter is a graphics character there. Typed text arrives as the host typed it.
      if (/^[a-zA-Z]$/.test(ch)) return [this.keyCell(ch.toLowerCase())];
    }
    // Typed characters carry their own SHIFT (above), so the host SHIFT has no
    // cell of its own — it would turn a host-shifted `:` into a `[`.
    // It is passed on to the keys that do not type (SHIFT+RETURN, SHIFT+HOME).
    const code = CODE_KEYS[event.code];
    if (!code) return null;
    const cells = [this.keyCell(code.key)];
    if (code.shift || event.shift) cells.push(this.keyCell('lshift'));
    return cells;
  }

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    if (event.code === RESTORE_CODE) { this.restore = down; return true; }
    if (down) {
      if (this.held.has(event.code || event.key)) return true;   // auto-repeat
      const cells = this.cellsFor(event);
      if (!cells) return false;
      this.held.set(event.code || event.key, cells);
      for (const c of cells) this.press(c);
      return true;
    }
    const cells = this.held.get(event.code || event.key);
    if (!cells) return false;
    this.held.delete(event.code || event.key);
    for (const c of cells) this.release(c);
    return true;
  }

  reset(): void {
    this.holds.fill(0);
    this.columns.fill(0);
    this.rows.fill(0);
    this.held.clear();
    this.restore = false;
  }
}
