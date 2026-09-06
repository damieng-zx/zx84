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

/**
 * Power-on offset of SAM BASIC's font table within the system page.
 *
 * CHARS (0x5C36) points 256 bytes below CHR$ 0, and at power-on holds 0x5090 —
 * this offset in the system page's 0x4000 window. The live value is followed
 * instead, so a program that repoints the character set still transcribes;
 * this is only the fallback for a CHARS that points somewhere unreachable.
 */
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

/**
 * Build a reader for the CLUT index a pixel is drawn through.
 *
 * In modes 3 and 4 the pixel value IS the CLUT index, so this is the pixel
 * reader. Modes 1 and 2 are one bit per pixel through an attribute — ink in
 * the low three bits, paper in the next three, and a shared BRIGHT that
 * supplies bit 3 of the index — exactly as `SamAsic.plotAttrCell` decodes it.
 *
 * Colour is taken from DISPLAY MEMORY rather than from the rendered frame
 * buffer for one blunt reason: the overlay blanks the cells it transcribes,
 * so a driver that sampled the frame buffer would be reading its own last
 * blanking whenever the machine had not redrawn in between. On a 50 Hz machine
 * shown at 60 Hz that is roughly one frame in six, and the text flashed black
 * on black.
 */
export function samColourReader(
  vram: (offset: number) => number,
  mode: 1 | 2 | 3 | 4,
): PixelReader {
  if (mode >= 3) return samPixelReader(vram, mode).read;
  const attrOf = mode === 1
    ? (x: number, y: number) => 6144 + ((y >> 3) << 5) + (x >> 3)
    : (x: number, y: number) => 0x2000 + (y << 5) + (x >> 3);
  const { read } = samPixelReader(vram, mode);
  return (x, y) => {
    const attr = vram(attrOf(x, y));
    const bright = (attr & 0x40) >> 3;
    return read(x, y)
      ? (attr & 0x07) | bright
      : ((attr >> 3) & 0x07) | bright;
  };
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

/**
 * Maximal runs of scanlines carrying ink, used to find the text rows.
 *
 * Segmenting rather than stepping a fixed grid is what picks up the status
 * line: SAM BASIC pins it to the bottom of the screen at y=183, which is not a
 * multiple of the 9-pixel row pitch the upper window uses.
 */
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
 * Rows the TEXT overlay lays out over the 192-line display.
 *
 * The pitch is 9 — an 8-pixel glyph plus one of leading — so 21 whole rows
 * fit. Transcription itself finds its rows by segmenting ink (see `inkBands`);
 * this is only the grid the overlay's blank rows are counted against, so that
 * a gap in the picture stays a gap in the text laid over it.
 */
export const SAM_TEXT_ROWS = 21;

/** A cell-by-cell reading of the screen, before it is turned into text, HTML
 *  or a blanking mask. Coordinates are in DISPLAY pixels (256 or 512 across),
 *  not frame-buffer pixels — the caller scales. */
export interface SamOcrCells {
  /** Character columns (32 in modes 1/2/4, 64 in mode 3). */
  readonly cols: number;
  readonly rows: number;
  /** Display-space width the cells were read from. */
  readonly width: number;
  /** Display y of each row's top scanline. */
  readonly rowTops: readonly number[];
  /** `cols*rows` transcribed characters; a space where nothing was inked. */
  readonly chars: readonly string[];
  /** `cols*rows` — true where a glyph was matched (and so may be blanked). */
  readonly mask: boolean[];
  /** CLUT index the glyph is inked in, per matched cell, or -1. */
  readonly ink: Int16Array;
  /** CLUT index behind the glyph, per matched cell, or -1. */
  readonly paper: Int16Array;
}

/**
 * Read the screen cell by cell.
 *
 * The colour of a cell is deliberately NOT decided here. Modes 1 and 2 carry
 * their colours in an attribute area this reader never sees, and in every mode
 * the ROM's wallpaper rewrites a palette entry mid-scanline, so the only
 * honest answer to "what colour is this glyph" is the one already on the
 * screen. Each matched cell therefore reports where to LOOK — one inked pixel
 * and one paper pixel — and the caller samples its own frame buffer.
 */
export function samScreenCells(
  vram: (offset: number) => number,
  mode: 1 | 2 | 3 | 4,
  font: Uint8Array,
  height = 192,
): SamOcrCells | null {
  const map = samFontMap(font);
  if (!map) return null;

  const { read, width } = samPixelReader(vram, mode);
  const paper = paperIndex(read, width, height);
  const cols = Math.floor(width / CELL_W);
  const rowTops = inkBands(read, width, paper, height);
  const rows = rowTops.length;
  const count = cols * rows;

  const chars: string[] = new Array(count).fill(' ');
  const mask: boolean[] = new Array(count).fill(false);
  const ink = new Int16Array(count).fill(-1);
  const paperOf = new Int16Array(count).fill(-1);
  const colourAt = samColourReader(vram, mode);

  const glyph = new Uint8Array(CELL_H);
  for (let row = 0; row < rows; row++) {
    const top = rowTops[row];
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const x0 = col * CELL_W;
      let blank = true;
      let inkIdx = -1, paperIdx = -1;
      for (let r = 0; r < CELL_H; r++) {
        let bits = 0;
        for (let b = 0; b < CELL_W; b++) {
          const x = x0 + b;
          const y = top + r;
          const on = read(x, y) !== paper;
          bits = (bits << 1) | (on ? 1 : 0);
          if (on) { if (inkIdx < 0) inkIdx = colourAt(x, y); }
          else if (paperIdx < 0) paperIdx = colourAt(x, y);
        }
        glyph[r] = bits;
        if (bits !== 0) blank = false;
      }
      if (blank) continue;
      const ch = map.get(key(glyph));
      chars[idx] = ch ?? '?';
      // Only a recognised glyph is blanked out from under the overlay: an
      // unmatched cell is graphics, and punching a hole in it would hide
      // picture the overlay is not replacing.
      if (ch !== undefined) {
        mask[idx] = true;
        ink[idx] = inkIdx;
        paperOf[idx] = paperIdx;
      }
    }
  }

  return { cols, rows, width, rowTops, chars, mask, ink, paper: paperOf };
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
  const cells = samScreenCells(vram, mode, font, height);
  if (!cells) return null;

  const lines: string[] = [];
  for (let row = 0; row < cells.rows; row++) {
    const from = row * cells.cols;
    const line = cells.chars.slice(from, from + cells.cols).join('').replace(/\s+$/, '');
    if (line) lines.push(line);
  }
  return { lines, text: lines.join('\n') };
}
