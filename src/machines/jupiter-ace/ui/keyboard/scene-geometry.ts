/**
 * Measured design-coordinate geometry for the Jupiter Ace keyboard face.
 *
 * The Ace's 40 moulded-rubber keys are laid out "just as on the Spectrum
 * keyboard" (Micro Choice, Winter 1983): the Spectrum 48K's stagger and wide
 * SHIFT / SPACE caps, but on square 1u keys. The Ace prints nothing on the case
 * around its letter keys — only the digit row carries a SHIFT-function legend,
 * just below it — and every row gap is sized to hold that legend so the four
 * rows stay evenly spaced.
 *
 * These functions only place objects; they do not know how a key is drawn.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import type { AceKey } from './legends.ts';

export interface PlacedAceKey {
  readonly key: AceKey;
  readonly cap: SceneBox;
  /** Case-legend box below the cap — digit row only, null elsewhere. */
  readonly below: SceneBox | null;
}

/** A 1u key is square. */
const KEY_SIZE = 42 * 52 / 72;
const KEY_GAP = 10;
const PITCH = KEY_SIZE + KEY_GAP;
const LEFT = 12;
const TOP = 10;
const BOTTOM = 10;
/** Room for a two-line case legend (INVERSE / VIDEO) under the digit row. */
const LEGEND_HEIGHT = 18;
const LEGEND_MARGIN = 2;
const ROW_GAP = LEGEND_MARGIN + LEGEND_HEIGHT + LEGEND_MARGIN;
/** The Spectrum 48K's row stagger (26 and 36 at its 52 pitch), in key units. */
const ROW_OFFSETS = [0, 26 / 52, 36 / 52, 0] as const;
/** The widest row: SHIFT 1.25u + 7 letters + SYMBOL SHIFT + SPACE 1.75u. */
const WIDEST_ROW_UNITS = 11;

const capWidth = (units = 1) => units * PITCH - KEY_GAP;

export const ACE_SCENE = {
  width: LEFT * 2 + capWidth(WIDEST_ROW_UNITS),
  height: TOP + 4 * KEY_SIZE + 3 * ROW_GAP + BOTTOM,
  unit: 1,
} as const;

/** Place the four staggered rows on the case surface. */
export function placeAceRows(rows: readonly (readonly AceKey[])[]): PlacedAceKey[] {
  const placed: PlacedAceKey[] = [];
  let y = TOP;

  rows.forEach((row, rowIndex) => {
    let x = LEFT + ROW_OFFSETS[rowIndex] * PITCH;
    for (const key of row) {
      const width = capWidth(key.w);
      placed.push({
        key,
        cap: { x, y, width, height: KEY_SIZE },
        below: rowIndex === 0
          ? { x, y: y + KEY_SIZE + LEGEND_MARGIN, width, height: LEGEND_HEIGHT }
          : null,
      });
      x += width + KEY_GAP;
    }
    y += KEY_SIZE + ROW_GAP;
  });

  return placed;
}
