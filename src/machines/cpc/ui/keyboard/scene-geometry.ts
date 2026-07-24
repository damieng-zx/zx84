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
