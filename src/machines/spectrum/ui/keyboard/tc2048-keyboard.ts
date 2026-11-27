/**
 * The Timex Computer 2048's keyboard: key data and measured geometry.
 *
 * Traced from a photograph of the machine. It is the Spectrum's 40-cell matrix
 * under hard keycaps, with three differences from the rubber 48K: a second CAPS
 * SHIFT at the right of the bottom row, a BREAK key that holds CAPS SHIFT and
 * SPACE together, and a SPACE bar in a row of its own. That makes 42 keys over
 * the 40 cells. The legends are the Spectrum's, with the TC2048's own spellings
 * (RETRN, BORDR).
 *
 * The Timex Sinclair 2068 / Timex Computer 2068 keyboard is the same keys in the
 * same places on a silver case, with the 2068 BASIC's own extended-mode keywords
 * under five keys (FREE, STICK, ON ERR, SOUND, RESET): see the 'ts2068' face.
 *
 * Nothing here knows how a key is drawn; see KeyboardTc2048.tsx.
 */

import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';
import type { LatchMode } from './keyboard-common.tsx';
import { lettersFor, numbersFor } from './legends.ts';

type Cell = readonly [row: number, bit: number];

const CAPS: Cell = [0, 0];
const SYMBOL: Cell = [7, 1];
const SPACE: Cell = [7, 0];

const NUMBER_CELLS: Readonly<Record<string, Cell>> = {
  '1': [3, 0], '2': [3, 1], '3': [3, 2], '4': [3, 3], '5': [3, 4],
  '6': [4, 4], '7': [4, 3], '8': [4, 2], '9': [4, 1], '0': [4, 0],
};
const LETTER_CELLS: Readonly<Record<string, Cell>> = {
  Q: [2, 0], W: [2, 1], E: [2, 2], R: [2, 3], T: [2, 4],
  Y: [5, 4], U: [5, 3], I: [5, 2], O: [5, 1], P: [5, 0],
  A: [1, 0], S: [1, 1], D: [1, 2], F: [1, 3], G: [1, 4],
  H: [6, 4], J: [6, 3], K: [6, 2], L: [6, 1],
  Z: [0, 1], X: [0, 2], C: [0, 3], V: [0, 4],
  B: [7, 4], N: [7, 3], M: [7, 2],
};
const ENTER: Cell = [6, 0];

/** The TC2048 prints these words shorter than the Spectrum does. */
const SPELLING: Readonly<Record<string, string>> = { RETURN: 'RETRN', BORDER: 'BORDR' };

/** Which Timex keyboard: the TC2048's, or the 2068's (TS2068 and TC2068). */
export type TimexKeyboardFace = 'tc2048' | 'ts2068';

/** The 2068's extended-mode words that differ from the Spectrum's, by key: its
 *  BASIC puts FREE, STICK, ON ERR, SOUND and RESET where the Spectrum has
 *  ~, |, {, } and the copyright sign. */
const TS2068_BELOW: Readonly<Record<string, string>> = {
  A: 'FREE', S: 'STICK', F: 'ON ERR', G: 'SOUND', P: 'RESET',
};

export type Tc2048Kind = 'num' | 'letter' | 'special' | 'space';

export interface Tc2048Key {
  readonly kind: Tc2048Kind;
  /** Matrix cells held while the key is down (BREAK holds two). */
  readonly cells: readonly Cell[];
  /** The glyph, or the label of a special key (lines joined with a newline). */
  readonly main: string;
  /** On the cap: the K-mode keyword, beside the glyph. */
  readonly keyword?: string;
  /** On the cap: the symbol-shift legend, in the black strip at its foot. */
  readonly strip?: string;
  /** On the case above the cap: the extended-mode function word, or a number key's command. */
  readonly above?: string;
  /** On the case above a number key: its colour, and the colour to print it in. */
  readonly colour?: string;
  readonly colourCss?: string;
  /** On the case below the cap: the extended-mode keyword (SYMBOL SHIFT held). */
  readonly below?: string;
  /** Number keys 1–8: which block-graphics swatch is printed on the cap. */
  readonly block?: number;
  readonly latch?: LatchMode;
  /** A black cap with white print (SYMBL SHIFT). */
  readonly dark?: boolean;
}

