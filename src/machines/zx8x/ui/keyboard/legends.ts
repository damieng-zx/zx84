/**
 * ZX81 / ZX80 on-screen keyboard legend data (pure — no solid-js, so it stays
 * unit-testable on its own).
 *
 * The real machines are a flat 4×10 grid of 40 keys filling the whole 8×5
 * (rows × bits) matrix. There are NO dedicated cursor/edit keys: the arrows,
 * RUBOUT, GRAPHICS, EDIT and BREAK are shift legends printed on the number/SPACE
 * keys, so every on-screen key maps to exactly one matrix cell.
 *
 * Each key occupies these print zones, matching the hardware:
 *   • keyword — white, on the case ABOVE the key (letter keys); left-aligned.
 *   • capFn   — red, printed at the TOP of the keycap: the shifted function
 *               word/arrow on the number keys (EDIT, ←, GRAPHICS…), plus BREAK
 *               (SPACE) and FUNCTION (NEW LINE).
 *   • main    — the black glyph, bottom-left of the cap, on a baseline it shares
 *               with the block-graphics swatch (bottom-right).
 *   • shift   — red SHIFT symbol/token, upper-right of the cap (letter keys).
 *   • func    — white FUNCTION word, on the case BELOW the key (ZX81 letters);
 *               left-aligned.
 *
 * Legend text is transcribed best-effort (Martin Korth's "Sinclair ZX
 * Specifications" cross-checked against the ZX81 manual and the reference
 * keyboard photo). The block-graphics quadrant patterns are read from the photo
 * and are approximate; keys the author is unsure of carry a `// UNCERTAIN` note.
 */

import type { Zx8xModel } from '@/machines/zx8x/models.ts';

export type Cell = readonly [number, number];

/** The single ZX8x modifier: SHIFT at matrix row 0, bit 0. */
export const SHIFT: Cell = [0, 0];

/** One block-graphics swatch quadrant: white, black, or 50% grey. */
export type Quad = 0 | 1 | 2;
/** A 2×2 mosaic swatch: [top-left, top-right, bottom-left, bottom-right]. */
export type Graphic = readonly [Quad, Quad, Quad, Quad];

export interface Zx8xKey {
  /** Matrix [row, bit]. */
  pos: Cell;
  /** Main glyph or key label (black on the cap). '\n' splits onto two lines. */
  main: string;
  /** K-mode BASIC keyword — white, on the case above the key. */
  keyword?: string;
  /** Shifted function word/arrow — red, printed at the top of the keycap
   *  (number keys, SPACE's BREAK, NEW LINE's FUNCTION). */
  capFn?: string;
  /** Red SHIFT symbol/token — on the keycap, upper-right. */
  shift?: string;
  /** FUNCTION-mode word — white, on the case below the key (ZX81). */
  func?: string;
  /** Block-graphics swatch on the cap. */
  graphic?: Graphic;
  /** SHIFT is the one-shot latching modifier. */
  latch?: boolean;
}

/** Per-key legends other than the fixed position/main/latch. */
type Legend = Omit<Zx8xKey, 'pos' | 'main' | 'latch'>;

interface LayoutKey { pos: Cell; main: string; latch?: boolean }

const NEWLINE = 'NEW\nLINE';

/**
 * The physical grid: four rows of ten, each cell a fixed matrix position and
 * main label. Shared by both machines; the per-model legend maps below supply
 * the keyword/shift/func/graphic text.
 */
const LAYOUT: readonly LayoutKey[][] = [
  [
    { pos: [3, 0], main: '1' }, { pos: [3, 1], main: '2' }, { pos: [3, 2], main: '3' },
    { pos: [3, 3], main: '4' }, { pos: [3, 4], main: '5' }, { pos: [4, 4], main: '6' },
    { pos: [4, 3], main: '7' }, { pos: [4, 2], main: '8' }, { pos: [4, 1], main: '9' },
    { pos: [4, 0], main: '0' },
  ],
  [
    { pos: [2, 0], main: 'Q' }, { pos: [2, 1], main: 'W' }, { pos: [2, 2], main: 'E' },
    { pos: [2, 3], main: 'R' }, { pos: [2, 4], main: 'T' }, { pos: [5, 4], main: 'Y' },
    { pos: [5, 3], main: 'U' }, { pos: [5, 2], main: 'I' }, { pos: [5, 1], main: 'O' },
    { pos: [5, 0], main: 'P' },
  ],
  [
    { pos: [1, 0], main: 'A' }, { pos: [1, 1], main: 'S' }, { pos: [1, 2], main: 'D' },
    { pos: [1, 3], main: 'F' }, { pos: [1, 4], main: 'G' }, { pos: [6, 4], main: 'H' },
    { pos: [6, 3], main: 'J' }, { pos: [6, 2], main: 'K' }, { pos: [6, 1], main: 'L' },
    { pos: [6, 0], main: NEWLINE },
  ],
  [
    { pos: [0, 0], main: 'SHIFT', latch: true }, { pos: [0, 1], main: 'Z' },
    { pos: [0, 2], main: 'X' }, { pos: [0, 3], main: 'C' }, { pos: [0, 4], main: 'V' },
    { pos: [7, 4], main: 'B' }, { pos: [7, 3], main: 'N' }, { pos: [7, 2], main: 'M' },
    { pos: [7, 1], main: '.' }, { pos: [7, 0], main: 'SPACE' },
  ],
];

