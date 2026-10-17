/**
 * Fixed design-coordinate geometry for the Acorn Electron on-screen keyboard:
 * five rows of keys edge to edge, ESCAPE/FUNC/CAPS LOCK/SHIFT down the left
 * edge, BREAK, DELETE, RETURN and COPY on the right and the space bar below.
 * The caps-lock and cassette-motor lamps sit beside the space bar.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { ELECTRON_KEY_INDEX, type ElectronKeyDef } from './layout.ts';

const PITCH = 40;
const MARGIN = 10;

const u = (n: number): number => MARGIN + n * PITCH;
const w = (n: number): number => n * PITCH;

const NUM_Y = MARGIN;
const Q_Y = NUM_Y + PITCH;
const A_Y = Q_Y + PITCH;
const Z_Y = A_Y + PITCH;
const SPACE_Y = Z_Y + PITCH;

/** Width of the widest row (the number row plus BREAK). */
const WIDTH_UNITS = 15.5;

export const ELECTRON_SCENE = {
  width: w(WIDTH_UNITS) + MARGIN * 2,
  height: SPACE_Y + PITCH + MARGIN,
} as const;

export interface PlacedElectronKey {
  readonly key: ElectronKeyDef;
  readonly box: SceneBox;
}

const placed: PlacedElectronKey[] = [];

function put(id: string, x: number, y: number, width = PITCH): void {
  const key = ELECTRON_KEY_INDEX.get(id);
  if (!key) throw new Error(`Unknown Electron key: ${id}`);
  placed.push({ key, box: { x, y, width, height: PITCH } });
}

function row(ids: readonly string[], start: number, y: number): void {
  ids.forEach((id, i) => put(id, u(start + i), y));
}

// Number row: ESCAPE is wider, BREAK sits apart at the right end.
put('escape', u(0), NUM_Y, w(1.5));
row(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'minus', 'left', 'right'], 1.5, NUM_Y);
put('break', u(14.5), NUM_Y);

// Q row.
put('func', u(0), Q_Y, w(1.25));
row(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'up', 'down'], 1.25, Q_Y);
put('delete', u(13.25), Q_Y, w(2.25));

// A row.
put('ctrl', u(0), A_Y, w(1.5));
row(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'semicolon', 'colon'], 1.5, A_Y);
put('return', u(12.5), A_Y, w(3));

// Z row.
put('shift-left', u(0), Z_Y, w(2));
row(['z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'period', 'slash'], 2, Z_Y);
put('shift-right', u(12), Z_Y, w(1.5));
put('copy', u(13.5), Z_Y, w(2));

// Space bar.
put('space', u(3), SPACE_Y, w(8));

/** The two indicator lamps, to the left of the space bar. */
export const ELECTRON_LED_BOX: SceneBox = { x: u(0), y: SPACE_Y, width: w(3), height: PITCH };

export function placeElectronKeys(): readonly PlacedElectronKey[] {
  return placed;
}
