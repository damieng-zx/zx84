/**
 * Fixed design-coordinate geometry traced from a Camputers Lynx 48K. The 96K
 * and 128K carry the same deck and the same badge, so one face serves all
 * three.
 *
 * Everything sits on a 40-unit pitch and no cap is under 1u. The deck is 16u
 * wide and every row is centred on it, which is what produces the Lynx's
 * staircase: the SHIFT row runs the full 16u, the A row is 15u, and the number
 * and Q rows are 14.5u, so each row above starts a quarter unit further right
 * than the one below. The row-start offsets and the 1.5u caps (BREAK, CONTROL,
 * both SHIFTs, SHIFT LOCK and RETURN) come off the reference photograph, where
 * a cap top measures 63px against a 94px pitch.
 *
 * The space bar is not part of the deck at all — it sits in its own well in
 * the case front, which meets the foot of the deck.
 *
 * Caps sit 2 units apart and the wells clear them by the same 2, so every gap
 * on the face — between caps, around the deck, and between the deck and the
 * space bar — is the one measurement.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import { LYNX_KEY_INDEX, type LynxKeyDef } from './layout.ts';

export const LYNX_SCENE = { width: 664, height: 280, unit: 1 } as const;

export interface PlacedLynxKey {
  readonly key: LynxKeyDef;
  readonly box: SceneBox;
}

const PITCH = 40;
const GAP = 2;
const CAP = PITCH - GAP;
/** Left margin. Half a gap of it is the deck's own edge, so the 16u deck ends
 *  up centred in the scene. */
const MARGIN = 13;

const NUMBER_Y = 68;
const Q_Y = 108;
const A_Y = 148;
const Z_Y = 188;
const SPACE_Y = 228;

/** Left margin, then 1u = PITCH. */
const u = (n: number) => MARGIN + n * PITCH;
/** Cap width for a cell `n` units wide. */
const w = (n: number) => n * PITCH - GAP;

/** The CAMPUTERS LYNX badge, at the top left of the case. */
export const LYNX_BADGE: SceneBox = { x: 30, y: 12, width: 148, height: 46 };

const placed: PlacedLynxKey[] = [];

function put(id: string, x: number, y: number, width = CAP): void {
  const definition = LYNX_KEY_INDEX.get(id);
  if (!definition) throw new Error(`Unknown Lynx key: ${id}`);
  placed.push({ key: definition, box: { x, y, width, height: CAP } });
}

/** A run of 1u caps starting at `start` units in. */
function row(ids: readonly string[], start: number, y: number): void {
  ids.forEach((id, i) => put(id, u(start + i), y));
}

// Number row — 14.5u, so it starts three quarters of a unit in.
row([
  'esc',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'minus', 'at',
], 0.75, NUMBER_Y);
put('break', u(13.75), NUMBER_Y, w(1.5));

// Q row — 14.5u as well, so it lines up flush with the number row.
put('control', u(0.75), Q_Y, w(1.5));
row([
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'bracket-left', 'bracket-right', 'delete',
], 2.25, Q_Y);

// A row — 15u of plain caps, the cursor pair leading and trailing it.
row([
  'down', 'up',
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'semicolon', 'colon',
  'left', 'right',
], 0.5, A_Y);

// Z row — the full 16u, four 1.5u caps and ten 1u ones.
put('shift-lock', u(0), Z_Y, w(1.5));
put('shift-left', u(1.5), Z_Y, w(1.5));
row([
  'z', 'x', 'c', 'v', 'b', 'n', 'm',
  'comma', 'period', 'slash',
], 3, Z_Y);
put('shift-right', u(13), Z_Y, w(1.5));
put('return', u(14.5), Z_Y, w(1.5));

// The space bar, 8u wide and centred on the deck.
put('space', u(4), SPACE_Y, w(8));

/** The stepped charcoal wells the caps sit in: one per row, each running down
 *  to the foot of the deck so the narrower rows above staircase over the wider
 *  ones below, plus the space bar's separate well in the case front. */
const WELL_PAD = 2;
const DECK_FOOT = Z_Y + CAP + WELL_PAD;

/** `bottom` is where the dark ends, pad included — the deck rows all share
 *  one foot, so they pass it directly rather than deriving it from their own
 *  row. */
const well = (start: number, span: number, y: number, bottom: number): SceneBox => ({
  x: u(start) - WELL_PAD,
  y: y - WELL_PAD,
  width: span * PITCH - GAP + WELL_PAD * 2,
  height: bottom - y + WELL_PAD,
});

export const LYNX_WELLS: readonly SceneBox[] = [
  well(0.75, 14.5, NUMBER_Y, DECK_FOOT),
  well(0.75, 14.5, Q_Y, DECK_FOOT),
  well(0.5, 15, A_Y, DECK_FOOT),
  well(0, 16, Z_Y, DECK_FOOT),
  well(4, 8, SPACE_Y, SPACE_Y + CAP + WELL_PAD),
];

export function placeLynxKeys(): readonly PlacedLynxKey[] {
  return placed;
}
