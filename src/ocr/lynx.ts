/**
 * Camputers Lynx screen OCR.
 *
 * The Lynx has no character grid anywhere in memory. Its screen is three
 * one-bit colour planes composited by the display circuitry, and BASIC plots
 * text into that bitmap a glyph at a time, so the only way back to text is to
 * cut the picture into character cells and match each against the ROM's
 * character set.
 *
 * The character set is a table of 96 glyphs (ASCII 0x20-0x7F), ten bytes each,
 * in the first 8K ROM image. Each byte is one scan line, the low **six** bits
 * significant, bit 5 leftmost — the underscore at 0x5F is 0x3F, which is what
 * proves the cell is six pixels wide rather than the five every letter uses.
 * Rows 7-9 carry descenders ('g', 'p', 'q', 'y') and are blank for most
 * glyphs.
 *
 * The table's address differs between the two ROM sets, and neither is
 * documented — both were found by booting the machine, printing known text and
 * matching the bitmap the ROM drew back into the ROM image:
 *
 *   48K / 96K   0x01D5
 *   128K        0x0101
 *
 * The text grid was measured the same way, by filling a line with a known
 * character and reading off where it started and wrapped: 6x10 cells, 24 rows
 * down the active area from y=6, 40 columns from x=6 on the 48K/96K and 80
 * from x=12 on the 128K (whose pixels are half as wide, so both fill the same
 * screen).
 *
 * Because the font address is a ROM convention rather than hardware, a
 * replaced system ROM can put something else there. `looksLikeLynxFont`
 * rejects a table that is not a font and the callers say so, rather than
 * transcribing a thousand wrong characters.
 */

import type { LynxOcrGrid, OcrResult } from './ocr.ts';

/** Cell size, in the machine's own pixels. */
export const LYNX_CELL_WIDTH = 6;
export const LYNX_CELL_HEIGHT = 10;

/** The table covers ASCII 0x20-0x7F, ten bytes per glyph. */
export const LYNX_FONT_FIRST_CHAR = 0x20;
export const LYNX_FONT_CHARS = 96;
export const LYNX_FONT_BYTES = LYNX_FONT_CHARS * LYNX_CELL_HEIGHT;

/** Where the character set sits in the first ROM image, per board. */
export const LYNX_FONT_OFFSET_48 = 0x01d5;
export const LYNX_FONT_OFFSET_128 = 0x0101;

/** Only the low six bits of a font byte are pixels. */
const GLYPH_MASK = 0x3f;

/** The text grid a model's display carries, in active-area pixels. */
export interface LynxOcrGeometry {
  readonly cols: number;
  readonly rows: number;
  /** Pixel offset of the grid's top-left cell inside the active area. */
  readonly originX: number;
  readonly originY: number;
  readonly grid: LynxOcrGrid;
}

export const LYNX_GEOMETRY_40: LynxOcrGeometry = {
  cols: 40, rows: 24, originX: 6, originY: 6, grid: '40x24',
};

export const LYNX_GEOMETRY_80: LynxOcrGeometry = {
  cols: 80, rows: 24, originX: 12, originY: 6, grid: '80x24',
};

/**
 * Reads one pixel of the active area as a palette index (0-7).
 *
 * The caller owns the walk from active-area coordinates to the framebuffer or
 * the colour planes, so this module never has to know which model it is
 * looking at.
 */
export type LynxPixelReader = (x: number, y: number) => number;

/**
 * Sanity-check a candidate character set.
 *
 * A real Lynx font has a blank space at 0x20, draws something for every other
 * printable character, and never sets a bit above the sixth — RAM or code
 * sitting at the same address fails all three. Cheap on purpose: it only has
 * to reject obvious rubbish, since a wrong-but-plausible font would produce
 * wrong-but-plausible text.
 */
export function looksLikeLynxFont(font: Uint8Array): boolean {
  if (font.length < LYNX_FONT_BYTES) return false;
  for (let i = 0; i < LYNX_CELL_HEIGHT; i++) if (font[i] !== 0) return false;
  let inked = 0;
  for (let ch = 1; ch < LYNX_FONT_CHARS; ch++) {
    const at = ch * LYNX_CELL_HEIGHT;
    let any = false;
    for (let i = 0; i < LYNX_CELL_HEIGHT; i++) {
      if (font[at + i] > GLYPH_MASK) return false;
      if (font[at + i] !== 0) any = true;
    }
    if (any) inked++;
  }
  // Every printable character but space should draw something; allow a few
  // blanks for the handful of control-ish slots at the top of the table.
  return inked >= LYNX_FONT_CHARS - 6;
}

/** One transcribed screen, the full untrimmed grid. */
export interface LynxOcrCells {
  /** One entry per cell, row-major: the recognised character, or '?'. */
  chars: string[];
  /** True where the cell matched the font, so the overlay may blank it. */
  mask: boolean[];
  /** Per-cell background palette index, for blanking a matched cell. */
  paper: number[];
  /** Per-cell foreground palette index (the paper index for a blank cell). */
  ink: number[];
  cols: number;
  rows: number;
}

