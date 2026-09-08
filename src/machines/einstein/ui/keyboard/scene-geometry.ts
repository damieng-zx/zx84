/**
 * Fixed design-coordinate geometry traced from a UK Tatung Einstein TC-01.
 *
 * Every cap is 1u square except ENTER (1.8u) and the space bar (8u) — the deck
 * has no other outsized keys. What gives the face its shape is the stagger: the
 * number row starts a quarter unit in, the Q row 0.35u beyond it, the A row a
 * further 0.2u and the Z row a further 0.55u — much deeper than a modern
 * keyboard. The eight function caps sit on the same pitch, starting above the
 * gap between 3 and 4, and the space bar runs from the left of X to the right
 * of the full stop.
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

// Function caps.
row(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'], 164, FUNCTION_Y);

// Number row — BREAK ends 0.6u short of the rows below.
row([
  'esc',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'equal', 'up-arrow', 'double-bar',
  'break',
], 22, NUMBER_Y);

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
put('enter', 564, A_Y, 68);

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
