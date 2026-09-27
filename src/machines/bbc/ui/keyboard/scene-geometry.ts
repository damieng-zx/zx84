/**
 * Fixed design-coordinate geometry for the BBC Micro on-screen keyboard.
 *
 * Keys sit edge to edge in the Model B's physical rows: the red f0-f9 strip
 * with BREAK beside f9, ESCAPE/TAB/CAPS LOCK+CTRL/SHIFT LOCK+SHIFT down the
 * left edge, and the ← → / ↑ ↓ / DELETE COPY cluster on the right, every row
 * flush to the same right edge. The cassette-motor, CAPS LOCK and SHIFT LOCK
 * lamps sit under SHIFT LOCK/SHIFT, beside the space bar.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { BBC_KEY_INDEX, type BbcKeyDef } from './layout.ts';

const PITCH = 40;
const MARGIN = 10;

const u = (n: number): number => MARGIN + n * PITCH;
const w = (n: number): number => n * PITCH;

const FUNC_Y = MARGIN;
const NUM_Y = FUNC_Y + PITCH;
const Q_Y = NUM_Y + PITCH;
const A_Y = Q_Y + PITCH;
const Z_Y = A_Y + PITCH;
const SPACE_Y = Z_Y + PITCH;

/** Width of the widest (Q) row. */
const WIDTH_UNITS = 16.75;

export const BBC_SCENE = {
  width: w(WIDTH_UNITS) + MARGIN * 2,
  height: SPACE_Y + PITCH + MARGIN,
} as const;

export interface PlacedBbcKey {
  readonly key: BbcKeyDef;
  readonly box: SceneBox;
}

const placed: PlacedBbcKey[] = [];

function put(id: string, x: number, y: number, width = PITCH): void {
  const key = BBC_KEY_INDEX.get(id);
  if (!key) throw new Error(`Unknown BBC key: ${id}`);
  placed.push({ key, box: { x, y, width, height: PITCH } });
}

/** A run of 1u caps starting at `start` units in. */
function row(ids: readonly string[], start: number, y: number): void {
  ids.forEach((id, i) => put(id, u(start + i), y));
}

// Function strip: f0-f9 then BREAK, starting a quarter-key in from the 2.
row(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'break'], 2.5, FUNC_Y);

// Number row, a quarter-key in from CAPS LOCK's left edge.
put('escape', u(0.25), NUM_Y);
row(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'minus', 'caret', 'backslash', 'left', 'right'], 1.25, NUM_Y);

// Q row, inset like the number row.
put('tab', u(0.25), Q_Y, w(1.5));
row(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'at', 'bracket-left', 'pound', 'up', 'down'], 1.75, Q_Y);

// A row.
row(['caps', 'ctrl', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'semicolon', 'colon', 'bracket-right'], 0, A_Y);
// RETURN runs a quarter-key past the right edge of ↑ (15.75).
put('return', u(14), A_Y, w(2));

// Z row.
put('shift-lock', u(0), Z_Y);
put('shift-left', u(1), Z_Y, w(1.5));
row(['z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'period', 'slash'], 2.5, Z_Y);
// The right SHIFT ends level with ]; DELETE and COPY follow it.
put('shift-right', u(12.5), Z_Y, w(1.5));
row(['delete', 'copy'], 14, Z_Y);

// Space bar.
put('space', u(3.5), SPACE_Y, w(8));

/** The three indicator lamps, under SHIFT LOCK/SHIFT to the left of the space bar. */
export const BBC_LED_BOX: SceneBox = { x: u(0), y: SPACE_Y, width: w(3.5), height: PITCH };

export function placeBbcKeys(): readonly PlacedBbcKey[] {
  return placed;
}
