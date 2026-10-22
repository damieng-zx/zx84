/**
 * Atari 8-bit key faces, each tied to what it does on the hardware: the 400's
 * membrane and the XL line's full-travel caps.
 *
 * Most keys are POKEY scan codes (the same codes `keyboard.ts` sends for host
 * keys; the OS turns them into characters through its two ROM tables). The
 * rest are not on POKEY's matrix at all: SHIFT and CONTROL are folded into
 * KBCODE bits 6 and 7, BREAK raises its own IRQ, the console keys are GTIA's
 * CONSOL bits, and SYSTEM RESET is an NMI.
 *
 * Legends follow the keyboard: `shift` is the upper legend reached with
 * SHIFT, `aux` the CONTROL function (the cursor arrows, CLEAR, INSERT).
 */

export type AtariKeyAction =
  | { readonly kind: 'scan'; readonly code: number }
  | { readonly kind: 'shift' }
  | { readonly kind: 'control' }
  | { readonly kind: 'break' }
  | { readonly kind: 'console'; readonly bit: number }
  | { readonly kind: 'reset' };

export type AtariKeyTone =
  | 'membrane' | 'function' | 'orange' | 'yellow' | 'console'
  // XL: the dark sculpted caps, and the flat aluminium console keys.
  | 'cap' | 'silver';

export interface AtariKeyDef {
  readonly id: string;
  readonly action: AtariKeyAction;
  readonly main: string;
  readonly shift?: string;
  readonly aux?: string;
  readonly tone: AtariKeyTone;
}

const scan = (
  id: string,
  code: number,
  main: string,
  shift?: string,
  aux?: string,
  tone: AtariKeyTone = 'membrane',
): AtariKeyDef => ({ id, action: { kind: 'scan', code }, main, shift, aux, tone });

const special = (
  id: string,
  action: AtariKeyAction,
  main: string,
  tone: AtariKeyTone = 'function',
): AtariKeyDef => ({ id, action, main, tone });

export const ATARI400_KEYS: readonly AtariKeyDef[] = [
  scan('esc', 0x1C, 'ESC', undefined, undefined, 'function'),
  scan('1', 0x1F, '1', '!'),
  scan('2', 0x1E, '2', '"'),
  scan('3', 0x1A, '3', '#'),
  scan('4', 0x18, '4', '$'),
  scan('5', 0x1D, '5', '%'),
  scan('6', 0x1B, '6', '&'),
  scan('7', 0x33, '7', "'"),
  scan('8', 0x35, '8', '@'),
  scan('9', 0x30, '9', '('),
  scan('0', 0x32, '0', ')'),
  scan('less', 0x36, '<', 'CLEAR'),
  scan('greater', 0x37, '>', 'INSERT'),
  scan('backspace', 0x34, 'BACK S', 'DELETE', undefined, 'function'),
  special('break', { kind: 'break' }, 'BREAK'),

  scan('tab', 0x2C, 'TAB', 'SET', 'CLR', 'function'),
  scan('q', 0x2F, 'Q'),
  scan('w', 0x2E, 'W'),
  scan('e', 0x2A, 'E'),
  scan('r', 0x28, 'R'),
  scan('t', 0x2D, 'T'),
  scan('y', 0x2B, 'Y'),
  scan('u', 0x0B, 'U'),
  scan('i', 0x0D, 'I'),
  scan('o', 0x08, 'O'),
  scan('p', 0x0A, 'P'),
  scan('minus', 0x0E, '-', '_', '↑'),
  scan('equal', 0x0F, '=', '|', '↓'),
  scan('return', 0x0C, 'RETURN', undefined, undefined, 'function'),

  special('ctrl', { kind: 'control' }, 'CTRL', 'yellow'),
  scan('a', 0x3F, 'A'),
  scan('s', 0x3E, 'S'),
  scan('d', 0x3A, 'D'),
  scan('f', 0x38, 'F'),
  scan('g', 0x3D, 'G'),
  scan('h', 0x39, 'H'),
  scan('j', 0x01, 'J'),
  scan('k', 0x05, 'K'),
  scan('l', 0x00, 'L'),
  scan('semicolon', 0x02, ';', ':'),
  scan('plus', 0x06, '+', '\\', '←'),
  scan('asterisk', 0x07, '*', '^', '→'),
  scan('caps', 0x3C, 'CAPS', 'LOWR', undefined, 'function'),

  special('shift-left', { kind: 'shift' }, 'SHIFT', 'orange'),
  scan('z', 0x17, 'Z'),
  scan('x', 0x16, 'X'),
  scan('c', 0x12, 'C'),
  scan('v', 0x10, 'V'),
  scan('b', 0x15, 'B'),
  scan('n', 0x23, 'N'),
  scan('m', 0x25, 'M'),
  scan('comma', 0x20, ',', '['),
  scan('period', 0x22, '.', ']'),
  scan('slash', 0x26, '/', '?'),
  // The inverse-video key, printed with the Atari logo.
  scan('inverse', 0x27, '', undefined, undefined, 'function'),
  special('shift-right', { kind: 'shift' }, 'SHIFT', 'orange'),

  scan('space', 0x21, ''),

  special('reset', { kind: 'reset' }, 'SYSTEM RESET', 'console'),
  special('option', { kind: 'console', bit: 0x04 }, 'OPTION', 'console'),
  special('select', { kind: 'console', bit: 0x02 }, 'SELECT', 'console'),
  special('start', { kind: 'console', bit: 0x01 }, 'START', 'console'),
];

export const ATARI400_KEY_INDEX = new Map(
  ATARI400_KEYS.map((definition) => [definition.id, definition] as const),
);

