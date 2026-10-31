/**
 * NewBrain keyboard — host keys onto the 16 × 4 matrix the COP420 scans.
 *
 * The matrix is read off the machine itself: the COP firmware turns a matrix
 * position into a key code and the OS ROM turns that into a character (the
 * decode tables are at F2FA-F36A), so every printable character below is the
 * one the ROM produces from that position, with or without SHIFT. Rows are
 * Y0-Y15, columns the COP's K3 / K7 / K8 / K9 lines.
 *
 *   Y15  K3 CONTROL   K7 SHIFT   K9 GRAPHICS
 *   Y14  K7 /   K8 SPACE   K9 ESCAPE
 *   Y13  K9 NEW LINE
 *   Y1   K3 up   K7 down   K8 left   K9 right
 *   Y0   K9 STOP
 *
 * The host's characters are typed by character, not by key position: a '"'
 * arrives as the NewBrain's SHIFT + 2 whatever the host's own layout is, and
 * the host's SHIFT key itself is not forwarded (it would double the one the
 * character already asked for). A key is released by the host `code` that
 * pressed it, so rolling from one key to the next works.
 */

import { K3, K7, K8, K9 } from './cop-board.ts';

/** A matrix position: row Y0-Y15 and the column line that closes there. */
interface Key { y: number; k: number }

const SHIFT: Key = { y: 15, k: K7 };
const CONTROL: Key = { y: 15, k: K3 };
const GRAPHICS: Key = { y: 15, k: K9 };

interface CharKey extends Key { shift: boolean }

/** Printable characters, by the position (and SHIFT state) that types them. */
const CHAR_MAP: Record<string, CharKey> = {
  "!": { y: 8, k: K8, shift: true },
  "\"": { y: 7, k: K8, shift: true },
  "#": { y: 6, k: K8, shift: true },
  "$": { y: 5, k: K8, shift: true },
  "%": { y: 4, k: K8, shift: true },
  "&": { y: 3, k: K8, shift: true },
  "'": { y: 2, k: K8, shift: true },
  "(": { y: 5, k: K9, shift: false },
  ")": { y: 6, k: K9, shift: false },
  "*": { y: 7, k: K9, shift: false },
  "+": { y: 12, k: K9, shift: false },
  ",": { y: 5, k: K3, shift: false },
  "-": { y: 11, k: K9, shift: false },
  ".": { y: 6, k: K3, shift: false },
  "/": { y: 14, k: K7, shift: false },
  "0": { y: 4, k: K9, shift: false },
  "1": { y: 8, k: K8, shift: false },
  "2": { y: 7, k: K8, shift: false },
  "3": { y: 6, k: K8, shift: false },
  "4": { y: 5, k: K8, shift: false },
  "5": { y: 4, k: K8, shift: false },
  "6": { y: 3, k: K8, shift: false },
  "7": { y: 2, k: K8, shift: false },
  "8": { y: 2, k: K9, shift: false },
  "9": { y: 3, k: K9, shift: false },
  ":": { y: 7, k: K7, shift: true },
  ";": { y: 7, k: K7, shift: false },
  "<": { y: 5, k: K3, shift: true },
  "=": { y: 10, k: K9, shift: false },
  ">": { y: 6, k: K3, shift: true },
  "?": { y: 14, k: K7, shift: true },
  "@": { y: 10, k: K9, shift: true },
  "A": { y: 13, k: K7, shift: true },
  "B": { y: 7, k: K3, shift: true },
  "C": { y: 9, k: K3, shift: true },
  "D": { y: 11, k: K7, shift: true },
  "E": { y: 11, k: K8, shift: true },
  "F": { y: 10, k: K7, shift: true },
  "G": { y: 9, k: K7, shift: true },
  "H": { y: 8, k: K7, shift: true },
  "I": { y: 3, k: K7, shift: true },
  "J": { y: 2, k: K3, shift: true },
  "K": { y: 13, k: K3, shift: true },
  "L": { y: 6, k: K7, shift: true },
  "M": { y: 4, k: K3, shift: true },
  "N": { y: 3, k: K3, shift: true },
  "O": { y: 5, k: K7, shift: true },
  "P": { y: 9, k: K9, shift: true },
  "Q": { y: 13, k: K8, shift: true },
  "R": { y: 10, k: K8, shift: true },
  "S": { y: 12, k: K7, shift: true },
  "T": { y: 9, k: K8, shift: true },
  "U": { y: 2, k: K7, shift: true },
  "V": { y: 8, k: K3, shift: true },
  "W": { y: 12, k: K8, shift: true },
  "X": { y: 10, k: K3, shift: true },
  "Y": { y: 4, k: K7, shift: true },
  "Z": { y: 11, k: K3, shift: true },
  "[": { y: 5, k: K9, shift: true },
  "\\": { y: 11, k: K9, shift: true },
  "]": { y: 6, k: K9, shift: true },
  "^": { y: 12, k: K9, shift: true },
  "_": { y: 8, k: K9, shift: true },
  "a": { y: 13, k: K7, shift: false },
  "b": { y: 7, k: K3, shift: false },
  "c": { y: 9, k: K3, shift: false },
  "d": { y: 11, k: K7, shift: false },
  "e": { y: 11, k: K8, shift: false },
  "f": { y: 10, k: K7, shift: false },
  "g": { y: 9, k: K7, shift: false },
  "h": { y: 8, k: K7, shift: false },
  "i": { y: 3, k: K7, shift: false },
  "j": { y: 2, k: K3, shift: false },
  "k": { y: 13, k: K3, shift: false },
  "l": { y: 6, k: K7, shift: false },
  "m": { y: 4, k: K3, shift: false },
  "n": { y: 3, k: K3, shift: false },
  "o": { y: 5, k: K7, shift: false },
  "p": { y: 9, k: K9, shift: false },
  "q": { y: 13, k: K8, shift: false },
  "r": { y: 10, k: K8, shift: false },
  "s": { y: 12, k: K7, shift: false },
  "t": { y: 9, k: K8, shift: false },
  "u": { y: 2, k: K7, shift: false },
  "v": { y: 8, k: K3, shift: false },
  "w": { y: 12, k: K8, shift: false },
  "x": { y: 10, k: K3, shift: false },
  "y": { y: 4, k: K7, shift: false },
  "z": { y: 11, k: K3, shift: false },
};

