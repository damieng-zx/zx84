/**
 * Fixed design-coordinate geometry for the two PCW decks, traced from
 * photographs of an 8256 and of a 9512.
 *
 * Both carry the same 82 caps on the same 40-unit pitch and the same five
 * rows; all that changed in the redesign is where the blocks sit.
 *
 * The 8000s' deck is a plain 19-column grid, and every row fills it exactly —
 * no staircase, no stepped wells, one well for the lot. Columns 0-14 are the
 * typewriter block and 15-18 the function-and-keypad cluster; the top row is
 * the one that runs straight across both, which is why CAN, CUT, COPY and
 * PASTE sit directly above the cluster rather than over the letters. Row
 * widths, all coming to 15u across the main block:
 *
 *   1  19 caps of 1u, straight across the whole deck
 *   2  TAB 1.5u, ten letters, two bracket caps, RETURN 1.5u
 *   3  SHIFT LOCK 1.75u, nine letters, three punctuation caps, RETURN's foot
 *   4  SHIFT 2.25u, seven letters, four punctuation caps, SHIFT 1.75u
 *   5  ALT and EXTRA 1.5u each, a boxed cap, the 8u bar, a boxed cap,
 *      PTR and EXIT 1u each
 *
 * The 9000s broke that slab into three blocks with case showing between them:
 * the function keys paired down the left, the typewriter block in the middle
 * with its bottom row cut back to the bar and EXIT, and CUT/COPY/PASTE over
 * the numeric pad on the right.
 *
 * Above the deck the case carries the AMSTRAD plate, which names the model.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { PCW_KEY_INDEX, type PcwKeyDef } from './layout.ts';

export interface PlacedPcwKey {
  readonly key: PcwKeyDef;
  readonly box: SceneBox;
  /** Set on RETURN alone — see `RETURN_CLIP`. */
  readonly hitClip?: string;
}

/** One machine's whole face: the caps, the wells they sit in, and the plate. */
export interface PcwFace {
  readonly scene: {
    readonly width: number; readonly height: number; readonly unit: number;
  };
  /** The charcoal recesses the blocks sit in: one on an 8000; on a 9000, four
   *  rectangles making three blocks. */
  readonly wells: readonly SceneBox[];
  readonly badge: SceneBox;
  readonly keys: readonly PlacedPcwKey[];
  /** The number printed in red at the right of the plate, where there is one. */
  readonly plateModel?: string;
  /** Which deck this is, for the styles that differ between them. */
  readonly deck: '8' | '9';
}

const PITCH = 40;
const GAP = 3;
const CAP = PITCH - GAP;
/** Left edge of column 0. */
const MARGIN = 16;
/** Top of row 1. The case above it carries the plate. */
const DECK_TOP = 74;
const ROW_PITCH = 40;
/** How far a well is cut back past the caps it holds. */
const WELL_PAD = 4;

/** Left margin, then 1u = PITCH. */
const u = (n: number) => MARGIN + n * PITCH;
/** Cap width for a cell `n` units wide. */
const w = (n: number) => n * PITCH - GAP;
const rowY = (row: number) => DECK_TOP + row * ROW_PITCH;
const sceneOf = (columns: number) => ({
  width: MARGIN * 2 + columns * PITCH,
  height: DECK_TOP + 5 * ROW_PITCH + 16,
  unit: 1,
} as const);

/** The well under a block `columns` wide and `rows` deep, from `column`/`row`. */
function wellFor(
  column: number, columns: number, row: number, rows: number,
): SceneBox {
  return {
    x: u(column) - WELL_PAD,
    y: rowY(row) - WELL_PAD,
    width: columns * PITCH - GAP + WELL_PAD * 2,
    height: (rows - 1) * ROW_PITCH + CAP + WELL_PAD * 2,
  };
}

