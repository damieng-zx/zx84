/**
 * Acorn Electron keyboard keys — matrix cells and legends.
 *
 * The 56-key keyboard has two SHIFT keys sharing one matrix cell, a CAPS LOCK
 * key that is also CTRL (tapped alone it toggles caps lock), a FUNC key that
 * turns the number keys into f0-f9, and cursor keys that carry symbols
 * (SHIFT: `^ _ £ |`, CTRL: `~ } { \`). BREAK has no matrix cell: it resets the CPU.
 */

import { ELK_KEYS, type ElectronKeyName } from '@/machines/electron/electron-keyboard-matrix.ts';

/** Cap colour: dark by default, cursor/COPY keys grey. */
export type ElectronKeyRegion = 'cursor';

export interface ElectronKeyDef {
  readonly id: string;
  /** [column, row] in the keyboard matrix, or null for BREAK. */
  readonly cell: readonly [number, number] | null;
  /** Primary legend; may contain '\n'. */
  readonly main: string;
  /** Shifted legend printed above the primary one. */
  readonly shift?: string;
  readonly region?: ElectronKeyRegion;
}

function key(
  id: string, name: ElectronKeyName | null, main: string, shift?: string,
  region?: ElectronKeyRegion,
): ElectronKeyDef {
  return { id, cell: name ? ELK_KEYS[name] : null, main, shift, region };
}

export const ELECTRON_KEYS: readonly ElectronKeyDef[] = [
  // Number row.
  key('escape', 'escape', 'ESCAPE'),
  key('1', '1', '1', '!'), key('2', '2', '2', '"'), key('3', '3', '3', '#'),
  key('4', '4', '4', '$'), key('5', '5', '5', '%'), key('6', '6', '6', '&'),
  key('7', '7', '7', "'"), key('8', '8', '8', '('), key('9', '9', '9', ')'),
  key('0', '0', '0', '@'),
  key('minus', 'minus', '-', '='),
  key('left', 'left', '←', '^', 'cursor'),
  key('right', 'right', '→', '|', 'cursor'),
  key('break', null, 'BREAK'),

  // Q row.
  key('func', 'func', 'FUNC'),
  key('q', 'q', 'Q'), key('w', 'w', 'W'), key('e', 'e', 'E'), key('r', 'r', 'R'),
  key('t', 't', 'T'), key('y', 'y', 'Y'), key('u', 'u', 'U'), key('i', 'i', 'I'),
  key('o', 'o', 'O'), key('p', 'p', 'P'),
  key('up', 'up', '↑', '£', 'cursor'),
  key('down', 'down', '↓', '_', 'cursor'),
  key('delete', 'delete', 'DELETE'),

  // A row.
  key('ctrl', 'ctrl', 'CAPS\nLOCK', 'CTRL'),
  key('a', 'a', 'A'), key('s', 's', 'S'), key('d', 'd', 'D'), key('f', 'f', 'F'),
  key('g', 'g', 'G'), key('h', 'h', 'H'), key('j', 'j', 'J'), key('k', 'k', 'K'),
  key('l', 'l', 'L'),
  key('semicolon', 'semicolon', ';', '+'),
  key('colon', 'colon', ':', '*'),
  key('return', 'return', 'RETURN'),

  // Z row.
  key('shift-left', 'shift', 'SHIFT'),
  key('z', 'z', 'Z'), key('x', 'x', 'X'), key('c', 'c', 'C'), key('v', 'v', 'V'),
  key('b', 'b', 'B'), key('n', 'n', 'N'), key('m', 'm', 'M'),
  key('comma', 'comma', ',', '<'),
  key('period', 'period', '.', '>'),
  key('slash', 'slash', '/', '?'),
  key('shift-right', 'shift', 'SHIFT'),
  key('copy', 'copy', 'COPY', '[', 'cursor'),

  // Space bar.
  key('space', 'space', ''),
];

export const ELECTRON_KEY_INDEX: ReadonlyMap<string, ElectronKeyDef> =
  new Map(ELECTRON_KEYS.map(k => [k.id, k]));
