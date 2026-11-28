/**
 * ZX80/ZX81 keyboard matrix.
 *
 * The scan hardware and the host-key handling are the ZX machines' common ones
 * (`MatrixKeyKeyboard`); this file is the ZX8x's key map. Eight half-rows of five
 * bits, selected by the high byte of a port 0xFE read, keys active-low.
 *
 * The ZX8x has no symbol shift (its SHIFT is applied differently), so it has no
 * CHAR_MAP: every host key maps to a cell or a bare chord. It also mirrors both
 * physical shifts onto the one SHIFT cell, and lacks a CAPS LOCK key.
 */

import { MatrixKeyKeyboard, type ComboMapping, type KeyMapping } from '@/machines/shared/matrix-key-keyboard.ts';

const KEY_MAP: Record<string, KeyMapping | ComboMapping> = {
  ShiftLeft: { row: 0, bit: 0 }, ShiftRight: { row: 0, bit: 0 },
  KeyZ: { row: 0, bit: 1 }, KeyX: { row: 0, bit: 2 }, KeyC: { row: 0, bit: 3 }, KeyV: { row: 0, bit: 4 },
  KeyA: { row: 1, bit: 0 }, KeyS: { row: 1, bit: 1 }, KeyD: { row: 1, bit: 2 }, KeyF: { row: 1, bit: 3 }, KeyG: { row: 1, bit: 4 },
  KeyQ: { row: 2, bit: 0 }, KeyW: { row: 2, bit: 1 }, KeyE: { row: 2, bit: 2 }, KeyR: { row: 2, bit: 3 }, KeyT: { row: 2, bit: 4 },
  Digit1: { row: 3, bit: 0 }, Digit2: { row: 3, bit: 1 }, Digit3: { row: 3, bit: 2 }, Digit4: { row: 3, bit: 3 }, Digit5: { row: 3, bit: 4 },
  Digit0: { row: 4, bit: 0 }, Digit9: { row: 4, bit: 1 }, Digit8: { row: 4, bit: 2 }, Digit7: { row: 4, bit: 3 }, Digit6: { row: 4, bit: 4 },
  KeyP: { row: 5, bit: 0 }, KeyO: { row: 5, bit: 1 }, KeyI: { row: 5, bit: 2 }, KeyU: { row: 5, bit: 3 }, KeyY: { row: 5, bit: 4 },
  Enter: { row: 6, bit: 0 }, KeyL: { row: 6, bit: 1 }, KeyK: { row: 6, bit: 2 }, KeyJ: { row: 6, bit: 3 }, KeyH: { row: 6, bit: 4 },
  Space: { row: 7, bit: 0 }, Period: { row: 7, bit: 1 }, KeyM: { row: 7, bit: 2 }, KeyN: { row: 7, bit: 3 }, KeyB: { row: 7, bit: 4 },
  Backspace: [{ row: 0, bit: 0 }, { row: 4, bit: 0 }],
  Delete: [{ row: 0, bit: 0 }, { row: 4, bit: 0 }],
  ArrowLeft: [{ row: 0, bit: 0 }, { row: 3, bit: 4 }],
  ArrowDown: [{ row: 0, bit: 0 }, { row: 4, bit: 4 }],
  ArrowUp: [{ row: 0, bit: 0 }, { row: 4, bit: 3 }],
  ArrowRight: [{ row: 0, bit: 0 }, { row: 4, bit: 2 }],
  Escape: [{ row: 0, bit: 0 }, { row: 7, bit: 0 }],
};

export class Zx8xKeyboard extends MatrixKeyKeyboard {
  constructor() {
    // No CHAR_MAP: the ZX8x has no symbol shift.
    super({ keyMap: KEY_MAP });
  }

  /** The port 0xFE half-row read (the shared matrix's name for it). */
  read(highByte: number): number {
    return this.readHalfRows(highByte);
  }
}
