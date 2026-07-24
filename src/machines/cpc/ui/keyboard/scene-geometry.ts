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
