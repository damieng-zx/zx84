/**
 * Fixed design-coordinate geometry traced from the UK Toshiba HX-10P.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import {
  HX10_KEY_INDEX,
  type Hx10KeyDef,
} from './layout.ts';

export const HX10_SCENE = {
  width: 860,
  height: 440,
  unit: 1,
} as const;

export interface PlacedHx10Key {
  readonly key: Hx10KeyDef;
  readonly box: SceneBox;
  readonly hitClip?: string;
}

const placed: PlacedHx10Key[] = [];

function put(
  id: string,
  x: number,
  y: number,
  width: number,
  height = 36,
  hitClip?: string,
): void {
  const definition = HX10_KEY_INDEX.get(id);
  if (!definition) throw new Error(`Unknown HX-10 key: ${id}`);
  placed.push({
    key: definition,
    box: { x, y, width, height },
    hitClip,
  });
}

const MAIN_LEFT = 44;
const PITCH = 40;
const ROW_TOP = 200;
const ROW_PITCH = 42;

// Five physical function caps, each with an MSX SHIFT function above it.
for (let index = 0; index < 5; index++) {
  put(`f${index + 1}`, 102 + index * 90, 154, 84);
}
put('stop', 606, 154, 82);

// Editing block.
put('ins', 714, 154, 38);
put('del', 756, 154, 38);
put('select', 714, 196, 38);
put('home', 756, 196, 38);

// Number row.
put('esc', MAIN_LEFT, ROW_TOP, 56);
[
  '1', '2', '3', '4', '5', '6', '7',
  '8', '9', '0', 'minus', 'equal', 'backslash',
].forEach((id, index) => put(id, 104 + index * PITCH, ROW_TOP, 36));
put('bs', 624, ROW_TOP, 64);

// Q row and the upper bar of the inverted-L RETURN.
put('tab', MAIN_LEFT, ROW_TOP + ROW_PITCH, 66);
[
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'open-bracket', 'close-bracket',
].forEach((id, index) => put(id, 114 + index * PITCH, ROW_TOP + ROW_PITCH, 36));
put(
  'return',
  594,
  ROW_TOP + ROW_PITCH,
  94,
  78,
  'polygon(0 0, 100% 0, 100% 100%, 31.91% 100%, 31.91% 46.15%, 0 46.15%)',
);

// A row.
put('ctrl', MAIN_LEFT, ROW_TOP + ROW_PITCH * 2, 66);
[
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'semicolon', 'quote', 'backquote',
].forEach((id, index) => put(id, 114 + index * PITCH, ROW_TOP + ROW_PITCH * 2, 36));

// Z row.
put('shift-left', MAIN_LEFT, ROW_TOP + ROW_PITCH * 3, 86);
[
  'z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'dot', 'slash',
].forEach((id, index) => put(id, 134 + index * PITCH, ROW_TOP + ROW_PITCH * 3, 36));
put('shift-right', 534, ROW_TOP + ROW_PITCH * 3, 90);
put('pound', 628, ROW_TOP + ROW_PITCH * 3, 60);

// Bottom modifier row.
put('caps', 136, 368, 48);
put('graph', 188, 368, 50);
put('space', 242, 368, 326);
put('code', 572, 368, 58);

// Detached blue cursor cross.
put('cursor-up', 741, 270, 48, 40);
put('cursor-left', 689, 316, 48, 40);
put('cursor-right', 793, 316, 48, 40);
put('cursor-down', 741, 362, 48, 40);

export function placeHx10Keys(): readonly PlacedHx10Key[] {
  return placed;
}
