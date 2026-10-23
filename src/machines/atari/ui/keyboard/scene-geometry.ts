/**
 * Fixed design-coordinate geometry for the Atari 400's membrane keyboard: a
 * fifteen-unit, five-row deck with the console keys in a column to its right.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import {
  ATARI400_KEY_INDEX,
  type AtariKeyDef,
} from './layout.ts';

const PITCH = 40;
const GAP = 4;
const ROW_PITCH = 42;
const KEY_HEIGHT = ROW_PITCH - GAP;
const DECK_X = 22;
const DECK_Y = 22;
const DECK_WIDTH = 15 * PITCH;
const CONSOLE_X = DECK_X + DECK_WIDTH + 24;
const CONSOLE_WIDTH = PITCH - GAP;

export const ATARI400_SCENE = {
  width: CONSOLE_X + CONSOLE_WIDTH + DECK_X,
  height: DECK_Y * 2 + 5 * ROW_PITCH - GAP,
  unit: 1,
} as const;

/** The membrane panel behind the main keys, and the console strip. */
export const ATARI400_DECK: SceneBox = {
  x: DECK_X - 8,
  y: DECK_Y - 8,
  width: DECK_WIDTH - GAP + 16,
  height: 5 * ROW_PITCH - GAP + 16,
};
export const ATARI400_CONSOLE: SceneBox = {
  x: CONSOLE_X - 8,
  y: DECK_Y - 8,
  width: CONSOLE_WIDTH + 16,
  height: 5 * ROW_PITCH - GAP + 16,
};
/** The power lamp, in the middle of the console column with its legend
 *  under it. */
export const ATARI400_POWER_LAMP: SceneBox = {
  x: CONSOLE_X + (CONSOLE_WIDTH - 12) / 2,
  y: DECK_Y + 2 * ROW_PITCH + 6,
  width: 12,
  height: 12,
};
export const ATARI400_POWER_LEGEND: SceneBox = {
  x: CONSOLE_X - 4,
  y: DECK_Y + 2 * ROW_PITCH + 22,
  width: CONSOLE_WIDTH + 8,
  height: 10,
};

export interface PlacedAtari400Key {
  readonly key: AtariKeyDef;
  readonly box: SceneBox;
}

const placed: PlacedAtari400Key[] = [];

function put(id: string, box: SceneBox): void {
  const definition = ATARI400_KEY_INDEX.get(id);
  if (!definition) throw new Error(`Unknown Atari 400 key: ${id}`);
  placed.push({ key: definition, box });
}

/** Lay a row out left to right; each entry is an id and its width in units. */
function row(index: number, keys: readonly (readonly [string, number])[], start = 0): void {
  let units = start;
  for (const [id, width] of keys) {
    put(id, {
      x: DECK_X + units * PITCH,
      y: DECK_Y + index * ROW_PITCH,
      width: width * PITCH - GAP,
      height: KEY_HEIGHT,
    });
    units += width;
  }
}

const unit = (ids: readonly string[]) => ids.map((id) => [id, 1] as const);

row(0, [
  ['esc', 1],
  ...unit(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'less', 'greater']),
  ['backspace', 1],
  ['break', 1],
]);
row(1, [
  ['tab', 1.5],
  ...unit(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'minus', 'equal']),
  ['return', 1.5],
]);
row(2, [
  ['ctrl', 1.75],
  ...unit(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'semicolon', 'plus', 'asterisk']),
  ['caps', 1.25],
]);
row(3, [
  ['shift-left', 2.25],
  ...unit(['z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'period', 'slash']),
  ['inverse', 1],
  ['shift-right', 1.75],
]);
row(4, [['space', 9]], 3);

// Console column, one 1U key per deck row with the power lamp in the middle
// row: SYSTEM RESET and OPTION above it, SELECT and START below.
(['reset', 'option', null, 'select', 'start'] as const).forEach((id, index) => {
  if (!id) return;
  put(id, {
    x: CONSOLE_X,
    y: DECK_Y + index * ROW_PITCH,
    width: CONSOLE_WIDTH,
    height: KEY_HEIGHT,
  });
});

export function placeAtari400Keys(): readonly PlacedAtari400Key[] {
  return placed;
}
