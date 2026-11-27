/**
 * Commodore 128 keyboard: the 64's 8 × 8 matrix scanned through CIA 1, plus
 * three more lines (K0-K2, chosen by bits 0-2 of VIC-IIe register $D02F, low
 * to select) read back through the same CIA 1 port B. The extra lines carry
 * the keys the 64 does not have: HELP, TAB, ESC, ALT, LINE FEED, NO SCROLL,
 * the four cursor keys and the numeric keypad.
 *
 * Two keys are not in the matrix: CAPS LOCK is read from the 8502's port (bit
 * 6, low while down), and the 40/80 DISPLAY key through the MMU's mode
 * register (bit 7, low while down, the 80-column display). Both are latching
 * keys, so they are state here, not a held key. RESTORE is an NMI, as on the 64.
 *
 * The extra lines' contents are read from the key-decode table in the screen
 * editor ROM, which follows the 64 entries of the 8 × 8 matrix: line K0 is HELP,
 * 8, 5, TAB, 2, 4, 7, 1 (PB0 to PB7), K1 is ESC, +, -, LINE FEED, ENTER, 6, 9, 3, and
 * K2 is ALT, 0, ., up, down, left, right, NO SCROLL; the keypad keys type the
 * digits.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import { CbmKeyboard } from '@/machines/shared/cbm/keyboard.ts';

/** The matrix, indexed [column][row]: columns 0-7 are CIA 1 port A bits, 8-10 the extra lines. */
export const C128_MATRIX: readonly (readonly string[])[] = [
  ['del', 'return', 'crsr-lr', 'f7', 'f1', 'f3', 'f5', 'crsr-ud'],
  ['3', 'w', 'a', '4', 'z', 's', 'e', 'lshift'],
  ['5', 'r', 'd', '6', 'c', 'f', 't', 'x'],
  ['7', 'y', 'g', '8', 'b', 'h', 'u', 'v'],
  ['9', 'i', 'j', '0', 'm', 'k', 'o', 'n'],
  ['+', 'p', 'l', '-', '.', ':', '@', ','],
  ['pound', '*', ';', 'home', 'rshift', '=', 'arrow-up', '/'],
  ['1', 'arrow-left', 'ctrl', '2', 'space', 'cbm', 'q', 'stop'],
  ['help', 'kp8', 'kp5', 'tab', 'kp2', 'kp4', 'kp7', 'kp1'],
  ['esc', 'kp+', 'kp-', 'linefeed', 'kp-enter', 'kp6', 'kp9', 'kp3'],
  ['alt', 'kp0', 'kp.', 'up', 'down', 'left', 'right', 'no-scroll'],
];

/**
 * The 128's keys that the 64's mapping (by typed character, and by position
 * for the cursors and function keys) has no host key for: the host keys that
 * stand for them.
 */
const EXTRA_KEYS: Readonly<Record<string, string>> = {
  F9: 'esc', F10: 'help', AltRight: 'alt', ScrollLock: 'no-scroll', PageDown: 'linefeed',
};

/**
 * Host keys that press a cell of the three extra lines in 128 mode, where the
 * 64's mapping would press something else: the four arrows are their own keys
 * there (the 64's cursor keys plus SHIFT would be seen as SHIFT held), TAB is a
 * key (the 64 mapping makes it CTRL, which the Control keys still are), and the
 * numeric keypad is a keypad. Not in 64 mode: its KERNAL never scans these lines.
 */
const EXTRA_KEYS_128: Readonly<Record<string, string>> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Tab: 'tab',
  Numpad0: 'kp0', Numpad1: 'kp1', Numpad2: 'kp2', Numpad3: 'kp3', Numpad4: 'kp4',
  Numpad5: 'kp5', Numpad6: 'kp6', Numpad7: 'kp7', Numpad8: 'kp8', Numpad9: 'kp9',
  NumpadDecimal: 'kp.', NumpadAdd: 'kp+', NumpadSubtract: 'kp-', NumpadEnter: 'kp-enter',
};

export class C128Keyboard extends CbmKeyboard {
  /** CAPS LOCK is down (its port bit reads low). */
  capsLock = false;
  /** The 40/80 DISPLAY key is down (the 80-column display). */
  display80 = false;
  /** A latching key changed: the machine puts its pin where the port reads it. */
  onLatchChange: (() => void) | null = null;
  /** The extra-line key each held host key pressed (so a release lets go of the same one even if the mode changed). */
  private readonly extraHeld = new Map<string, string>();
  /** Whether the machine is in 64 mode, where the 128's own keys are not there. */
  isC64Mode: () => boolean = () => false;

  constructor() { super(C128_MATRIX); }

  toggleCapsLock(): void { this.capsLock = !this.capsLock; this.onLatchChange?.(); }
  toggleDisplay80(): void { this.display80 = !this.display80; this.onLatchChange?.(); }

  override handleEvent(event: HostKeyEvent, down: boolean): boolean {
    // CAPS LOCK and the 40/80 key latch: a press flips them, the release is ignored.
    if (event.code === 'CapsLock') { if (down) this.toggleCapsLock(); return true; }
    if (event.code === 'Pause') { if (down) this.toggleDisplay80(); return true; }
    if (!down) {
      const held = this.extraHeld.get(event.code);
      if (held !== undefined) { this.extraHeld.delete(event.code); this.setKey(held, false); return true; }
      return super.handleEvent(event, down);
    }
    const extra = EXTRA_KEYS[event.code] ?? (this.isC64Mode() ? undefined : EXTRA_KEYS_128[event.code]);
    if (extra) {
      if (!this.extraHeld.has(event.code)) { this.extraHeld.set(event.code, extra); this.setKey(extra, true); }
      return true;
    }
    return super.handleEvent(event, down);
  }

  override reset(): void {
    super.reset();
    this.extraHeld.clear();
  }

  /** The row lines (CIA 1 port B) for the columns CIA 1 port A drives and the
   *  extra lines `$D02F` selects. */
  rowsForLines(portA: number, extraLines: number): number {
    return this.rowsFor((portA & 0xFF) | ((extraLines & 7) << 8));
  }
}
