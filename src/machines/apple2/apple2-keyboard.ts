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

export class Apple2Keyboard {
  /** The //e: full ASCII, CAPS LOCK, Apple keys. */
  private readonly iie: boolean;
  /** //e CAPS LOCK (down at power-on, like a lock left pressed). */
  private capsLock = true;
  /** //e Open-Apple / Solid-Apple / SHIFT, read back as buttons 0, 1 and 2. */
  private openApple = false;
  private solidApple = false;
  private shift = false;

  constructor(iie = false) { this.iie = iie; }

  /** Last latched key byte. */
  private latch = 0;
  /** Keyboard strobe: a key is waiting to be read (and not yet cleared). */
  private strobe = false;
  /** Pressed key bytes (for the activity LED and on-screen keyboard). */
  private readonly pressed = new Set<number>();

  /** Press/release a raw encoder byte — used by the on-screen keyboard. */
  setKey(code: number, down: boolean): void {
    if (down) { this.latch = code & 0xFF; this.strobe = true; this.pressed.add(code & 0xFF); }
    else this.pressed.delete(code & 0xFF);
  }

  /** Game-port push buttons 0-2: Open-Apple, Solid-Apple, SHIFT (the //e only). */
  button(n: number): boolean {
    if (!this.iie) return false;
    return n === 0 ? this.openApple : n === 1 ? this.solidApple : this.shift;
  }

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    if (this.iie) return this.handleIieEvent(event, down);
    // Modifiers themselves are not keys on the Apple II.
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight'
      || event.code === 'ControlLeft' || event.code === 'ControlRight'
      || event.code === 'AltLeft' || event.code === 'AltRight'
      || event.code === 'MetaLeft' || event.code === 'MetaRight') return false;
    const byte = apple2KeyByte(event);
    if (byte === null) return false;
    this.setKey(byte, down);
    return true;
  }

  private handleIieEvent(event: HostKeyEvent, down: boolean): boolean {
    switch (event.code) {
      case 'AltLeft': this.openApple = down; return true;
      case 'AltRight': this.solidApple = down; return true;
      case 'ShiftLeft': case 'ShiftRight': this.shift = down; return false;
      case 'CapsLock':
        if (down) this.capsLock = !this.capsLock;
        return true;
      default: break;
    }
    if (event.code.startsWith('Control') || event.code.startsWith('Meta')) return false;
    const byte = apple2eKeyByte(event, this.capsLock);
    if (byte === null) return false;
    this.setKey(byte, down);
    return true;
  }

  /** What a read of $C000 returns: the key byte with the strobe in bit 7. */
  readData(): number {
    return this.strobe ? (this.latch | 0x80) : (this.latch & 0x7F);
  }

  /** A read or write of $C010 clears the strobe. */
  clearStrobe(): void { this.strobe = false; }

  get anyPressed(): boolean { return this.pressed.size > 0; }
  get strobeActive(): boolean { return this.strobe; }

  /** The last key's code without the strobe (the //e's $C010 read-back). */
  get lastKey(): number { return this.latch & 0x7F; }

  reset(): void {
    this.latch = 0;
    this.strobe = false;
    this.pressed.clear();
    this.openApple = false;
    this.solidApple = false;
    this.shift = false;
  }
}
