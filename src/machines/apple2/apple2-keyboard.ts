/**
 * Apple II keyboard.
 *
 * The II/II+ has no keyboard matrix the software can scan: a hardware encoder
 * latches the last key's ASCII and raises a strobe, which the CPU reads from
 * $C000 (bit 7 = key waiting; bit 7 clear once $C010 is touched). So the host
 * mapping turns a key event straight into the byte the encoder would produce —
 * shifted symbols included, since the encoder, not software, resolves SHIFT.
 *
 * The II+ keyboard is upper-case only, so letters always produce $41-$5A. The
 * //e's is full ASCII with a locking CAPS LOCK, and adds the two Apple keys that
 * read as game-port buttons.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';

/** Unshifted / shifted byte for a punctuation or digit position. */
const CHAR_KEYS: Record<string, [number, number]> = {
  Digit0: [0x30, 0x29], Digit1: [0x31, 0x21], Digit2: [0x32, 0x40],
  Digit3: [0x33, 0x23], Digit4: [0x34, 0x24], Digit5: [0x35, 0x25],
  Digit6: [0x36, 0x5E], Digit7: [0x37, 0x26], Digit8: [0x38, 0x2A],
  Digit9: [0x39, 0x28],
  Minus: [0x2D, 0x5F], Equal: [0x3D, 0x2B],
  BracketLeft: [0x5B, 0x7B], BracketRight: [0x5D, 0x7D],
  Semicolon: [0x3B, 0x3A], Quote: [0x27, 0x22],
  Comma: [0x2C, 0x3C], Period: [0x2E, 0x3E], Slash: [0x2F, 0x3F],
  Backslash: [0x5C, 0x7C], Backquote: [0x60, 0x7E],
};

/** Named keys with a single Apple II code. */
const NAMED_KEYS: Record<string, number> = {
  Enter: 0x0D, NumpadEnter: 0x0D,
  Space: 0x20,
  Escape: 0x1B,
  Tab: 0x09,
  Backspace: 0x08,   // the Apple II backspace is Ctrl-H
  Delete: 0x7F,
  ArrowLeft: 0x08,   // ← sends Ctrl-H
  ArrowRight: 0x15,  // → sends Ctrl-U
  ArrowUp: 0x0B,     // Ctrl-K
  ArrowDown: 0x0A,   // Ctrl-J
};

function letterCode(code: string): number | null {
  if (code.length === 4 && code.startsWith('Key')) {
    const c = code.charCodeAt(3);
    if (c >= 65 && c <= 90) return c;
  }
  return null;
}

/** The byte the encoder would produce, or null for a key we don't map. */
export function apple2KeyByte(event: HostKeyEvent): number | null {
  const letter = letterCode(event.code);
  if (letter !== null) {
    return event.ctrl ? letter & 0x1F : letter;
  }
  const punctuation = CHAR_KEYS[event.code];
  if (punctuation) return event.shift ? punctuation[1] : punctuation[0];
  const named = NAMED_KEYS[event.code];
  if (named !== undefined) return named;
  return null;
}

/**
 * The byte a //e keyboard would produce, or null for a key we don't map.
 *
 * Printable keys give the character the host layout typed, so punctuation is
 * right on any layout. `capsLock` is the //e's own locking key: with it down
 * letters are upper case whether or not SHIFT is held.
 */
export function apple2eKeyByte(event: HostKeyEvent, capsLock: boolean): number | null {
  const letter = letterCode(event.code);
  if (event.ctrl) {
    if (letter !== null) return letter & 0x1F;
    if (event.code === 'BracketLeft') return 0x1B;
    if (event.code === 'Backslash') return 0x1C;
    if (event.code === 'BracketRight') return 0x1D;
    if (event.shift && event.code === 'Digit6') return 0x1E;
    if (event.shift && event.code === 'Minus') return 0x1F;
    if (event.shift && event.code === 'Digit2') return 0x00;
  }
  const named = NAMED_KEYS[event.code];
  if (named !== undefined) return named;
  if (letter !== null) return (event.shift || capsLock) ? letter : letter + 0x20;
  const ch = event.key.length === 1 ? event.key.charCodeAt(0) : 0;
  if (ch >= 0x20 && ch < 0x7F) return ch;
  const punctuation = CHAR_KEYS[event.code];
  if (punctuation) return event.shift ? punctuation[1] : punctuation[0];
  return null;
}

/**
 * The ][/][+ encoder's byte for a keycap, for the on-screen keyboard (the host
 * mapping above follows the PC's own shift pairs instead). `face` is the cap's
 * id: a DOM key code where one fits, or `colon` for the `: *` cap the PC lacks.
 *
 * SHIFT only changes the symbol caps and three letters — N ^, M ], P @ — and
 * CTRL only the letters (Apple II Reference Manual, keyboard code table).
 */
export function apple2FaceByte(face: string, shift: boolean, ctrl: boolean): number | null {
  const letter = letterCode(face);
  if (letter !== null) {
    const shifted = shift ? (II_SHIFTED_LETTERS[face] ?? letter) : letter;
    return ctrl ? shifted & 0x1F : shifted;
  }
  const pair = II_FACES[face];
  if (pair) return shift ? pair[1] : pair[0];
  return null;
}

