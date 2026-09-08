/**
 * Fixed design-coordinate geometry traced from a UK Tatung Einstein TC-01.
 *
 * Traced at a 40-unit key pitch from a straight-on measurement of the real key
 * deck: the four typing rows step right by 0.6u, 0.8u and 1.25u respectively —
 * a much deeper stagger than a modern keyboard — and each row's leading
 * modifier grows to fill the step, so ESC, CTL, ALPHA LOCK and SHIFT get wider
 * as you go down. The eight function caps sit on the same pitch, starting above
 * the gap between 3 and 4.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { TC01_KEY_INDEX, type Tc01KeyDef } from './layout.ts';

export const TC01_SCENE = {
  width: 648,
  height: 250,
  unit: 1,
} as const;

export interface PlacedTc01Key {
  readonly key: Tc01KeyDef;
  readonly box: SceneBox;
}

const placed: PlacedTc01Key[] = [];

function put(id: string, x: number, y: number, width: number, height = 36): void {
  const definition = TC01_KEY_INDEX.get(id);
  if (!definition) throw new Error(`Unknown Einstein TC-01 key: ${id}`);
  placed.push({ key: definition, box: { x, y, width, height } });
}

function row(ids: readonly string[], x: number, y: number, pitch = 40): void {
  ids.forEach((id, index) => put(id, x + index * pitch, y, 36));
}

const PITCH = 40;
const FUNCTION_Y = 6;
const NUMBER_Y = 44;
const Q_Y = 84;
const A_Y = 124;
const Z_Y = 164;
const SPACE_Y = 204;

// Function caps: eight low-profile keys, wider than they are apart.
['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']
  .forEach((id, index) => put(id, 164 + index * PITCH, FUNCTION_Y, 38, 32));

// Number row.
put('esc', 12, NUMBER_Y, 36);
row([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'equal', 'up-arrow', 'double-bar',
], 52, NUMBER_Y);
put('break', 576, NUMBER_Y, 48);

// Q row, ending in the two twin-arrow cursor caps.
put('ctl', 36, Q_Y, 36);
row([
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'underscore', 'left-arrow', 'cursor-lr', 'cursor-ud',
], 76, Q_Y);

// A row, ending in the red ENTER.
put('alpha-lock', 44, A_Y, 40);
row([
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'semicolon', 'colon', 'right-arrow',
], 88, A_Y);
put('enter', 568, A_Y, 64);

// Z row.
put('shift-left', 62, Z_Y, 42);
row([
  'z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'period', 'slash',
], 108, Z_Y);
put('shift-right', 508, Z_Y, 42);
put('ins-del', 554, Z_Y, 36);
put('graph', 594, Z_Y, 40);

// The space bar sits on its own row, offset left of the deck's centre.
put('space', 144, SPACE_Y, 336);

export function placeTc01Keys(): readonly PlacedTc01Key[] {
  return placed;
}
