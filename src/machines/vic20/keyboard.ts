/**
 * Commodore VIC-20 keyboard: the same 64 keys as the C64's (and the same host
 * mapping, `shared/cbm/keyboard.ts`) on a matrix wired its own way, scanned
 * through VIA 2: the KERNAL drives the columns low on port B ($9120) and
 * reads the rows on port A ($9121). RESTORE is not in the matrix: it pulls
 * VIA 1's CA1, which interrupts the CPU on NMI.
 *
 * The matrix is the KERNAL's own key table read in its scan order: column 0
 * (PB0 low) gives the keys of rows PA0-PA7, then column 1, and so on.
 */

import { CbmKeyboard } from '@/machines/shared/cbm/keyboard.ts';

/** The matrix, indexed [column (VIA 2 PB bit)][row (VIA 2 PA bit)]. */
export const VIC20_MATRIX: readonly (readonly string[])[] = [
  ['1', '3', '5', '7', '9', '+', 'pound', 'del'],
  ['arrow-left', 'w', 'r', 'y', 'i', 'p', '*', 'return'],
  ['ctrl', 'a', 'd', 'g', 'j', 'l', ';', 'crsr-lr'],
  ['stop', 'lshift', 'x', 'v', 'n', ',', '/', 'crsr-ud'],
  ['space', 'z', 'c', 'b', 'm', '.', 'rshift', 'f1'],
  ['cbm', 's', 'f', 'h', 'k', ':', '=', 'f3'],
  ['q', 'e', 't', 'u', 'o', '@', 'arrow-up', 'f5'],
  ['2', '4', '6', '8', '0', '-', 'home', 'f7'],
];

/** The VIC-20's keyboard: VIA 2 port B bits are the columns, port A bits the rows. */
export class Vic20Keyboard extends CbmKeyboard {
  constructor() { super(VIC20_MATRIX); }
}
