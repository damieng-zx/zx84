/**
 * What the 8563 VDC shows: its registers and RAM drawn into an RGBA frame.
 *
 * The VDC builds the picture from character cells. Register 1 cells across,
 * register 6 rows down, each cell `(R22 >> 4) + 1` pixels wide and
 * `(R9 & 31) + 1` scan lines tall, of which the pixels the R22 low nibble says
 * (fewer than the high one: that many and one, the same: none, more: the whole
 * cell) and `(R23 & 31) + 1` lines are shown. In double-pixel mode (R25 bit 4:
 * the VDC's "40 columns") every font pixel is two wide and the cell is
 * `2 * (R22 >> 4)` pixels across. The screen RAM is at R12/R13 and, with the colour attributes
 * on (R25 bit 6), an attribute RAM at R20/R21 follows the same layout; each row
 * starts `R1 + R27` bytes after the last. A character's pixels are 16 bytes in
 * the character set at `(R28 & $E0) << 8`, or 4K further on for a cell whose
 * attribute selects the alternate set.
 *
 * Attribute byte: bit 7 alternate set, bit 6 reverse, bit 5 underline (at scan
 * line R29), bit 4 flash (alternating with reverse), bits 3-0 the foreground
 * colour (RGBI). The background, and the border, are R26's low nibble; with
 * the attributes off the foreground is its high nibble. R24 bit 6 reverses
 * everything and bit 5 chooses the flash rate (1/16 or 1/30 of the frame
 * rate); R10 bits 6-5 are the cursor mode (steady, none, 1/16, 1/32) over scan
 * lines R10 & 31 to R11 & 31, at the position in R14/R15. In bitmap mode
 * (R25 bit 7) the screen RAM is the picture itself, a byte to eight pixels.
 *
 * Not drawn: interlace, the display-enable window (R34/R35), the light pen.
 * The horizontal smooth scroll (R25 bits 3-0): raising it moves the picture
 * right. The unscrolled value is `R22 >> 4` (the editor writes $47 with an
 * 8-pixel cell) on the 8563 R8/R9 and the 8568, and 0 on the early R7A, which
 * is why the editor writes a different value when the status register says R7A.
 * The vertical (R24 bits 4-0) moves it up by that many lines.
 */

import { VDC_R, type Vdc } from './vdc.ts';

/** The frame the display is drawn into: 640×200 of picture and a border round it. */
export const VDC_FRAME_WIDTH = 704;
export const VDC_FRAME_HEIGHT = 248;
/** The width of a pixel relative to its height when the frame fills a 4:3 screen. */
export const VDC_PIXEL_ASPECT_X = (4 / 3) * VDC_FRAME_HEIGHT / VDC_FRAME_WIDTH;

/** The sixteen RGBI colours, as the frame's ABGR words: bit 3 red, 2 green, 1 blue, 0 intensity. */
export const VDC_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const intensity = (i & 1) !== 0 ? 0x55 : 0;
    const r = ((i & 8) !== 0 ? 0xAA : 0) + intensity;
    const g = ((i & 4) !== 0 ? 0xAA : 0) + intensity;
    const b = ((i & 2) !== 0 ? 0xAA : 0) + intensity;
    out[i] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
})();

/**
 * Where the VDC's character cells land in the frame: the grid's origin and the
 * cell and row pitches, plus the smooth scrolls that move the picture. The
 * renderer draws from it and the TEXT overlay blanks from it, so the two cannot
 * drift apart.
 */
export interface VdcGeometry {
  /** False when the registers describe no picture (no columns, no rows). */
  readonly ok: boolean;
  /** The grid's top-left corner in frame pixels, before the smooth scrolls. */
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  /** The cell's full pitch across and the part of it the chip shows. */
  readonly cellTotalW: number;
  readonly cellW: number;
  /** The row's full pitch down and the scan lines of it the chip shows. */
  readonly rowTotal: number;
  readonly rowShown: number;
  /** The horizontal smooth scroll: the picture moves right by this many pixels (left when negative). */
  readonly shiftX: number;
  /** Double-pixel mode: every font pixel is two wide. */
  readonly doublePixel: boolean;
  /** The vertical smooth scroll: the picture moves up by this many lines. */
  readonly vScroll: number;
}

export function vdcGeometry(vdc: Vdc): VdcGeometry {
  const r = vdc.regs;
  const cols = r[VDC_R.HDISP];
  const rows = r[VDC_R.VDISP];
  const hi = r[VDC_R.CHARH] >> 4;
  const lo = r[VDC_R.CHARH] & 0x0F;
  const doublePixel = (r[VDC_R.MODE] & 0x10) !== 0;
  const cellTotalW = doublePixel ? Math.max(1, 2 * hi) : hi + 1;
  // Font pixels the display stop leaves: fewer than the cell, that many and one;
  // as many, none; more, the whole cell.
  const fontShown = lo < hi ? lo + 1 : lo === hi ? 0 : hi + 1;
  const cellW = Math.min(doublePixel ? 2 * fontShown : fontShown, cellTotalW);
  const rowTotal = (r[VDC_R.CHARV] & 0x1F) + 1;
  const rowShown = Math.min((r[VDC_R.CHAR_DISP_V] & 0x1F) + 1, rowTotal);
  const hss = r[VDC_R.MODE] & 0x0F;
  const shiftX = (vdc.version === 0 ? hss : hss - hi) * (doublePixel ? 2 : 1);
  return {
    ok: cols !== 0 && rows !== 0 && cellW !== 0 && rowShown !== 0,
    x0: (VDC_FRAME_WIDTH - cols * cellTotalW) >> 1,
    y0: (VDC_FRAME_HEIGHT - rows * rowTotal) >> 1,
    cols, rows, cellTotalW, cellW, rowTotal, rowShown,
    shiftX, doublePixel,
    vScroll: r[VDC_R.SCROLL_V] & 0x1F,
  };
}