// ── RETURN ─────────────────────────────────────────────────────────────────
//
// The one cap on either deck that is not a rectangle: an upside-down L two
// rows tall, 1.5u wide at the top and stepping a quarter unit right at the
// foot, so the `> #` cap fits under its shoulder. (Row 3 carries a quarter
// unit more cap before it than row 2 does, SHIFT LOCK being wider than TAB.)
// The step is a clip path rather than two boxes, because a browser clips
// hit-testing too — without it the invisible corner would swallow presses
// meant for `> #`.
const RETURN_STEP = 0.25;
const RETURN_WIDTH = w(1.5);
const RETURN_HEIGHT = ROW_PITCH + CAP;
const pct = (n: number) => `${+(n * 100).toFixed(3)}%`;
/** The inset: everything left of this is missing from the lower row. */
const STEP_X = pct(RETURN_STEP * PITCH / RETURN_WIDTH);
/** The shoulder is one cap tall, so the row gap belongs to the foot below it. */
const STEP_Y = pct(CAP / RETURN_HEIGHT);
const RETURN_CLIP =
  `polygon(0 0, 100% 0, 100% 100%, ${STEP_X} 100%, ${STEP_X} ${STEP_Y}, 0 ${STEP_Y})`;

/** A deck under construction: `put` places one cap, `row` a run of 1u caps. */
function deckKeys() {
  const keys: PlacedPcwKey[] = [];

  function put(
    id: string, x: number, y: number,
    width = CAP, height = CAP, hitClip?: string,
  ): void {
    const definition = PCW_KEY_INDEX.get(id);
    if (!definition) throw new Error(`Unknown PCW key: ${id}`);
    keys.push({ key: definition, box: { x, y, width, height }, hitClip });
  }

  /** A run of 1u caps starting at `start` units in. */
  function row(ids: readonly string[], start: number, y: number): void {
    ids.forEach((id, i) => put(id, u(start + i), y));
  }

  /** Rows 2-4 of the typewriter block, which are the same on both decks.
   *  `left` is the column the block's left edge sits at. */
  function typewriter(left: number): void {
    put('tab', u(left), rowY(1), w(1.5));
    row([
      'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
      'bracket-left', 'bracket-right',
    ], left + 1.5, rowY(1));
    put('return', u(left + 13.5), rowY(1),
      RETURN_WIDTH, RETURN_HEIGHT, RETURN_CLIP);

    put('shift-lock', u(left), rowY(2), w(1.75));
    row([
      'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
      'semicolon', 'section', 'hash',
    ], left + 1.75, rowY(2));

    put('shift-left', u(left), rowY(3), w(2.25));
    row([
      'z', 'x', 'c', 'v', 'b', 'n', 'm',
      'comma', 'period', 'slash', 'half',
    ], left + 2.25, rowY(3));
    put('shift-right', u(left + 13.25), rowY(3), w(1.75));
  }

  return { keys, put, row, typewriter };
}

// ═══ The 8256/8512 deck ════════════════════════════════════════════════════

const COLUMNS_8 = 19;

export const PCW_SCENE = sceneOf(COLUMNS_8);

const eight = deckKeys();

// ── Row 1 — the full 19 columns ────────────────────────────────────────────
eight.row([
  'stop',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'minus', 'equals',
  'del-right', 'del-left',
  'can', 'cut', 'copy', 'paste',
], 0, rowY(0));

// ── Rows 2-4 — TAB down to the SHIFTs ──────────────────────────────────────
eight.typewriter(0);

// ── Row 5 — the bar and what sits either side of it ────────────────────────
eight.put('alt', u(0), rowY(4), w(1.5));
eight.put('extra', u(1.5), rowY(4), w(1.5));
eight.put('box-plus', u(3), rowY(4));
eight.put('space', u(4), rowY(4), w(8));
eight.put('box-minus', u(12), rowY(4));
eight.put('ptr', u(13), rowY(4));
eight.put('exit', u(14), rowY(4));

// ── The right-hand cluster — four columns, four rows ───────────────────────
const CLUSTER = COLUMNS_8 - 4;
([
  ['f8-f7', 'pad7', 'pad8', 'pad9'],
  ['f6-f5', 'pad4', 'pad5', 'pad6'],
  ['f4-f3', 'pad1', 'pad2', 'pad3'],
  ['f2-f1', 'pad0', 'pad-dot', 'pad-enter'],
] as const).forEach((ids, index) => eight.row(ids, CLUSTER, rowY(index + 1)));

/** The charcoal well the whole deck sits in — one rectangle, since no row is
 *  narrower than another. */
export const PCW_WELL: SceneBox = wellFor(0, COLUMNS_8, 0, 5);

/** The AMSTRAD plate, at the top left of the case, flush with the well. */
export const PCW_BADGE: SceneBox = { x: PCW_WELL.x, y: 16, width: 336, height: 34 };

