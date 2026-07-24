/**
 * Fixed design-coordinate geometry traced from the UK Toshiba HX-10P.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import {
  HX10_KEY_INDEX,
  type Hx10KeyDef,
} from './layout.ts';

export const HX10_SCENE = {
  width: 738,
  height: 280,
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

const PITCH = 40;
const ROW_TOP = 58;
const ROW_PITCH = 42;

// Five physical function caps, each with an MSX SHIFT function above it.
for (let index = 0; index < 5; index++) {
  put(`f${index + 1}`, 54 + index * 80, 14, 76);
}
put('stop', 528, 14, 82);

// Editing block.
put('ins', 624, 14, 38);
put('del', 666, 14, 38);
put('select', 624, 58, 38);
put('home', 666, 58, 38);

// Number row.
put('esc', 13, ROW_TOP, 36);
[
  '1', '2', '3', '4', '5', '6', '7',
  '8', '9', '0', 'minus', 'equal', 'backslash',
].forEach((id, index) => put(id, 54 + index * PITCH, ROW_TOP, 36));
put('bs', 574, ROW_TOP, 36);

// Q row and the upper bar of the inverted-L RETURN.
put('tab', 23, ROW_TOP + ROW_PITCH, 46);
[
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'open-bracket', 'close-bracket',
].forEach((id, index) => put(id, 74 + index * PITCH, ROW_TOP + ROW_PITCH, 36));
put(
  'return',
  554,
  ROW_TOP + ROW_PITCH,
  57,
  78,
  'polygon(0 0, 100% 0, 100% 100%, 18% 100%, 18% 48%, 0 48%)',
);

// A row.
put('ctrl', 31, ROW_TOP + ROW_PITCH * 2, 49);
[
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'semicolon', 'quote', 'backquote',
].forEach((id, index) => put(id, 84 + index * PITCH, ROW_TOP + ROW_PITCH * 2, 36));

// Z row.
put('shift-left', 41, ROW_TOP + ROW_PITCH * 3, 59);
[
  'z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'dot', 'slash',
].forEach((id, index) => put(id, 104 + index * PITCH, ROW_TOP + ROW_PITCH * 3, 36));
put('shift-right', 504, ROW_TOP + ROW_PITCH * 3, 56);
put('pound', 564, ROW_TOP + ROW_PITCH * 3, 36);

// Bottom modifier row.
put('caps', 104, 226, 36);
put('graph', 144, 226, 36);
put('space', 184, 226, 275);
put('code', 464, 226, 36);

// Detached blue cursor cross.
put('cursor-up', 651, 140, 47, 40);
put('cursor-left', 625, 184, 48, 36);
put('cursor-right', 676, 184, 47, 36);
put('cursor-down', 651, 224, 48, 40);

export function placeHx10Keys(): readonly PlacedHx10Key[] {
  return placed;
}
