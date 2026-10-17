/**
 * Acorn Electron keyboard: the 14 × 4 matrix and the host-key mapping.
 *
 * Pressed keys are reference-counted per cell, so a SHIFT pressed for a typed
 * `"` and the user's own SHIFT hold the same cell without releasing it early.
 * A host key remembers the cells it pressed, so releasing it undoes exactly
 * that even if the caps-lock state changed in between.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import {
  ELK_CHAR_CHORDS, ELK_CODE_KEYS, ELK_FUNCTION_KEYS, ELK_KEYS,
  type ElectronKeyName,
} from './electron-keyboard-matrix.ts';

const cellIndex = (col: number, row: number): number => col * 4 + (row & 3);

export class ElectronKeyboard {
  /** How many holds each of the 14×4 cells has. */
  private readonly holds = new Uint8Array(14 * 4);
  /** Pressed rows per column (bit n = row n), kept in step with `holds`. */
  private readonly columns = new Uint8Array(14);
  /** Cells each held host key pressed. */
  private readonly held = new Map<string, number[]>();

  /** Whether caps lock is on (the ULA's LED), so typed letters get the right case. */
  capsLock = false;

  /** Reads of the matrix this frame, for the KEY activity LED. */
  reads = 0;

  private press(index: number): void {
    if (this.holds[index]++ === 0) this.columns[index >> 2] |= 1 << (index & 3);
  }

  private release(index: number): void {
    if (this.holds[index] > 0 && --this.holds[index] === 0) {
      this.columns[index >> 2] &= ~(1 << (index & 3));
    }
  }

  /** Press/release a raw matrix cell — used by the on-screen keyboard. */
  setCell(column: number, row: number, down: boolean): void {
    if (down) this.press(cellIndex(column, row)); else this.release(cellIndex(column, row));
  }

  isPressed(column: number, row: number): boolean {
    return this.holds[cellIndex(column, row)] > 0;
  }

  anyPressed(): boolean {
    for (let i = 0; i < this.columns.length; i++) if (this.columns[i]) return true;
    return false;
  }

  /** The pressed bits of every column whose address line in `addr` is low. */
  read(addr: number): number {
    this.reads++;
    let data = 0;
    for (let col = 0; col < 14; col++) {
      if (((addr >> col) & 1) === 0) data |= this.columns[col];
    }
    return data;
  }

  private cellsFor(event: HostKeyEvent): number[] | null {
    const cell = (name: ElectronKeyName): number => {
      const [c, r] = ELK_KEYS[name];
      return cellIndex(c, r);
    };
    // Printable characters go by the character produced.
    if (event.key.length === 1) {
      const chord = ELK_CHAR_CHORDS[event.key];
      if (chord) {
        const cells = [cell(chord.key)];
        if (chord.shift) cells.push(cell('shift'));
        if (chord.ctrl) cells.push(cell('ctrl'));
        return cells;
      }
      // Letters: the machine's own case comes from caps lock XOR shift.
      if (/^[a-zA-Z]$/.test(event.key)) {
        const lower = event.key.toLowerCase();
        const wantUpper = event.key !== lower;
        const cells = [cell(lower as ElectronKeyName)];
        if (wantUpper !== this.capsLock) cells.push(cell('shift'));
        return cells;
      }
    }
    const fn = ELK_FUNCTION_KEYS[event.code];
    if (fn) return [cell(fn), cell('func')];
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') return null;
    const name = ELK_CODE_KEYS[event.code];
    return name ? [cell(name)] : null;
  }

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    if (down) {
      if (this.held.has(event.code)) return true;           // auto-repeat
      const cells = this.cellsFor(event);
      if (!cells) return false;
      this.held.set(event.code, cells);
      for (const c of cells) this.press(c);
      return true;
    }
    const cells = this.held.get(event.code);
    if (!cells) return false;
    this.held.delete(event.code);
    for (const c of cells) this.release(c);
    return true;
  }

  reset(): void {
    this.holds.fill(0);
    this.columns.fill(0);
    this.held.clear();
  }
}
