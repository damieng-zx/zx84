/**
 * Tatung Einstein physical key faces mapped to the Einstein key matrix, for
 * both the TC-01 and the 256.
 *
 * Cells are `[line, bit]` in the AY-scanned 8x8 matrix (see
 * `einstein-keyboard.ts`). SHIFT, CONTROL and GRAPH are not scanned rows — they
 * sit in the I/O 0x20 status byte — so they use the synthetic status line 8,
 * whose bits are the status byte's own (b7 SHIFT, b6 CONTROL, b5 GRAPH). A cap
 * therefore presses a *chord*: usually one cell, but a modifier plus a cell
 * where the printed key is not a switch of its own.
 *
 * Legends are the printed cap faces: `main` is the unshifted glyph, `shift` the
 * one above it. Several caps carry glyphs that are plain ASCII in the matrix but
 * print as Einstein font characters — 0x5B is a left arrow, 0x5C a half, 0x5D a
 * right arrow, 0x5E an up arrow, 0x60 a pound, 0x7B/0x7D quarters, 0x7C a double
 * bar and 0x7E a division sign — so the caps are labelled as the machine draws
 * them, not as ASCII. The front-face block-graphic legends are omitted.
 */

export type EinsteinCell = readonly [line: number, bit: number];

export type EinsteinKeyTone = 'cream' | 'dark' | 'red';

export type EinsteinKeyRegion = 'main' | 'function' | 'modifier' | 'cursor';

export interface EinsteinKeyDef {
  readonly id: string;
  readonly chord: readonly EinsteinCell[];
  readonly main: string;
  readonly shift?: string;
  readonly tone: EinsteinKeyTone;
  readonly region: EinsteinKeyRegion;
}

/** The status byte's modifier line — not scanned, see the file header. */
export const STATUS_LINE = 8;
const SHIFT: EinsteinCell = [STATUS_LINE, 7];
const CONTROL: EinsteinCell = [STATUS_LINE, 6];
const GRAPH: EinsteinCell = [STATUS_LINE, 5];

const key = (
  id: string,
  chord: readonly EinsteinCell[],
  main: string,
  shift?: string,
  tone: EinsteinKeyTone = 'cream',
  region: EinsteinKeyRegion = 'main',
): EinsteinKeyDef => ({ id, chord, main, shift, tone, region });

/** What differs between the two decks, cap by cap. */
interface DeckStyle {
  /** The zero cap prints a slashed zero on the TC-01, a plain one on the 256. */
  readonly zero: string;
  readonly spaceTone: EinsteinKeyTone;
  readonly functionTone: EinsteinKeyTone;
}

