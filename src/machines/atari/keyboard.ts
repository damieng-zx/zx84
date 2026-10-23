/**
 * Host keyboard → Atari keyboard-code mapping.
 *
 * The Atari 400/800 keyboard is not a simple ASCII keyboard: POKEY scans a
 * six-bit key matrix and the OS translates each code through two 64-entry
 * tables (one unshifted, one shifted) that live in the OS ROM at $FEFE and
 * $FF3E. The shifted table is what gives `!` on the 1 key, `"` on 2, `[` on
 * comma, `\` on the dedicated `+` key, and so on.
 *
 * So the emulator must send the *physical* key's code, not the character the
 * host produced. Typing `+` on a PC means Shift+=, but the Atari has a
 * dedicated unshifted `+` key — sending Shift would make the OS return `\`.
 * Character mapping below therefore carries its own shift flag; letters and
 * digits use the host's Shift state so case and the shifted number row work.
 *
 * The table itself is the OS ROM's:
 *
 *   unshifted ($FEFE)        shifted ($FF3E)
 *   L J ; F1 F2 K + *        L J : INV INV K \ ^
 *   O -- P U EOL I - =       O -- P U EOL I _ |
 *   V -- C -- -- B X Z       V -- C -- -- B X Z
 *   4 -- 3 6 ESC 5 2 1       4 -- 3 6 ESC 5 2 1
 *   , SPC . N -- M / INV     , SPC ] N -- M / INV
 *   R -- E Y TAB T W Q       R -- E Y SET-TAB T W Q
 *   9 -- 0 7 BS 8 < >        9 -- 0 7 DEL-LINE 8 } INS-LINE
 *   F H D -- CAPS G S A      F H D -- INV-C G S A
 *
 * (`--` marks a position with no key on the 400/800; the entries read
 * $80/$81/$83 in the ROM, which are the inverse-video graphics slots.)
 *
 * SHIFT is reported to the OS through SKSTAT bit 3 as well as KBCODE bit 6;
 * CONTROL is KBCODE bit 7. BREAK is outside the matrix and raises IRQST bit 7.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';

export interface AtariKeyPress {
  /** Six-bit POKEY scan code. */
  readonly code: number;
  /** SHIFT must be asserted for this key (the Atari key's own legend). */
  readonly shift: boolean;
  readonly control: boolean;
}

/** Letter keys, as the OS's two tables index them. */
const LETTERS: Readonly<Record<string, number>> = {
  A: 0x3F, B: 0x15, C: 0x12, D: 0x3A, E: 0x2A, F: 0x38, G: 0x3D,
  H: 0x39, I: 0x0D, J: 0x01, K: 0x05, L: 0x00, M: 0x25, N: 0x23,
  O: 0x08, P: 0x0A, Q: 0x2F, R: 0x28, S: 0x3E, T: 0x2D, U: 0x0B,
  V: 0x10, W: 0x2E, X: 0x16, Y: 0x2B, Z: 0x17,
};

const DIGITS: Readonly<Record<string, number>> = {
  '0': 0x32, '1': 0x1F, '2': 0x1E, '3': 0x1A, '4': 0x18,
  '5': 0x1D, '6': 0x1B, '7': 0x33, '8': 0x35, '9': 0x30,
};

/**
 * Printable characters the Atari keyboard can produce, with the key and
 * shift state needed to produce them. Letters and digits are handled above.
 */
