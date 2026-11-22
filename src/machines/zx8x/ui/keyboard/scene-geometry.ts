/**
 * Measured scene geometry for the ZX80, ZX81 and Timex Sinclair 1500 keyboards.
 *
 * All three share the same 40-key matrix layout but the real keycaps differ: the
 * ZX80 and ZX81 are uniform flat caps of different heights, while the TS1500's
 * are narrower, further apart and include a wide SHIFT and a wide SPACE (traced
 * from a photograph of the machine). Case legends are separate scene objects
 * above and below each cap rather than being constrained to a generic key
 * legend model.
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
const CASE_LEGEND_HEIGHT = 8;
const KEY_MARGIN = 1.5;
const SCENE_WIDTH = 536.5;

/** The measured geometry of one keyboard face. */
interface Face {
  /** Top of the first row's case legends. */
  readonly top: number;
  readonly keyWidth: number;
  readonly keyGap: number;
  readonly keyHeight: number;
  /** How far each row is shifted right of the first. */
  readonly rowOffsets: readonly [number, number, number, number];
  /** Keys wider than `keyWidth`, by their main label. */
  readonly wide: Readonly<Record<string, number>>;
}

const ZX81_FACE: Face = {
  top: 10, keyWidth: 42, keyGap: 6, keyHeight: 30, rowOffsets: [0, 24, 34.5, 0], wide: {},
};
const ZX80_FACE: Face = { ...ZX81_FACE, keyHeight: 40 };
// The TS1500: a 48-unit pitch with 37-wide caps; the second and third rows start
// half and three-quarters of a pitch in, SHIFT is a pitch wide and SPACE a pitch
// and a half, which brings SPACE and ENTER to the same right edge.
const TS1500_FACE: Face = {
  top: 10, keyWidth: 37, keyGap: 11, keyHeight: 29, rowOffsets: [0, 24, 37, 0],
  wide: { SHIFT: 50, SPACE: 61 },
};

function faceFor(model: Zx8xModel): Face {
  return model === 'zx80' ? ZX80_FACE : model === 'ts1500' ? TS1500_FACE : ZX81_FACE;
}

export function zx8xScene(model: Zx8xModel) {
  const face = faceFor(model);
  const rowHeight = CASE_LEGEND_HEIGHT * 2 + KEY_MARGIN * 2 + face.keyHeight;
  return {
    width: SCENE_WIDTH,
    height: face.top + rowHeight * 4 + 12,
    unit: UNIT,
    keyHeight: face.keyHeight,
    rowHeight,
  } as const;
}

export function placeZx8xRows(
  rows: readonly (readonly Zx8xKey[])[],
  model: Zx8xModel,
): PlacedZx8xKey[] {
  const face = faceFor(model);
  const scene = zx8xScene(model);
  const placed: PlacedZx8xKey[] = [];

  rows.forEach((row, rowIndex) => {
    const rowTop = face.top + rowIndex * scene.rowHeight;
    let x = LEFT + face.rowOffsets[rowIndex];

    for (const key of row) {
      const width = face.wide[key.main] ?? face.keyWidth;
      const cap: SceneBox = {
        x,
        y: rowTop + CASE_LEGEND_HEIGHT + KEY_MARGIN,
        width,
        height: face.keyHeight,
      };
      placed.push({
        key,
        cap,
        above: {
          x,
          y: rowTop,
          width,
          height: CASE_LEGEND_HEIGHT,
        },
        below: {
          x,
          y: cap.y + cap.height + KEY_MARGIN,
          width,
          height: CASE_LEGEND_HEIGHT,
        },
      });
      x += width + face.keyGap;
    }
  });

  return placed;
}