function buildRows(face: TimexKeyboardFace): Tc2048Key[][] {
  const letters = lettersFor('uk');
  const numbers = numbersFor('uk');
  const num = (d: string): Tc2048Key => {
    const n = numbers[d];
    return {
      kind: 'num', cells: [NUMBER_CELLS[d]], main: d,
      strip: n.red, above: n.cmd, colour: n.color, colourCss: n.colorCss,
      below: n.ext, block: n.block,
    };
  };
  const letter = (c: string): Tc2048Key => {
    const l = letters[c];
    return {
      kind: 'letter', cells: [LETTER_CELLS[c]], main: c,
      keyword: SPELLING[l.word] ?? l.word, strip: l.red, above: l.green,
      below: (face === 'ts2068' ? TS2068_BELOW[c] : undefined) ?? l.ess,
    };
  };
  const special = (main: string, cells: readonly Cell[], extra: Partial<Tc2048Key> = {}): Tc2048Key =>
    ({ kind: 'special', cells, main, ...extra });
  return [
    [...'1234567890'].map(num),
    [...'QWERTYUIOP'].map(letter),
    [...[...'ASDFGHJKL'].map(letter), special('ENTER', [ENTER])],
    [
      special('CAPS\nSHIFT', [CAPS], { latch: 'oneshot' }),
      ...[...'ZXCVBNM'].map(letter),
      special('SYMBL\nSHIFT', [SYMBOL], { latch: 'oneshot', dark: true }),
      special('BREAK', [CAPS, SPACE]),
      special('CAPS\nSHIFT', [CAPS], { latch: 'oneshot' }),
    ],
    [{ kind: 'space', cells: [SPACE], main: 'SPACE' }],
  ];
}

export const TC2048_ROWS: readonly (readonly Tc2048Key[])[] = buildRows('tc2048');
/** The 2068's keys: the TC2048's layout and wiring with its own extended-mode words. */
export const TS2068_ROWS: readonly (readonly Tc2048Key[])[] = buildRows('ts2068');

// ── Geometry ────────────────────────────────────────────────────────────────
// Measured from the photograph at about three photo pixels to a design unit.
// The keys sit on a square 49-unit pitch, each in a ruled cell on the case.

const PITCH = 49;
const LEFT = 36;
const CAP_WIDTH = 37;
const CAP_HEIGHT = 24;

/** Each row's start, in pitches, and the top and height of its ruled cells. */
const ROWS = [
  { start: 0,    top: 2,   height: 62, capTop: 26 },   // the number row is taller: colour and command words sit above the keys
  { start: 0.5,  top: 64,  height: 49, capTop: 13 },
  { start: 38 / PITCH, top: 113, height: 49, capTop: 13 },
  { start: 0,    top: 162, height: 49, capTop: 13 },
  { start: 110 / PITCH, top: 211, height: 48, capTop: 8 },
] as const;

/** Width of the ruled cell and of the cap, for the keys that are not one pitch. */
const WIDE: Readonly<Record<string, { cell: number; cap: number }>> = {
  ENTER: { cell: 84, cap: 72 },
  'CAPS\nSHIFT': { cell: 61, cap: 48 },
  'SYMBL\nSHIFT': { cell: PITCH, cap: 35 },
  BREAK: { cell: PITCH, cap: 36 },
  SPACE: { cell: 7 * PITCH, cap: 327 },
};

export const TC2048_SCENE = {
  width: LEFT * 2 + 563,
  height: 277,
  unit: 1,
} as const;

export interface PlacedTc2048Key {
  readonly key: Tc2048Key;
  /** The ruled cell on the case that the key and its legends sit in. */
  readonly cell: SceneBox;
  readonly cap: SceneBox;
  /** Case legends: the space above the cap and the space below it, within the cell. */
  readonly above: SceneBox;
  readonly below: SceneBox;
}

export function placeTc2048Rows(rows: readonly (readonly Tc2048Key[])[]): PlacedTc2048Key[] {
  const placed: PlacedTc2048Key[] = [];
  rows.forEach((row, r) => {
    const g = ROWS[r];
    let x = LEFT + g.start * PITCH;
    for (const key of row) {
      const wide = WIDE[key.main];
      const cellWidth = wide?.cell ?? PITCH;
      const capWidth = wide?.cap ?? CAP_WIDTH;
      const capHeight = key.kind === 'space' ? 27 : CAP_HEIGHT;
      const cell: SceneBox = { x, y: g.top, width: cellWidth, height: g.height };
      const cap: SceneBox = {
        x: x + (cellWidth - capWidth) / 2,
        y: g.top + g.capTop,
        width: capWidth,
        height: capHeight,
      };
      placed.push({
        key,
        cell,
        cap,
        above: { x, y: g.top, width: cellWidth, height: g.capTop },
        below: { x, y: cap.y + cap.height, width: cellWidth, height: g.top + g.height - cap.y - cap.height },
      });
      x += cellWidth;
    }
  });
  return placed;
}
