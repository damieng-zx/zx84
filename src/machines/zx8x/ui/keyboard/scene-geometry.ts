/**
 * Measured scene geometry for the ZX80 and ZX81 membrane keyboards.
 *
 * The two machines share the same 40-key matrix layout but the real keycaps have
 * different heights. Case legends are separate scene objects above and below
 * each cap rather than being constrained to a generic key legend model.
 */

import type { Zx8xModel } from '@/machines/zx8x/models.ts';
import type { Zx8xKey } from './legends.ts';
import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';

export interface PlacedZx8xKey {
  readonly key: Zx8xKey;
  readonly cap: SceneBox;
  readonly above: SceneBox;
  readonly below: SceneBox;
}

const UNIT = 15 / 14;
const LEFT = 14;
const TOP = 10;
const KEY_WIDTH = 42;
const KEY_GAP = 6;
const CASE_LEGEND_HEIGHT = 8;
const KEY_MARGIN = 1.5;
const ROW_OFFSETS = [0, 24, 34.5, 0] as const;
const SCENE_WIDTH = 536.5;

export function zx8xScene(model: Zx8xModel) {
  const keyHeight = model === 'zx80' ? 40 : 30;
  const rowHeight = CASE_LEGEND_HEIGHT * 2 + KEY_MARGIN * 2 + keyHeight;
  return {
    width: SCENE_WIDTH,
    height: TOP + rowHeight * 4 + 12,
    unit: UNIT,
    keyHeight,
    rowHeight,
  } as const;
}

export function placeZx8xRows(
  rows: readonly (readonly Zx8xKey[])[],
  model: Zx8xModel,
): PlacedZx8xKey[] {
  const scene = zx8xScene(model);
  const placed: PlacedZx8xKey[] = [];

  rows.forEach((row, rowIndex) => {
    const rowTop = TOP + rowIndex * scene.rowHeight;
    let x = LEFT + ROW_OFFSETS[rowIndex];

    for (const key of row) {
      const cap: SceneBox = {
        x,
        y: rowTop + CASE_LEGEND_HEIGHT + KEY_MARGIN,
        width: KEY_WIDTH,
        height: scene.keyHeight,
      };
      placed.push({
        key,
        cap,
        above: {
          x,
          y: rowTop,
          width: KEY_WIDTH,
          height: CASE_LEGEND_HEIGHT,
        },
        below: {
          x,
          y: cap.y + cap.height + KEY_MARGIN,
          width: KEY_WIDTH,
          height: CASE_LEGEND_HEIGHT,
        },
      });
      x += KEY_WIDTH + KEY_GAP;
    }
  });

  return placed;
}