export function placePcwKeys(): readonly PlacedPcwKey[] {
  return eight.keys;
}

export const PCW8_FACE: PcwFace = {
  scene: PCW_SCENE,
  wells: [PCW_WELL],
  badge: PCW_BADGE,
  keys: eight.keys,
  deck: '8',
};

// ═══ The 9512/9256 deck ════════════════════════════════════════════════════
//
//   columns 0-1    the function keys, paired down the left: f8/f7 beside CAN,
//                  f6/f5 beside PTR, and so on to the two boxed caps
//   columns 3-17   the typewriter block, as on an 8256 but with the bottom row
//                  cut back to the bar and EXIT
//   columns 19-21  CUT, COPY and PASTE over the numeric pad

const COLUMNS_9 = 22;
/** Left edge of the typewriter block and of the pad: one column of case
 *  stands between each pair of blocks. */
const MAIN_9 = 3;
const PAD_9 = 19;

export const PCW9_SCENE = sceneOf(COLUMNS_9);

const nine = deckKeys();

// ── The function block — two columns, five rows ────────────────────────────
([
  ['f8-f7', 'can'],
  ['f6-f5', 'ptr'],
  ['f4-f3', 'alt'],
  ['f2-f1', 'extra'],
  ['box-plus', 'box-minus'],
] as const).forEach((ids, index) => nine.row(ids, 0, rowY(index)));

// ── Row 1 — STOP, the number row, the editing caps ─────────────────────────
nine.row([
  'stop',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'minus', 'equals',
  'del-right', 'del-left',
], MAIN_9, rowY(0));

// ── Rows 2-4 — TAB down to the SHIFTs ──────────────────────────────────────
nine.typewriter(MAIN_9);

// ── Row 5 — the bar, with EXIT under the `@ ½` cap ─────────────────────────
const BAR_LEFT = MAIN_9 + 2.25;
const BAR_WIDTH = 10;
nine.put('space', u(BAR_LEFT), rowY(4), w(BAR_WIDTH));
nine.put('exit', u(BAR_LEFT + BAR_WIDTH), rowY(4));

// ── The right-hand block — three columns, five rows ────────────────────────
([
  ['cut', 'copy', 'paste'],
  ['pad7', 'pad8', 'pad9'],
  ['pad4', 'pad5', 'pad6'],
  ['pad1', 'pad2', 'pad3'],
  ['pad0', 'pad-dot', 'pad-enter'],
] as const).forEach((ids, index) => nine.row(ids, PAD_9, rowY(index)));

/** The 9000s' pad prints the spell-check legend where the 8000s printed the
 *  page symbol. Everything else on the deck is legend-for-legend the same. */
const NINE_SERIES_FN: Readonly<Record<string, string>> = { pad2: 'SPCHK' };

const placedNine: readonly PlacedPcwKey[] = nine.keys.map((item) => {
  const fn = NINE_SERIES_FN[item.key.id];
  return fn ? { ...item, key: { ...item.key, fn } } : item;
});

/** One well per block. The middle one is an L — its bottom row is inset at
 *  both ends — so it takes two rectangles, overlapping by more than their
 *  corner radius so that the join leaves no seam. */
export const PCW9_WELLS: readonly SceneBox[] = [
  wellFor(0, 2, 0, 5),
  wellFor(MAIN_9, 15, 0, 4),
  wellFor(BAR_LEFT, BAR_WIDTH + 1, 4, 1),
  wellFor(PAD_9, 3, 0, 5),
];

/** The plate, which on this deck runs the width of the whole deck and carries
 *  the model number in red at its right-hand end. */
export const PCW9_BADGE: SceneBox = {
  x: PCW9_WELLS[0].x,
  y: 16,
  width: PCW9_WELLS[3].x + PCW9_WELLS[3].width - PCW9_WELLS[0].x,
  height: 34,
};

export function placePcw9Keys(): readonly PlacedPcwKey[] {
  return placedNine;
}

export function pcw9Face(plateModel: string): PcwFace {
  return {
    scene: PCW9_SCENE,
    wells: PCW9_WELLS,
    badge: PCW9_BADGE,
    keys: placedNine,
    plateModel,
    deck: '9',
  };
}