// Block-graphics swatch shorthands (quadrants: 0 white/blank, 1 black, 2 grey).
const TL: Graphic = [1, 0, 0, 0];
const TR: Graphic = [0, 1, 0, 0];
const BR: Graphic = [0, 0, 0, 1];
const BL: Graphic = [0, 0, 1, 0];
const LEFT: Graphic = [1, 0, 1, 0];
const RIGHT: Graphic = [0, 1, 0, 1];
const TOP: Graphic = [1, 1, 0, 0];
const BOT: Graphic = [0, 0, 1, 1];
// Inverse quadrants (three filled) and the two diagonals — the Q–Y graphics.
const INV_TL: Graphic = [0, 1, 1, 1];
const INV_TR: Graphic = [1, 0, 1, 1];
const INV_BR: Graphic = [1, 1, 1, 0];
const INV_BL: Graphic = [1, 1, 0, 1];
const DIAG_TRBL: Graphic = [0, 1, 1, 0]; // top-right + bottom-left
const DIAG_TLBR: Graphic = [1, 0, 0, 1]; // top-left + bottom-right
const GREY: Graphic = [2, 2, 2, 2];         // full grey (checker) mosaic
// The ZX81 grey graphics on the A–H keys: checker halves against blank/solid.
const CHK_TOP: Graphic = [2, 2, 0, 0];      // top-half checker, blank bottom (S)
const CHK_BOT: Graphic = [0, 0, 2, 2];      // bottom-half checker, blank top (D)
const CHK_TOP_SOLID: Graphic = [2, 2, 1, 1]; // top checker, solid bottom (F)
const CHK_BOT_SOLID: Graphic = [1, 1, 2, 2]; // solid top, bottom checker (G)

// ── ZX81 — high confidence on text; block patterns approximate ──────────────
const ZX81_LEGENDS: Record<string, Legend> = {
  '1': { capFn: 'EDIT', graphic: TL },
  '2': { capFn: 'AND', graphic: TR },
  '3': { capFn: 'THEN', graphic: BR },
  '4': { capFn: 'TO', graphic: BL },
  '5': { capFn: '←', graphic: LEFT },  // ←
  '6': { capFn: '↓', graphic: BOT },   // ↓
  '7': { capFn: '↑', graphic: TOP },   // ↑
  '8': { capFn: '→', graphic: RIGHT }, // →
  '9': { capFn: 'GRAPHICS' },
  '0': { capFn: 'RUBOUT' },
  Q: { keyword: 'PLOT', shift: '""', func: 'SIN', graphic: INV_TL }, // quote-image
  W: { keyword: 'UNPLOT', shift: 'OR', func: 'COS', graphic: INV_TR },
  E: { keyword: 'REM', shift: 'STEP', func: 'TAN', graphic: INV_BR },
  R: { keyword: 'RUN', shift: '<=', func: 'INT', graphic: INV_BL },
  T: { keyword: 'RAND', shift: '<>', func: 'RND', graphic: DIAG_TRBL },
  Y: { keyword: 'RETURN', shift: '>=', func: 'STR$', graphic: DIAG_TLBR },
  U: { keyword: 'IF', shift: '$', func: 'CHR$' },
  I: { keyword: 'INPUT', shift: '(', func: 'CODE' },
  O: { keyword: 'POKE', shift: ')', func: 'PEEK' },
  P: { keyword: 'PRINT', shift: '"', func: 'TAB' },
  A: { keyword: 'NEW', shift: 'STOP', func: 'ARCSIN', graphic: GREY },
  S: { keyword: 'SAVE', shift: 'LPRINT', func: 'ARCCOS', graphic: CHK_TOP },
  D: { keyword: 'DIM', shift: 'SLOW', func: 'ARCTAN', graphic: CHK_BOT },
  F: { keyword: 'FOR', shift: 'FAST', func: 'SGN', graphic: CHK_TOP_SOLID },
  G: { keyword: 'GOTO', shift: 'LLIST', func: 'ABS', graphic: CHK_BOT_SOLID },
  H: { keyword: 'GOSUB', shift: '**', func: 'SQR', graphic: GREY },
  J: { keyword: 'LOAD', shift: '−', func: 'VAL' }, // − minus
  K: { keyword: 'LIST', shift: '+', func: 'LEN' },
  L: { keyword: 'LET', shift: '=', func: 'USR' },
  Z: { keyword: 'COPY', shift: ':', func: 'LN' },
  X: { keyword: 'CLEAR', shift: ';', func: 'EXP' },
  C: { keyword: 'CONT', shift: '?', func: 'AT' },
  V: { keyword: 'CLS', shift: '/' }, // no FUNCTION word on V
  B: { keyword: 'SCROLL', shift: '*', func: 'INKEY$' },
  N: { keyword: 'NEXT', shift: '<', func: 'NOT' },
  M: { keyword: 'PAUSE', shift: '>', func: 'π' },
  '.': { shift: ',' },
  [NEWLINE]: { capFn: 'FUNCTION' }, // SHIFT+NEWLINE enters FUNCTION mode
  SPACE: { keyword: 'BREAK', shift: '£' }, // BREAK white above; £ on the cap
};

