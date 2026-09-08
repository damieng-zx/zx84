/**
 * Fixed design-coordinate geometry traced from a UK Tatung Einstein TC-01.
 *
 * Every cap is 1u square except ENTER (1.55u) and the space bar (8u) — the deck
 * has no other outsized keys. What gives the face its shape is the stagger: the
 * number row starts 0.1u in, the Q row 0.6u, the A row 0.8u and the Z row
 * 1.35u — much deeper than a modern keyboard, and enough that the gap between
 * the 1 and the 2 falls over the centre of Q. The eight function caps sit on
 * the same pitch, the row starting at the centre of the 3; ENTER and GRAPH
 * finish flush; and the space bar runs from the left of X to the right of the
 * full stop.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { TC01_KEY_INDEX, type Tc01KeyDef } from './layout.ts';

export const TC01_SCENE = {
  width: 644,
  height: 250,
  unit: 1,
} as const;

export interface PlacedTc01Key {
  readonly key: Tc01KeyDef;
  readonly box: SceneBox;
}

const placed: PlacedTc01Key[] = [];

/** 1u: the cap pitch. Caps are CAP wide, leaving a GAP-wide channel between. */
const PITCH = 40;
const CAP = 36;

const FUNCTION_Y = 4;
const NUMBER_Y = 44;
const Q_Y = 84;
const A_Y = 124;
const Z_Y = 164;
const SPACE_Y = 204;

function put(id: string, x: number, y: number, width = CAP): void {
  const definition = TC01_KEY_INDEX.get(id);
  if (!definition) throw new Error(`Unknown Einstein TC-01 key: ${id}`);
  placed.push({ key: definition, box: { x, y, width, height: CAP } });
}

/** A run of 1u caps starting at `x`. */
function row(ids: readonly string[], x: number, y: number): void {
  ids.forEach((id, index) => put(id, x + index * PITCH, y));
}

// Function caps, the row starting at the centre of the 3.
row(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'], 156, FUNCTION_Y);

// Number row — BREAK ends 0.6u short of the rows below.
row([
  'esc',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'equal', 'up-arrow', 'double-bar',
  'break',
], 16, NUMBER_Y);

// Q row, ending in the two twin-arrow cursor caps.
row([
  'ctrl',
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'underscore', 'left-arrow',
  'cursor-lr', 'cursor-ud',
], 36, Q_Y);

// A row: thirteen 1u caps and the 1.8u red ENTER, flush with the cursor cross.
row([
  'alpha-lock',
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'semicolon', 'colon', 'right-arrow',
], 44, A_Y);
put('enter', 564, A_Y, 58);

// Z row, GRAPH flush with ENTER.
row([
  'shift-left',
  'z', 'x', 'c', 'v', 'b', 'n', 'm',
  'comma', 'period', 'slash',
  'shift-right', 'ins-del', 'graph',
], 66, Z_Y);

// The space bar spans X to the full stop.
put('space', 146, SPACE_Y, 316);

export function placeTc01Keys(): readonly PlacedTc01Key[] {
  return placed;
}
