/**
 * Fixed design-coordinate geometry traced from a photographed PCW 8256 deck.
 *
 * The deck is a plain 19-column grid on a 40-unit pitch, and every row fills it
 * exactly — no staircase, no stepped wells. Columns 0-14 are the typewriter
 * block and 15-18 the function-and-keypad cluster; the top row is the one that
 * runs straight across both, which is why CAN, CUT, COPY and PASTE sit directly
 * above the cluster rather than over the letters.
 *
 * Row widths, all coming to 15u across the main block:
 *
 *   1  19 caps of 1u, straight across the whole deck
 *   2  TAB 1.5u, ten letters, two bracket caps, RETURN 1.5u
 *   3  SHIFT LOCK 1.75u, nine letters, three punctuation caps, RETURN's foot
 *   4  SHIFT 2.25u, seven letters, four punctuation caps, SHIFT 1.75u
 *   5  ALT and EXTRA 1.5u each, a boxed cap, the 7.5u bar, a boxed cap,
 *      PTR and EXIT 1.25u each
 *
 * RETURN is the one cap that is not a rectangle: it is an upside-down L two
 * rows tall, narrow at the top and stepping out to the left at the foot, so
 * the `> #` cap fits under its shoulder. That step is a clip path rather than
 * two boxes, because a browser clips hit-testing too — without it the invisible
 * corner would swallow presses meant for `> #`.
 *
 * Above the deck the case carries the AMSTRAD plate, which names the model.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { PCW_KEY_INDEX, type PcwKeyDef } from './layout.ts';

export interface PlacedPcwKey {
  readonly key: PcwKeyDef;
  readonly box: SceneBox;
  /** Set on RETURN alone — see the note above. */
  readonly hitClip?: string;
}

const PITCH = 40;
const GAP = 3;
const CAP = PITCH - GAP;
/** Left edge of column 0. */
const MARGIN = 16;
/** Top of row 1. The case above it carries the badge. */
const DECK_TOP = 92;
const ROW_PITCH = 40;

const COLUMNS = 19;

export const PCW_SCENE = {
  width: MARGIN * 2 + COLUMNS * PITCH,
  height: DECK_TOP + 5 * ROW_PITCH + 16,
  unit: 1,
} as const;

/** Left margin, then 1u = PITCH. */
const u = (n: number) => MARGIN + n * PITCH;
/** Cap width for a cell `n` units wide. */
const w = (n: number) => n * PITCH - GAP;
const rowY = (row: number) => DECK_TOP + row * ROW_PITCH;

const placed: PlacedPcwKey[] = [];

function put(id: string, x: number, y: number, width = CAP, height = CAP, hitClip?: string): void {
  const definition = PCW_KEY_INDEX.get(id);
  if (!definition) throw new Error(`Unknown PCW key: ${id}`);
  placed.push({ key: definition, box: { x, y, width, height }, hitClip });
}

/** A run of 1u caps starting at `start` units in. */
function row(ids: readonly string[], start: number, y: number): void {
  ids.forEach((id, i) => put(id, u(start + i), y));
}

// ── Row 1 — the full 19 columns ────────────────────────────────────────────
row([
  'stop',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'minus', 'equals',
  'del-right', 'del-left',
  'can', 'cut', 'copy', 'paste',
], 0, rowY(0));

// ── Row 2 — TAB, QWERTY, brackets; RETURN starts here ──────────────────────
put('tab', u(0), rowY(1), w(1.5));
row([
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'bracket-left', 'bracket-right',
], 1.5, rowY(1));

// ── Row 3 — SHIFT LOCK, the home row, the punctuation trio ─────────────────
put('shift-lock', u(0), rowY(2), w(1.75));
row([
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'semicolon', 'section', 'hash',
], 1.75, rowY(2));

// ── RETURN — two rows tall, with the foot inset on the left ────────────────
//
// The top is the full 1.5u left over on row 2; row 3 carries a quarter-unit
// more cap before it (SHIFT LOCK is wider than TAB), so the foot starts a
// quarter unit further right and the shoulder overhangs the `> #` cap.
const RETURN_LEFT = 13.5;
const RETURN_FOOT_LEFT = 13.75;
const RETURN_WIDTH = w(COLUMNS - 4 - RETURN_LEFT);   // to the end of column 14
const RETURN_HEIGHT = ROW_PITCH + CAP;
const pct = (n: number) => `${+(n * 100).toFixed(3)}%`;
/** The inset: everything left of this is missing from the lower row. */
const STEP_X = pct((RETURN_FOOT_LEFT - RETURN_LEFT) * PITCH / RETURN_WIDTH);
const STEP_Y = pct(ROW_PITCH / RETURN_HEIGHT);
const RETURN_CLIP =
  `polygon(0 0, 100% 0, 100% 100%, ${STEP_X} 100%, ${STEP_X} ${STEP_Y}, 0 ${STEP_Y})`;
put('return', u(RETURN_LEFT), rowY(1), RETURN_WIDTH, RETURN_HEIGHT, RETURN_CLIP);

// ── Row 4 — the SHIFTs and the bottom letter row ───────────────────────────
put('shift-left', u(0), rowY(3), w(2.25));
row([
  'z', 'x', 'c', 'v', 'b', 'n', 'm',
  'comma', 'period', 'slash', 'half',
], 2.25, rowY(3));
put('shift-right', u(13.25), rowY(3), w(1.75));

// ── Row 5 — the bar and what sits either side of it ────────────────────────
put('alt', u(0), rowY(4), w(1.5));
put('extra', u(1.5), rowY(4), w(1.5));
put('box-plus', u(3), rowY(4));
put('space', u(4), rowY(4), w(7.5));
put('box-minus', u(11.5), rowY(4));
put('ptr', u(12.5), rowY(4), w(1.25));
put('exit', u(13.75), rowY(4), w(1.25));

// ── The right-hand cluster — four columns, four rows ───────────────────────
const CLUSTER = COLUMNS - 4;
([
  ['f8-f7', 'pad7', 'pad8', 'pad9'],
  ['f6-f5', 'pad4', 'pad5', 'pad6'],
  ['f4-f3', 'pad1', 'pad2', 'pad3'],
  ['f2-f1', 'pad0', 'pad-dot', 'pad-enter'],
] as const).forEach((ids, index) => row(ids, CLUSTER, rowY(index + 1)));

/** The charcoal well the whole deck sits in — one rectangle, since no row is
 *  narrower than another. */
const WELL_PAD = 4;
export const PCW_WELL: SceneBox = {
  x: u(0) - WELL_PAD,
  y: rowY(0) - WELL_PAD,
  width: COLUMNS * PITCH - GAP + WELL_PAD * 2,
  height: 4 * ROW_PITCH + CAP + WELL_PAD * 2,
};

/** The AMSTRAD plate, at the top left of the case. */
export const PCW_BADGE: SceneBox = { x: u(0) + 4, y: 34, width: 336, height: 34 };

export function placePcwKeys(): readonly PlacedPcwKey[] {
  return placed;
}
