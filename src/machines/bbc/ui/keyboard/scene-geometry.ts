/**
 * Fixed design-coordinate geometry for the BBC Micro on-screen keyboard.
 * Keys are laid out in the machine's physical rows.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { BBC_KEY_INDEX, type BbcKeyDef } from './layout.ts';

const PITCH = 40;
const GAP = 6;
const CAP = PITCH - GAP;
const MARGIN = 10;

const u = (n: number): number => MARGIN + n * PITCH;
const w = (n: number): number => n * PITCH - GAP;

const FUNC_Y = 10;
const NUM_Y = FUNC_Y + PITCH;
const Q_Y = NUM_Y + PITCH;
const A_Y = Q_Y + PITCH;
const Z_Y = A_Y + PITCH;
const SPACE_Y = Z_Y + PITCH;

export const BBC_SCENE = { width: w(16) + MARGIN * 2, height: SPACE_Y + CAP + MARGIN } as const;

export interface PlacedBbcKey {
  readonly key: BbcKeyDef;
  readonly box: SceneBox;
}

const placed: PlacedBbcKey[] = [];

function put(id: string, x: number, y: number, width = CAP): void {
  const key = BBC_KEY_INDEX.get(id);
  if (!key) throw new Error(`Unknown BBC key: ${id}`);
  placed.push({ key, box: { x, y, width, height: CAP } });
}

/** A run of 1u caps starting at `start` units in. */
function row(ids: readonly string[], start: number, y: number): void {
  ids.forEach((id, i) => put(id, u(start + i), y));
}

// Function strip: BREAK then f0-f9.
put('break', u(0), FUNC_Y, w(1.5));
row(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9'], 2, FUNC_Y);

// Number row.
row(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], 0, NUM_Y);
put('minus', u(10), NUM_Y);
put('caret', u(11), NUM_Y);
put('pound', u(12), NUM_Y);
put('up', u(13), NUM_Y);
put('backslash', u(14), NUM_Y);

// Q row.
row(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], 0, Q_Y);
put('bracket-left', u(10), Q_Y);
put('bracket-right', u(11), Q_Y);
put('left', u(12), Q_Y);
put('down', u(13), Q_Y);
put('right', u(14), Q_Y);

// A row.
put('caps', u(0), A_Y, w(1.5));
row(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], 1.75, A_Y);
put('semicolon', u(10.75), A_Y);
put('colon', u(11.75), A_Y);
put('at', u(12.75), A_Y);
put('return', u(13.75), A_Y, w(1.25));

// Z row.
put('shift-left', u(0), Z_Y, w(1.75));
row(['z', 'x', 'c', 'v', 'b', 'n', 'm'], 2, Z_Y);
put('comma', u(9), Z_Y);
put('period', u(10), Z_Y);
put('slash', u(11), Z_Y);
put('shift-right', u(12), Z_Y, w(1.75));
put('delete', u(14), Z_Y, w(1.75));

// Space row.
put('ctrl', u(0), SPACE_Y, w(1.5));
put('shift-lock', u(1.75), SPACE_Y, w(1.5));
put('space', u(3.5), SPACE_Y, w(7));
put('copy', u(10.75), SPACE_Y, w(1.5));

export function placeBbcKeys(): readonly PlacedBbcKey[] {
  return placed;
}
