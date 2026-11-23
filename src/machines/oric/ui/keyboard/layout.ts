/**
 * Oric Atmos key faces and matrix cells, in physical order.
 *
 * The deck is a typewriter block, and its shape comes from the *widths* of the
 * control caps and the small left insets of the lower rows — not from offsetting
 * whole rows. Every row is measured from a photograph of a real Atmos, with the
 * cap pitch as the unit and ESC's left edge at zero:
 *
 *   ESC 0.00/0.96   CTRL 0.17/1.04   SHIFT-L 0.21/1.46
 *   DEL 13.00/0.92  RETURN 12.25/1.58  SHIFT-R 11.79/1.46
 *
 * The Atmos's outer keys are orange — ESC / CTRL / SHIFT down the left, DEL and
 * RETURN on the right, and the four arrows plus FUNCT along the bottom.
 *
 * There is **no CAPS key**: uppercase is reached through CTRL-T, which is why the
 * deck has 58 caps and the machine has 58 keys.
 *
 * Cells are `[row, column]` in the 8x8 matrix: the row is what the ROM drives on
 * VIA port B bits 0-2, the column is the bit the PSG's port A clears. They come
 * from MAME's `tangerine/oric.cpp` and agree with the hardware reference's own
 * matrix table (oric.free.fr, "Hardware Programming on the Oric").
 */

import { activeOric } from '@/machines/oric/ui/active.ts';

export type OricKeyAction = 'key' | 'shift' | 'ctrl' | 'return';

export type OricKeyRegion = 'letter' | 'number' | 'word' | 'space' | 'cursor' | 'mod';

export interface OricKeyDef {
  readonly id: string;
  /** Matrix row/column. */
  readonly row: number;
  readonly col: number;
  /** The legend printed on the cap, `\n` for a second line. */
  readonly main: string;
  /** The shifted legend, where the key has one. */
  readonly shift?: string;
  readonly action: OricKeyAction;
  readonly region: OricKeyRegion;
  /**
   * True for the caps the moulded in orange: the modifiers, ESC, DEL, RETURN,
   * the arrows and FUNCT.
   */
  readonly control?: boolean;
  /** Width in cap units, from the photograph. */
  readonly span?: number;
}

function key(
  row: number, col: number, main: string, shift?: string,
  region: OricKeyRegion = 'letter',
): OricKeyDef {
  return { id: `r${row}c${col}`, row, col, main, shift, action: 'key', region };
}

/** A cap with a named legend rather than a character. */
function control(
  id: string, row: number, col: number, main: string, action: OricKeyAction,
  region: OricKeyRegion, span = 1,
): OricKeyDef {
  return { id, row, col, main, action, region, span, control: true };
}

/**
 * The number row: the Oric's digits carry punctuation as SHIFT, and the minus
 * carries the pound sign rather than the underscore a PC would print.
 */
export const ORIC_TOP_ROW: readonly OricKeyDef[] = [
  key(0, 5, '1', '!', 'number'),
  key(2, 6, '2', '"', 'number'),
  key(0, 7, '3', '#', 'number'),
  key(2, 3, '4', '$', 'number'),
  key(0, 2, '5', '%', 'number'),
  key(2, 1, '6', '^', 'number'),
  key(0, 0, '7', '&', 'number'),
  key(7, 0, '8', '*', 'number'),
  key(3, 1, '9', '(', 'number'),
  key(7, 2, '0', ')', 'number'),
  key(3, 3, '-', '\u00a3', 'number'),
  key(7, 7, '=', '+', 'number'),
  key(3, 6, '\\', '|', 'number'),
];

/** ESC, Q..P, the brackets and DEL. */
export const ORIC_Q_ROW: readonly OricKeyDef[] = [
  control('esc', 1, 5, 'ESC', 'key', 'word', 0.96),
  key(1, 6, 'Q'), key(6, 7, 'W'), key(6, 3, 'E'), key(1, 2, 'R'), key(1, 1, 'T'),
  key(6, 0, 'Y'), key(5, 0, 'U'), key(5, 1, 'I'), key(5, 2, 'O'), key(5, 3, 'P'),
  key(5, 7, '[', '{', 'number'),
  key(5, 6, ']', '}', 'number'),
  control('del', 5, 5, 'DEL', 'key', 'word', 0.92),
];

