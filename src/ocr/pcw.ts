/**
 * Amstrad PCW screen OCR.
 *
 * The PCW has no character grid in memory — the screen is a 720x256 bitmap
 * fetched through roller RAM — so text is recovered by cutting the picture into
 * 90x32 cells of 8x8 pixels and matching each against the system font.
 *
 * Two things make that tractable:
 *
 *  - The bitmap is *stored* as 8-byte character cells in the first place (a
 *    line's 90 bytes are 8 apart in memory), so a cell's 8 rows are 8
 *    consecutive bytes as long as the roller RAM maps a character row's eight
 *    scan lines to consecutive offsets — which is what CP/M sets up.
 *  - The font is in RAM at a known place. The documented block 2 layout is
 *    "Screen (&0000-&332F); roller RAM (&3600-&37FF); character set
 *    (&3800-&3FFF)" — 256 glyphs of 8 bytes.
 *
 * Both are CP/M conventions rather than hardware, so `pcwScreenText` returns
 * null when the font does not look like a font, and the caller says so rather
 * than printing 2880 wrong characters.
 */

/** Where the CP/M character set lives: block 2, offset &3800, 256 x 8 bytes. */
export const PCW_FONT_BLOCK = 2;
export const PCW_FONT_OFFSET = 0x3800;
export const PCW_FONT_BYTES = 256 * 8;

export const PCW_OCR_COLS = 90;
export const PCW_OCR_ROWS = 32;

/** Reads one byte of a cell: `(col, row, line)` in character coordinates. */
export type PcwCellReader = (col: number, row: number, line: number) => number;

/**
 * Sanity-check a candidate font table.
 *
 * A real font has a blank glyph at 0x20 and a good spread of set pixels across
 * the printable range; a screen buffer or uninitialised RAM sitting at the same
 * address does not. This is deliberately cheap and only has to reject obvious
 * rubbish — a wrong-but-plausible font produces wrong-but-plausible text, which
 * is the failure mode worth avoiding.
 */
export function looksLikeFont(font: Uint8Array): boolean {
  if (font.length < PCW_FONT_BYTES) return false;
  for (let i = 0; i < 8; i++) if (font[0x20 * 8 + i] !== 0) return false;
  let inked = 0;
  for (let ch = 0x21; ch <= 0x7E; ch++) {
    for (let i = 0; i < 8; i++) if (font[ch * 8 + i] !== 0) { inked++; break; }
  }
  // Every printable character except space should draw something.
  return inked > 0x5E - 8;
}

/**
 * Transcribe the screen.
 *
 * `read` supplies the bitmap a cell row at a time so the caller keeps ownership
 * of the roller-RAM walk. Unmatched cells become spaces when blank and '?'
 * otherwise, so a graphics screen reads as sparse punctuation rather than
 * silently looking like empty text.
 */
export interface PcwOcrCells {
  /** One entry per cell, row-major: the recognised character, or '?'. */
  chars: string[];
  /** Parallel flags: true where the cell matched the font, so the TEXT overlay
   *  may blank it. False for the '?' cells, which stay as picture. */
  mask: boolean[];
  cols: number;
  rows: number;
}

/**
 * Transcribe the screen cell by cell.
 *
 * The full grid, untrimmed — the TEXT overlay needs every cell so its rows line
 * up with the picture underneath. `pcwScreenText` trims this for reading.
 */
export function pcwScreenCells(read: PcwCellReader, font: Uint8Array): PcwOcrCells | null {
  if (!looksLikeFont(font)) return null;

  // Index the font by its 8 bytes so each cell is one map lookup.
  const glyphs = new Map<string, number>();
  for (let ch = 0; ch < 256; ch++) {
    const key = Array.from(font.subarray(ch * 8, ch * 8 + 8)).join(',');
    if (!glyphs.has(key)) glyphs.set(key, ch);
  }

  const chars: string[] = new Array(PCW_OCR_COLS * PCW_OCR_ROWS);
  const mask: boolean[] = new Array(PCW_OCR_COLS * PCW_OCR_ROWS);
  const cell = new Array<number>(8);
  for (let row = 0; row < PCW_OCR_ROWS; row++) {
    for (let col = 0; col < PCW_OCR_COLS; col++) {
      const idx = row * PCW_OCR_COLS + col;
      let blank = true;
      for (let line = 0; line < 8; line++) {
        const b = read(col, row, line);
        cell[line] = b;
        if (b !== 0) blank = false;
      }
      if (blank) { chars[idx] = ' '; mask[idx] = true; continue; }
      const ch = glyphs.get(cell.join(','));
      // Codes outside printable ASCII are PCW-specific graphics; show them as
      // '?' rather than emitting control characters into the transcript.
      const printable = ch !== undefined && ch >= 0x20 && ch <= 0x7E;
      chars[idx] = printable ? String.fromCharCode(ch) : '?';
      mask[idx] = printable;
    }
  }
  return { chars, mask, cols: PCW_OCR_COLS, rows: PCW_OCR_ROWS };
}

export function pcwScreenText(read: PcwCellReader, font: Uint8Array): string | null {
  const cells = pcwScreenCells(read, font);
  if (!cells) return null;

  const rows: string[] = [];
  for (let row = 0; row < cells.rows; row++) {
    const from = row * cells.cols;
    rows.push(cells.chars.slice(from, from + cells.cols).join('').replace(/\s+$/, ''));
  }

  // Trim trailing blank lines; leading ones are meaningful (they are screen
  // position) and are kept.
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}
