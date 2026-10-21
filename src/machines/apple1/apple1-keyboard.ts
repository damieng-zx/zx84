/**
 * Apple I keyboard.
 *
 * A hardware encoder, not a matrix: pressing a key puts its 7-bit ASCII code on
 * PIA port A (bit 7 always set) and pulses CA1, which sets the "key waiting"
 * flag in KBDCR bit 7. The code stays on the pins until the next key. The
 * keyboard is upper-case only and has no function keys: the RESET and CLEAR
 * SCREEN keys are wired to the CPU/PIA reset line and to the terminal, not to
 * the PIA data lines, so the machine handles those itself.
 *
 * Host keys give the character the host layout typed. The on-screen keyboard has
 * no layout to ask, so its caps are named by a face id and run through the same
 * encoder via {@link apple1FaceByte}.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import type { M6820 } from '@/cores/m6820.ts';

/** The Monitor treats `_` as backspace; it is also what the key is labelled. */
const RUBOUT = 0x5F;

/** The byte the encoder would produce (without bit 7), or null for a key it lacks. */
export function apple1KeyByte(event: HostKeyEvent): number | null {
  switch (event.code) {
    case 'Enter': case 'NumpadEnter': return 0x0D;
    case 'Backspace': case 'Delete': return RUBOUT;
    case 'Escape': return 0x1B;
    default: break;
  }
  if (event.ctrl) {
    if (event.code.length === 4 && event.code.startsWith('Key')) return event.code.charCodeAt(3) & 0x1F;
    return null;
  }
  if (event.key.length !== 1) return null;
  const code = event.key.toUpperCase().charCodeAt(0);
  return code >= 0x20 && code <= 0x5F ? code : null;
}

/** Unshifted / shifted byte for each non-letter cap, named by DOM key code. */
const FACES: Record<string, [number, number]> = {
  Digit1: [0x31, 0x21], Digit2: [0x32, 0x22], Digit3: [0x33, 0x23],
  Digit4: [0x34, 0x24], Digit5: [0x35, 0x25], Digit6: [0x36, 0x26],
  Digit7: [0x37, 0x27], Digit8: [0x38, 0x28], Digit9: [0x39, 0x29],
  Digit0: [0x30, 0x30],
  colon: [0x3A, 0x2A], Minus: [0x2D, 0x3D], Semicolon: [0x3B, 0x2B],
  Comma: [0x2C, 0x3C], Period: [0x2E, 0x3E], Slash: [0x2F, 0x3F],
  Escape: [0x1B, 0x1B], Enter: [0x0D, 0x0D], Space: [0x20, 0x20],
  Backspace: [RUBOUT, RUBOUT],
};

/** SHIFT turns three letters into the teletype's control symbols. */
const SHIFTED_LETTERS: Record<string, number> = { KeyN: 0x5E, KeyM: 0x5D, KeyP: 0x40 };

/** The byte a cap produces with SHIFT and CTRL as given, or null for a cap with none. */
export function apple1FaceByte(face: string, shift: boolean, ctrl: boolean): number | null {
  if (face.length === 4 && face.startsWith('Key')) {
    const letter = face.charCodeAt(3);
    const shifted = shift ? (SHIFTED_LETTERS[face] ?? letter) : letter;
    return ctrl ? shifted & 0x1F : shifted;
  }
  const pair = FACES[face];
  return pair ? (shift ? pair[1] : pair[0]) : null;
}

/**
 * The key presses that type `text`: what a person would key in from a listing.
 * Any line ending is a RETURN, lower case is upper-cased (the keyboard has no
 * lower case) and tabs are spaces; characters with no key (accents, braces,
 * control codes) are dropped, as a listing's formatting is not part of the program.
 */
export function apple1PasteBytes(text: string): Uint8Array {
  const out: number[] = [];
  const upper = text.replace(/^﻿/, '').replace(/\r\n?|\n/g, '\r').toUpperCase();
  for (const ch of upper) {
    const code = ch === '\t' ? 0x20 : ch.charCodeAt(0);
    if (code === 0x0D || (code >= 0x20 && code <= 0x5F)) out.push(code);
  }
  return Uint8Array.from(out);
}

export class Apple1Keyboard {
  /** On-screen SHIFT and CTRL, latched until the next key. */
  shiftHeld = false;
  ctrlHeld = false;
  /** Caps currently down (host key codes and on-screen face ids), for lighting them. */
  private readonly held = new Set<string>();

  constructor(private readonly pia: M6820) {}

  /** Latch `code` on port A and strobe CA1, as the encoder does. */
  press(code: number): void {
    this.pia.portAInput = (code & 0x7F) | 0x80;
    this.pia.setCA1(true);
    this.pia.setCA1(false);
  }

  isHeld(code: string): boolean { return this.held.has(code); }

  /** Record a cap going down or up, without producing a character. */
  track(code: string, down: boolean): void {
    if (down) this.held.add(code); else this.held.delete(code);
  }

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    this.track(event.code, down);
    const code = apple1KeyByte(event);
    if (code === null) return false;
    if (down) this.press(code);
    return true;
  }

  /** An on-screen cap: the face id names the key, the held modifiers decide the byte. */
  pressFace(face: string, down: boolean): void {
    this.track(face, down);
    if (!down) return;
    const code = apple1FaceByte(face, this.shiftHeld, this.ctrlHeld);
    if (code !== null) this.press(code);
  }

  /** Power-up / reset: nothing latched. */
  reset(): void {
    this.pia.portAInput = 0x00;
    this.shiftHeld = false;
    this.ctrlHeld = false;
    this.held.clear();
  }
}
