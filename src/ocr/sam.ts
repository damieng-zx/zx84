/**
 * SAM Coupé screen OCR.
 *
 * The SAM has no character grid in memory — its screen is a plain bitmap in
 * whichever of the four modes is selected — so reading text back means matching
 * 8x8 cells against the font, as the Spectrum engine does.
 *
 * Three things about the SAM's text layout were measured from a real `LIST`
 * rather than assumed, and each of them will silently ruin the output if got
 * wrong:
 *
 *  - **Columns are 8 pixels apart, from x = 0.** Glyphs have differing left
 *    bearings inside their cell (an `m` sits further right than an `i`), which
 *    is easy to mistake for proportional spacing when measuring ink rather
 *    than cells. It is not proportional.
 *  - **Rows are 9 pixels apart, not 8** — an 8-pixel glyph plus one of
 *    leading. A fixed 8-pixel row grid decodes the first line and then garbage.
 *    Rows are therefore found by segmenting bands of inked scanlines, which
 *    also picks up the status line pinned to the bottom of the screen.
 *  - **The font lives in RAM, not ROM.** SAM BASIC keeps a redefinable copy;
 *    searching the ROM for rendered glyphs finds nothing. Reading it from RAM
 *    means a program that redefines characters is still transcribed correctly.
 *
 * Everything reads DISPLAY MEMORY, never the rendered frame buffer. The ROM's
 * own wallpaper is a raster effect that rewrites a palette entry mid-scanline,
 * so the rendered background colour changes along a row while the underlying
 * pixel indices do not.
 */

/** Page and offset of SAM BASIC's font table, indexed by character code. */
export const SAM_FONT_PAGE = 0;
export const SAM_FONT_OFFSET = 0x1090;

/** Glyph cell size, and the extra scanline of leading between text rows. */
const CELL_W = 8;
const CELL_H = 8;
const ROW_PITCH = 9;

const FIRST_CHAR = 32;
/**
 * Only printable ASCII is transcribed. The SAM's character set continues past
 * 127 — its copyright sign and the accented letter in "SAM Coupe" live up
 * there — but those codes are not Unicode code points, so mapping them with
 * `String.fromCharCode` yields a plausible-looking wrong character that prints
 * as nothing. A glyph outside this range is reported as `?`, which at least
 * says "seen but not named".
 */
const LAST_CHAR = 126;

/** Reads one pixel's colour index from display memory. */
export type PixelReader = (x: number, y: number) => number;

/**
 * Build a pixel reader for a SAM screen mode over the 24K display window.
 *
 * Modes 1 and 2 are one bit per pixel (ink/paper via an attribute we do not
 * need here — any set bit is ink); modes 3 and 4 are 2 and 4 bits per pixel
 * over 128 bytes per line.
 */
export function samPixelReader(
  vram: (offset: number) => number,
  mode: 1 | 2 | 3 | 4,
): { read: PixelReader; width: number } {
  switch (mode) {
    case 1:
      // Spectrum third / character-row / pixel-row interleave.
      return {
        width: 256,
        read: (x, y) => {
          const off = ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | (x >> 3);
          return (vram(off) >> (7 - (x & 7))) & 1;
        },
      };
    case 2:
      return {
        width: 256,
        read: (x, y) => (vram((y << 5) + (x >> 3)) >> (7 - (x & 7))) & 1,
      };
    case 3:
      return {
        width: 512,
        read: (x, y) => (vram((y << 7) + (x >> 2)) >> (6 - 2 * (x & 3))) & 3,
      };
    default:
      return {
        width: 256,
        read: (x, y) => {
          const b = vram((y << 7) + (x >> 1));
          return (x & 1) ? (b & 0x0F) : (b >> 4);
        },
      };
  }
}

/** A glyph bitmap keyed for lookup. */
const key = (g: Uint8Array): string => g.join(',');

/**
 * Build a glyph -> character map from a font table.
 *
 * Returns null when the table does not look like a font: the space glyph must
 * be blank and there must be a decent spread of distinct shapes, which guards
 * against reading the wrong address on an unfamiliar ROM rather than emitting
 * confident nonsense.
 */
export function samFontMap(font: Uint8Array): Map<string, string> | null {
  const space = font.subarray(FIRST_CHAR * CELL_H, FIRST_CHAR * CELL_H + CELL_H);
  if (space.length < CELL_H || !space.every(b => b === 0)) return null;

  const map = new Map<string, string>();
  let distinct = 0;
  for (let c = FIRST_CHAR; c <= LAST_CHAR; c++) {
    const at = c * CELL_H;
    if (at + CELL_H > font.length) break;
    const g = font.subarray(at, at + CELL_H);
    if (g.every(b => b === 0)) continue;
    const k = key(g);
    if (!map.has(k)) { map.set(k, String.fromCharCode(c)); distinct++; }
  }
  return distinct >= 40 ? map : null;
}

/** Maximal runs of scanlines carrying ink, used to find the text rows. */
function inkBands(read: PixelReader, width: number, paper: number, height: number): number[] {
  const rows: number[] = [];
  let runStart = -1;
  for (let y = 0; y <= height; y++) {
    let any = false;
    if (y < height) {
      for (let x = 0; x < width && !any; x++) if (read(x, y) !== paper) any = true;
    }
    if (any && runStart < 0) runStart = y;
    else if (!any && runStart >= 0) {
      // Subdivide the run at the row pitch: two text rows whose descenders
      // touch arrive as one band.
      for (let o = runStart; o + CELL_H <= y + 1; o += ROW_PITCH) rows.push(o);
      runStart = -1;
    }
  }
  return rows;
}

/** The colour index that dominates the screen, taken as paper. */
function paperIndex(read: PixelReader, width: number, height: number): number {
  const freq = new Array(16).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) freq[read(x, y) & 0x0F]++;
  }
  let best = 0;
  for (let i = 1; i < 16; i++) if (freq[i] > freq[best]) best = i;
  return best;
}

export interface SamOcrResult {
  /** Transcribed lines, trailing blanks trimmed. */
  readonly lines: string[];
  /** Plain text with newlines between rows. */
  readonly text: string;
}

/**
 * Transcribe the screen.
 *
 * `font` is the 8-bytes-per-character table, indexed by character code —
 * normally read live from RAM so a redefined font still transcribes.
 */
export function samScreenText(
  vram: (offset: number) => number,
  mode: 1 | 2 | 3 | 4,
  font: Uint8Array,
  height = 192,
): SamOcrResult | null {
  const map = samFontMap(font);
  if (!map) return null;

  const { read, width } = samPixelReader(vram, mode);
  const paper = paperIndex(read, width, height);
  const cols = Math.floor(width / CELL_W);

  const lines: string[] = [];
  for (const top of inkBands(read, width, paper, height)) {
    let line = '';
    for (let col = 0; col < cols; col++) {
      const g = new Uint8Array(CELL_H);
      let blank = true;
      for (let r = 0; r < CELL_H; r++) {
        let bits = 0;
        for (let b = 0; b < CELL_W; b++) {
          const on = read(col * CELL_W + b, top + r) !== paper;
          bits = (bits << 1) | (on ? 1 : 0);
        }
        g[r] = bits;
        if (bits !== 0) blank = false;
      }
      line += blank ? ' ' : (map.get(key(g)) ?? '?');
    }
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed) lines.push(trimmed);
  }

  return { lines, text: lines.join('\n') };
}
