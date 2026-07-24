/**
 * Toshiba HX-10P physical key faces mapped to the international MSX matrix.
 *
 * The five function caps carry F1/F6 through F5/F10; MSX produces F6-F10 by
 * combining SHIFT with the corresponding F1-F5 matrix key. Both SHIFT caps are
 * physical switches wired to the same matrix cell.
 */

export type Hx10Cell = readonly [row: number, bit: number];

export type Hx10KeyTone =
  | 'cream'
  | 'dark'
  | 'red'
  | 'green'
  | 'blue';

export type Hx10KeyRegion =
  | 'main'
  | 'function'
  | 'edit'
  | 'cursor';

export interface Hx10KeyDef {
  readonly id: string;
  readonly cell: Hx10Cell;
  readonly main: string;
  readonly shift?: string;
  readonly aux?: string;
  readonly tone: Hx10KeyTone;
  readonly region: Hx10KeyRegion;
}

const key = (
  id: string,
  cell: Hx10Cell,
  main: string,
  shift?: string,
  tone: Hx10KeyTone = 'cream',
  region: Hx10KeyRegion = 'main',
  aux?: string,
): Hx10KeyDef => ({ id, cell, main, shift, aux, tone, region });

export const HX10_KEYS: readonly Hx10KeyDef[] = [
  key('f1', [6, 5], 'F1', undefined, 'dark', 'function', 'F6'),
  key('f2', [6, 6], 'F2', undefined, 'dark', 'function', 'F7'),
  key('f3', [6, 7], 'F3', undefined, 'dark', 'function', 'F8'),
  key('f4', [7, 0], 'F4', undefined, 'dark', 'function', 'F9'),
  key('f5', [7, 1], 'F5', undefined, 'dark', 'function', 'F10'),
  key('stop', [7, 4], 'STOP', undefined, 'red', 'function'),

  key('esc', [7, 2], 'ESC', undefined, 'dark'),
  key('1', [0, 1], '1', '!'),
  key('2', [0, 2], '2', '@'),
  key('3', [0, 3], '3', '#'),
  key('4', [0, 4], '4', '$'),
  key('5', [0, 5], '5', '%'),
  key('6', [0, 6], '6', '^'),
  key('7', [0, 7], '7', '&'),
  key('8', [1, 0], '8', '*'),
  key('9', [1, 1], '9', '('),
  key('0', [0, 0], '0', ')'),
  key('minus', [1, 2], '-', '_'),
  key('equal', [1, 3], '=', '+'),
  key('backslash', [1, 4], '\\', '|'),
  key('bs', [7, 5], 'BS', undefined, 'dark'),

  key('tab', [7, 3], 'TAB', undefined, 'dark'),
  key('q', [4, 6], 'Q'),
  key('w', [5, 4], 'W'),
  key('e', [3, 2], 'E'),
  key('r', [4, 7], 'R'),
  key('t', [5, 1], 'T'),
  key('y', [5, 6], 'Y'),
  key('u', [5, 2], 'U'),
  key('i', [3, 6], 'I'),
  key('o', [4, 4], 'O'),
  key('p', [4, 5], 'P'),
  key('open-bracket', [1, 5], '[', '{'),
  key('close-bracket', [1, 6], ']', '}'),
  key('return', [7, 7], 'RETURN', undefined, 'dark'),

  key('ctrl', [6, 1], 'CTRL', undefined, 'dark'),
  key('a', [2, 6], 'A'),
  key('s', [5, 0], 'S'),
  key('d', [3, 1], 'D'),
  key('f', [3, 3], 'F'),
  key('g', [3, 4], 'G'),
  key('h', [3, 5], 'H'),
  key('j', [3, 7], 'J'),
  key('k', [4, 0], 'K'),
  key('l', [4, 1], 'L'),
  key('semicolon', [1, 7], ';', ':'),
  key('quote', [2, 0], "'", '"'),
  key('backquote', [2, 1], '`', '~'),

  key('shift-left', [6, 0], 'SHIFT', undefined, 'dark'),
  key('z', [5, 7], 'Z'),
  key('x', [5, 5], 'X'),
  key('c', [3, 0], 'C'),
  key('v', [5, 3], 'V'),
  key('b', [2, 7], 'B'),
  key('n', [4, 3], 'N'),
  key('m', [4, 2], 'M'),
  key('comma', [2, 2], ',', '<'),
  key('dot', [2, 3], '.', '>'),
  key('slash', [2, 4], '/', '?'),
  key('shift-right', [6, 0], 'SHIFT', undefined, 'dark'),
  key('pound', [2, 5], '£', undefined, 'dark'),

  key('caps', [6, 3], 'CAPS', undefined, 'dark'),
  key('graph', [6, 2], 'GRAPH', undefined, 'green'),
  key('space', [8, 0], '', undefined, 'cream'),
  key('code', [6, 4], 'CODE', undefined, 'dark'),

  key('ins', [8, 2], 'INS', undefined, 'dark', 'edit'),
  key('del', [8, 3], 'DEL', undefined, 'dark', 'edit'),
  key('select', [7, 6], 'SELECT', undefined, 'dark', 'edit'),
  key('home', [8, 1], 'HOME', undefined, 'dark', 'edit'),

  key('cursor-up', [8, 5], '↑', undefined, 'blue', 'cursor'),
  key('cursor-left', [8, 4], '←', undefined, 'blue', 'cursor'),
  key('cursor-right', [8, 7], '→', undefined, 'blue', 'cursor'),
  key('cursor-down', [8, 6], '↓', undefined, 'blue', 'cursor'),
] as const;

export const HX10_KEY_INDEX = new Map(
  HX10_KEYS.map((definition) => [definition.id, definition] as const),
);
