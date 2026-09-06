/**
 * Where each SAM key sits on the case.
 *
 * Design coordinates, one unit per standard key pitch, traced from a
 * photograph of a real machine. Five rows of a 16.25-unit main block, plus the
 * function/cursor cluster to its right — the SAM's F0-F9 are a keypad rather
 * than a top row, which is why the F keys sit over there instead.
 *
 * The only awkward shape is RETURN. It is a tall inverted-L: a narrow upper
 * part on the Q row and a wider foot on the A row, notched at the top left.
 * The notch is a clip path rather than two separate keys, so the cap paints as
 * one object — and because a browser applies `clip-path` to hit testing too,
 * the notch cannot swallow pointer events meant for the `"` cap beside it.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { SAM_KEY_INDEX, type SamKey } from './layout.ts';

export interface PlacedSamKey {
  readonly key: SamKey;
  readonly box: SceneBox;
  readonly hitClip?: string;
}

/** One key pitch, and the cap inside it. */
const PITCH = 40;
const GAP = 4;
const ROW_PITCH = 40;
const CAP = 36;

/** Case margins around the key field. */
const LEFT = 16;
const TOP = 16;

/**
 * Where the function/cursor cluster starts, in units.
 *
 * Flush against the main block: on the real machine DELETE and F7 are one
 * ordinary key gap apart, not a separate island.
 */
const CLUSTER = 14.5;

/** Main block rows, as [id, width in units].
 *
 * Widths are measured off a photograph: sampling a scanline across each row
 * and reading the gaps between caps gives a pitch of about 42 pixels, against
 * which ESC comes out at one unit, DELETE at one and a half, and both SHIFTs
 * at about two and three quarters.
 */
type Row = readonly (readonly [string, number])[];

const MAIN_ROWS: readonly Row[] = [
  [['esc', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1],
    ['7', 1], ['8', 1], ['9', 1], ['0', 1], ['minus', 1], ['plus', 1],
    ['delete', 1.5]],
  [['tab', 1.5], ['q', 1], ['w', 1], ['e', 1], ['r', 1], ['t', 1], ['y', 1],
    ['u', 1], ['i', 1], ['o', 1], ['p', 1], ['equals', 1], ['quotes', 1]],
  [['caps', 1.75], ['a', 1], ['s', 1], ['d', 1], ['f', 1], ['g', 1], ['h', 1],
    ['j', 1], ['k', 1], ['l', 1], ['semicolon', 1], ['colon', 1]],
  [['shift', 2.25], ['z', 1], ['x', 1], ['c', 1], ['v', 1], ['b', 1], ['n', 1],
    ['m', 1], ['comma', 1], ['period', 1], ['inv', 1], ['shift-right', 2.25]],
  // The bottom row is pinned to the row above it rather than measured on its
  // own: SPACE starts where X starts and stops where the full stop stops, and
  // SYMBOL is a CAPS-width cap, which leaves CNTRL to make up the difference.
  // EDIT and the right SYMBOL mirror them, so the row closes flush.
  [['symbol', 1.75], ['cntrl', 1.5], ['space', 8], ['edit', 1.5],
    ['symbol-right', 1.75]],
];

/** The keypad to the right: three columns of function keys, then the cursors
 *  in an inverted T. The up key sits over the down key, with the keypad's
 *  decimal point beside it. */
const CLUSTER_ROWS: readonly Row[] = [
  [['f7', 1], ['f8', 1], ['f9', 1]],
  [['f4', 1], ['f5', 1], ['f6', 1]],
  [['f1', 1], ['f2', 1], ['f3', 1]],
  [['f0', 1], ['up', 1], ['period-keypad', 1]],
  [['left', 1], ['down', 1], ['right', 1]],
];

/**
 * RETURN's inverted-L.
 *
 * The foot starts where the A row's keys stop and the upper part where the `"`
 * cap stops, so the notch is exactly one cap wide and the `"` key shows
 * through it. Wider and there is a slot of bare case beside the quote key;
 * narrower and RETURN paints over it.
 *
 * The cap is one Q row plus one A row tall, top and bottom flush with the caps
 * either side of it. The notch therefore cuts down a WHOLE row pitch, not half
 * the box: that leaves the foot exactly one cap tall, and puts the gap between
 * the two rows in the narrow upper part where the `"` cap needs it.
 */
const RETURN_LEFT = 12.75;
const RETURN_UNITS = 1.75;
/** Where the `"` cap's right edge falls, in units — the notch stops there. */
const RETURN_NOTCH_UNITS = 13.5 - RETURN_LEFT;
const RETURN_WIDTH = RETURN_UNITS * PITCH - GAP;
const RETURN_HEIGHT = ROW_PITCH + CAP;
const pct = (n: number) => `${+(n * 100).toFixed(3)}%`;
const NOTCH_X = pct(RETURN_NOTCH_UNITS * PITCH / RETURN_WIDTH);
const NOTCH_Y = pct(ROW_PITCH / RETURN_HEIGHT);
const RETURN_CLIP =
  `polygon(${NOTCH_X} 0, 100% 0, 100% 100%, 0 100%,`
  + ` 0 ${NOTCH_Y}, ${NOTCH_X} ${NOTCH_Y})`;

export const SAM_SCENE = {
  width: LEFT * 2 + (CLUSTER + 3) * PITCH,
  height: TOP * 2 + 4 * ROW_PITCH + CAP,
  unit: 1,
};

function place(id: string, box: SceneBox, hitClip?: string): PlacedSamKey {
  const key = SAM_KEY_INDEX.get(id);
  if (!key) throw new Error(`Unknown SAM key in keyboard geometry: ${id}`);
  return { key, box, hitClip };
}

/** Lay the whole face out. */
export function placeSamKeys(): PlacedSamKey[] {
  const placed: PlacedSamKey[] = [];

  const row = (keys: Row, index: number, startUnits: number) => {
    let units = startUnits;
    for (const [id, width] of keys) {
      placed.push(place(id, {
        x: LEFT + units * PITCH,
        y: TOP + index * ROW_PITCH,
        width: width * PITCH - GAP,
        height: CAP,
      }));
      units += width;
    }
  };

  MAIN_ROWS.forEach((keys, index) => row(keys, index, 0));
  CLUSTER_ROWS.forEach((keys, index) => row(keys, index, CLUSTER));

  // RETURN spans the Q and A rows at the right of the main block.
  placed.push(place('return', {
    x: LEFT + RETURN_LEFT * PITCH,
    y: TOP + ROW_PITCH,
    width: RETURN_WIDTH,
    height: RETURN_HEIGHT,
  }, RETURN_CLIP));

  return placed;
}