const SYMBOLS: Readonly<Record<string, { code: number; shift: boolean }>> = {
  ' ': { code: 0x21, shift: false },
  '!': { code: 0x1F, shift: true },   // 1
  '"': { code: 0x1E, shift: true },   // 2
  '#': { code: 0x1A, shift: true },   // 3
  '$': { code: 0x18, shift: true },   // 4
  '%': { code: 0x1D, shift: true },   // 5
  '&': { code: 0x1B, shift: true },   // 6
  "'": { code: 0x33, shift: true },   // 7
  '(': { code: 0x30, shift: true },   // 9
  ')': { code: 0x32, shift: true },   // 0
  '*': { code: 0x07, shift: false },  // dedicated * key
  '+': { code: 0x06, shift: false },  // dedicated + key
  ',': { code: 0x20, shift: false },
  '-': { code: 0x0E, shift: false },
  '.': { code: 0x22, shift: false },
  '/': { code: 0x26, shift: false },
  ':': { code: 0x02, shift: true },   // ;
  ';': { code: 0x02, shift: false },
  '<': { code: 0x36, shift: false },  // dedicated < key
  '=': { code: 0x0F, shift: false },
  '>': { code: 0x37, shift: false },  // dedicated > key
  '?': { code: 0x26, shift: true },   // /
  '@': { code: 0x35, shift: true },   // 8
  '[': { code: 0x20, shift: true },   // ,
  '\\': { code: 0x06, shift: true },  // +
  ']': { code: 0x22, shift: true },   // .
  '^': { code: 0x07, shift: true },   // *
  '_': { code: 0x0E, shift: true },   // -
  '|': { code: 0x0F, shift: true },   // =
  '}': { code: 0x36, shift: true },   // <
};

/** Non-printing keys, mapped by host `code` so layout does not matter. */
const SPECIAL: Readonly<Record<string, AtariKeyPress>> = {
  Enter: { code: 0x0C, shift: false, control: false },
  NumpadEnter: { code: 0x0C, shift: false, control: false },
  Escape: { code: 0x1C, shift: false, control: false },
  Backspace: { code: 0x34, shift: false, control: false },
  Tab: { code: 0x2C, shift: false, control: false },
  Space: { code: 0x21, shift: false, control: false },
  CapsLock: { code: 0x3C, shift: false, control: false },
  F1: { code: 0x03, shift: false, control: false },       // 1200XL F1
  // F2-F4 are the console keys (CONSOLE_KEYS below), so the 1200XL's F2-F4
  // have no host key.
  F5: { code: 0x11, shift: false, control: false },       // HELP (XL)
  F6: { code: 0x11, shift: false, control: false },       // HELP, Altirra's key
  Insert: { code: 0x27, shift: false, control: false },   // INV
  Delete: { code: 0x34, shift: false, control: true },    // CTRL+BACKSPACE
  // Cursor keys are the CTRL+/-/=/+/* combinations on the Atari.
  ArrowUp: { code: 0x0E, shift: false, control: true },
  ArrowDown: { code: 0x0F, shift: false, control: true },
  ArrowLeft: { code: 0x06, shift: false, control: true },
  ArrowRight: { code: 0x07, shift: false, control: true },
};

/**
 * The console keys START, SELECT and OPTION are not on POKEY's matrix: GTIA
 * reads them through CONSOL. Host F2/F3/F4, as Altirra assigns them. Holding
 * OPTION through a reset is how an XL is started with BASIC switched off.
 */
export const CONSOLE_KEYS: Readonly<Record<string, number>> = {
  F2: 0x01, // START
  F3: 0x02, // SELECT
  F4: 0x04, // OPTION
};

/** Translate a host key event, or null for a key the Atari has no equivalent
 *  for (or a bare modifier, which is tracked by the caller). */
export function mapAtariKey(e: HostKeyEvent): AtariKeyPress | null {
  const special = SPECIAL[e.code];
  if (special) {
    return {
      code: special.code,
      shift: special.shift || (e.shift && !special.control),
      control: special.control || e.ctrl,
    };
  }

  const key = e.key;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z' && upper.length === 1) {
      const code = LETTERS[upper];
      if (code !== undefined) return { code, shift: e.shift, control: e.ctrl };
    }
    if (key >= '0' && key <= '9') {
      const code = DIGITS[key];
      if (code !== undefined) return { code, shift: e.shift, control: e.ctrl };
    }
    const symbol = SYMBOLS[key];
    if (symbol) return { code: symbol.code, shift: symbol.shift, control: e.ctrl };
  }
  return null;
}

/** Host key codes that are bare modifiers (never sent as keys themselves). */
export function isModifierKey(code: string): boolean {
  return code === 'ShiftLeft' || code === 'ShiftRight'
    || code === 'ControlLeft' || code === 'ControlRight';
}
