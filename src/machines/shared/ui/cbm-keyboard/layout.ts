/**
 * The Commodore breadbin keyboard face (the C64's, and the VIC-20's, which
 * has the same caps in the same places): every cap with its legends and where it
 * sits, laid out as on the machine (measured from a photograph of one) on a
 * 40-unit key pitch, with the caps touching.
 *
 * The rows are staggered like a typewriter's: the digit and CTRL rows start
 * half a key in from the left, RUN/STOP and C= a quarter key. The Z row sits
 * half a key right of the A row; RESTORE and DEL end flush on the right at
 * 16.5 keys, RETURN and the cursor keys a quarter key short of that. The
 * function keys stand apart in a column of grey caps two keys wide, level with
 * the first four rows, and the space bar sits under the bottom row. A margin of
 * case shows all round the keys.
 *
 * A cap's `name` is the matrix key it presses (each machine's matrix: `C64_MATRIX`, `VIC20_MATRIX`). Three caps
 * are not plain matrix keys: RESTORE pulls the NMI line, SHIFT LOCK is a
 * latching switch that holds the left SHIFT down, and the other modifiers
 * (SHIFT, CTRL, C=) latch for one keystroke so a single pointer can type a
 * chord.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';

export type CbmKeyAction = 'key' | 'modifier' | 'shift-lock' | 'restore';

export interface CbmKeyDef {
  /** Unique cap id. */
  readonly id: string;
  /** The matrix key pressed (`C64_MATRIX`); absent for RESTORE and SHIFT LOCK. */
  readonly name?: string;
  /** The main legend, on the top face. */
  readonly main: string;
  /** The legend printed above the main one: what SHIFT types. */
  readonly shift?: string;
  /** What is printed on the cap's front face: the colour a CTRL or C= chord gives. */
  readonly front?: string;
  readonly action: CbmKeyAction;
  /** The function keys are grey, the rest dark. */
  readonly grey?: boolean;
  /** A word or symbol cap rather than a character. */
  readonly word?: boolean;
  readonly box: SceneBox;
}

/** One key's pitch in scene units. */
const U = 40;
/** Caps fill their slots: neighbours touch, and the dark edge of each is the line between. */
const GAP = 0;
const CAP_HEIGHT = U;
/** Case showing above the top row and below the bottom one. */
const PAD_Y = 16;
/** And a little to the left of the C= and RUN/STOP keys and the right of the function keys. */
const PAD_X = 16;

/** The leftmost caps (RUN/STOP, C=) start this far in; the scene starts at them. */
const X0 = 0.25;
/** Where the keys end on the right, in keys. */
const RIGHT_EDGE = 16.5;
const FKEY_X = 17.25;

export const CBM_KEYBOARD_SCENE = { width: (FKEY_X + 2 - X0) * U + 2 * PAD_X, height: 5 * U + 2 * PAD_Y, unit: 1 } as const;

const keys: CbmKeyDef[] = [];

interface Opts {
  name?: string;
  shift?: string;
  front?: string;
  action?: CbmKeyAction;
  word?: boolean;
}

/** A cap `w` keys wide whose slot starts at `x` keys, on row `row` (in keys). */
function put(x: number, row: number, w: number, id: string, main: string, o: Opts = {}): number {
  const action = o.action ?? 'key';
  keys.push({
    id,
    name: action === 'key' || action === 'modifier' ? (o.name ?? id) : undefined,
    main,
    shift: o.shift,
    front: o.front,
    action,
    word: o.word,
    box: { x: Math.round((x - X0) * U) + PAD_X, y: Math.round(row * U) + PAD_Y, width: Math.round(w * U) - GAP, height: CAP_HEIGHT },
  });
  return x + w;
}

/** A blank above-legend: the 0 key prints nothing there but is set like the other digits. */
const NO_SHIFT = ' ';

type Cap = readonly [id: string, main: string, shift?: string, front?: string];

