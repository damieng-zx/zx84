/**
 * UK Amstrad CPC 464 key faces and matrix positions.
 *
 * The physical order follows the CPC464 keyboard drawing and the matrix cells
 * follow the CPC firmware/CPCTech 10×8 table. Shifted punctuation is printed
 * above the unshifted character, as on the real caps.
 */

export type CpcCell = readonly [number, number];
export type CpcKeyTone = 'dark' | 'green' | 'red' | 'blue';
export type CpcKeyRegion = 'main' | 'cursor' | 'numpad';

export interface CpcKeyDef {
  readonly id: string;
  readonly main: string;
  readonly shift?: string;
  readonly fn?: string;
  readonly cell: CpcCell;
  readonly units?: number;
  readonly tone?: CpcKeyTone;
  readonly tall?: boolean;
}

const key = (
  id: string,
  main: string,
  cell: CpcCell,
  shift?: string,
  units = 1,
  tone: CpcKeyTone = 'dark',
): CpcKeyDef => ({ id, main, shift, cell, units, tone });

export interface CpcMainRow {
  readonly startUnits?: number;
  readonly keys: readonly CpcKeyDef[];
}

export const CPC_MAIN_ROWS: readonly CpcMainRow[] = [
  {
    keys: [
      key('esc', 'ESC', [8, 2], undefined, 1, 'red'),
      key('1', '1', [8, 0], '!'),
      key('2', '2', [8, 1], '"'),
      key('3', '3', [7, 1], '#'),
      key('4', '4', [7, 0], '$'),
      key('5', '5', [6, 1], '%'),
      key('6', '6', [6, 0], '&'),
      key('7', '7', [5, 1], "'"),
      key('8', '8', [5, 0], '('),
      key('9', '9', [4, 1], ')'),
      key('0', '0', [4, 0], '_'),
      key('hyphen', '-', [3, 1], '='),
      key('caret', '^', [3, 0], '£'),
      key('clr', 'CLR', [2, 0], undefined, 1, 'green'),
      key('del', 'DEL', [9, 7], undefined, 1.25, 'green'),
    ],
  },
  {
    keys: [
      key('tab', 'TAB', [8, 4], undefined, 1.5, 'green'),
      key('q', 'Q', [8, 3]),
      key('w', 'W', [7, 3]),
      key('e', 'E', [7, 2]),
      key('r', 'R', [6, 2]),
      key('t', 'T', [6, 3]),
      key('y', 'Y', [5, 3]),
      key('u', 'U', [5, 2]),
      key('i', 'I', [4, 3]),
      key('o', 'O', [4, 2]),
      key('p', 'P', [3, 3]),
      key('at', '@', [3, 2], '|'),
      key('open-bracket', '[', [2, 1], '{'),
      { ...key('return', 'ENTER', [2, 2], undefined, 1.5, 'blue'), tall: true },
    ],
  },
  {
    keys: [
      key('caps-lock', 'CAPS\nLOCK', [8, 6], undefined, 1.75, 'green'),
      key('a', 'A', [8, 5]),
      key('s', 'S', [7, 4]),
      key('d', 'D', [7, 5]),
      key('f', 'F', [6, 5]),
      key('g', 'G', [6, 4]),
      key('h', 'H', [5, 4]),
      key('j', 'J', [5, 5]),
      key('k', 'K', [4, 5]),
      key('l', 'L', [4, 4]),
      key('semicolon', ';', [3, 4], '+'),
      key('colon', ':', [3, 5], '*'),
      key('close-bracket', ']', [2, 3], '}'),
    ],
  },
  {
    keys: [
      key('shift-left', 'SHIFT', [2, 5], undefined, 2.25, 'green'),
      key('z', 'Z', [8, 7]),
      key('x', 'X', [7, 7]),
      key('c', 'C', [7, 6]),
      key('v', 'V', [6, 7]),
      key('b', 'B', [6, 6]),
      key('n', 'N', [5, 6]),
      key('m', 'M', [4, 6]),
      key('comma', ',', [4, 7], '>'),
      key('dot', '.', [3, 7], '<'),
      key('slash', '/', [3, 6], '?'),
      key('backslash', '\\', [2, 6], '`'),
      key('shift-right', 'SHIFT', [2, 5], undefined, 2.25, 'green'),
    ],
  },
  {
    startUnits: 2.75,
    keys: [
      key('space', '', [5, 7], undefined, 8.5),
      key('ctrl', 'CTRL', [2, 7], undefined, 1.25, 'green'),
    ],
  },
] as const;

export const CPC_CURSOR_KEYS: readonly CpcKeyDef[] = [
  key('cursor-up', '↑', [0, 0]),
  key('cursor-left', '←', [1, 0]),
  key('copy', 'COPY', [1, 1], undefined, 1, 'green'),
  key('cursor-right', '→', [0, 1]),
  key('cursor-down', '↓', [0, 2]),
] as const;

export const CPC_NUMPAD_ROWS: readonly (readonly CpcKeyDef[])[] = [
  [
    { ...key('f7', '7', [1, 2]), fn: 'f7' },
    { ...key('f8', '8', [1, 3]), fn: 'f8' },
    { ...key('f9', '9', [0, 3]), fn: 'f9' },
  ],
  [
    { ...key('f4', '4', [2, 4]), fn: 'f4' },
    { ...key('f5', '5', [1, 4]), fn: 'f5' },
    { ...key('f6', '6', [0, 4]), fn: 'f6' },
  ],
  [
    { ...key('f1', '1', [1, 5]), fn: 'f1' },
    { ...key('f2', '2', [1, 6]), fn: 'f2' },
    { ...key('f3', '3', [0, 5]), fn: 'f3' },
  ],
  [
    { ...key('f0', '0', [1, 7]), fn: 'f0' },
    { ...key('fdot', '.', [0, 7]), fn: 'f.' },
    key('numpad-enter', 'ENTER', [0, 6], undefined, 1, 'blue'),
  ],
] as const;