// ── ZX80 — best-effort. Integer 4K BASIC, reshuffled keywords, no FUNCTION
// mode; shifted letter keys carry block graphics (shown as a grey swatch). ─────
const ZX80_LEGENDS: Record<string, Legend> = {
  '1': { capFn: 'NOT' },
  '2': { capFn: 'AND' },
  '3': { capFn: 'THEN' },
  '4': { capFn: 'TO' },
  '5': { capFn: '←' },
  '6': { capFn: '↓' },
  '7': { capFn: '↑' },
  '8': { capFn: '→' },
  '9': {}, // UNCERTAIN: source unclear; the ZX80 has no GRAPHICS mode
  '0': { capFn: 'RUBOUT' },
  Q: { keyword: 'NEW', graphic: LEFT },
  W: { keyword: 'LOAD', graphic: BOT },
  E: { keyword: 'SAVE', graphic: TL },
  R: { keyword: 'RUN', graphic: TR },
  T: { graphic: CHK_BOT }, // UNCERTAIN keyword: source shows none on T
  Y: { keyword: 'REM', shift: '"' },
  U: { keyword: 'IF', shift: '$' },
  I: { keyword: 'INPUT', shift: '(' },
  O: { keyword: 'PRINT', shift: ')' },
  P: { shift: '*' },
  A: { keyword: 'LIST', graphic: GREY },
  S: { keyword: 'STOP', graphic: DIAG_TRBL },
  D: { keyword: 'DIM', graphic: BL },
  F: { keyword: 'FOR', graphic: BR },
  G: { keyword: 'GO TO', graphic: CHK_TOP },
  H: { keyword: 'POKE', shift: '**' },
  J: { keyword: 'RAND', shift: '−' },
  K: { keyword: 'LET', shift: '+' },
  L: { shift: '=' },
  Z: { shift: ':' },
  X: { keyword: 'CLEAR', shift: ';' },
  C: { keyword: 'CLS', shift: '?' },
  V: { keyword: 'GO SUB', shift: '/' },
  B: { keyword: 'RETURN', shift: 'OR' },
  N: { keyword: 'NEXT', shift: '<' },
  M: { shift: '>' },
  '.': { shift: ',' },
  [NEWLINE]: { capFn: 'EDIT' }, // SHIFT+NEWLINE = EDIT on the ZX80
  SPACE: { keyword: 'BREAK', shift: '£' },
};

function build(legends: Record<string, Legend>): Zx8xKey[][] {
  return LAYOUT.map((row) =>
    row.map((k) => ({ pos: k.pos, main: k.main, latch: k.latch, ...legends[k.main] })),
  );
}

export const ZX81_ROWS: Zx8xKey[][] = build(ZX81_LEGENDS);
export const ZX80_ROWS: Zx8xKey[][] = build(ZX80_LEGENDS);

/** The key rows for a model's on-screen keyboard. */
export function rowsForModel(model: Zx8xModel): Zx8xKey[][] {
  return model === 'zx80' ? ZX80_ROWS : ZX81_ROWS;
}