/** Whether a flashing cell is in its reversed half now. */
function flashReversed(vdc: Vdc): boolean {
  const period = (vdc.regs[VDC_R.SCROLL_V] & 0x20) !== 0 ? 30 : 16;
  return vdc.frame % period >= period >> 1;
}

/** Whether the cursor is drawn this frame (R10 bits 6-5). */
function cursorShown(vdc: Vdc): boolean {
  switch ((vdc.regs[VDC_R.CURSOR_MODE] >> 5) & 3) {
    case 0: return true;
    case 1: return false;
    case 2: return vdc.frame % 16 < 8;
    default: return vdc.frame % 32 < 16;
  }
}

/**
 * Draw the VDC's picture into `out` (`VDC_FRAME_WIDTH` × `VDC_FRAME_HEIGHT`
 * words): the border colour, then the character area centred in it and clipped
 * to it.
 */
export function renderVdc(vdc: Vdc, out: Uint32Array): void {
  const r = vdc.regs;
  const reverseScreen = (r[VDC_R.SCROLL_V] & 0x40) !== 0;
  const bgIndex = r[VDC_R.COLOUR] & 0x0F;
  out.fill(VDC_PALETTE[bgIndex]);

  const cols = r[VDC_R.HDISP];
  const rows = r[VDC_R.VDISP];
  const geom = vdcGeometry(vdc);
  const { cellTotalW, cellW, rowTotal, rowShown, x0, y0, shiftX, vScroll, doublePixel } = geom;
  if (!geom.ok) return;

  const mode = r[VDC_R.MODE];
  const bitmap = (mode & 0x80) !== 0;
  const colour = (mode & 0x40) !== 0;
  const semigraphic = (mode & 0x20) !== 0;

  const screen = (r[VDC_R.SCREEN_HI] << 8) | r[VDC_R.SCREEN_LO];
  const attrs = (r[VDC_R.ATTR_HI] << 8) | r[VDC_R.ATTR_LO];
  const stride = cols + r[VDC_R.ROW_ADD];
  const charBase = (r[VDC_R.CHARSET] & 0xE0) << 8;
  const underline = r[VDC_R.UNDERLINE] & 0x1F;
  const cursorAt = (r[VDC_R.CURSOR_HI] << 8) | r[VDC_R.CURSOR_LO];
  const cursorFrom = r[VDC_R.CURSOR_MODE] & 0x1F;
  const cursorTo = r[VDC_R.CURSOR_END] & 0x1F;
  const showCursor = cursorShown(vdc);
  const flashRev = flashReversed(vdc);
  const defaultFg = (r[VDC_R.COLOUR] >> 4) & 0x0F;

  const height = rows * rowTotal;

  for (let line = 0; line < height; line++) {
    const y = y0 + line;
    if (y < 0 || y >= VDC_FRAME_HEIGHT) continue;
    // The scan line of the display this line shows, after the vertical scroll.
    const src = line + vScroll;
    const row = Math.floor(src / rowTotal);
    const ln = src - row * rowTotal;
    if (ln >= rowShown || row > rows) continue;
    const rowBase = row * stride;
    const outRow = y * VDC_FRAME_WIDTH;
    for (let col = 0; col < cols; col++) {
      const cell = rowBase + col;
      const code = vdc.at(screen + cell);
      const attr = colour ? vdc.at(attrs + cell) : 0;
      let fg = colour ? attr & 0x0F : defaultFg;
      let bg = bgIndex;
      let glyph: number;
      if (bitmap) glyph = code;
      else glyph = vdc.at(charBase + ((attr & 0x80) !== 0 ? 0x1000 : 0) + code * 16 + ln);
      if ((attr & 0x20) !== 0 && ln === underline) glyph = 0xFF;
      if (showCursor && screen + cell === cursorAt && ln >= cursorFrom && ln <= cursorTo) glyph ^= 0xFF;
      let swap = reverseScreen !== ((attr & 0x40) !== 0);
      if ((attr & 0x10) !== 0 && flashRev) swap = !swap;
      if (swap) { const t = fg; fg = bg; bg = t; }
      const px0 = x0 + col * cellTotalW + shiftX;
      for (let p = 0; p < cellW; p++) {
        const x = px0 + p;
        if (x < 0 || x >= VDC_FRAME_WIDTH) continue;
        const fontPx = doublePixel ? p >> 1 : p;
        const on = fontPx < 8 ? (glyph >> (7 - fontPx)) & 1 : semigraphic ? glyph & 1 : 0;
        out[outRow + x] = VDC_PALETTE[on !== 0 ? fg : bg];
      }
    }
  }
}
