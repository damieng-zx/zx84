/**
 * Fixed design-coordinate geometry for the Acorn Atom on-screen keyboard.
 *
 * The Atom's deck is staggered like a typewriter, not ortholinear: the Q row
 * sits furthest left, the A row steps right, the number row steps further
 * right and the Z row more again, while the right-hand edges step in the same
 * way (BREAK reaches furthest, then RETURN, DELETE and REPT). Caps are the same
 * size in every row; the Z row simply has one fewer.
 *
 * The case is cream, the keys sit on a black plate and the green ACORN ATOM
 * badge is printed to the right of the space bar, as on the real machine.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import {
  ATOM_A_ROW, ATOM_Q_ROW, ATOM_SPACE_ROW, ATOM_TOP_ROW, ATOM_Z_ROW, type AtomKeyDef,
} from './layout.ts';

const PITCH = 46;
const CAP = 41;
const KEY_H = 39;
const MARGIN = 12;
const TOP = 18;
const ROW_PITCH = 44;
const SPACE_GAP = 2;
const SPACE_H = 40;
const BOTTOM = 14;

const ROW_GAP = PITCH - CAP;
const ROW_WIDTH = 15 * PITCH - ROW_GAP;

/** Row starts, staggered as on the machine; the Q row is the leftmost. */
const Q_X = MARGIN;
const A_X = Q_X + 11;
const TOP_X = Q_X + 19;
const Z_X = Q_X + 34;

const TOP_RIGHT = TOP_X + ROW_WIDTH;

export const ATOM_SCENE = {
  width: TOP_RIGHT + MARGIN,
  height: TOP + 4 * ROW_PITCH + SPACE_GAP + SPACE_H + BOTTOM,
} as const;

/** The black plate the keys and badge sit on. */
export const ATOM_PLATE_BOX: SceneBox = {
  x: MARGIN - 6,
  y: TOP - 10,
  width: TOP_RIGHT - (MARGIN - 6) + 6,
  height: 4 * ROW_PITCH + SPACE_GAP + SPACE_H + 12,
};

const SPACE_Y = TOP + 4 * ROW_PITCH + SPACE_GAP;
/** Under X, eight caps wide. */
const SPACE_X = Z_X + 3 * PITCH;
const SPACE_W = 8 * PITCH - ROW_GAP;

/** Right of the space bar, level with its top edge. */
export const ATOM_BADGE_BOX: SceneBox = {
  x: SPACE_X + SPACE_W + 8,
  y: SPACE_Y,
  width: TOP_RIGHT - (SPACE_X + SPACE_W + 8) + 2,
  height: SPACE_H,
};

export interface PlacedAtomKey {
  readonly key: AtomKeyDef;
  readonly box: SceneBox;
}

const placed: PlacedAtomKey[] = [];

/** A row of equal caps starting at its staggered left edge. */
function placeRow(keys: readonly AtomKeyDef[], x: number, y: number): void {
  keys.forEach((key, i) => {
    placed.push({
      key,
      box: { x: x + i * PITCH, y, width: CAP, height: KEY_H },
    });
  });
}

placeRow(ATOM_TOP_ROW, TOP_X, TOP);
placeRow(ATOM_Q_ROW, Q_X, TOP + ROW_PITCH);
placeRow(ATOM_A_ROW, A_X, TOP + 2 * ROW_PITCH);
placeRow(ATOM_Z_ROW, Z_X, TOP + 3 * ROW_PITCH);

placed.push({
  key: ATOM_SPACE_ROW[0],
  box: { x: SPACE_X, y: SPACE_Y, width: SPACE_W, height: SPACE_H },
});

export function placeAtomKeys(): readonly PlacedAtomKey[] {
  return placed;
}
