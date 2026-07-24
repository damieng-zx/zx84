/**
 * Measured fixed-coordinate geometry for the CPC 464 keyboard face.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import {
  CPC_CURSOR_KEYS,
  CPC_MAIN_ROWS,
  CPC_NUMPAD_ROWS,
  type CpcKeyDef,
  type CpcKeyRegion,
} from './layout.ts';

export const CPC464_SCENE = {
  width: 810,
  height: 274,
  unit: 1,
} as const;

export const CPC664_SCENE = CPC464_SCENE;

export const CPC6128_SCENE = {
  width: 744,
  height: 248,
  unit: 1,
} as const;

const PITCH = 42;
const GAP = 4;
const CAP_HEIGHT = 34;
const ROW_PITCH = 38;
const MAIN_LEFT = 8;
const MAIN_TOP = 42;
const CLUSTER_LEFT = 680;

export interface PlacedCpcKey {
  readonly key: CpcKeyDef;
  readonly box: SceneBox;
  readonly region: CpcKeyRegion;
  readonly hitClip?: string;
}

const widthOf = (units = 1) => units * PITCH - GAP;

export function placeCpc464Keys(): PlacedCpcKey[] {
  const placed: PlacedCpcKey[] = [];

  CPC_MAIN_ROWS.forEach((row, rowIndex) => {
    let units = row.startUnits ?? 0;
    for (const key of row.keys) {
      const keyUnits = key.units ?? 1;
      placed.push({
        key,
        region: 'main',
        box: {
          x: MAIN_LEFT + units * PITCH,
          y: MAIN_TOP + rowIndex * ROW_PITCH,
          width: widthOf(keyUnits),
          height: key.tall ? CAP_HEIGHT * 2 + (ROW_PITCH - CAP_HEIGHT) : CAP_HEIGHT,
        },
      });
      units += keyUnits;
    }
  });

  const cursorCells = [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [1, 2],
  ] as const;
  CPC_CURSOR_KEYS.forEach((key, index) => {
    const [column, row] = cursorCells[index];
    placed.push({
      key,
      region: 'cursor',
      box: {
        x: CLUSTER_LEFT + column * PITCH,
        y: 4 + row * ROW_PITCH,
        width: widthOf(),
        height: CAP_HEIGHT,
      },
    });
  });

  CPC_NUMPAD_ROWS.forEach((row, rowIndex) => {
    row.forEach((key, column) => {
      placed.push({
        key,
        region: 'numpad',
        box: {
          x: CLUSTER_LEFT + column * PITCH,
          y: 118 + rowIndex * ROW_PITCH,
          width: widthOf(),
          height: CAP_HEIGHT,
        },
      });
    });
  });

  return placed;
}

/**
 * The CPC664 retained the 464 matrix and main-key geometry, but replaced the
 * five separated cursor caps with four individually spaced wedges around COPY.
 */
export function placeCpc664Keys(): PlacedCpcKey[] {
  const base = placeCpc464Keys();
  const rightShift = base.find((placed) => placed.key.id === 'shift-right');
  if (!rightShift) throw new Error('CPC keyboard geometry is missing right SHIFT');
  const controlRight = rightShift.box.x + rightShift.box.width;

  const cursorFace: Readonly<Record<string, Pick<PlacedCpcKey, 'box' | 'hitClip'>>> = {
    'cursor-up': {
      box: { x: CLUSTER_LEFT + 3, y: 4, width: PITCH * 3 - GAP - 6, height: 35 },
      hitClip: 'polygon(0 0, 100% 0, 65% 100%, 35% 100%)',
    },
    'cursor-left': {
      box: { x: CLUSTER_LEFT, y: 7, width: 40, height: 104 },
      hitClip: 'polygon(0 0, 100% 35%, 100% 65%, 0 100%)',
    },
    copy: {
      box: { x: CLUSTER_LEFT + PITCH, y: 42, width: widthOf(), height: CAP_HEIGHT },
    },
    'cursor-right': {
      box: { x: CLUSTER_LEFT + 82, y: 7, width: 40, height: 104 },
      hitClip: 'polygon(0 35%, 100% 0, 100% 100%, 0 65%)',
    },
    'cursor-down': {
      box: { x: CLUSTER_LEFT + 3, y: 78, width: PITCH * 3 - GAP - 6, height: 36 },
      hitClip: 'polygon(35% 0, 65% 0, 100% 100%, 0 100%)',
    },
  };

  return base.map((placed) => {
    const alignRight = placed.key.id === 'return' || placed.key.id === 'del';
    const adjusted = alignRight
      ? { ...placed, box: { ...placed.box, x: controlRight - placed.box.width } }
      : placed;
    const face = cursorFace[placed.key.id];
    return face ? { ...adjusted, ...face } : adjusted;
  });
}