/**
 * The XL keyboard. The 600XL and 800XL share it: the 400/800 matrix with
 * relabelled caps (CONTROL, CAPS without LOWR, DELETE BACK SPACE, the inverse
 * key printed as a half-filled square after the right SHIFT), and the console
 * keys plus HELP as a column of flat keys down the right. The 1200XL moved
 * the console keys, inverse and BREAK onto a strip above the keyboard, joined
 * by HELP and F1-F4; its BACK SPACE and right SHIFT widen to fill the gaps.
 *
 * The CONTROL functions are printed in small reversed boxes (`aux`), with the
 * SHIFT legend beside them.
 */
const xlCap = (id: string, code: number, main: string, shift?: string, aux?: string): AtariKeyDef =>
  scan(id, code, main, shift, aux, 'cap');

const xlFlat = (id: string, action: AtariKeyAction, main: string): AtariKeyDef =>
  ({ id, action, main, tone: 'silver' });

export const ATARI_XL_KEYS: readonly AtariKeyDef[] = [
  xlCap('esc', 0x1C, 'ESC'),
  xlCap('1', 0x1F, '1', '!'),
  xlCap('2', 0x1E, '2', '"'),
  xlCap('3', 0x1A, '3', '#'),
  xlCap('4', 0x18, '4', '$'),
  xlCap('5', 0x1D, '5', '%'),
  xlCap('6', 0x1B, '6', '&'),
  xlCap('7', 0x33, '7', "'"),
  xlCap('8', 0x35, '8', '@'),
  xlCap('9', 0x30, '9', '('),
  xlCap('0', 0x32, '0', ')'),
  xlCap('less', 0x36, '<', 'CLEAR'),
  xlCap('greater', 0x37, '>', 'INSERT'),
  xlCap('backspace', 0x34, 'BACK SPACE', 'DELETE'),
  { id: 'break', action: { kind: 'break' }, main: 'BREAK', tone: 'cap' },

  xlCap('tab', 0x2C, 'TAB', 'SET', 'CLR'),
  xlCap('q', 0x2F, 'Q'),
  xlCap('w', 0x2E, 'W'),
  xlCap('e', 0x2A, 'E'),
  xlCap('r', 0x28, 'R'),
  xlCap('t', 0x2D, 'T'),
  xlCap('y', 0x2B, 'Y'),
  xlCap('u', 0x0B, 'U'),
  xlCap('i', 0x0D, 'I'),
  xlCap('o', 0x08, 'O'),
  xlCap('p', 0x0A, 'P'),
  xlCap('minus', 0x0E, '-', '_', '↑'),
  xlCap('equal', 0x0F, '=', '|', '↓'),
  xlCap('return', 0x0C, 'RETURN'),

  { id: 'ctrl', action: { kind: 'control' }, main: 'CONTROL', tone: 'cap' },
  xlCap('a', 0x3F, 'A'),
  xlCap('s', 0x3E, 'S'),
  xlCap('d', 0x3A, 'D'),
  xlCap('f', 0x38, 'F'),
  xlCap('g', 0x3D, 'G'),
  xlCap('h', 0x39, 'H'),
  xlCap('j', 0x01, 'J'),
  xlCap('k', 0x05, 'K'),
  xlCap('l', 0x00, 'L'),
  xlCap('semicolon', 0x02, ';', ':'),
  xlCap('plus', 0x06, '+', '\\', '←'),
  xlCap('asterisk', 0x07, '*', '^', '→'),
  xlCap('caps', 0x3C, 'CAPS'),

  { id: 'shift-left', action: { kind: 'shift' }, main: 'SHIFT', tone: 'cap' },
  xlCap('z', 0x17, 'Z'),
  xlCap('x', 0x16, 'X'),
  xlCap('c', 0x12, 'C'),
  xlCap('v', 0x10, 'V'),
  xlCap('b', 0x15, 'B'),
  xlCap('n', 0x23, 'N'),
  xlCap('m', 0x25, 'M'),
  xlCap('comma', 0x20, ',', '['),
  xlCap('period', 0x22, '.', ']'),
  xlCap('slash', 0x26, '/', '?'),
  { id: 'shift-right', action: { kind: 'shift' }, main: 'SHIFT', tone: 'cap' },
  // The inverse-video key, printed with a half-filled square.
  xlCap('inverse', 0x27, ''),

  xlCap('space', 0x21, ''),

  xlFlat('reset', { kind: 'reset' }, 'RESET'),
  xlFlat('option', { kind: 'console', bit: 0x04 }, 'OPTION'),
  xlFlat('select', { kind: 'console', bit: 0x02 }, 'SELECT'),
  xlFlat('start', { kind: 'console', bit: 0x01 }, 'START'),
  xlFlat('help', { kind: 'scan', code: 0x11 }, 'HELP'),

  // 1200XL strip only: F1-F4, and inverse and BREAK as flat keys.
  xlFlat('f1', { kind: 'scan', code: 0x03 }, 'F1'),
  xlFlat('f2', { kind: 'scan', code: 0x04 }, 'F2'),
  xlFlat('f3', { kind: 'scan', code: 0x13 }, 'F3'),
  xlFlat('f4', { kind: 'scan', code: 0x14 }, 'F4'),
  xlFlat('strip-inverse', { kind: 'scan', code: 0x27 }, ''),
  xlFlat('strip-break', { kind: 'break' }, 'BREAK'),
];

export const ATARI_XL_KEY_INDEX = new Map(
  ATARI_XL_KEYS.map((definition) => [definition.id, definition] as const),
);
