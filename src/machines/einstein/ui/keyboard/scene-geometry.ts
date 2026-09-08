/**
 * Fixed design-coordinate geometry traced from a UK Tatung Einstein TC-01 and
 * an Einstein 256, both on a 40-unit key pitch.
 *
 * TC-01: every cap is 1u square except ENTER (1.55u) and the space bar (8u).
 * What gives the face its shape is the stagger — the number row starts 0.1u in,
 * the Q row 0.6u, the A row 0.8u and the Z row 1.35u, much deeper than a modern
 * keyboard, and enough that the gap between the 1 and the 2 falls over the
 * centre of Q. The function caps sit on the same pitch, the row starting at the
 * centre of the 3; ENTER and GRAPH finish flush; and the space bar runs from
 * the left of X to the right of the full stop.
 *
 * 256: a squarer deck. The four modifier caps down the left edge share a common
 * left margin and grow to meet their own row's first key (ESC 1u, CTRL 1.5u,
 * ALPHA LOCK 1.75u, SHIFT 2.25u), the typing block staggering by the classic
 * 0.5u / 0.25u / 0.5u, and every row finishes flush at 15.5u. The function keys
 * are a separate 1.25u-pitch strip under a legend card cut to the same span,
 * ENTER is an L across two rows, and the cursor keys are four wedges on a
 * detached pad out to the right of the deck.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import {
  E256_KEY_INDEX,
  TC01_KEY_INDEX,
  type EinsteinKeyDef,
} from './layout.ts';

export const TC01_SCENE = { width: 644, height: 250, unit: 1 } as const;
export const E256_SCENE = { width: 784, height: 290, unit: 1 } as const;

export interface PlacedEinsteinKey {
  readonly key: EinsteinKeyDef;
  readonly box: SceneBox;
  readonly hitClip?: string;
}

/** 1u: the cap pitch. Caps are GAP narrower, leaving a channel between them. */
const PITCH = 40;
const GAP = 4;
const CAP = PITCH - GAP;

function builder(index: Map<string, EinsteinKeyDef>) {
  const placed: PlacedEinsteinKey[] = [];
  const put = (
    id: string,
    x: number,
    y: number,
    width = CAP,
    height = CAP,
    hitClip?: string,
  ): void => {
    const definition = index.get(id);
    if (!definition) throw new Error(`Unknown Einstein key: ${id}`);
    placed.push({ key: definition, box: { x, y, width, height }, hitClip });
  };
  /** A run of 1u caps starting at `x`. */
  const row = (ids: readonly string[], x: number, y: number): void => {
    ids.forEach((id, i) => put(id, x + i * PITCH, y));
  };
  return { placed, put, row };
}

// ── TC-01 ────────────────────────────────────────────────────────────────────

