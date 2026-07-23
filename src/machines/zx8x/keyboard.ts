/** ZX80/ZX81 8x5 active-low keyboard matrix. */
type Cell = readonly [number, number];

const KEY_MAP: Record<string, Cell | readonly Cell[]> = {
  ShiftLeft: [0, 0], ShiftRight: [0, 0],
  KeyZ: [0, 1], KeyX: [0, 2], KeyC: [0, 3], KeyV: [0, 4],
  KeyA: [1, 0], KeyS: [1, 1], KeyD: [1, 2], KeyF: [1, 3], KeyG: [1, 4],
  KeyQ: [2, 0], KeyW: [2, 1], KeyE: [2, 2], KeyR: [2, 3], KeyT: [2, 4],
  Digit1: [3, 0], Digit2: [3, 1], Digit3: [3, 2], Digit4: [3, 3], Digit5: [3, 4],
  Digit0: [4, 0], Digit9: [4, 1], Digit8: [4, 2], Digit7: [4, 3], Digit6: [4, 4],
  KeyP: [5, 0], KeyO: [5, 1], KeyI: [5, 2], KeyU: [5, 3], KeyY: [5, 4],
  Enter: [6, 0], KeyL: [6, 1], KeyK: [6, 2], KeyJ: [6, 3], KeyH: [6, 4],
  Space: [7, 0], Period: [7, 1], KeyM: [7, 2], KeyN: [7, 3], KeyB: [7, 4],
  Backspace: [[0, 0], [4, 0]],
  Delete: [[0, 0], [4, 0]],
  ArrowLeft: [[0, 0], [3, 4]],
  ArrowDown: [[0, 0], [4, 4]],
  ArrowUp: [[0, 0], [4, 3]],
  ArrowRight: [[0, 0], [4, 2]],
  Escape: [[0, 0], [7, 0]],
};

function isCell(value: Cell | readonly Cell[]): value is Cell {
  return typeof value[0] === 'number';
}

export class Zx8xKeyboard {
  /** 8 half-rows, bits 0-4, active-low (0 = pressed). Read by the on-screen
   *  keyboard to mirror the live matrix for highlighting. */
  readonly rows = new Uint8Array(8).fill(0xff);
  private readonly held = new Map<string, readonly Cell[]>();

  /**
   * Reference count per [row][bit]. Several sources can hold the same bit at
   * once — e.g. the on-screen SHIFT and a physical Shift both press [0,0]. A
   * bit only releases when its count drops back to zero.
   */
  private readonly pressCount = Array.from({ length: 8 }, () => new Array<number>(5).fill(0));

  read(highByte: number): number {
    let value = 0x1f;
    for (let row = 0; row < 8; row++) {
      if ((highByte & (1 << row)) === 0) value &= this.rows[row];
    }
    return value;
  }

  /** Press or release one matrix bit by position, reference-counted so
   *  overlapping presses of the same bit coexist. */
  setKey(row: number, bit: number, pressed: boolean): void {
    if (pressed) {
      this.pressCount[row][bit]++;
      this.rows[row] &= ~(1 << bit);
    } else {
      this.pressCount[row][bit] = Math.max(0, this.pressCount[row][bit] - 1);
      if (this.pressCount[row][bit] === 0) this.rows[row] |= 1 << bit;
    }
  }

  handleKeyEvent(code: string, pressed: boolean): boolean {
    const mapped = KEY_MAP[code];
    if (!mapped) return false;
    const cells: readonly Cell[] = isCell(mapped) ? [mapped] : mapped;
    if (pressed) {
      if (this.held.has(code)) return true;
      this.held.set(code, cells);
      for (const [row, bit] of cells) this.setKey(row, bit, true);
    } else {
      const active = this.held.get(code);
      if (!active) return true;
      this.held.delete(code);
      for (const [row, bit] of active) this.setKey(row, bit, false);
    }
    return true;
  }

  reset(): void {
    this.rows.fill(0xff);
    this.held.clear();
    for (const row of this.pressCount) row.fill(0);
  }
}