const CPC_KEY_INDEX = new Map<string, { key: CpcKeyDef; region: CpcKeyRegion }>([
  ...CPC_MAIN_ROWS.flatMap((row) =>
    row.keys.map((key) => [key.id, { key, region: 'main' as const }] as const)),
  ...CPC_CURSOR_KEYS.map((key) =>
    [key.id, { key, region: 'cursor' as const }] as const),
  ...CPC_NUMPAD_ROWS.flatMap((row) =>
    row.map((key) => [key.id, { key, region: 'numpad' as const }] as const)),
]);

type Cpc6128Row = readonly (readonly [id: string, units: number])[];

const CPC6128_MAIN_ROWS: readonly Cpc6128Row[] = [
  [
    ['esc', 1.25],
    ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1],
    ['7', 1], ['8', 1], ['9', 1], ['0', 1],
    ['hyphen', 1], ['caret', 1], ['clr', 1], ['del', 1],
  ],
  [
    ['tab', 1.5],
    ['q', 1], ['w', 1], ['e', 1], ['r', 1], ['t', 1], ['y', 1],
    ['u', 1], ['i', 1], ['o', 1], ['p', 1], ['at', 1], ['open-bracket', 1],
    ['return', 1.75],
  ],
  [
    ['caps-lock', 1.75],
    ['a', 1], ['s', 1], ['d', 1], ['f', 1], ['g', 1], ['h', 1],
    ['j', 1], ['k', 1], ['l', 1],
    ['semicolon', 1], ['colon', 1], ['close-bracket', 1],
  ],
  [
    ['shift-left', 2.25],
    ['z', 1], ['x', 1], ['c', 1], ['v', 1], ['b', 1], ['n', 1], ['m', 1],
    ['comma', 1], ['dot', 1], ['slash', 1], ['backslash', 1],
    ['shift-right', 2],
  ],
  [
    ['ctrl', 2.25],
    ['copy', 1.75],
    ['space', 7.5],
    ['numpad-enter', 3.75],
  ],
] as const;

const CPC6128_RIGHT_ROWS: readonly Cpc6128Row[] = [
  [['f7', 1], ['f8', 1], ['f9', 1]],
  [['f4', 1], ['f5', 1], ['f6', 1]],
  [['f1', 1], ['f2', 1], ['f3', 1]],
  [['f0', 1], ['cursor-up', 1], ['fdot', 1]],
  [['cursor-left', 1], ['cursor-down', 1], ['cursor-right', 1]],
] as const;

/**
 * The CPC6128 rearranged the same 74 matrix switches into a compact five-row
 * calculator-style keyboard, with the function and cursor keys at the right.
 */
export function placeCpc6128Keys(): PlacedCpcKey[] {
  const placed: PlacedCpcKey[] = [];
  const pitch = 40;
  const gap = 4;
  const capHeight = 36;
  const rowPitch = 40;
  const left = 8;
  const top = 42;
  const rightStartUnits = 15.25;

  const placeRow = (row: Cpc6128Row, rowIndex: number, startUnits = 0) => {
    let units = startUnits;
    for (const [id, keyUnits] of row) {
      const indexed = CPC_KEY_INDEX.get(id);
      if (!indexed) throw new Error(`Unknown CPC key in 6128 geometry: ${id}`);
      const isReturn = id === 'return';
      placed.push({
        ...indexed,
        box: {
          x: left + units * pitch,
          y: top + rowIndex * rowPitch,
          width: keyUnits * pitch - gap,
          height: isReturn ? capHeight * 2 + rowPitch - capHeight : capHeight,
        },
        hitClip: isReturn
          ? 'polygon(0 0, 100% 0, 100% 100%, 15.15% 100%, 15.15% 47.37%, 0 47.37%)'
          : undefined,
      });
      units += keyUnits;
    }
  };

  CPC6128_MAIN_ROWS.forEach((row, rowIndex) => placeRow(row, rowIndex));
  CPC6128_RIGHT_ROWS.forEach((row, rowIndex) =>
    placeRow(row, rowIndex, rightStartUnits));

  return placed;
}
