/**
 * Memotech MTX physical key faces mapped to the keyboard matrix.
 *
 * Cells are `[drive, sense]` in the 8x10 matrix (see `mtx-keyboard.ts`). Every
 * cap and both its legends come from MTX BASIC's own key tables — `basic.rom`
 * at 0x1729 unshifted and 0x177A shifted, one entry per cell — which is what
 * settles the caps the host key map never named: LINE FEED is [3,6] (0x0A), the
 * keypad's 8/EOL is [1,7] (0x05) and its 9/BRK is [0,8] (0x03), and ENT/CLS is
 * [7,7] (0x0D shifted, 0x0C unshifted).
 *
 * `main` is the unshifted legend, `shift` the one printed above it. The two
 * unlabelled caps flanking the space bar are the one guess here: the ROM gives
 * the spare cells on their sense line no character at all, so they are
 * presented as further space bars, which is what their position suggests.
 */

export type MtxCell = readonly [drive: number, sense: number];

export type MtxKeyRegion = 'main' | 'modifier' | 'keypad' | 'function';

export interface MtxKeyDef {
  readonly id: string;
  readonly cell: MtxCell;
  readonly main: string;
  readonly shift?: string;
  readonly region: MtxKeyRegion;
}

const key = (
  id: string,
  cell: MtxCell,
  main: string,
  shift?: string,
  region: MtxKeyRegion = 'main',
): MtxKeyDef => ({ id, cell, main, shift, region });

const SPACE: MtxCell = [7, 8];

export const MTX_KEYS: readonly MtxKeyDef[] = [
  key('esc', [1, 0], 'ESC', undefined, 'modifier'),
  key('1', [0, 0], '1', '!'),
  key('2', [1, 1], '2', '"'),
  key('3', [0, 1], '3', '#'),
  key('4', [1, 2], '4', '$'),
  key('5', [0, 2], '5', '%'),
  key('6', [1, 3], '6', '&'),
  key('7', [0, 3], '7', '’'),
  key('8', [1, 4], '8', '('),
  key('9', [0, 4], '9', ')'),
  key('0', [1, 5], 'Ø'),
  key('minus', [0, 5], '-', '='),
  key('caret', [1, 6], '^', '~'),
  key('backslash', [0, 6], '\\', '|'),
  key('bs', [1, 8], 'BS', undefined, 'modifier'),

  key('ctrl', [2, 0], 'CTRL', undefined, 'modifier'),
  key('q', [3, 0], 'Q'),
  key('w', [2, 1], 'W'),
  key('e', [3, 1], 'E'),
  key('r', [2, 2], 'R'),
  key('t', [3, 2], 'T'),
  key('y', [2, 3], 'Y'),
  key('u', [3, 3], 'U'),
  key('i', [2, 4], 'I'),
  key('o', [3, 4], 'O'),
  key('p', [2, 5], 'P'),
  key('at', [3, 5], '@', '`'),
  key('bracket-left', [2, 6], '[', '{'),
  key('line-feed', [3, 6], 'LINE\nFEED', undefined, 'modifier'),

  key('alpha-lock', [4, 0], 'ALPHA\nLOCK', undefined, 'modifier'),
  key('a', [5, 0], 'A'),
  key('s', [4, 1], 'S'),
  key('d', [5, 1], 'D'),
  key('f', [4, 2], 'F'),
  key('g', [5, 2], 'G'),
  key('h', [4, 3], 'H'),
  key('j', [5, 3], 'J'),
  key('k', [4, 4], 'K'),
  key('l', [5, 4], 'L'),
  key('semicolon', [4, 5], ';', '+'),
  key('colon', [5, 5], ':', '*'),
  key('bracket-right', [4, 6], ']', '}'),
  key('ret', [5, 6], 'RET', undefined, 'modifier'),

  key('shift-left', [6, 0], 'SHIFT', undefined, 'modifier'),
  key('z', [7, 0], 'Z'),
  key('x', [6, 1], 'X'),
  key('c', [7, 1], 'C'),
  key('v', [6, 2], 'V'),
  key('b', [7, 2], 'B'),
  key('n', [6, 3], 'N'),
  key('m', [7, 3], 'M'),
  key('comma', [6, 4], ',', '<'),
  key('period', [7, 4], '.', '>'),
  key('slash', [6, 5], '/', '?'),
  key('underscore', [7, 5], '_'),
  key('shift-right', [6, 6], 'SHIFT', undefined, 'modifier'),

  key('space-left', SPACE, ''),
  key('space', SPACE, ''),
  key('space-right', SPACE, ''),

  key('pad-7', [0, 7], 'PAGE', '7', 'keypad'),
  key('pad-8', [1, 7], 'EOL', '8', 'keypad'),
  key('pad-9', [0, 8], 'BRK', '9', 'keypad'),
  key('pad-4', [2, 8], 'TAB', '4', 'keypad'),
  key('pad-5', [2, 7], '⬆', '5', 'keypad'),
  key('pad-6', [3, 8], 'DEL', '6', 'keypad'),
  key('pad-1', [3, 7], '⬅', '1', 'keypad'),
  key('pad-2', [5, 7], 'HOME', '2', 'keypad'),
  key('pad-3', [4, 7], '➡', '3', 'keypad'),
  key('pad-0', [7, 6], 'INS', '0', 'keypad'),
  key('pad-dot', [6, 7], '⬇', '.', 'keypad'),
  key('pad-ent', [7, 7], 'CLS', 'ENT', 'keypad'),

  key('f1', [0, 9], 'F1', undefined, 'function'),
  key('f2', [2, 9], 'F2', undefined, 'function'),
  key('f3', [5, 9], 'F3', undefined, 'function'),
  key('f4', [7, 9], 'F4', undefined, 'function'),
  key('f5', [1, 9], 'F5', undefined, 'function'),
  key('f6', [3, 9], 'F6', undefined, 'function'),
  key('f7', [4, 9], 'F7', undefined, 'function'),
  key('f8', [6, 9], 'F8', undefined, 'function'),
] as const;

export const MTX_KEY_INDEX = new Map(
  MTX_KEYS.map((definition) => [definition.id, definition] as const),
);
