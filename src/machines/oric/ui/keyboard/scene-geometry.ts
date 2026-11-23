/**
 * Design-coordinate geometry for the Oric's on-screen keyboard.
 *
 * The deck is a typewriter block on a black plate: the number row, the Q/A/Z
 * rows, then a bottom row of arrow caps either side of the space bar.
 *
 * The stagger comes from the *widths* of the control caps, not from offsetting
 * whole rows — every row finishes at the same right edge while the letter blocks
 * step right as you go down. CTRL is a single cap but its row starts a quarter
 * cap in, so the bottom row's arrows are positioned explicitly in cap units to
 * keep them aligned with the caps above them:
 *
 *   ← right-aligned with the left SHIFT's right edge (2.0)
 *   ↓ directly below Z (2.0)
 *   space starting at X's left edge (3.0)
 *
 * Positions are in arbitrary design units, the same way the Atom and Lynx decks
 * are laid out, so the CSS can scale them.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import {
  ORIC_BOTTOM_ROW, ORIC_DECK_ROWS, ORIC_SPACE, ORIC_Z_ROW, type OricKeyDef,
} from './layout.ts';

const PITCH = 46;
const KEY_H = 39;
const MARGIN = 18;
const TOP = 22;
const ROW_PITCH = 44;
const ROW_GAP = PITCH - KEY_H;

/** The letter block's left edge. */
const BLOCK_X = MARGIN;

/**
 * The block is fourteen cap units wide. Rows that start a quarter cap in and end
 * a quarter cap short still finish on the same right edge.
 */
const BLOCK_COLS = 14;
const BLOCK_RIGHT = BLOCK_X + BLOCK_COLS * PITCH - ROW_GAP;

/**
 * Where each of the four letter rows starts, in cap units from the block's left
 * edge. The number row is centred; the A and Z rows start slightly in, so CTRL
 * and the left SHIFT sit inboard of ESC. The insets are the ones measured from
 * the photo, and each row's widths are chosen so it still ends on the right edge.
 */
const ROW_INSET: readonly number[] = [0.5, 0, 0.17, 0.17];

/**
 * The bottom row, in cap units from the block's left edge, derived from the row
 * above it so the arrows stay aligned if a cap width changes: `←` is right-
 * aligned with the left SHIFT's right edge, `↓` sits directly below Z, and the
 * space bar starts at X's left edge.
 */
const Z_INSET = ROW_INSET[3]!;
const SHIFT_L_W = ORIC_Z_ROW[0]!.span ?? 1;
const ARROW_L_X = Z_INSET + SHIFT_L_W - 1;   // ← ends where the left SHIFT ends
const ARROW_D_X = Z_INSET + SHIFT_L_W;       // ↓ directly under Z
const SPACE_X = ARROW_D_X + 1;               // space starts at X's left edge

// The right-hand caps are chained off the space bar's own end, so they cannot
// drift into it when the space span changes.
const SPACE_END = SPACE_X + (ORIC_SPACE.span ?? 1);
const ARROW_U_X = SPACE_END;
const ARROW_R_X = SPACE_END + 1;
const FUNCT_X = SPACE_END + 2;

const BOTTOM_ROW_X: readonly number[] = [
  ARROW_L_X, ARROW_D_X, SPACE_X, ARROW_U_X, ARROW_R_X, FUNCT_X,
];

/** Row top edges, top to bottom. */
const ROW_Y = (index: number): number => TOP + index * ROW_PITCH;

const BOTTOM_ROW_Y = ROW_Y(ORIC_DECK_ROWS.length);

export const ORIC_SCENE = {
  width: BLOCK_RIGHT + MARGIN,
  height: BOTTOM_ROW_Y + KEY_H + MARGIN,
} as const;

/** The black plate the caps sit on. */
export const ORIC_PLATE_BOX: SceneBox = {
  x: MARGIN - 8,
  y: TOP - 12,
  width: BLOCK_RIGHT - (MARGIN - 8) + 8,
  height: BOTTOM_ROW_Y + KEY_H - (TOP - 12) + 12,
};

export interface PlacedOricKey {
  readonly key: OricKeyDef;
  readonly box: SceneBox;
}

/** The pixel width of a cap spanning `span` cap units. */
function capWidth(span: number): number {
  return span * PITCH - ROW_GAP;
}

/** Lay out one row from a starting x, honouring each cap's `span`. */
function placeRow(keys: readonly OricKeyDef[], x: number, y: number, out: PlacedOricKey[]): void {
  let cursor = x;
  for (const key of keys) {
    const span = key.span ?? 1;
    out.push({ key, box: { x: cursor, y, width: capWidth(span), height: KEY_H } });
    cursor += span * PITCH;
  }
}

function build(): PlacedOricKey[] {
  const out: PlacedOricKey[] = [];

  // The four rows of the letter block, top to bottom.
  ORIC_DECK_ROWS.forEach((row, i) => {
    placeRow(row, BLOCK_X + (ROW_INSET[i] ?? 0) * PITCH, ROW_Y(i), out);
  });

  // The bottom row: `← ↓ SPACE ↑ → FUNCT`, placed at fixed cap positions.
  let i = 0;
  for (const key of ORIC_BOTTOM_ROW) {
    const capX = BOTTOM_ROW_X[i] ?? i;
    out.push({
      key,
      box: { x: BLOCK_X + capX * PITCH, y: BOTTOM_ROW_Y, width: capWidth(key.span ?? 1), height: KEY_H },
    });
    i++;
  }

  return out;
}

const PLACED: readonly PlacedOricKey[] = build();

export function placeOricKeys(): readonly PlacedOricKey[] {
  return PLACED;
}
