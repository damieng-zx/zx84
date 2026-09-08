/**
 * Fixed design-coordinate geometry traced from a Memotech MTX512. The MTX500
 * and RS128 share the deck exactly; only the badge at the top right differs.
 *
 * Everything sits on a 40-unit pitch and no cap is under 1u. The typing block
 * staggers by the classic 0.5u / 0.25u / 0.5u, its leading modifiers all 1.5u
 * so ESC, CTRL, ALPHA LOCK and SHIFT step right with their rows; the number,
 * Q and A rows finish flush at 15u with BS, LINE FEED and RET. The numeric
 * keypad and the two-column function block stand off to the right on their own
 * recessed plates, their four rows sharing the main block's row lines.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { MTX_KEY_INDEX, type MtxKeyDef } from './layout.ts';

export const MTX_SCENE = { width: 866, height: 250, unit: 1 } as const;

export interface PlacedMtxKey {
  readonly key: MtxKeyDef;
  readonly box: SceneBox;
}

const PITCH = 40;
const GAP = 6;
const CAP = PITCH - GAP;

const NUMBER_Y = 46;
const Q_Y = 86;
const A_Y = 126;
const Z_Y = 166;
const SPACE_Y = 206;

/** Left margin, then 1u = PITCH. */
const u = (n: number) => 10 + n * PITCH;
/** Cap width for a cell `n` units wide. */
const w = (n: number) => n * PITCH - GAP;

/** The badge strip above the deck: MEMOTECH, a rule, and the model name. */
export const MTX_BADGE: SceneBox = { x: 10, y: 8, width: 846, height: 24 };
/** The recessed plates the keypad and function block sit in. */
export const MTX_KEYPAD_WELL: SceneBox =
  { x: u(15.375), y: NUMBER_Y - 8, width: 3.25 * PITCH, height: 4 * PITCH + 10 };
export const MTX_FUNCTION_WELL: SceneBox =
  { x: u(18.875), y: NUMBER_Y - 8, width: 2.25 * PITCH, height: 4 * PITCH + 10 };

const placed: PlacedMtxKey[] = [];

function put(id: string, x: number, y: number, width = CAP): void {
  const definition = MTX_KEY_INDEX.get(id);
  if (!definition) throw new Error(`Unknown MTX key: ${id}`);
  placed.push({ key: definition, box: { x, y, width, height: CAP } });
}

/** A run of 1u caps starting at `start` units in. */
function row(ids: readonly string[], start: number, y: number): void {
  ids.forEach((id, i) => put(id, u(start + i), y));
}

// Number row.
row([
  'esc',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'minus', 'caret', 'backslash',
  'bs',
], 0, NUMBER_Y);

// Q row.
put('ctrl', u(0), Q_Y, w(1.5));
row([
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'at', 'bracket-left',
], 1.5, Q_Y);
put('line-feed', u(13.5), Q_Y, w(1.5));

// A row.
put('alpha-lock', u(0.25), A_Y, w(1.5));
row([
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'semicolon', 'colon', 'bracket-right',
], 1.75, A_Y);
put('ret', u(13.75), A_Y, w(1.25));

// Z row — the right SHIFT stops a quarter unit short of the rows above.
put('shift-left', u(0.75), Z_Y, w(1.5));
row([
  'z', 'x', 'c', 'v', 'b', 'n', 'm',
  'comma', 'period', 'slash', 'underscore',
], 2.25, Z_Y);
put('shift-right', u(13.25), Z_Y, w(1.5));

// Space row: the bar between two unlabelled caps of its own.
put('space-left', u(2.25), SPACE_Y, w(1.5));
put('space', u(3.75), SPACE_Y, w(8));
put('space-right', u(11.75), SPACE_Y, w(1.25));

// Numeric keypad, its rows on the main block's row lines.
[
  ['pad-7', 'pad-8', 'pad-9'],
  ['pad-4', 'pad-5', 'pad-6'],
  ['pad-1', 'pad-2', 'pad-3'],
  ['pad-0', 'pad-dot', 'pad-ent'],
].forEach((ids, index) => row(ids, 15.5, NUMBER_Y + index * PITCH));

// Function block, two columns of four.
[
  ['f1', 'f5'],
  ['f2', 'f6'],
  ['f3', 'f7'],
  ['f4', 'f8'],
].forEach((ids, index) => row(ids, 19, NUMBER_Y + index * PITCH));

export function placeMtxKeys(): readonly PlacedMtxKey[] {
  return placed;
}
