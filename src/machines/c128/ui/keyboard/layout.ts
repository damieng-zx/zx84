/**
 * The Commodore 128's keyboard face, as the machine has it (traced from a
 * photograph of one): a beige case, the main block's cream caps on a 40-unit
 * key pitch, and above and beside it the groups of darker grey caps, set on the
 * case like the rest.
 *
 * The main block is 16 keys wide with every row flush on the left: the ←/digit
 * row is all single keys; CONTROL is a key and a half and so is RESTORE;
 * RUN/STOP and SHIFT LOCK are single keys before the A row; RETURN is two keys;
 * C= is a single key and SHIFT a key and a half before the Z row, the right
 * SHIFT a key and a half before the two cursor keys. The space bar hangs under
 * the Z row from the X key to the end of the / key.
 *
 * Above it, four groups of four grey caps: ESC TAB ALT CAPS LOCK, then HELP
 * LINE FEED 40/80 DISPLAY NO SCROLL, then the four cursor arrows, and the
 * function keys over the numeric keypad at the right.
 *
 * A cap's `name` is the matrix key it presses (`C128_MATRIX`). CAPS LOCK and
 * 40/80 DISPLAY are latching switches the machine reads off its own pins, not
 * matrix keys; RESTORE pulls the NMI line, SHIFT LOCK holds the left SHIFT
 * down, and SHIFT, CTRL and C= latch for one keystroke (`CbmOnScreenKeys`).
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import type { CbmKeyDef } from '@/machines/shared/ui/cbm-keyboard/layout.ts';

/** A cap that latches in the machine itself rather than pressing a matrix key. */
export interface C128LatchDef {
  readonly id: string;
  readonly action: 'caps-lock' | 'display-80';
  readonly main: string;
  readonly lines?: readonly string[];
  readonly grey?: boolean;
  readonly word?: boolean;
  readonly box: SceneBox;
}

/** A matrix cap, with an optional stack of lines for the legends too long for `shift` over `main`. */
export type C128MatrixDef = CbmKeyDef & { readonly lines?: readonly string[] };

export type C128KeyDef = C128MatrixDef | C128LatchDef;

export const isLatch = (key: C128KeyDef): key is C128LatchDef => key.action === 'caps-lock' || key.action === 'display-80';

/** One key's pitch in scene units. */
const U = 40;
/** Caps are set this far (px) short of their slot, so the case shows between them. */
const GAP = 2;
const PAD_X = 16;
const PAD_Y = 16;

/** Where the main block's rows start, in keys below the top of the grey strip. */
const ROW0 = 1.5;
/** The function keys and keypad start here, in keys. */
const RIGHT_X = 16.85;
const RIGHT_END = RIGHT_X + 4;

export const C128_KEYBOARD_SCENE = {
  width: Math.round(RIGHT_END * U) + 2 * PAD_X,
  height: Math.round(6.4 * U) + 2 * PAD_Y,
  unit: 1,
} as const;

const keys: C128KeyDef[] = [];

const boxAt = (x: number, y: number, w: number, h: number): SceneBox => ({
  x: Math.round(x * U) + PAD_X,
  y: Math.round(y * U) + PAD_Y,
  width: Math.round(w * U) - GAP,
  height: Math.round(h * U) - GAP,
});

interface Opts {
  name?: string;
  shift?: string;
  front?: string;
  lines?: readonly string[];
  action?: CbmKeyDef['action'];
  grey?: boolean;
  word?: boolean;
  h?: number;
}

/** A cap `w` keys wide at (`x`, `y`) in keys. Returns where its slot ends. */
function put(x: number, y: number, w: number, id: string, main: string, o: Opts = {}): number {
  const action = o.action ?? 'key';
  keys.push({
    id,
    name: action === 'key' || action === 'modifier' ? (o.name ?? id) : undefined,
    main,
    shift: o.shift,
    front: o.front,
    lines: o.lines,
    action,
    grey: o.grey,
    word: o.word,
    box: boxAt(x, y, w, o.h ?? 1),
  });
  return x + w;
}

function latch(x: number, y: number, id: string, action: C128LatchDef['action'], lines: readonly string[]): number {
  keys.push({ id, action, main: lines.join(' '), lines, grey: true, word: true, box: boxAt(x, y, 1, 1) });
  return x + 1;
}

type Cap = readonly [id: string, main: string, shift?: string];

/** A run of one-key caps from `x`; returns where it ends. */
function run(x: number, y: number, caps: readonly Cap[]): number {
  let at = x;
  for (const [id, main, shift] of caps) at = put(at, y, 1, id, main, { shift });
  return at;
}

// ── The main block ───────────────────────────────────────────────────────────

// Row 1: ← 1 2 3 4 5 6 7 8 9 0 + - £ CLR/HOME INST/DEL
let x = put(0, ROW0, 1, 'arrow-left', '←');
x = run(x, ROW0, [
  ['1', '1', '!'], ['2', '2', '"'], ['3', '3', '#'], ['4', '4', '$'], ['5', '5', '%'],
  ['6', '6', '&'], ['7', '7', '\''], ['8', '8', '('], ['9', '9', ')'], ['0', 'Ø'],
  ['+', '+'], ['-', '-'], ['pound', '£'],
]);
x = put(x, ROW0, 1, 'home', 'HOME', { shift: 'CLR', word: true });
put(x, ROW0, 1, 'del', 'DEL', { shift: 'INST', word: true });

