/**
 * Commodore 64 keyboard: the 8 × 8 matrix scanned through CIA 1, the
 * RESTORE key (wired to the NMI line, not the matrix) and the host mapping
 * (the shared Commodore keyboard, `shared/cbm/keyboard.ts`).
 *
 * CIA 1 port A drives the columns and port B reads the rows: a pressed key
 * joins its PA and PB lines, so a line driven low pulls the other low too.
 * That works in both directions (programs that drive PB and read PA see the
 * keyboard as well), and it is how the joysticks share the same two ports.
 */

import { CbmKeyboard } from '@/machines/shared/cbm/keyboard.ts';

/** The matrix, indexed [column (PA bit)][row (PB bit)]. */
export const C64_MATRIX: readonly (readonly string[])[] = [
  ['del', 'return', 'crsr-lr', 'f7', 'f1', 'f3', 'f5', 'crsr-ud'],
  ['3', 'w', 'a', '4', 'z', 's', 'e', 'lshift'],
  ['5', 'r', 'd', '6', 'c', 'f', 't', 'x'],
  ['7', 'y', 'g', '8', 'b', 'h', 'u', 'v'],
  ['9', 'i', 'j', '0', 'm', 'k', 'o', 'n'],
  ['+', 'p', 'l', '-', '.', ':', '@', ','],
  ['pound', '*', ';', 'home', 'rshift', '=', 'arrow-up', '/'],
  ['1', 'arrow-left', 'ctrl', '2', 'space', 'cbm', 'q', 'stop'],
];

/** The 64's keyboard: port A bits are the columns, port B bits the rows. */
export class C64Keyboard extends CbmKeyboard {
  constructor() { super(C64_MATRIX); }
}

