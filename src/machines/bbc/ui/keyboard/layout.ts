/**
 * BBC Micro Model B keyboard keys — matrix cells ([column, row]) and legends.
 *
 * Cells follow the BBC's scan-code matrix (col = low nibble, row = bits 4-6;
 * see beebwiki). The legends are the machine's own: the number row is
 * `! " # $ % & ' ( )`, `*`/`:` share the '*' next to RETURN, and the `_`/`£`
 * key is its own cap. BREAK has no matrix cell (it resets the machine).
 */

/** Cap colour: black by default, red function keys, dark green COPY/cursors. */
export type BbcKeyRegion = 'function' | 'cursor';

export interface BbcKeyDef {
  readonly id: string;
  /** [column, row] in the keyboard matrix, or null for BREAK. */
  readonly cell: readonly [number, number] | null;
  /** Primary (unshifted) legend; may contain '\n'. */
  readonly main: string;
  /** Shifted legend printed above the primary one. */
  readonly shift?: string;
  readonly region?: BbcKeyRegion;
}

export const BBC_KEYS: readonly BbcKeyDef[] = [
  // Function strip (red caps on the real machine), then the black BREAK.
  { id: 'f0', cell: [0, 2], main: 'f0', region: 'function' },
  { id: 'f1', cell: [1, 7], main: 'f1', region: 'function' },
  { id: 'f2', cell: [2, 7], main: 'f2', region: 'function' },
  { id: 'f3', cell: [3, 7], main: 'f3', region: 'function' },
  { id: 'f4', cell: [4, 1], main: 'f4', region: 'function' },
  { id: 'f5', cell: [4, 7], main: 'f5', region: 'function' },
  { id: 'f6', cell: [5, 7], main: 'f6', region: 'function' },
  { id: 'f7', cell: [6, 1], main: 'f7', region: 'function' },
  { id: 'f8', cell: [6, 7], main: 'f8', region: 'function' },
  { id: 'f9', cell: [7, 7], main: 'f9', region: 'function' },
  { id: 'break', cell: null, main: 'BREAK' },

  // Number row.
  { id: 'escape', cell: [0, 7], main: 'ESCAPE' },
  { id: '1', cell: [0, 3], main: '1', shift: '!' },
  { id: '2', cell: [1, 3], main: '2', shift: '"' },
  { id: '3', cell: [1, 1], main: '3', shift: '#' },
  { id: '4', cell: [2, 1], main: '4', shift: '$' },
  { id: '5', cell: [3, 1], main: '5', shift: '%' },
  { id: '6', cell: [4, 3], main: '6', shift: '&' },
  { id: '7', cell: [4, 2], main: '7', shift: "'" },
  { id: '8', cell: [5, 1], main: '8', shift: '(' },
  { id: '9', cell: [6, 2], main: '9', shift: ')' },
  { id: '0', cell: [7, 2], main: '0' },
  { id: 'minus', cell: [7, 1], main: '-', shift: '=' },
  { id: 'caret', cell: [8, 1], main: '^', shift: '~' },
  { id: 'backslash', cell: [8, 7], main: '\\', shift: '|' },
  { id: 'left', cell: [9, 1], main: '←', region: 'cursor' },
  { id: 'right', cell: [9, 7], main: '→', region: 'cursor' },

  // Q row.
  { id: 'tab', cell: [0, 6], main: 'TAB' },
  { id: 'q', cell: [0, 1], main: 'Q' },
  { id: 'w', cell: [1, 2], main: 'W' },
  { id: 'e', cell: [2, 2], main: 'E' },
  { id: 'r', cell: [3, 3], main: 'R' },
  { id: 't', cell: [3, 2], main: 'T' },
  { id: 'y', cell: [4, 4], main: 'Y' },
  { id: 'u', cell: [5, 3], main: 'U' },
  { id: 'i', cell: [5, 2], main: 'I' },
  { id: 'o', cell: [6, 3], main: 'O' },
  { id: 'p', cell: [7, 3], main: 'P' },
  { id: 'at', cell: [7, 4], main: '@' },
  { id: 'bracket-left', cell: [8, 3], main: '[', shift: '{' },
  { id: 'pound', cell: [8, 2], main: '_', shift: '£' },
  { id: 'up', cell: [9, 3], main: '↑', region: 'cursor' },
  { id: 'down', cell: [9, 2], main: '↓', region: 'cursor' },

  // A row.
  { id: 'caps', cell: [0, 4], main: 'CAPS\nLOCK' },
  { id: 'ctrl', cell: [1, 0], main: 'CTRL' },
  { id: 'a', cell: [1, 4], main: 'A' },
  { id: 's', cell: [1, 5], main: 'S' },
  { id: 'd', cell: [2, 3], main: 'D' },
  { id: 'f', cell: [3, 4], main: 'F' },
  { id: 'g', cell: [3, 5], main: 'G' },
  { id: 'h', cell: [4, 5], main: 'H' },
  { id: 'j', cell: [5, 4], main: 'J' },
  { id: 'k', cell: [6, 4], main: 'K' },
  { id: 'l', cell: [6, 5], main: 'L' },
  { id: 'semicolon', cell: [7, 5], main: ';', shift: '+' },
  { id: 'colon', cell: [8, 4], main: ':', shift: '*' },
  { id: 'bracket-right', cell: [8, 5], main: ']', shift: '}' },
  { id: 'return', cell: [9, 4], main: 'RETURN' },

  // Z row.
  { id: 'shift-lock', cell: [0, 5], main: 'SHIFT\nLOCK' },
  { id: 'shift-left', cell: [0, 0], main: 'SHIFT' },
  { id: 'z', cell: [1, 6], main: 'Z' },
  { id: 'x', cell: [2, 4], main: 'X' },
  { id: 'c', cell: [2, 5], main: 'C' },
  { id: 'v', cell: [3, 6], main: 'V' },
  { id: 'b', cell: [4, 6], main: 'B' },
  { id: 'n', cell: [5, 5], main: 'N' },
  { id: 'm', cell: [5, 6], main: 'M' },
  { id: 'comma', cell: [6, 6], main: ',', shift: '<' },
  { id: 'period', cell: [7, 6], main: '.', shift: '>' },
  { id: 'slash', cell: [8, 6], main: '/', shift: '?' },
  { id: 'shift-right', cell: [0, 0], main: 'SHIFT' },
  { id: 'delete', cell: [9, 5], main: 'DELETE' },
  { id: 'copy', cell: [9, 6], main: 'COPY', region: 'cursor' },

  // Space bar (a plain black bar on the Model B).
  { id: 'space', cell: [2, 6], main: '' },
];

export const BBC_KEY_INDEX: ReadonlyMap<string, BbcKeyDef> =
  new Map(BBC_KEYS.map(key => [key.id, key]));