/** A run of one-key caps from `x`; returns where it ends. */
function run(x: number, row: number, caps: readonly Cap[]): number {
  let at = x;
  for (const [id, main, shift, front] of caps) at = put(at, row, 1, id, main, { shift, front });
  return at;
}

// Row 0: ← 1 2 3 4 5 6 7 8 9 0 + - £ CLR/HOME INST/DEL
let x = put(0.5, 0, 1, 'arrow-left', '←');
x = run(x, 0, [
  ['1', '1', '!'], ['2', '2', '"'], ['3', '3', '#'], ['4', '4', '$'],
  ['5', '5', '%'], ['6', '6', '&'], ['7', '7', '\''], ['8', '8', '('],
  ['9', '9', ')'], ['0', '0', NO_SHIFT],
  ['+', '+'], ['-', '-'], ['pound', '£'],
]);
x = put(x, 0, 1, 'home', 'HOME', { shift: 'CLR', word: true });
put(x, 0, 1, 'del', 'DEL', { shift: 'INST', word: true });

// Row 1: CTRL Q W E R T Y U I O P @ * ↑ RESTORE
x = put(0.5, 1, 1.5, 'ctrl', 'CTRL', { action: 'modifier', word: true });
x = run(x, 1, [
  ['q', 'Q'], ['w', 'W'], ['e', 'E'], ['r', 'R'], ['t', 'T'], ['y', 'Y'], ['u', 'U'], ['i', 'I'],
  ['o', 'O'], ['p', 'P'], ['@', '@'], ['*', '*'], ['arrow-up', '↑', 'π'],
]);
put(x, 1, RIGHT_EDGE - x, 'restore', 'RESTORE', { action: 'restore', word: true });

// Row 2: RUN/STOP SHIFT LOCK A S D F G H J K L : ; = RETURN
put(0.25, 2, 1, 'stop', 'STOP', { shift: 'RUN', word: true });
x = put(1.25, 2, 1, 'shift-lock', 'LOCK', { shift: 'SHIFT', action: 'shift-lock', word: true });
x = run(x, 2, [
  ['a', 'A'], ['s', 'S'], ['d', 'D'], ['f', 'F'], ['g', 'G'], ['h', 'H'], ['j', 'J'], ['k', 'K'],
  ['l', 'L'], [':', ':', '['], [';', ';', ']'], ['=', '='],
]);
put(x, 2, 2, 'return', 'RETURN', { word: true });

// Row 3: C= SHIFT Z X C V B N M , . / SHIFT ↑/↓ ←/→ (the cursor keys, a pair of arrows on each; the C= cap carries the logo)
put(0.25, 3, 1, 'cbm', 'C=', { action: 'modifier', word: true });
x = put(1.25, 3, 1.5, 'lshift', 'SHIFT', { action: 'modifier', word: true });
x = run(x, 3, [
  ['z', 'Z'], ['x', 'X'], ['c', 'C'], ['v', 'V'], ['b', 'B'], ['n', 'N'], ['m', 'M'],
  [',', ',', '<'], ['.', '.', '>'], ['/', '/', '?'],
]);
/** Where the / cap starts: the space bar ends there. */
const slashX = x - 1;
x = put(x, 3, 1.5, 'rshift', 'SHIFT', { action: 'modifier', word: true });
x = put(x, 3, 1, 'crsr-ud', '↓', { shift: '↑' });
put(x, 3, 1, 'crsr-lr', '→', { shift: '←' });

// Row 4: the space bar, under the letters, ending where the / key starts
put(3, 4, slashX - 3, 'space', '', { word: true });

// The function keys: a column of grey caps two keys wide, in step with the rows.
[['f1', 'f2'], ['f3', 'f4'], ['f5', 'f6'], ['f7', 'f8']].forEach(([main, shift], i) => {
  const box: SceneBox = { x: (FKEY_X - X0) * U + PAD_X, y: PAD_Y + i * U, width: 2 * U - GAP, height: CAP_HEIGHT };
  keys.push({ id: main, name: main, main, front: shift, action: 'key', grey: true, box });
});

export const CBM_KEYS: readonly CbmKeyDef[] = keys;
