/**
 * Jupiter Ace on-screen keyboard legend data (pure — no solid-js, so it stays
 * unit-testable on its own).
 *
 * The Ace has exactly 40 keys filling its 8×5 matrix (see `../../keyboard.ts`),
 * positioned like the Spectrum 48K's: SHIFT bottom-left, SYMBOL SHIFT next to
 * SPACE, ENTER at the end of the A row (Ace manual ch. 2; Micro Choice review,
 * Winter 1983). FORTH has no keyword entry, so the Ace prints far less than the
 * Spectrum:
 *   • main    — the key's own character, on the cap.
 *   • symbol  — the SYMBOL SHIFT character, on the cap, from the ROM's
 *               key-decode table at 0x03C6. Q, W and E decode to themselves
 *               and carry none.
 *   • shiftFn — the SHIFT function of a digit key, on the case below it
 *               (manual ch. 2). SHIFT+3 decodes to a plain '3' — no function.
 *               Unlike the Spectrum, SHIFT+6 is cursor UP and SHIFT+7 DOWN.
 *   • graphic — the GRAPHICS-mode block on digits 1–7 and 0, on the cap.
 *               Booting the ROM, digit d types code d − 0x20, whose glyph the
 *               ROM builds from bit 1 (top-left), bit 0 (top-right) and bit 2
 *               (bottom-right); inverse video supplies the other eight. 0
 *               (0x10) is the empty block; 8 and 9 (0x18, 0x19) only repeat
 *               0's and 1's blocks and carry none.
 */

export type Cell = readonly [row: number, bit: number];

/** The two modifiers: SHIFT at matrix [0,0], SYMBOL SHIFT at [0,1]. */
export const SHIFT: Cell = [0, 0];
export const SYMBOL_SHIFT: Cell = [0, 1];

export type AceKeyKind = 'num' | 'letter' | 'special';

/** A 2×2 block-graphics swatch — [top-left, top-right, bottom-left,
 *  bottom-right], 1 = lit (white on the Ace's black screen). */
export type Graphic = readonly [0 | 1, 0 | 1, 0 | 1, 0 | 1];

export interface AceKey {
  readonly kind: AceKeyKind;
  /** Matrix [row, bit]. */
  readonly pos: Cell;
  /** Cap label; '\n' splits a special key's label onto two lines. */
  readonly main: string;
  /** SYMBOL SHIFT character printed on the cap. */
  readonly symbol?: string;
  /** SHIFT function printed on the case below a digit key. */
  readonly shiftFn?: string;
  /** GRAPHICS-mode block character printed on a digit key. */
  readonly graphic?: Graphic;
  /** SHIFT / SYMBOL SHIFT latch one-shot. */
  readonly latch?: boolean;
  /** Render the last label line large (BREAK SPACE). */
  readonly bigLast?: boolean;
  /** Width in key units (default 1). */
  readonly w?: number;
}

const num = (main: string, pos: Cell, symbol: string, shiftFn?: string, graphic?: Graphic): AceKey =>
  ({ kind: 'num', pos, main, symbol, shiftFn, graphic });

const letter = (main: string, pos: Cell, symbol?: string): AceKey =>
  ({ kind: 'letter', pos, main, symbol });

export const ACE_ROWS: readonly (readonly AceKey[])[] = [
  [
    num('1', [3, 0], '!', 'DELETE\nLINE', [0, 1, 0, 0]),
    num('2', [3, 1], '@', 'CAPS\nLOCK', [1, 0, 0, 0]),
    num('3', [3, 2], '#', undefined, [1, 1, 0, 0]),
    num('4', [3, 3], '$', 'INVERSE\nVIDEO', [0, 0, 0, 1]),
    num('5', [3, 4], '%', '←', [0, 1, 0, 1]),
    num('6', [4, 4], '&', '↑', [1, 0, 0, 1]),
    num('7', [4, 3], "'", '↓', [1, 1, 0, 1]),
    num('8', [4, 2], '(', '→'),
    num('9', [4, 1], ')', 'GRAPHICS'),
    num('0', [4, 0], '_', 'DELETE', [0, 0, 0, 0]),
  ],
  [
    letter('Q', [2, 0]),
    letter('W', [2, 1]),
    letter('E', [2, 2]),
    letter('R', [2, 3], '<'),
    letter('T', [2, 4], '>'),
    letter('Y', [5, 4], '['),
    letter('U', [5, 3], ']'),
    letter('I', [5, 2], '©'),
    letter('O', [5, 1], ';'),
    letter('P', [5, 0], '"'),
  ],
  [
    letter('A', [1, 0], '~'),
    letter('S', [1, 1], '|'),
    letter('D', [1, 2], '\\'),
    letter('F', [1, 3], '{'),
    letter('G', [1, 4], '}'),
    letter('H', [6, 4], '↑'),
    letter('J', [6, 3], '-'),
    letter('K', [6, 2], '+'),
    letter('L', [6, 1], '='),
    { kind: 'special', pos: [6, 0], main: 'ENTER' },
  ],
  [
    { kind: 'special', pos: SHIFT, main: 'SHIFT', latch: true, w: 1.25 },
    letter('Z', [0, 2], ':'),
    letter('X', [0, 3], '£'),
    letter('C', [0, 4], '?'),
    letter('V', [7, 4], '/'),
    letter('B', [7, 3], '*'),
    letter('N', [7, 2], ','),
    letter('M', [7, 1], '.'),
    { kind: 'special', pos: SYMBOL_SHIFT, main: 'SYMBOL\nSHIFT', latch: true },
    { kind: 'special', pos: [7, 0], main: 'BREAK\nSPACE', bigLast: true, w: 1.75 },
  ],
];
