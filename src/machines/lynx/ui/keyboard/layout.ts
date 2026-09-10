/**
 * Camputers Lynx physical key faces mapped to the keyboard matrix.
 *
 * Cells are `[line, bit]` in the 10-line matrix (see `lynx-keyboard.ts`), read
 * through the address bus rather than selected by a write. `main` is the
 * unshifted legend, `shift` the one printed above it.
 *
 * The matrix is MAME's `camplynx.cpp` LINE0-LINE9, with one cell MAME leaves
 * unnamed: SHIFT LOCK at [0,3], which the MiSTer Lynx48 core identifies. The
 * two together account for every cell in the matrix but [9,4], and for every
 * cap on the deck but BREAK — which is why BREAK is carried here with no cell
 * at all. It is not a matrix key: it pulls the CPU's interrupt line directly,
 * and this machine already asserts that once a frame, so the cap depresses and
 * does nothing else.
 *
 * The unlabelled key face is the Ø cap: MAME gives it a shifted `_`, but the
 * real cap prints the slashed zero alone, so that is what it shows.
 */

export type LynxCell = readonly [line: number, bit: number];

/** `word` caps print a red legend (ESC, CONTROL, SHIFT…); `cursor` caps print
 *  a red arrow; `main` caps print white letters and symbols. */
export type LynxKeyRegion = 'main' | 'word' | 'cursor' | 'space';

export interface LynxKeyDef {
  readonly id: string;
  /** null on BREAK, the one cap that is not in the matrix. */
  readonly cell: LynxCell | null;
  readonly main: string;
  readonly shift?: string;
  readonly region: LynxKeyRegion;
}

const key = (
  id: string,
  cell: LynxCell | null,
  main: string,
  shift?: string,
  region: LynxKeyRegion = 'main',
): LynxKeyDef => ({ id, cell, main, shift, region });

/** Both SHIFT caps are the same switch. */
const SHIFT: LynxCell = [0, 7];

export const LYNX_KEYS: readonly LynxKeyDef[] = [
  key('esc', [0, 6], 'ESC', undefined, 'word'),
  key('1', [0, 0], '1', '!'),
  key('2', [2, 0], '2', '"'),
  key('3', [1, 0], '3', '#'),
  key('4', [1, 1], '4', '$'),
  key('5', [3, 0], '5', '%'),
  key('6', [4, 0], '6', '&'),
  key('7', [5, 0], '7', '’'),
  key('8', [5, 1], '8', '('),
  key('9', [6, 0], '9', ')'),
  key('0', [7, 0], 'Ø'),
  key('minus', [8, 0], '-', '='),
  key('at', [8, 1], '@', '\\'),
  key('break', null, 'BREAK', undefined, 'word'),

  key('control', [2, 6], 'CONTROL', undefined, 'word'),
  key('q', [2, 1], 'Q'),
  key('w', [2, 2], 'W'),
  key('e', [1, 2], 'E'),
  key('r', [3, 1], 'R'),
  key('t', [3, 2], 'T'),
  key('y', [4, 1], 'Y'),
  key('u', [5, 2], 'U'),
  key('i', [6, 1], 'I'),
  key('o', [6, 2], 'O'),
  key('p', [7, 1], 'P'),
  key('bracket-left', [8, 2], '['),
  key('bracket-right', [9, 1], ']'),
  key('delete', [9, 0], 'DELETE', undefined, 'word'),

  key('down', [0, 5], '↓', undefined, 'cursor'),
  key('up', [0, 4], '↑', undefined, 'cursor'),
  key('a', [2, 5], 'A'),
  key('s', [2, 4], 'S'),
  key('d', [1, 4], 'D'),
  key('f', [3, 5], 'F'),
  key('g', [3, 4], 'G'),
  key('h', [4, 2], 'H'),
  key('j', [5, 5], 'J'),
  key('k', [6, 5], 'K'),
  key('l', [7, 2], 'L'),
  key('semicolon', [7, 5], ';', '+'),
  key('colon', [8, 5], ':', '*'),
  key('left', [9, 2], '←', undefined, 'cursor'),
  key('right', [9, 5], '→', undefined, 'cursor'),

  key('shift-lock', [0, 3], 'SHIFT\nLOCK', undefined, 'word'),
  key('shift-left', SHIFT, 'SHIFT', undefined, 'word'),
  key('z', [2, 3], 'Z'),
  key('x', [1, 3], 'X'),
  key('c', [1, 5], 'C'),
  key('v', [3, 3], 'V'),
  key('b', [4, 5], 'B'),
  key('n', [4, 4], 'N'),
  key('m', [5, 3], 'M'),
  key('comma', [6, 3], ',', '<'),
  key('period', [7, 3], '.', '>'),
  key('slash', [8, 3], '/', '?'),
  key('shift-right', SHIFT, 'SHIFT', undefined, 'word'),
  key('return', [9, 3], 'RETURN', undefined, 'word'),

  key('space', [4, 3], '', undefined, 'space'),
] as const;

export const LYNX_KEY_INDEX = new Map(
  LYNX_KEYS.map((definition) => [definition.id, definition] as const),
);