/** Everything both decks share, which is every cap but the cursor keys. */
function commonKeys({ zero, spaceTone, functionTone }: DeckStyle): readonly EinsteinKeyDef[] {
  return [
    key('f0', [[0, 2]], 'F0', undefined, functionTone, 'function'),
    key('f1', [[6, 7]], 'F1', undefined, functionTone, 'function'),
    key('f2', [[5, 7]], 'F2', undefined, functionTone, 'function'),
    key('f3', [[4, 7]], 'F3', undefined, functionTone, 'function'),
    key('f4', [[3, 7]], 'F4', undefined, functionTone, 'function'),
    key('f5', [[2, 7]], 'F5', undefined, functionTone, 'function'),
    key('f6', [[7, 7]], 'F6', undefined, functionTone, 'function'),
    key('f7', [[0, 3]], 'F7', undefined, functionTone, 'function'),

    key('esc', [[0, 7]], 'ESC', undefined, 'dark', 'modifier'),
    key('1', [[4, 6]], '1', '!'),
    key('2', [[4, 5]], '2', '"'),
    key('3', [[4, 4]], '3', '#'),
    key('4', [[4, 3]], '4', '$'),
    key('5', [[4, 2]], '5', '%'),
    key('6', [[4, 1]], '6', '&'),
    key('7', [[4, 0]], '7', "'"),
    key('8', [[3, 3]], '8', '('),
    key('9', [[2, 6]], '9', ')'),
    key('0', [[1, 7]], zero, '@'),
    key('equal', [[3, 5]], '=', '−'),
    key('up-arrow', [[3, 6]], '↑', '÷'),
    key('double-bar', [[1, 6]], '‖', '½'),
    key('break', [[0, 0]], 'BREAK', undefined, 'dark', 'modifier'),

    key('ctrl', [CONTROL], 'CTRL', undefined, 'dark', 'modifier'),
    key('q', [[5, 6]], 'Q'),
    key('w', [[5, 5]], 'W'),
    key('e', [[5, 4]], 'E'),
    key('r', [[5, 3]], 'R'),
    key('t', [[5, 2]], 'T'),
    key('y', [[5, 1]], 'Y'),
    key('u', [[5, 0]], 'U'),
    key('i', [[1, 0]], 'I'),
    key('o', [[1, 1]], 'O'),
    key('p', [[1, 2]], 'P'),
    key('underscore', [[1, 4]], '_', '£'),
    key('left-arrow', [[1, 3]], '←', '¼'),
    key('ins-del', [[3, 4]], 'INS\nDEL', undefined, 'dark', 'modifier'),

    key('alpha-lock', [[0, 4]], 'ALPHA\nLOCK', undefined, 'dark', 'modifier'),
    key('a', [[6, 6]], 'A'),
    key('s', [[6, 5]], 'S'),
    key('d', [[6, 4]], 'D'),
    key('f', [[6, 3]], 'F'),
    key('g', [[6, 2]], 'G'),
    key('h', [[6, 1]], 'H'),
    key('j', [[6, 0]], 'J'),
    key('k', [[2, 0]], 'K'),
    key('l', [[2, 1]], 'L'),
    key('semicolon', [[2, 2]], ';', '+'),
    key('colon', [[2, 3]], ':', '*'),
    key('right-arrow', [[2, 4]], '→', '¾'),
    key('enter', [[0, 5]], 'ENTER', undefined, 'red', 'modifier'),

    key('shift-left', [SHIFT], 'SHIFT', undefined, 'dark', 'modifier'),
    key('z', [[7, 6]], 'Z'),
    key('x', [[7, 5]], 'X'),
    key('c', [[7, 4]], 'C'),
    key('v', [[7, 3]], 'V'),
    key('b', [[7, 2]], 'B'),
    key('n', [[7, 1]], 'N'),
    key('m', [[7, 0]], 'M'),
    key('comma', [[3, 0]], ',', '<'),
    key('period', [[3, 1]], '.', '>'),
    key('slash', [[3, 2]], '/', '?'),
    key('shift-right', [SHIFT], 'SHIFT', undefined, 'dark', 'modifier'),
    key('graph', [GRAPH], 'GRAPH', undefined, 'dark', 'modifier'),

    key('space', [[0, 6]], '', undefined, spaceTone),
  ];
}

/**
 * TC-01. Two cursor caps, each printing two arrows: the cell alone gives the
 * lower legend, SHIFT the upper one (MOS 1.2 decodes [2,5] to 0x04/0x08 and
 * [1,5] to 0x0A/0x0B).
 */
export const TC01_KEYS: readonly EinsteinKeyDef[] = [
  ...commonKeys({ zero: 'Ø', spaceTone: 'cream', functionTone: 'dark' }),
  key('cursor-lr', [[2, 5]], '⇨', '⇦', 'dark', 'cursor'),
  key('cursor-ud', [[1, 5]], '⇩', '⇧', 'dark', 'cursor'),
];

/**
 * Einstein 256. The twin-arrow caps give way to a four-wedge cursor pad set
 * apart from the deck, and SHIFT no longer picks a direction — MOS 2.1 decodes
 * shifted [1,5] and [2,5] to the same codes as unshifted. Sweeping every cell
 * and modifier against the real MOS 2.1 ROM found down on [1,5], right on
 * [2,5], left on [0,1] (the cell MAME marks unused, and which the TC-01 has no
 * key for), and no single cell for up at all: CONTROL+K is the ROM's only route
 * to 0x0B, so that is what the up wedge presses.
 */
export const E256_KEYS: readonly EinsteinKeyDef[] = [
  ...commonKeys({ zero: '0', spaceTone: 'dark', functionTone: 'cream' }),
  key('cursor-up', [CONTROL, [2, 0]], '⇧', undefined, 'cream', 'cursor'),
  key('cursor-down', [[1, 5]], '⇩', undefined, 'cream', 'cursor'),
  key('cursor-left', [[0, 1]], '⇦', undefined, 'cream', 'cursor'),
  key('cursor-right', [[2, 5]], '⇨', undefined, 'cream', 'cursor'),
];

const index = (keys: readonly EinsteinKeyDef[]) =>
  new Map(keys.map((definition) => [definition.id, definition] as const));

export const TC01_KEY_INDEX = index(TC01_KEYS);
export const E256_KEY_INDEX = index(E256_KEYS);
