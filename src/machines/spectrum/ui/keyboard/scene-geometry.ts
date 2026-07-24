/**
 * Measured design-coordinate geometry for the Spectrum keyboard faces.
 *
 * These functions only place objects. They deliberately do not know how a key
 * is drawn, what its legends mean, or how it is wired to the matrix.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';

export interface RubberGeometryKey {
  readonly kind: 'num' | 'letter' | 'special';
  readonly w?: number;
}

export interface PlacedRubberKey<T> {
  readonly key: T;
  readonly cap: SceneBox;
  readonly above: SceneBox;
  readonly below: SceneBox;
}

export const RUBBER_SCENE = {
  width: 586,
  height: 268 + 1 / 3,
  unit: 1,
} as const;

const RUBBER_KEY_WIDTH = 42;
const RUBBER_KEY_HEIGHT = RUBBER_KEY_WIDTH * 52 / 72;
const RUBBER_GAP = 10;
const RUBBER_ROW_GAP = 4;
const RUBBER_LEFT = 12;
const RUBBER_TOP = 10;
const RUBBER_BOTTOM_LEGEND_HEIGHT = 12;
const RUBBER_BOTTOM_LEGEND_GAP = 2;
const RUBBER_ROW_OFFSETS = [0, 26, 36, 0] as const;

const rubberWidth = (units = 1) =>
  units * (RUBBER_KEY_WIDTH + RUBBER_GAP) - RUBBER_GAP;

/** Place the four irregular rubber-keyboard rows on the case surface. */
export function placeRubberRows<T extends RubberGeometryKey>(
  rows: readonly (readonly T[])[],
): PlacedRubberKey<T>[] {
  const placed: PlacedRubberKey<T>[] = [];
  let rowTop = RUBBER_TOP;

  rows.forEach((row, rowIndex) => {
    let x = RUBBER_LEFT + RUBBER_ROW_OFFSETS[rowIndex];
    const aboveHeight = rowIndex === 0 ? 24 : 11;

    for (const key of row) {
      const width = rubberWidth(key.w);
      const cap: SceneBox = {
        x,
        y: rowTop + aboveHeight,
        width,
        height: RUBBER_KEY_HEIGHT,
      };
      placed.push({
        key,
        cap,
        above: { x, y: rowTop, width, height: aboveHeight },
        below: {
          x,
          y: cap.y + cap.height + RUBBER_BOTTOM_LEGEND_GAP,
          width,
          height: RUBBER_BOTTOM_LEGEND_HEIGHT,
        },
      });
      x += width + RUBBER_GAP;
    }

    rowTop += aboveHeight
      + RUBBER_KEY_HEIGHT
      + RUBBER_BOTTOM_LEGEND_GAP
      + RUBBER_BOTTOM_LEGEND_HEIGHT
      + RUBBER_ROW_GAP;
  });

  return placed;
}

export type HardFace = 'toastrack' | 'sparse';

export interface HardGeometryKey {
  readonly variant: string;
  readonly label?: string;
  readonly w?: number;
}

export interface PlacedHardKey<T> {
  readonly key: T;
  readonly cap: SceneBox;
}

interface HardMetrics {
  readonly width: number;
  readonly height: number;
  readonly pitch: number;
  readonly rowGap: number;
  readonly capGap: number;
  readonly enterWidth: number;
  readonly enterHeight: number;
}

const HARD_METRICS: Record<HardFace, HardMetrics> = {
  toastrack: {
    width: 660,
    height: 250,
    pitch: 48,
    rowGap: 2,
    capGap: 2,
    enterWidth: 82,
    enterHeight: 94,
  },
  sparse: {
    width: 673.5,
    height: 258,
    pitch: 49,
    rowGap: 4,
    capGap: 3,
    enterWidth: 82.75,
    enterHeight: 96,
  },
};

const HARD_PADDING = 6;
const HARD_KEY_HEIGHT = 46;

export function hardScene(face: HardFace) {
  return { ...HARD_METRICS[face], unit: 1 } as const;
}

/** Place every hard-key cap; the single ENTER scene key owns stem and foot. */
export function placeHardRows<T extends HardGeometryKey>(
  rows: readonly (readonly T[])[],
  face: HardFace,
  widthOf: (key: T) => number,
): PlacedHardKey<T>[] {
  const metrics = HARD_METRICS[face];
  const placed: PlacedHardKey<T>[] = [];

  rows.forEach((row, rowIndex) => {
    let units = 0;
    const y = HARD_PADDING + rowIndex * (HARD_KEY_HEIGHT + metrics.rowGap);

    for (const key of row) {
      const widthUnits = widthOf(key);
      if (key.variant === 'enter') {
        const right = metrics.width - HARD_PADDING - metrics.capGap / 2;
        placed.push({
          key,
          cap: {
            x: right - metrics.enterWidth,
            y,
            width: metrics.enterWidth,
            height: metrics.enterHeight,
          },
        });
      } else {
        placed.push({
          key,
          cap: {
            x: HARD_PADDING + units * metrics.pitch + metrics.capGap / 2,
            y,
            width: widthUnits * metrics.pitch - metrics.capGap,
            height: HARD_KEY_HEIGHT,
          },
        });
      }
      units += widthUnits;
    }
  });

  return placed;
}
