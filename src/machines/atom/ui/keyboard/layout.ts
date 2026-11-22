/**
 * Acorn Atom key faces and matrix cells.
 *
 * The Atom scans a 10x6 matrix, but its keyboard is a normal QWERTY deck: the
 * matrix rows are the *columns* of the physical board. This file lists the caps
 * in their physical order — ESC/1..0/=/ * /↑/BREAK, the Q row, the A row, the Z
 * row and the space bar — with each cap's matrix cell alongside. Cells follow
 * the Atom matrix table (shift on port B bit 7, ctrl bit 6, REPT on port C bit
 * 6): digits and punctuation in columns 0-2, letters in columns 3-5.
 *
 * `-`/`=` and `:`/`*` are the two-legend punctuation keys; `@`, `\`, `[` and
 * `]` carry one legend (SHIFT only inverts them), and the zero key's upper
 * glyph is the Atom's slashed zero, not a shift legend.
 */

export type AtomKeyAction = 'key' | 'shift' | 'ctrl' | 'rept' | 'break';
export type AtomKeyRegion = 'letter' | 'number' | 'word' | 'space' | 'cursor' | 'mod';

export interface AtomKeyDef {
  readonly id: string;
  /** Matrix row/column; -1 for SHIFT/CTRL/REPT/BREAK, which are not cells. */
  readonly row: number;
  readonly col: number;
  readonly main: string;
  readonly shift?: string;
  readonly action: AtomKeyAction;
  readonly region: AtomKeyRegion;
}

function cell(
  row: number, col: number, main: string, shift?: string,
  region: AtomKeyRegion = 'letter',
): AtomKeyDef {
  return { id: `r${row}c${col}`, row, col, main, shift, action: 'key', region };
}

function mod(id: string, main: string, action: AtomKeyAction): AtomKeyDef {
  return { id, row: -1, col: -1, main, action, region: 'mod' };
}

/** ESC, the number row, `-`/`=` and `:`/`*`, the up-arrow key and BREAK. */
export const ATOM_TOP_ROW: readonly AtomKeyDef[] = [
  cell(0, 5, 'ESC', undefined, 'word'),
  cell(2, 1, '1', '!', 'number'),
  cell(1, 1, '2', '"', 'number'),
  cell(0, 1, '3', '#', 'number'),
  cell(9, 2, '4', '$', 'number'),
  cell(8, 2, '5', '%', 'number'),
  cell(7, 2, '6', '&', 'number'),
  cell(6, 2, '7', "'", 'number'),
  cell(5, 2, '8', '(', 'number'),
  cell(4, 2, '9', ')', 'number'),
  cell(3, 1, '0', undefined, 'number'),
  cell(0, 2, '-', '=', 'number'),
  cell(3, 2, ':', '*', 'number'),
  cell(5, 0, '↑', undefined, 'cursor'),
  mod('break', 'BREAK', 'break'),
];

/** The left/right arrow, COPY, QWERTY, `@`, `\` and DELETE. */
export const ATOM_Q_ROW: readonly AtomKeyDef[] = [
  cell(3, 0, '↔', undefined, 'cursor'),
  cell(5, 1, 'COPY', undefined, 'word'),
  cell(0, 4, 'Q'), cell(4, 5, 'W'), cell(2, 3, 'E'), cell(9, 5, 'R'),
  cell(7, 5, 'T'), cell(2, 5, 'Y'), cell(6, 5, 'U'), cell(8, 4, 'I'),
  cell(2, 4, 'O'), cell(1, 4, 'P'),
  cell(7, 3, '@', undefined, 'number'),
  cell(7, 0, '\\', undefined, 'number'),
  cell(4, 1, 'DELETE', undefined, 'word'),
];

/** The up/down arrow, CTRL, ASDF, the `;`/`+` key, `[`, `]` and RETURN. */
export const ATOM_A_ROW: readonly AtomKeyDef[] = [
  cell(2, 0, '↕', undefined, 'cursor'),
  mod('ctrl', 'CTRL', 'ctrl'),
  cell(6, 3, 'A'), cell(8, 5, 'S'), cell(3, 3, 'D'), cell(1, 3, 'F'),
  cell(0, 3, 'G'), cell(9, 4, 'H'), cell(7, 4, 'J'), cell(6, 4, 'K'),
  cell(5, 4, 'L'),
  cell(2, 2, ';', '+', 'number'),
  cell(8, 0, '[', undefined, 'number'),
  cell(6, 0, ']', undefined, 'number'),
  cell(6, 1, 'RETURN', undefined, 'word'),
];

/** LOCK, SHIFT, ZXCV, the `,`/`<` `.`/`>` `/`/`?` keys, SHIFT and REPT. */
export const ATOM_Z_ROW: readonly AtomKeyDef[] = [
  cell(4, 0, 'LOCK', undefined, 'word'),
  mod('shift-left', 'SHIFT', 'shift'),
  cell(1, 5, 'Z'), cell(3, 5, 'X'), cell(4, 3, 'C'), cell(5, 5, 'V'),
  cell(5, 3, 'B'), cell(3, 4, 'N'), cell(4, 4, 'M'),
  cell(1, 2, ',', '<', 'number'),
  cell(9, 3, '.', '>', 'number'),
  cell(8, 3, '/', '?', 'number'),
  mod('shift-right', 'SHIFT', 'shift'),
  mod('rept', 'REPT', 'rept'),
];

export const ATOM_SPACE_ROW: readonly AtomKeyDef[] = [
  cell(9, 0, '', undefined, 'space'),
];

export const ATOM_KEYS: readonly AtomKeyDef[] = [
  ...ATOM_TOP_ROW, ...ATOM_Q_ROW, ...ATOM_A_ROW, ...ATOM_Z_ROW, ...ATOM_SPACE_ROW,
];