/** Keys that are not characters, by host `KeyboardEvent.code`. */
const CODE_MAP: Record<string, Key[]> = {
  Space: [{ y: 14, k: K8 }],
  Enter: [{ y: 13, k: K9 }],
  NumpadEnter: [{ y: 13, k: K9 }],
  Tab: [{ y: 14, k: K9 }],                       // ESCAPE
  Escape: [{ y: 0, k: K9 }],                     // STOP
  Backspace: [CONTROL, { y: 1, k: K8 }],         // CONTROL + left wipes
  ArrowUp: [{ y: 1, k: K3 }],
  ArrowDown: [{ y: 1, k: K7 }],
  ArrowLeft: [{ y: 1, k: K8 }],
  ArrowRight: [{ y: 1, k: K9 }],
  ControlLeft: [CONTROL],
  ControlRight: [CONTROL],
  AltLeft: [GRAPHICS],
  AltRight: [GRAPHICS],
};

/** Frames between a modifier going down and the key it modifies. The COP
 *  scans the rows in order and reports the first key it finds, and SHIFT,
 *  CONTROL and GRAPHICS sit in the last row, so a key that arrives with them
 *  would be reported before they were seen. */
export const MODIFIER_LEAD = 6;
/** Frames a key stays down at least, so a quick tap is still scanned. */
export const MIN_HOLD = 4;

interface Held {
  mods: Key[];
  keys: Key[];
  /** Frame at which the keys go down (the modifiers are already down). */
  keysAt: number;
  keysDown: boolean;
  /** Frame the keys went down. */
  downAt: number;
  /** The host has released the key; release the matrix once it has been held long enough. */
  up: boolean;
}

export class NewBrainKeyboard {
  /** Host keys down, by `code`. */
  private readonly held = new Map<string, Held>();
  /** How many held host keys close each cell, so a shared SHIFT survives one release. */
  private readonly count = new Uint8Array(16 * 4);
  private frame = 0;

  constructor(private readonly keys: () => Uint8Array) {}

  private cell(k: number): number { return k === K3 ? 0 : k === K7 ? 1 : k === K8 ? 2 : 3; }

  private press(list: Key[]): void {
    const m = this.keys();
    for (const { y, k } of list) {
      if (this.count[y * 4 + this.cell(k)]++ === 0) m[y] |= k;
    }
  }

  private release(list: Key[]): void {
    const m = this.keys();
    for (const { y, k } of list) {
      const i = y * 4 + this.cell(k);
      if (this.count[i] > 0 && --this.count[i] === 0) m[y] &= ~k;
    }
  }

  handleKeyEvent(code: string, down: boolean, key?: string): boolean {
    if (!down) {
      const h = this.held.get(code);
      if (!h) return false;
      h.up = true;
      this.settle(code, h);
      return true;
    }
    if (this.held.has(code)) return true;           // host auto-repeat: already down
    let mods: Key[] = [];
    let keys: Key[] | undefined = CODE_MAP[code];
    if (keys && keys.length > 1 && keys[0] === CONTROL) { mods = [CONTROL]; keys = keys.slice(1); }
    if (!keys && key && key.length === 1) {
      const c = CHAR_MAP[key];
      if (c) { keys = [{ y: c.y, k: c.k }]; if (c.shift) mods = [SHIFT]; }
    }
    if (!keys) return code.startsWith('Shift');     // host SHIFT: swallowed, not forwarded
    const h: Held = {
      mods, keys, keysAt: this.frame + (mods.length ? MODIFIER_LEAD : 0), keysDown: false, downAt: 0, up: false,
    };
    this.held.set(code, h);
    this.press(mods);
    this.settle(code, h);
    return true;
  }

  /** Move a held key along: put its keys down when due, and take everything
   *  up once the host has let go and the minimum hold is over. */
  private settle(code: string, h: Held): void {
    if (!h.keysDown && this.frame >= h.keysAt) {
      this.press(h.keys);
      h.keysDown = true;
      h.downAt = this.frame;
    }
    if (h.up && h.keysDown && this.frame - h.downAt >= MIN_HOLD) {
      this.release(h.keys);
      this.release(h.mods);
      this.held.delete(code);
    }
  }

  /** Once per frame: carry delayed presses and releases along. */
  tick(): void {
    this.frame++;
    for (const [code, h] of this.held) this.settle(code, h);
  }

  reset(): void {
    this.held.clear();
    this.count.fill(0);
    this.keys().fill(0);
  }
}