const tc01 = builder(TC01_KEY_INDEX);
{
  const { put, row } = tc01;
  const FUNCTION_Y = 4, NUMBER_Y = 44, Q_Y = 84, A_Y = 124, Z_Y = 164, SPACE_Y = 204;

  // Function caps, the row starting at the centre of the 3.
  row(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'], 156, FUNCTION_Y);

  // Number row — BREAK ends 0.5u short of the rows below.
  row([
    'esc',
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
    'equal', 'up-arrow', 'double-bar',
    'break',
  ], 16, NUMBER_Y);

  // Q row, ending in the two twin-arrow cursor caps.
  row([
    'ctrl',
    'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
    'underscore', 'left-arrow',
    'cursor-lr', 'cursor-ud',
  ], 36, Q_Y);

  // A row: thirteen 1u caps and the 1.55u red ENTER, flush with GRAPH.
  row([
    'alpha-lock',
    'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
    'semicolon', 'colon', 'right-arrow',
  ], 44, A_Y);
  put('enter', 564, A_Y, 58);

  // Z row, GRAPH flush with ENTER.
  row([
    'shift-left',
    'z', 'x', 'c', 'v', 'b', 'n', 'm',
    'comma', 'period', 'slash',
    'shift-right', 'ins-del', 'graph',
  ], 66, Z_Y);

  // The space bar spans X to the full stop.
  put('space', 146, SPACE_Y, 316);
}

export function placeTc01Keys(): readonly PlacedEinsteinKey[] {
  return tc01.placed;
}

// ── Einstein 256 ─────────────────────────────────────────────────────────────

/** Left margin, then 1u = PITCH: `u(n)` is design x for n units into the deck. */
const u = (n: number) => 8 + n * PITCH;
/** Cap width for a cell `n` units wide. */
const w = (n: number) => n * PITCH - GAP;

/** The legend card, flush with the function caps it labels. */
export const E256_FUNCTION_STRIP: SceneBox =
  { x: u(0.75), y: 6, width: w(10), height: 27 };
/** The moulded recess the cursor wedges sit in. */
export const E256_CURSOR_WELL: SceneBox = { x: u(16.5), y: 183, width: 100, height: 100 };
/** The eight legend pairs printed on the card above the function keys. */
export const E256_FUNCTION_LEGENDS: readonly (readonly [string, string])[] = [
  ['RUN', 'DIR'], ['LIST', 'LOAD'], ['PRINT', 'SAVE'], ['RST:BCOL4', 'DISP'],
  ['BCOL', 'MOS'], ['TCOL', 'EBAS'], ['GCOL', 'BACKUP'], ['REM', 'COPY'],
];

const e256 = builder(E256_KEY_INDEX);
{
  const { put, row } = e256;
  const FUNCTION_Y = 37, NUMBER_Y = 82, Q_Y = 122, A_Y = 162, Z_Y = 202, SPACE_Y = 242;

  // Function keys: a separate strip on a 1.25u pitch with low, wide caps.
  ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']
    .forEach((id, i) => put(id, u(0.75 + i * 1.25), FUNCTION_Y, w(1.25), 26));

  // Number row.
  put('esc', u(0), NUMBER_Y);
  row([
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
    'equal', 'up-arrow', 'double-bar',
  ], u(1), NUMBER_Y);
  put('break', u(14), NUMBER_Y, w(1.5));

  // Q row. ENTER is one L-shaped cap reaching up into it from the A row, so it
  // is placed with that row.
  put('ctrl', u(0), Q_Y, w(1.5));
  row([
    'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
    'underscore', 'left-arrow',
  ], u(1.5), Q_Y);
  put('ins-del', u(13.5), Q_Y);

  // A row.
  put('alpha-lock', u(0), A_Y, w(1.75));
  row([
    'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
    'semicolon', 'colon', 'right-arrow',
  ], u(1.75), A_Y);
  // ENTER: 1.75u across the A row, narrowing to the rightmost 1u where it
  // rises past INS DEL into the Q row.
  put(
    'enter', u(13.75), Q_Y, w(1.75), A_Y - Q_Y + CAP,
    'polygon(45.45% 0, 100% 0, 100% 100%, 0 100%, 0 52.63%, 45.45% 52.63%)',
  );

  // Z row.
  put('shift-left', u(0), Z_Y, w(2.25));
  row([
    'z', 'x', 'c', 'v', 'b', 'n', 'm',
    'comma', 'period', 'slash',
  ], u(2.25), Z_Y);
  put('shift-right', u(12.25), Z_Y, w(2.25));
  put('graph', u(14.5), Z_Y);

  // The space bar spans X to just short of the full stop.
  put('space', u(3.25), SPACE_Y, w(7.75));

  // Detached cursor pad: four triangular wedges cut from one square, each
  // clipped so it only takes the pointer events inside its own triangle.
  const pad = { x: u(16.625), y: 188, size: 90 };
  const wedge = (id: string, clip: string) =>
    put(id, pad.x, pad.y, pad.size, pad.size, clip);
  wedge('cursor-up', 'polygon(2% 0, 98% 0, 50% 48%)');
  wedge('cursor-right', 'polygon(100% 2%, 100% 98%, 52% 50%)');
  wedge('cursor-down', 'polygon(98% 100%, 2% 100%, 50% 52%)');
  wedge('cursor-left', 'polygon(0 98%, 0 2%, 48% 50%)');
}

export function placeE256Keys(): readonly PlacedEinsteinKey[] {
  return e256.placed;
}