/** Index the font by its ten rows so each cell costs one map lookup. */
function indexGlyphs(font: Uint8Array): Map<string, number> {
  const glyphs = new Map<string, number>();
  for (let ch = 0; ch < LYNX_FONT_CHARS; ch++) {
    const at = ch * LYNX_CELL_HEIGHT;
    const key: number[] = [];
    for (let i = 0; i < LYNX_CELL_HEIGHT; i++) key.push(font[at + i] & GLYPH_MASK);
    const code = LYNX_FONT_FIRST_CHAR + ch;
    // First writer wins, so a duplicate glyph keeps the lower code point.
    if (!glyphs.has(key.join(','))) glyphs.set(key.join(','), code);
  }
  return glyphs;
}

/**
 * Transcribe the screen cell by cell.
 *
 * Each cell's most common colour is taken as its background and every pixel
 * differing from it as ink, which recognises inverse video (the cursor, and
 * anything PRINTed over a filled ground) with the same table as normal text.
 */
export function lynxScreenCells(
  read: LynxPixelReader,
  font: Uint8Array,
  geo: LynxOcrGeometry,
): LynxOcrCells | null {
  if (!looksLikeLynxFont(font)) return null;
  const glyphs = indexGlyphs(font);

  const count = geo.cols * geo.rows;
  const chars: string[] = new Array(count);
  const mask: boolean[] = new Array(count);
  const paper: number[] = new Array(count);
  const ink: number[] = new Array(count);

  const cell = new Array<number>(LYNX_CELL_HEIGHT);
  const histogram = new Array<number>(8);

  for (let row = 0; row < geo.rows; row++) {
    for (let col = 0; col < geo.cols; col++) {
      const idx = row * geo.cols + col;
      const x0 = geo.originX + col * LYNX_CELL_WIDTH;
      const y0 = geo.originY + row * LYNX_CELL_HEIGHT;

      histogram.fill(0);
      for (let line = 0; line < LYNX_CELL_HEIGHT; line++) {
        for (let bit = 0; bit < LYNX_CELL_WIDTH; bit++) histogram[read(x0 + bit, y0 + line) & 7]++;
      }
      let ground = 0;
      for (let pen = 1; pen < 8; pen++) if (histogram[pen] > histogram[ground]) ground = pen;

      let bits = 0, foreground = ground;
      for (let line = 0; line < LYNX_CELL_HEIGHT; line++) {
        let value = 0;
        for (let bit = 0; bit < LYNX_CELL_WIDTH; bit++) {
          const pen = read(x0 + bit, y0 + line) & 7;
          if (pen !== ground) { value |= 1 << (LYNX_CELL_WIDTH - 1 - bit); foreground = pen; }
        }
        cell[line] = value;
        bits |= value;
      }

      paper[idx] = ground;
      ink[idx] = foreground;
      if (bits === 0) { chars[idx] = ' '; mask[idx] = true; continue; }

      const code = glyphs.get(cell.join(','));
      chars[idx] = code === undefined ? '?' : String.fromCharCode(code);
      mask[idx] = code !== undefined;
    }
  }
  return { chars, mask, paper, ink, cols: geo.cols, rows: geo.rows };
}

/**
 * Transcribe the screen as plain text, trailing blanks trimmed.
 *
 * Leading blank lines are kept: on a bitmap machine they are screen position,
 * which is worth seeing.
 */
export function lynxScreenText(
  read: LynxPixelReader,
  font: Uint8Array,
  geo: LynxOcrGeometry,
): string | null {
  const cells = lynxScreenCells(read, font, geo);
  if (!cells) return null;

  const lines: string[] = [];
  for (let row = 0; row < cells.rows; row++) {
    const from = row * cells.cols;
    lines.push(cells.chars.slice(from, from + cells.cols).join('').replace(/\s+$/, ''));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value === '<' ? '&lt;' : value === '>' ? '&gt;' : value === '&' ? '&amp;' : value;
}

/** The same transcription shaped for the TEXT overlay: full-width rows, each
 *  run of same-coloured cells in its own span so the colours survive. */
export function lynxOcrResult(
  cells: LynxOcrCells,
  palette: Uint32Array,
  grid: LynxOcrGrid,
): OcrResult {
  const css = (pen: number): string => {
    // The palette is ABGR to match the renderer's buffer; CSS wants RGB.
    const abgr = palette[pen & 7] >>> 0;
    const r = abgr & 0xff, g = (abgr >>> 8) & 0xff, b = (abgr >>> 16) & 0xff;
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  };

  let text = '', html = '';
  for (let row = 0; row < cells.rows; row++) {
    const from = row * cells.cols;
    let span = '', pen = -1;
    for (let col = 0; col < cells.cols; col++) {
      const idx = from + col;
      const colour = cells.ink[idx];
      if (colour !== pen) {
        if (span !== '') html += `<span style="color:${css(pen)}">${span}</span>`;
        span = ''; pen = colour;
      }
      span += escapeHtml(cells.chars[idx]);
      text += cells.chars[idx];
    }
    if (span !== '') html += `<span style="color:${css(pen)}">${span}</span>`;
    if (row < cells.rows - 1) { text += '\n'; html += '\n'; }
  }
  return {
    text, html, mask: cells.mask, paper: cells.paper, grid,
    cellWidth: LYNX_CELL_WIDTH, cellHeight: LYNX_CELL_HEIGHT,
    cols: cells.cols, rows: cells.rows,
  };
}