const II_SHIFTED_LETTERS: Record<string, number> = { KeyN: 0x5E, KeyM: 0x5D, KeyP: 0x40 };

/** Unshifted / shifted byte for each non-letter ][ cap. */
const II_FACES: Record<string, [number, number]> = {
  Digit1: [0x31, 0x21], Digit2: [0x32, 0x22], Digit3: [0x33, 0x23],
  Digit4: [0x34, 0x24], Digit5: [0x35, 0x25], Digit6: [0x36, 0x26],
  Digit7: [0x37, 0x27], Digit8: [0x38, 0x28], Digit9: [0x39, 0x29],
  Digit0: [0x30, 0x30],
  colon: [0x3A, 0x2A], Minus: [0x2D, 0x3D], Semicolon: [0x3B, 0x2B],
  Comma: [0x2C, 0x3C], Period: [0x2E, 0x3E], Slash: [0x2F, 0x3F],
  Escape: [0x1B, 0x1B], Enter: [0x0D, 0x0D], Space: [0x20, 0x20],
  ArrowLeft: [0x08, 0x08], ArrowRight: [0x15, 0x15],
};

/** Host modifier codes, and the //e's Apple keys on the two Alts. */
const MODIFIERS = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

/** A held modifier: in `held`, but latches no byte. */
const NO_BYTE = -1;

export class Apple2Keyboard {
  /** The //e: full ASCII, CAPS LOCK, Apple keys. */
  private readonly iie: boolean;
  /** //e CAPS LOCK (down at power-on, like a lock left pressed). */
  private capsLock = true;

  constructor(iie = false) { this.iie = iie; }

  /** Last latched key byte. */
  private latch = 0;
  /** Keyboard strobe: a key is waiting to be read (and not yet cleared). */
  private strobe = false;
  /**
   * Keys held down, by physical key (a DOM key code, or an on-screen cap's id),
   * with the byte each latched — so a key releases what it pressed even if a
   * modifier changed meanwhile, and the on-screen keyboard can light the cap.
   */
  private readonly held = new Map<string, number>();

  /** Press/release a raw encoder byte (tests, scripted input). */
  setKey(code: number, down: boolean): void {
    this.pressFace(`byte:${code & 0xFF}`, code, down);
  }

  /** Press/release a physical key that latches `code` (null for a modifier). */
  pressFace(id: string, code: number | null, down: boolean): void {
    if (!down) { this.held.delete(id); return; }
    if (code === null) { this.held.set(id, NO_BYTE); return; }
    this.latch = code & 0xFF;
    this.strobe = true;
    this.held.set(id, code & 0xFF);
  }

  /** Whether a physical key (DOM code or on-screen cap id) is held. */
  isHeld(id: string): boolean { return this.held.has(id); }

  get shiftHeld(): boolean { return this.held.has('ShiftLeft') || this.held.has('ShiftRight'); }
  get ctrlHeld(): boolean { return this.held.has('ControlLeft') || this.held.has('ControlRight'); }

  /** The //e's CAPS LOCK latch. */
  get capsLocked(): boolean { return this.capsLock; }
  toggleCapsLock(): void { this.capsLock = !this.capsLock; }

  /** Game-port push buttons 0-2: Open-Apple, Solid-Apple, SHIFT (the //e only). */
  button(n: number): boolean {
    if (!this.iie) return false;
    return n === 0 ? this.held.has('AltLeft') : n === 1 ? this.held.has('AltRight') : this.shiftHeld;
  }

  /** The ][ REPT key: latch the last key again, as its repeat oscillator does. */
  repeat(): void { this.strobe = true; }

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    if (!down && this.held.has(event.code)) {
      const byte = this.held.get(event.code)!;
      this.held.delete(event.code);
      return byte !== NO_BYTE || (this.iie && event.code.startsWith('Alt'));
    }
    if (MODIFIERS.has(event.code)) {
      // Tracked for SHIFT/CTRL state and the on-screen keyboard; only the //e's
      // Apple keys are hardware of their own (the game-port buttons).
      this.pressFace(event.code, null, down);
      return this.iie && event.code.startsWith('Alt');
    }
    if (this.iie && event.code === 'CapsLock') {
      if (down) this.toggleCapsLock();
      return true;
    }
    const byte = this.iie ? apple2eKeyByte(event, this.capsLock) : apple2KeyByte(event);
    if (byte === null) return false;
    if (down) this.pressFace(event.code, byte, true);
    return true;
  }

  /** What a read of $C000 returns: the key byte with the strobe in bit 7. */
  readData(): number {
    return this.strobe ? (this.latch | 0x80) : (this.latch & 0x7F);
  }

  /** A read or write of $C010 clears the strobe. */
  clearStrobe(): void { this.strobe = false; }

  /** Any key that latches a byte is down (the //e's $C010 bit 7). */
  get anyPressed(): boolean {
    for (const byte of this.held.values()) if (byte !== NO_BYTE) return true;
    return false;
  }
  get strobeActive(): boolean { return this.strobe; }

  /** The last key's code without the strobe (the //e's $C010 read-back). */
  get lastKey(): number { return this.latch & 0x7F; }

  reset(): void {
    this.latch = 0;
    this.strobe = false;
    this.held.clear();
  }
}
