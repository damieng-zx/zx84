/**
 * Apple II key faces.
 *
 * Three keyboards cover the five models:
 *  - the ][ and ][+ share one 52-key, upper-case keyboard laid out like the
 *    teletypes it replaced: ESC beside Q, the arrows beside L, REPT and RESET;
 *  - the //e (unenhanced and Enhanced — the kit changed ROMs, not keys) has the
 *    63-key full-ASCII keyboard with TAB, DELETE, CAPS LOCK and the two Apple
 *    keys, and moves RESET off the main block to the top right;
 *  - the //c has the //e's keys in its own case, with RESET above ESC and the
 *    80/40 and KEYBOARD switches beside it.
 *
 * There is no matrix to scan: a cap's `face` is the DOM key code fed to the
 * keyboard encoder (or a cap the PC lacks, like the ][ `: *`), which also lets
 * physical keystrokes light the matching cap.
 */

import type { MachineModel } from '@/models.ts';

export type Apple2KeyboardVariant = 'apple2' | 'apple2e' | 'apple2c';

export function apple2KeyboardVariant(model: MachineModel): Apple2KeyboardVariant {
  if (model === 'apple2c') return 'apple2c';
  if (model === 'apple2e' || model === 'apple2e-enhanced') return 'apple2e';
  return 'apple2';
}

/** What a cap does when pressed. */
export type Apple2KeyAction =
  | 'char'
  | 'shift'
  | 'ctrl'
  | 'open-apple'
  | 'solid-apple'
  | 'caps-lock'
  | 'reset'
  | 'repeat';

export type Apple2KeyRegion = 'main' | 'word' | 'space' | 'cursor' | 'apple';

export interface Apple2KeyDef {
  /** Unique cap id within one face. */
  readonly id: string;
  /** DOM key code (or encoder face id) this cap presses. */
  readonly face: string;
  readonly main: string;
  readonly shift?: string;
  /** A function printed on the cap's front, like the ][ G key's BELL. */
  readonly aux?: string;
  readonly action: Apple2KeyAction;
  readonly region: Apple2KeyRegion;
  /** Other host key codes that light this cap. */
  readonly host?: readonly string[];
}

function char(face: string, main: string, shift?: string, aux?: string): Apple2KeyDef {
  return { id: face, face, main, shift, aux, action: 'char', region: 'main' };
}

function word(
  id: string,
  face: string,
  main: string,
  action: Apple2KeyAction = 'char',
  host?: readonly string[],
): Apple2KeyDef {
  return { id, face, main, action, region: 'word', host };
}

function arrow(face: string, main: string, host?: readonly string[]): Apple2KeyDef {
  return { id: face, face, main, action: 'char', region: 'cursor', host };
}

const letters = (row: string): Apple2KeyDef[] =>
  [...row].map((ch) => char(`Key${ch}`, ch));

const SPACE: Apple2KeyDef = { id: 'Space', face: 'Space', main: '', action: 'char', region: 'space' };

/** Apple ][ and ][+: shift legends sit above the main legend, as printed. */
export const APPLE2_KEYS: readonly Apple2KeyDef[] = [
  char('Digit1', '1', '!'),
  char('Digit2', '2', '"'),
  char('Digit3', '3', '#'),
  char('Digit4', '4', '$'),
  char('Digit5', '5', '%'),
  char('Digit6', '6', '&'),
  char('Digit7', '7', "'"),
  char('Digit8', '8', '('),
  char('Digit9', '9', ')'),
  char('Digit0', '0'),
  char('colon', ':', '*'),
  char('Minus', '-', '='),
  word('reset', 'reset', 'RESET', 'reset'),

  word('Escape', 'Escape', 'ESC'),
  ...letters('QWERTYUIO'),
  char('KeyP', 'P', '@'),
  word('rept', 'rept', 'REPT', 'repeat'),
  word('Enter', 'Enter', 'RETURN', 'char', ['NumpadEnter']),

  word('ctrl', 'ControlLeft', 'CTRL', 'ctrl', ['ControlRight']),
  ...letters('ASDF'),
  char('KeyG', 'G', undefined, 'BELL'),
  ...letters('HJKL'),
  char('Semicolon', ';', '+'),
  arrow('ArrowLeft', '←', ['Backspace']),
  arrow('ArrowRight', '→'),

  word('shift-left', 'ShiftLeft', 'SHIFT', 'shift'),
  ...letters('ZXCVB'),
  char('KeyN', 'N', '^'),
  char('KeyM', 'M', ']'),
  char('Comma', ',', '<'),
  char('Period', '.', '>'),
  char('Slash', '/', '?'),
  word('shift-right', 'ShiftRight', 'SHIFT', 'shift'),

  SPACE,
];

/** Apple //e and //c: lower-case word caps, legends top left. */
export const APPLE2E_KEYS: readonly Apple2KeyDef[] = [
  word('reset', 'reset', 'reset', 'reset'),

  word('Escape', 'Escape', 'esc'),
  char('Digit1', '1', '!'),
  char('Digit2', '2', '@'),
  char('Digit3', '3', '#'),
  char('Digit4', '4', '$'),
  char('Digit5', '5', '%'),
  char('Digit6', '6', '^'),
  char('Digit7', '7', '&'),
  char('Digit8', '8', '*'),
  char('Digit9', '9', '('),
  char('Digit0', '0', ')'),
  char('Minus', '-', '_'),
  char('Equal', '=', '+'),
  word('Delete', 'Delete', 'delete'),

  word('Tab', 'Tab', 'tab'),
  ...letters('QWERTYUIOP'),
  char('BracketLeft', '[', '{'),
  char('BracketRight', ']', '}'),
  char('Backslash', '\\', '|'),

  word('ctrl', 'ControlLeft', 'control', 'ctrl', ['ControlRight']),
  ...letters('ASDFGHJKL'),
  char('Semicolon', ';', ':'),
  char('Quote', "'", '"'),
  word('Enter', 'Enter', 'return', 'char', ['NumpadEnter']),

  word('shift-left', 'ShiftLeft', 'shift', 'shift'),
  ...letters('ZXCVBNM'),
  char('Comma', ',', '<'),
  char('Period', '.', '>'),
  char('Slash', '/', '?'),
  word('shift-right', 'ShiftRight', 'shift', 'shift'),

  word('caps-lock', 'CapsLock', 'caps\nlock', 'caps-lock'),
  char('Backquote', '`', '~'),
  { id: 'open-apple', face: 'AltLeft', main: 'Open Apple', action: 'open-apple', region: 'apple' },
  SPACE,
  { id: 'solid-apple', face: 'AltRight', main: 'Solid Apple', action: 'solid-apple', region: 'apple' },
  arrow('ArrowLeft', '←', ['Backspace']),
  arrow('ArrowRight', '→'),
  arrow('ArrowDown', '↓'),
  arrow('ArrowUp', '↑'),
];

export function apple2Keys(variant: Apple2KeyboardVariant): readonly Apple2KeyDef[] {
  return variant === 'apple2' ? APPLE2_KEYS : APPLE2E_KEYS;
}