// Row 2: CONTROL Q W E R T Y U I O P @ * ↑ RESTORE
x = put(0, ROW0 + 1, 1.5, 'ctrl', 'CONTROL', { action: 'modifier', word: true });
x = run(x, ROW0 + 1, [
  ['q', 'Q'], ['w', 'W'], ['e', 'E'], ['r', 'R'], ['t', 'T'], ['y', 'Y'], ['u', 'U'], ['i', 'I'],
  ['o', 'O'], ['p', 'P'], ['@', '@'], ['*', '*'], ['arrow-up', '↑'],
]);
put(x, ROW0 + 1, 16 - x, 'restore', 'RESTORE', { action: 'restore', word: true });

// Row 3: RUN/STOP SHIFT LOCK A S D F G H J K L : ; = RETURN
put(0, ROW0 + 2, 1, 'stop', 'STOP', { shift: 'RUN', word: true });
x = put(1, ROW0 + 2, 1, 'shift-lock', 'LOCK', { shift: 'SHIFT', action: 'shift-lock', word: true });
x = run(x, ROW0 + 2, [
  ['a', 'A'], ['s', 'S'], ['d', 'D'], ['f', 'F'], ['g', 'G'], ['h', 'H'], ['j', 'J'], ['k', 'K'],
  ['l', 'L'], [':', ':', '['], [';', ';', ']'], ['=', '='],
]);
put(x, ROW0 + 2, 16 - x, 'return', 'RETURN', { word: true });

// Row 4: C= SHIFT Z X C V B N M , . / SHIFT CRSR CRSR
put(0, ROW0 + 3, 1, 'cbm', 'C=', { action: 'modifier', word: true });
x = put(1, ROW0 + 3, 1.5, 'lshift', 'SHIFT', { action: 'modifier', word: true });
const zX = x;
x = run(x, ROW0 + 3, [
  ['z', 'Z'], ['x', 'X'], ['c', 'C'], ['v', 'V'], ['b', 'B'], ['n', 'N'], ['m', 'M'],
  [',', ',', '<'], ['.', '.', '>'], ['/', '/', '?'],
]);
x = put(x, ROW0 + 3, 1.5, 'rshift', 'SHIFT', { action: 'modifier', word: true });
x = put(x, ROW0 + 3, 1, 'crsr-ud', 'CRSR', { lines: ['↑', 'CRSR', '↓'], word: true });
put(x, ROW0 + 3, 1, 'crsr-lr', 'CRSR', { lines: ['←', 'CRSR', '→'], word: true });

// Row 5: the space bar, from the X key to the end of the / key.
put(zX + 1, ROW0 + 4, 9, 'space', '', { word: true, h: 0.9 });

// ── The grey strip above ─────────────────────────────────────────────────────

// ESC TAB ALT CAPS LOCK
x = put(0, 0, 1, 'esc', 'ESC', { grey: true, word: true });
x = put(x, 0, 1, 'tab', 'TAB', { grey: true, word: true });
x = put(x, 0, 1, 'alt', 'ALT', { grey: true, word: true });
latch(x, 0, 'caps-lock', 'caps-lock', ['CAPS', 'LOCK']);

// HELP LINE FEED 40/80 DISPLAY NO SCROLL
x = put(6, 0, 1, 'help', 'HELP', { grey: true, word: true });
x = put(x, 0, 1, 'linefeed', 'LINE FEED', { lines: ['LINE', 'FEED'], grey: true, word: true });
x = latch(x, 0, 'display-80', 'display-80', ['40/80', 'DISPLAY']);
put(x, 0, 1, 'no-scroll', 'NO SCROLL', { lines: ['NO', 'SCROLL'], grey: true, word: true });

// The four cursor arrows.
x = put(12, 0, 1, 'up', '↑', { grey: true });
x = put(x, 0, 1, 'down', '↓', { grey: true });
x = put(x, 0, 1, 'left', '←', { grey: true });
put(x, 0, 1, 'right', '→', { grey: true });

// F1 F3 F5 F7, each with the key SHIFT gives printed on its front.
[['f1', 'f2'], ['f3', 'f4'], ['f5', 'f6'], ['f7', 'f8']].forEach(([main, front], i) => {
  put(RIGHT_X + i, 0, 1, main, main.toUpperCase(), { front: front.toUpperCase(), grey: true, word: true });
});

// ── The numeric keypad ───────────────────────────────────────────────────────

const pad = (id: string, main: string, col: number, row: number, w = 1, h = 1): void => {
  put(RIGHT_X + col, ROW0 + row, w, id, main, { h });
};
pad('kp7', '7', 0, 0); pad('kp8', '8', 1, 0); pad('kp9', '9', 2, 0); pad('kp+', '+', 3, 0);
pad('kp4', '4', 0, 1); pad('kp5', '5', 1, 1); pad('kp6', '6', 2, 1); pad('kp-', '−', 3, 1);
pad('kp1', '1', 0, 2); pad('kp2', '2', 1, 2); pad('kp3', '3', 2, 2);
put(RIGHT_X + 3, ROW0 + 2, 1, 'kp-enter', 'ENTER', { h: 2, word: true });
pad('kp0', '0', 0, 3, 2); pad('kp.', '.', 2, 3);

export const C128_KEYS: readonly C128KeyDef[] = keys;