/** CTRL, A..L, the two punctuation caps and RETURN. */
export const ORIC_A_ROW: readonly OricKeyDef[] = [
  control('ctrl', 2, 4, 'CTRL', 'ctrl', 'word', 1.04),
  key(6, 5, 'A'), key(6, 6, 'S'), key(1, 7, 'D'), key(1, 3, 'F'), key(6, 2, 'G'),
  key(6, 1, 'H'), key(1, 0, 'J'), key(3, 0, 'K'), key(7, 1, 'L'),
  key(3, 2, ';', ':', 'number'),
  key(3, 7, "'", '"', 'number'),
  control('return', 7, 5, 'RETURN', 'return', 'word', 1.58),
];

/** SHIFT, Z..M, the three punctuation caps and the right SHIFT. */
export const ORIC_Z_ROW: readonly OricKeyDef[] = [
  control('shift-left', 4, 4, 'SHIFT', 'shift', 'mod', 1.46),
  key(2, 5, 'Z'), key(0, 6, 'X'), key(2, 7, 'C'), key(0, 3, 'V'), key(2, 2, 'B'),
  key(0, 1, 'N'), key(2, 0, 'M'),
  key(4, 1, ',', '<', 'number'),
  key(4, 2, '.', '>', 'number'),
  key(7, 3, '/', '?', 'number'),
  control('shift-right', 7, 4, 'SHIFT', 'shift', 'mod', 1.46),
];

/** The four arrow caps, on the bottom row either side of the space bar. */
export const ORIC_CURSOR_COLUMN: readonly OricKeyDef[] = [
  control('arrow-left', 4, 5, '\u2190', 'key', 'cursor'),
  control('arrow-down', 4, 6, '\u2193', 'key', 'cursor'),
  control('arrow-up', 4, 3, '\u2191', 'key', 'cursor'),
  control('arrow-right', 4, 7, '\u2192', 'key', 'cursor'),
];

/** The space bar: it runs from X's left edge to just before the `UP` arrow. */
export const ORIC_SPACE: OricKeyDef = {
  id: 'space', row: 4, col: 0, main: '', action: 'key', region: 'space', span: 8.37,
};

/** The Atmos-only Funct key, in the row-5 slot the Oric-1 leaves unwired. */
export const ORIC_FUNCT: OricKeyDef = {
  id: 'funct', row: 5, col: 4, main: 'FUNCT', action: 'key', region: 'word', span: 1,
  control: true,
};

/**
 * The bottom row: `← ↓ SPACE ↑ → FUNCT`. `←` is right-aligned with the left
 * SHIFT's right edge and `↓` sits directly below Z; the space bar then starts at
 * X's left edge.
 */
export const ORIC_BOTTOM_ROW: readonly OricKeyDef[] = [
  ORIC_CURSOR_COLUMN[0]!,   // left
  ORIC_CURSOR_COLUMN[1]!,   // down
  ORIC_SPACE,
  ORIC_CURSOR_COLUMN[2]!,   // up
  ORIC_CURSOR_COLUMN[3]!,   // right
  ORIC_FUNCT,
];

/** The four rows of the letter block. The bottom row is placed separately. */
export const ORIC_DECK_ROWS: readonly (readonly OricKeyDef[])[] = [
  ORIC_TOP_ROW, ORIC_Q_ROW, ORIC_A_ROW, ORIC_Z_ROW,
];

export const ORIC_DECK_KEYS: readonly OricKeyDef[] = [
  ...ORIC_TOP_ROW, ...ORIC_Q_ROW, ...ORIC_A_ROW, ...ORIC_Z_ROW, ...ORIC_BOTTOM_ROW,
];

/** The Atmos-only cap, which the Oric-1 does not have. */
export function isFunctCap(key: OricKeyDef): boolean {
  return key.id === ORIC_FUNCT.id;
}

/** Whether the running model has the Funct key (the Atmos does, the Oric-1 not). */
export function modelHasFunctKey(): boolean {
  return activeOric()?.model !== 'oric1';
}
